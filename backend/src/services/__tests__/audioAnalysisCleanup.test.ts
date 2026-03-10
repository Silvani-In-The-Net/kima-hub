/**
 * AudioAnalysisCleanupService Tests
 *
 * Tests the stale track cleanup logic, circuit breaker, and status transitions.
 * All database calls are mocked -- these test the decision logic, not SQL execution.
 *
 * Run with: npx jest audioAnalysisCleanup.test.ts
 */

// Mock Prisma before any imports
jest.mock("../../utils/db", () => ({
    prisma: {
        $queryRaw: jest.fn(),
        $executeRaw: jest.fn(),
        track: {
            count: jest.fn(),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../enrichmentFailureService", () => ({
    enrichmentFailureService: {
        recordFailure: jest.fn().mockResolvedValue({}),
    },
}));

import { prisma } from "../../utils/db";
import { enrichmentFailureService } from "../enrichmentFailureService";

// Need to re-import fresh instance for each test
let audioAnalysisCleanupService: any;

const mockQueryRaw = prisma.$queryRaw as jest.Mock;
const mockExecuteRaw = prisma.$executeRaw as jest.Mock;
const mockTrackCount = prisma.track.count as jest.Mock;
const mockRecordFailure = enrichmentFailureService.recordFailure as jest.Mock;

function makeStaleTracks(count: number, overrides: Partial<any> = {}): any[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `track-${i}`,
        analysisRetryCount: BigInt(overrides.analysisRetryCount ?? 0),
        analysisStartedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        filePath: `/music/track-${i}.flac`,
        title: `Track ${i}`,
        artistName: `Artist ${i}`,
        ...overrides,
    }));
}

