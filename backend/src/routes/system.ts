import { Router } from "express";
import { featureDetection } from "../services/featureDetection";
import { requireAuth } from "../middleware/auth";
import { logger } from "../utils/logger";

const router = Router();

/**
 * GET /api/system/features
 * Returns which analyzer features are available based on running services
 */
router.get("/features", requireAuth, async (req, res) => {
    try {
        const features = await featureDetection.getFeatures();
        res.json(features);
    } catch (error: any) {
        logger.error("Feature detection error:", error);
        res.status(500).json({ error: "Failed to detect features" });
    }
});

/**
 * GET /api/system/gpu
 * Returns GPU status and configuration for audio analysis services
 */
router.get("/gpu", requireAuth, async (req, res) => {
    try {
        const gpuStatus = await featureDetection.getGpuStatus();
        res.json(gpuStatus);
    } catch (error: any) {
        logger.error("GPU status error:", error);
        res.status(500).json({ error: "Failed to detect GPU" });
    }
});

export default router;
