import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";

const REQUEST_CHANNEL = "audio:text:embed";
const RESPONSE_PREFIX = "audio:text:embed:response:";
const TIMEOUT_MS = 15000;

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

let subscriber: ReturnType<typeof redisClient.duplicate> | null = null;
let subscriberReady = false;

async function ensureSubscriber(): Promise<void> {
    if (subscriberReady) return;
    if (subscriber) return;

    subscriber = redisClient.duplicate();
    await subscriber.connect();
    await subscriber.pSubscribe(`${RESPONSE_PREFIX}*`, (message, channel) => {
        const requestId = channel.slice(RESPONSE_PREFIX.length);
        emitter.emit(requestId, message);
    });
    subscriberReady = true;
    logger.info("[TEXT-EMBED] Shared subscriber connected");
}

/**
 * Request a text embedding from the Python CLAP analyzer via Redis pub/sub.
 * Uses a shared subscriber connection instead of creating one per request.
 */
export async function getTextEmbedding(text: string): Promise<number[]> {
    await ensureSubscriber();

    const requestId = randomUUID();

    const embeddingPromise = new Promise<number[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
            emitter.removeAllListeners(requestId);
            reject(new Error("Text embedding request timed out"));
        }, TIMEOUT_MS);

        emitter.once(requestId, (message: string) => {
            clearTimeout(timeout);
            try {
                const data = JSON.parse(message);
                if (data.error) {
                    reject(new Error(data.error));
                } else {
                    resolve(data.embedding);
                }
            } catch {
                reject(new Error("Invalid response from analyzer"));
            }
        });
    });

    await redisClient.publish(
        REQUEST_CHANNEL,
        JSON.stringify({ requestId, text })
    );

    return embeddingPromise;
}