describe("AudioAnalysisCleanupService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Re-require to get fresh instance with reset circuit breaker state
        jest.resetModules();
        // Re-mock after resetModules
        jest.mock("../../utils/db", () => ({
            prisma: {
                $queryRaw: jest.fn(),
                $executeRaw: jest.fn(),
                track: { count: jest.fn() },
            },
        }));
        jest.mock("../../utils/logger", () => ({
            logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
        }));
        jest.mock("../enrichmentFailureService", () => ({
            enrichmentFailureService: { recordFailure: jest.fn().mockResolvedValue({}) },
        }));
        const mod = require("../audioAnalysisCleanup");
        audioAnalysisCleanupService = mod.audioAnalysisCleanupService;
    });

    describe("cleanupStaleProcessing", () => {
        it("should return zeros when no stale tracks found", async () => {
            const { prisma: p } = require("../../utils/db");
            (p.$queryRaw as jest.Mock).mockResolvedValue([]);

            const result = await audioAnalysisCleanupService.cleanupStaleProcessing();

            expect(result).toEqual({ reset: 0, permanentlyFailed: 0, recovered: 0 });
        });

        it("should recover track with existing embedding", async () => {
            const { prisma: p } = require("../../utils/db");
            const tracks = makeStaleTracks(1);
            (p.$queryRaw as jest.Mock)
                .mockResolvedValueOnce(tracks) // stale tracks query
                .mockResolvedValueOnce([{ count: BigInt(1) }]); // embedding exists
            (p.$executeRaw as jest.Mock).mockResolvedValue(1); // UPDATE succeeds

            const result = await audioAnalysisCleanupService.cleanupStaleProcessing();

            expect(result).toEqual({ reset: 0, permanentlyFailed: 0, recovered: 1 });
        });

        it("should reset track for retry when retry count < MAX_RETRIES", async () => {
            const { prisma: p } = require("../../utils/db");
            const tracks = makeStaleTracks(1, { analysisRetryCount: BigInt(1) });
            (p.$queryRaw as jest.Mock)
                .mockResolvedValueOnce(tracks) // stale tracks
                .mockResolvedValueOnce([{ count: BigInt(0) }]); // no embedding
            (p.$executeRaw as jest.Mock).mockResolvedValue(1); // UPDATE succeeds

            const result = await audioAnalysisCleanupService.cleanupStaleProcessing();

            expect(result).toEqual({ reset: 1, permanentlyFailed: 0, recovered: 0 });
        });

        it("should permanently fail track when retry count >= MAX_RETRIES", async () => {
            const { prisma: p } = require("../../utils/db");
            const { enrichmentFailureService: efs } = require("../enrichmentFailureService");
            const tracks = makeStaleTracks(1, { analysisRetryCount: BigInt(3) });
            (p.$queryRaw as jest.Mock)
                .mockResolvedValueOnce(tracks) // stale tracks
                .mockResolvedValueOnce([{ count: BigInt(0) }]); // no embedding
            (p.$executeRaw as jest.Mock).mockResolvedValue(1); // UPDATE succeeds

            const result = await audioAnalysisCleanupService.cleanupStaleProcessing();

            expect(result).toEqual({ reset: 0, permanentlyFailed: 1, recovered: 0 });
            expect(efs.recordFailure).toHaveBeenCalledWith(
                expect.objectContaining({
                    entityType: "audio",
                    entityId: "track-0",
                    errorCode: "MAX_RETRIES_EXCEEDED",
                }),
            );
        });

        it("should not count UPDATE that affected 0 rows (TOCTOU protection)", async () => {
            const { prisma: p } = require("../../utils/db");
            const tracks = makeStaleTracks(1, { analysisRetryCount: BigInt(1) });
            (p.$queryRaw as jest.Mock)
                .mockResolvedValueOnce(tracks) // stale tracks
                .mockResolvedValueOnce([{ count: BigInt(0) }]); // no embedding
            (p.$executeRaw as jest.Mock).mockResolvedValue(0); // UPDATE affected 0 rows -- track was claimed

            const result = await audioAnalysisCleanupService.cleanupStaleProcessing();

            expect(result).toEqual({ reset: 0, permanentlyFailed: 0, recovered: 0 });
        });

        it("should handle mixed batch: some recoverable, some retryable, some permanently failed", async () => {
            const { prisma: p } = require("../../utils/db");
            const tracks = [
                { ...makeStaleTracks(1, { analysisRetryCount: BigInt(0) })[0], id: "track-recover" },
                { ...makeStaleTracks(1, { analysisRetryCount: BigInt(1) })[0], id: "track-retry" },
                { ...makeStaleTracks(1, { analysisRetryCount: BigInt(3) })[0], id: "track-perm-fail" },
            ];

            (p.$queryRaw as jest.Mock)
                .mockResolvedValueOnce(tracks) // stale tracks
                .mockResolvedValueOnce([{ count: BigInt(1) }]) // track-recover has embedding
                .mockResolvedValueOnce([{ count: BigInt(0) }]) // track-retry no embedding
                .mockResolvedValueOnce([{ count: BigInt(0) }]); // track-perm-fail no embedding
            (p.$executeRaw as jest.Mock).mockResolvedValue(1); // all UPDATEs succeed

            const result = await audioAnalysisCleanupService.cleanupStaleProcessing();

            expect(result).toEqual({ reset: 1, permanentlyFailed: 1, recovered: 1 });
        });
    });

    describe("circuit breaker", () => {
        it("should start in closed state", () => {
            expect(audioAnalysisCleanupService.isCircuitOpen()).toBe(false);
        });

        it("should not open until threshold reached", async () => {
            const { prisma: p } = require("../../utils/db");

            for (let i = 0; i < 29; i++) {
                const tracks = makeStaleTracks(1, { analysisRetryCount: BigInt(0) });
                (p.$queryRaw as jest.Mock)
                    .mockResolvedValueOnce(tracks)
                    .mockResolvedValueOnce([{ count: BigInt(0) }]);
                (p.$executeRaw as jest.Mock).mockResolvedValue(1);
                await audioAnalysisCleanupService.cleanupStaleProcessing();
            }

            expect(audioAnalysisCleanupService.isCircuitOpen()).toBe(false);
        });

        it("should open after threshold failures", async () => {
            const { prisma: p } = require("../../utils/db");

            for (let i = 0; i < 30; i++) {
                const tracks = makeStaleTracks(1, { analysisRetryCount: BigInt(0) });
                (p.$queryRaw as jest.Mock)
                    .mockResolvedValueOnce(tracks)
                    .mockResolvedValueOnce([{ count: BigInt(0) }]);
                (p.$executeRaw as jest.Mock).mockResolvedValue(1);
                await audioAnalysisCleanupService.cleanupStaleProcessing();
            }

            expect(audioAnalysisCleanupService.isCircuitOpen()).toBe(true);
        });

        it("should close on successful recovery after reset", () => {
            audioAnalysisCleanupService.resetCircuitBreaker();
            audioAnalysisCleanupService.recordSuccess();
            expect(audioAnalysisCleanupService.isCircuitOpen()).toBe(false);
        });

        it("should reset all state on resetCircuitBreaker", () => {
            audioAnalysisCleanupService.resetCircuitBreaker();
            const stats = { circuitOpen: false, circuitState: "closed", failureCount: 0 };
            // isCircuitOpen checks state
            expect(audioAnalysisCleanupService.isCircuitOpen()).toBe(false);
        });
    });

    describe("getStats", () => {
        it("should return all status counts and circuit breaker state", async () => {
            const { prisma: p } = require("../../utils/db");
            (p.track.count as jest.Mock)
                .mockResolvedValueOnce(10) // pending
                .mockResolvedValueOnce(5)  // processing
                .mockResolvedValueOnce(100) // completed
                .mockResolvedValueOnce(2)  // failed
                .mockResolvedValueOnce(1); // permanently_failed

            const stats = await audioAnalysisCleanupService.getStats();

            expect(stats).toEqual({
                pending: 10,
                processing: 5,
                completed: 100,
                failed: 2,
                permanentlyFailed: 1,
                circuitOpen: false,
                circuitState: "closed",
                failureCount: 0,
            });
        });
    });
});
