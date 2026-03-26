import { existsSync } from "fs";
import { redisClient } from "../utils/redis";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

// Analyzer script paths in the Docker image
const ESSENTIA_ANALYZER_PATH = "/app/audio-analyzer/analyzer.py";
const CLAP_ANALYZER_PATH = "/app/audio-analyzer-clap/analyzer.py";

export interface GpuStatus {
    available: boolean;
    type?: 'nvidia' | 'intel' | 'cpu';
    name?: string;
    memoryGb?: number;
    backend?: string;
    warning?: string;
}

export interface AvailableFeatures {
    musicCNN: boolean;
    vibeEmbeddings: boolean;
    audiobookshelfEnabled: boolean;
}

const HEARTBEAT_TTL = 300000; // 5 minutes
const CACHE_TTL = 60000; // 60 seconds

class FeatureDetectionService {
    private cache: AvailableFeatures | null = null;
    private lastCheck: number = 0;

    async getFeatures(): Promise<AvailableFeatures> {
        const now = Date.now();
        if (this.cache && now - this.lastCheck < CACHE_TTL) {
            return this.cache;
        }

        const [musicCNN, vibeEmbeddings, audiobookshelfEnabled] = await Promise.all([
            this.checkMusicCNN(),
            this.checkCLAP(),
            this.checkAudiobookshelf(),
        ]);

        this.cache = { musicCNN, vibeEmbeddings, audiobookshelfEnabled };
        this.lastCheck = now;

        logger.debug(
            `[FEATURE-DETECTION] Features: musicCNN=${musicCNN}, vibeEmbeddings=${vibeEmbeddings}, audiobookshelf=${audiobookshelfEnabled}`
        );

        return this.cache;
    }

    private async checkMusicCNN(): Promise<boolean> {
        try {
            // Analyzer script bundled in image = feature is available
            if (existsSync(ESSENTIA_ANALYZER_PATH)) {
                return true;
            }

            const heartbeat = await redisClient.get("audio:worker:heartbeat");
            if (heartbeat) {
                const timestamp = parseInt(heartbeat, 10);
                if (!isNaN(timestamp) && Date.now() - timestamp < HEARTBEAT_TTL) {
                    return true;
                }
            }

            const trackWithEnergy = await prisma.track.findFirst({
                where: { energy: { not: null } },
                select: { id: true },
            });
            return trackWithEnergy !== null;
        } catch (error) {
            logger.error("[FEATURE-DETECTION] Error checking MusicCNN:", error);
            return false;
        }
    }

    private async checkCLAP(): Promise<boolean> {
        try {
            // If explicitly disabled via env var, CLAP is not available
            const disabled = process.env.DISABLE_CLAP;
            if (disabled === "true" || disabled === "1") {
                return false;
            }

            if (existsSync(CLAP_ANALYZER_PATH)) {
                return true;
            }

            const heartbeat = await redisClient.get("clap:worker:heartbeat");
            if (heartbeat) {
                const timestamp = parseInt(heartbeat, 10);
                if (!isNaN(timestamp) && Date.now() - timestamp < HEARTBEAT_TTL) {
                    return true;
                }
            }

            const embeddingCount = await prisma.trackEmbedding.count();
            return embeddingCount > 0;
        } catch (error) {
            logger.error("[FEATURE-DETECTION] Error checking CLAP:", error);
            return false;
        }
    }

    private async checkAudiobookshelf(): Promise<boolean> {
        try {
            const settings = await prisma.systemSettings.findUnique({
                where: { id: "default" },
                select: { audiobookshelfEnabled: true },
            });
            return settings?.audiobookshelfEnabled ?? false;
        } catch (error) {
            logger.error("[FEATURE-DETECTION] Error checking Audiobookshelf:", error);
            return false;
        }
    }

    async getGpuStatus(): Promise<GpuStatus> {
        try {
            // Check audio-analyzer service logs for GPU detection
            const analyzerLog = await this.getServiceLogs('audio-analyzer', 50);
            const clapLog = await this.getServiceLogs('audio-analyzer-clap', 50);

            let gpuType: 'nvidia' | 'intel' | 'cpu' = 'cpu';
            let backend = 'CPU (default)';
            let name: string | undefined;
            let memoryGb: number | undefined;
            let warning: string | undefined;

            // Check for NVIDIA CUDA detection
            if (analyzerLog.includes('TensorFlow GPU detected') || clapLog.includes('CUDA available')) {
                gpuType = 'nvidia';
                backend = 'CUDA';
                name = 'NVIDIA GPU';
                memoryGb = 4; // Default estimate
            }
            // Check for Intel XPU/Level Zero detection
            else if (clapLog.includes('Intel XPU') || clapLog.includes('torch.xpu')) {
                gpuType = 'intel';
                backend = 'XPU (oneDNN)';
                name = 'Intel Arc GPU';
                memoryGb = 3; // A380 has ~8GB shared, estimate 3 for ML
            }
            // Check for Intel oneDNN in analyzer logs
            else if (analyzerLog.includes('oneDNN') || analyzerLog.includes('Level Zero')) {
                gpuType = 'intel';
                backend = 'oneDNN/Level Zero';
                name = 'Intel GPU';
                memoryGb = 3;
            }
            // Default CPU mode
            else if (analyzerLog.includes('TensorFlow running on CPU') || clapLog.includes('on CPU')) {
                gpuType = 'cpu';
                backend = 'CPU';
                warning = 'GPU acceleration not detected. Audio analysis will run slower.';
            }

            return {
                available: gpuType !== 'cpu',
                type: gpuType,
                name,
                memoryGb,
                backend,
                warning
            };
        } catch (error) {
            logger.error('[FEATURE-DETECTION] GPU status error:', error);
            // Return CPU as fallback
            return {
                available: false,
                type: 'cpu',
                name: 'CPU Only',
                backend: 'CPU',
                warning: 'GPU detection failed. Running on CPU.'
            };
        }
    }

    private async getServiceLogs(serviceName: string, lines: number = 50): Promise<string> {
        try {
            const { exec } = require('child_process');
            return new Promise((resolve) => {
                exec(`docker logs --tail ${lines} ${serviceName}`, (error, stdout, stderr) => {
                    if (error) {
                        resolve('');
                    } else {
                        resolve(stdout + stderr);
                    }
                });
            });
        } catch {
            return '';
        }
    }

    invalidateCache(): void {
        this.cache = null;
        this.lastCheck = 0;
    }
}

export const featureDetection = new FeatureDetectionService();
