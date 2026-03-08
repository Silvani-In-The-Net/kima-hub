import type { MapTrack } from "./types";

/**
 * Mood-to-color mapping for map dots.
 * Colors are RGB arrays [r, g, b] for deck.gl.
 */
const MOOD_COLORS: Record<string, [number, number, number]> = {
    moodHappy:      [245, 166, 35],
    moodSad:        [100, 100, 220],
    moodRelaxed:    [80, 200, 160],
    moodAggressive: [220, 50, 80],
    moodParty:      [240, 90, 200],
    moodAcoustic:   [180, 160, 100],
    moodElectronic: [50, 180, 240],
    neutral:        [160, 150, 140],
};

const MOOD_LABEL_MAP: Record<string, string> = {
    moodHappy: "Upbeat",
    moodSad: "Melancholic",
    moodRelaxed: "Chill",
    moodAggressive: "Intense",
    moodParty: "Dance",
    moodAcoustic: "Acoustic",
    moodElectronic: "Electronic",
    neutral: "Mixed",
};

/**
 * Get the RGBA color for a track based on its dominant mood.
 * Alpha scales with mood confidence (more confident = more vivid).
 */
export function getTrackColor(track: MapTrack, dimmed = false): [number, number, number, number] {
    const base = MOOD_COLORS[track.dominantMood] || MOOD_COLORS.neutral;
    const confidence = Math.max(0.3, Math.min(1, track.moodScore));
    const alpha = dimmed ? 40 : Math.round(100 + confidence * 130);
    return [base[0], base[1], base[2], alpha];
}

/**
 * Get the highlight color (full brightness) for a track.
 */
export function getTrackHighlightColor(track: MapTrack): [number, number, number, number] {
    const base = MOOD_COLORS[track.dominantMood] || MOOD_COLORS.neutral;
    return [base[0], base[1], base[2], 255];
}

/**
 * Compute cluster labels for the visible viewport.
 * Divides the viewport into an NxN grid and picks the most common mood per cell.
 */
export function computeClusterLabels(
    tracks: MapTrack[],
    viewBounds: { minX: number; maxX: number; minY: number; maxY: number },
    gridSize = 5
): Array<{ x: number; y: number; label: string }> {
    const { minX, maxX, minY, maxY } = viewBounds;
    const cellW = (maxX - minX) / gridSize;
    const cellH = (maxY - minY) / gridSize;

    if (cellW <= 0 || cellH <= 0) return [];

    const grid: Map<string, Map<string, number>> = new Map();

    for (const track of tracks) {
        if (track.x < minX || track.x > maxX || track.y < minY || track.y > maxY) continue;

        const col = Math.min(gridSize - 1, Math.floor((track.x - minX) / cellW));
        const row = Math.min(gridSize - 1, Math.floor((track.y - minY) / cellH));
        const key = `${col},${row}`;

        if (!grid.has(key)) grid.set(key, new Map());
        const cell = grid.get(key)!;
        cell.set(track.dominantMood, (cell.get(track.dominantMood) || 0) + 1);
    }

    const labels: Array<{ x: number; y: number; label: string }> = [];

    for (const [key, moods] of grid) {
        let total = 0;
        for (const count of moods.values()) total += count;
        if (total < 3) continue;

        let bestMood = "";
        let bestCount = 0;
        for (const [mood, count] of moods) {
            if (count > bestCount) {
                bestMood = mood;
                bestCount = count;
            }
        }

        const [col, row] = key.split(",").map(Number);
        const x = minX + (col + 0.5) * cellW;
        const y = minY + (row + 0.5) * cellH;

        labels.push({ x, y, label: MOOD_LABEL_MAP[bestMood] || "Mixed" });
    }

    return labels;
}

/**
 * Get dot radius based on zoom level.
 * deck.gl zoom: ~0-2 = galaxy, ~2-5 = neighborhood, 5+ = street.
 */
export function getRadiusForZoom(zoom: number): number {
    if (zoom < 2) return 2;
    if (zoom < 5) return 4 + (zoom - 2) * 1.5;
    return 8 + (zoom - 5) * 2;
}

