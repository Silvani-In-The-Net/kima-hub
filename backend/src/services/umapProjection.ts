import path from "path";
import { Worker } from "worker_threads";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { parseEmbedding } from "../utils/embedding";

const MIN_TRACKS_FOR_UMAP = 5;
const MAX_EMBEDDINGS = 15000;

interface MapTrack {
    id: string;
    x: number;
    y: number;
    title: string;
    artist: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    dominantMood: string;
    moodScore: number;
    energy: number | null;
    valence: number | null;
}

interface MapResponse {
    tracks: MapTrack[];
    trackCount: number;
    sampled?: boolean;
    computedAt: string;
}

const MOOD_FIELDS = [
    "moodHappy", "moodSad", "moodRelaxed", "moodAggressive",
    "moodParty", "moodAcoustic", "moodElectronic",
] as const;

function getDominantMood(track: Record<string, number | null>): { mood: string; score: number } {
    let best = { mood: "neutral", score: 0 };
    for (const field of MOOD_FIELDS) {
        const val = track[field];
        if (val !== null && val !== undefined && val > best.score) {
            best = { mood: field, score: val };
        }
    }
    return best;
}

function runUmapInWorker(embeddings: number[][], nNeighbors: number): Promise<number[][]> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, "../workers/umapWorker.js"), {
            workerData: { embeddings, nNeighbors },
        });
        worker.on("message", resolve);
        worker.on("error", reject);
        worker.on("exit", (code) => {
            if (code !== 0) reject(new Error(`UMAP worker exited with code ${code}`));
        });
    });
}

let computePromise: Promise<MapResponse> | null = null;

export async function computeMapProjection(): Promise<MapResponse> {
    const trackIdHash = await prisma.$queryRaw<{ hash: string }[]>`
        SELECT md5(string_agg(track_id, ',' ORDER BY track_id)) as hash
        FROM track_embeddings
    `;
    const hash = trackIdHash[0]?.hash || "empty";

    if (hash === "empty") {
        return { tracks: [], trackCount: 0, computedAt: new Date().toISOString() };
    }

    const cacheKey = `vibe:map:v2:${hash}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) {
        logger.debug(`[VIBE-MAP] Cache hit (hash=${hash.slice(0, 8)})`);
        return JSON.parse(cached);
    }

    if (computePromise) {
        logger.info("[VIBE-MAP] Waiting for in-progress computation");
        return computePromise;
    }

    computePromise = doCompute(cacheKey);
    try {
        return await computePromise;
    } finally {
        computePromise = null;
    }
}

async function doCompute(cacheKey: string): Promise<MapResponse> {
    const startTime = Date.now();

    const rows = await prisma.$queryRaw<Array<{
        track_id: string;
        title: string;
        artistName: string;
        artistId: string;
        albumId: string;
        coverUrl: string | null;
        energy: number | null;
        valence: number | null;
        moodHappy: number | null;
        moodSad: number | null;
        moodRelaxed: number | null;
        moodAggressive: number | null;
        moodParty: number | null;
        moodAcoustic: number | null;
        moodElectronic: number | null;
        embedding: string;
    }>>`
        SELECT
            te.track_id,
            t.title,
            ar.name as "artistName",
            ar.id as "artistId",
            a.id as "albumId",
            a."coverUrl",
            t.energy,
            t.valence,
            t."moodHappy",
            t."moodSad",
            t."moodRelaxed",
            t."moodAggressive",
            t."moodParty",
            t."moodAcoustic",
            t."moodElectronic",
            te.embedding::text as embedding
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        ORDER BY RANDOM()
        LIMIT ${MAX_EMBEDDINGS}
    `;

    const sampled = rows.length === MAX_EMBEDDINGS;

    logger.info(`[VIBE-MAP] Computing UMAP projection for ${rows.length} tracks${sampled ? " (sampled)" : ""}...`);

    if (rows.length < MIN_TRACKS_FOR_UMAP) {
        return {
            tracks: rows.map((r, i) => {
                const dominant = getDominantMood(r as any);
                const angle = (2 * Math.PI * i) / rows.length;
                return {
                    id: r.track_id,
                    x: 0.5 + 0.3 * Math.cos(angle),
                    y: 0.5 + 0.3 * Math.sin(angle),
                    title: r.title,
                    artist: r.artistName, artistId: r.artistId, albumId: r.albumId,
                    coverUrl: r.coverUrl, dominantMood: dominant.mood,
                    moodScore: dominant.score, energy: r.energy, valence: r.valence,
                };
            }),
            trackCount: rows.length,
            computedAt: new Date().toISOString(),
        };
    }

    const embeddings: number[][] = rows.map(r => parseEmbedding(r.embedding));
    const nNeighbors = Math.min(15, Math.max(2, Math.floor(rows.length / 2)));

    const projection = await runUmapInWorker(embeddings, nNeighbors);

    // Normalize to 0-1 range
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of projection) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    const tracks: MapTrack[] = rows.map((row, i) => {
        const dominant = getDominantMood(row as any);
        return {
            id: row.track_id,
            x: (projection[i][0] - minX) / rangeX,
            y: (projection[i][1] - minY) / rangeY,
            title: row.title,
            artist: row.artistName,
            artistId: row.artistId,
            albumId: row.albumId,
            coverUrl: row.coverUrl,
            dominantMood: dominant.mood,
            moodScore: dominant.score,
            energy: row.energy,
            valence: row.valence,
        };
    });

    const result: MapResponse = {
        tracks,
        trackCount: tracks.length,
        ...(sampled && { sampled: true }),
        computedAt: new Date().toISOString(),
    };

    try {
        await redisClient.setEx(cacheKey, 86400, JSON.stringify(result));
    } catch (e) {
        logger.warn("[VIBE-MAP] Failed to cache projection:", (e as Error).message);
    }

    const elapsed = Date.now() - startTime;
    logger.info(`[VIBE-MAP] UMAP projection computed in ${elapsed}ms for ${tracks.length} tracks`);

    return result;
}
