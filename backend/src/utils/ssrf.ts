import { lookup } from "dns/promises";
import { logger } from "./logger";

/**
 * Private/internal IP ranges that must not be accessed via server-side fetch.
 * Prevents SSRF attacks where authenticated users could probe internal networks.
 */
const BLOCKED_PREFIXES = [
  "127.",          // Loopback
  "10.",           // RFC 1918
  "192.168.",      // RFC 1918
  "169.254.",      // Link-local / cloud metadata
  "0.",            // Current network
  "::ffff:127.",   // IPv4-mapped loopback
  "::ffff:10.",    // IPv4-mapped private
  "::ffff:192.168.", // IPv4-mapped private
  "::ffff:169.254.", // IPv4-mapped link-local
];

const ALLOWED_HOSTS = process.env.SSRF_ALLOWED_HOSTS
  ? process.env.SSRF_ALLOWED_HOSTS.split(",").map((h) => h.trim())
  : [];

function isBlockedIp(ip: string): boolean {
  if (ip === "0.0.0.0" || ip === "::" || ip === "::1") return true;
  for (const prefix of BLOCKED_PREFIXES) {
    if (ip.startsWith(prefix)) return true;
  }
  // 172.16.0.0/12
  if (ip.startsWith("172.") || ip.startsWith("::ffff:172.")) {
    const raw = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
    const second = parseInt(raw.split(".")[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Validate a URL is safe to fetch server-side (no SSRF risk).
 * Returns null if safe, or an error string if blocked.
 */
export async function validateUrlForFetch(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL";
  }

  // Only allow http/https schemes
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Blocked scheme: ${parsed.protocol}`;
  }

  // Resolve hostname to IP and check against blocked ranges
  const hostname = parsed.hostname;

  // Block obvious internal hostnames
  if (hostname === "localhost" || hostname === "0.0.0.0") {
    return "Blocked hostname: localhost";
  }

  try {
    const { address } = await lookup(hostname);

    // Check against allowed hosts whitelist first
    if (ALLOWED_HOSTS.length > 0) {
      const isAllowed = ALLOWED_HOSTS.some((allowed) => {
        const trimmed = allowed.trim();
        return (
          trimmed === hostname ||
          trimmed === address ||
          (trimmed.endsWith(".") && hostname.startsWith(trimmed.slice(0, -1)))
        );
      });

      if (isAllowed) {
        logger.debug(`[SSRF] Allowed fetch to ${hostname} (matches SSRF_ALLOWED_HOSTS)`);
        return null;
      }
    }

    if (isBlockedIp(address)) {
      logger.warn(`[SSRF] Blocked fetch to ${hostname} (resolved to ${address})`);
      return `Blocked: internal address`;
    }
  } catch {
    // DNS resolution failed -- could be a non-existent host
    return "DNS resolution failed";
  }

  return null;
}
