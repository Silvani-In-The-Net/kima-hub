"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { SettingsSection, SettingsRow } from "../ui";

interface GpuStatus {
    available: boolean;
    type?: "nvidia" | "intel" | "cpu";
    name?: string;
    memoryGb?: number;
    backend?: string;
    warning?: string;
}

export function GpuStatusSection() {
    const { token } = useAuth();
    const [gpuStatus, setGpuStatus] = useState<GpuStatus | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        async function fetchGpuStatus() {
            if (!token) return;

            try {
                const response = await fetch("/api/system/gpu", {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                });

                if (!response.ok) {
                    throw new Error("Failed to fetch GPU status");
                }

                const data = await response.json();
                setGpuStatus(data);
            } catch (err) {
                setError(err instanceof Error ? err.message : "Unknown error");
            } finally {
                setIsLoading(false);
            }
        }

        fetchGpuStatus();
    }, [token]);

    const getStatusColor = () => {
        if (!gpuStatus) return "text-gray-400";
        switch (gpuStatus.type) {
            case "nvidia":
                return "text-green-400";
            case "intel":
                return "text-blue-400";
            default:
                return "text-yellow-400";
        }
    };

    const getStatusIcon = () => {
        if (!gpuStatus) return "❓";
        switch (gpuStatus.type) {
            case "nvidia":
                return "🔥";
            case "intel":
                return "⚡";
            default:
                return "💻";
        }
    };

    return (
        <SettingsSection
            id="gpu"
            title="GPU Acceleration"
            description="Audio analysis GPU configuration and status"
        >
            <SettingsRow
                label="Status"
                description={isLoading ? "Loading GPU information..." : error ? `Error: ${error}` : "Current GPU configuration"}
            >
                {isLoading ? (
                    <span className="text-gray-400">Loading...</span>
                ) : gpuStatus ? (
                    <div className="flex items-center gap-2">
                        <span className={`text-lg ${getStatusColor()}`}>
                            {getStatusIcon()} {gpuStatus.type === "cpu" ? "CPU Only" : gpuStatus.type?.toUpperCase()}
                        </span>
                    </div>
                ) : (
                    <span className="text-gray-400">Unknown</span>
                )}
            </SettingsRow>

            {gpuStatus && (
                <>
                    <SettingsRow
                        label="Backend"
                        description="ML framework being used"
                    >
                        <span className="text-zinc-200">{gpuStatus.backend || "N/A"}</span>
                    </SettingsRow>

                    {gpuStatus.name && (
                        <SettingsRow
                            label="Device"
                            description="GPU model"
                        >
                            <span className="text-zinc-200">{gpuStatus.name}</span>
                        </SettingsRow>
                    )}

                    {gpuStatus.memoryGb && (
                        <SettingsRow
                            label="Memory"
                            description="Approximate VRAM"
                        >
                            <span className="text-zinc-200">~{gpuStatus.memoryGb} GB</span>
                        </SettingsRow>
                    )}

                    {gpuStatus.warning && (
                        <div className="mt-2 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded text-yellow-200 text-sm">
                            ⚠️ {gpuStatus.warning}
                        </div>
                    )}

                    {gpuStatus.available && (
                        <div className="mt-2 p-3 bg-green-500/10 border border-green-500/20 rounded text-green-200 text-sm">
                            ✅ GPU acceleration enabled for audio analysis
                        </div>
                    )}
                </>
            )}
        </SettingsSection>
    );
}