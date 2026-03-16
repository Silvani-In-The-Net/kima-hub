import { test, expect } from "@playwright/test";
import { loginAsTestUser, getAuthToken } from "./fixtures/test-helpers";

/** Login via API without a browser page -- returns the JWT token. */
async function apiLogin(
    page: Parameters<typeof loginAsTestUser>[0],
    username: string,
    password: string,
): Promise<string> {
    const res = await page.request.post("/api/auth/login", {
        data: { username, password },
    });
    if (!res.ok()) throw new Error(`Login failed: ${res.status()} ${await res.text()}`);
    const body = await res.json();
    return body.token as string;
}

const SECURITY_USER = `sec_test_${Date.now()}`;
const SECURITY_PASS = "SecTestPass123!";

test.describe("Security", () => {
    test.describe("Unauthenticated access", () => {
        test("GET /api/library/tracks without token returns 401", async ({ page }) => {
            const res = await page.request.get("/api/library/tracks");
            expect(res.status()).toBe(401);
        });

        test("GET /api/playlists without token returns 401", async ({ page }) => {
            const res = await page.request.get("/api/playlists");
            expect(res.status()).toBe(401);
        });

        test("POST /api/playlists without token returns 401", async ({ page }) => {
            const res = await page.request.post("/api/playlists", {
                data: { name: "unauthorized" },
            });
            expect(res.status()).toBe(401);
        });

        test("GET /api/auth/me without token returns 401", async ({ page }) => {
            const res = await page.request.get("/api/auth/me");
            expect(res.status()).toBe(401);
        });
    });

    test.describe("IDOR -- playlist isolation", () => {
        test("user B cannot read user A private playlist", async ({ page }) => {
            // User A (admin) logs in and creates a private playlist
            await loginAsTestUser(page);
            const tokenA = await getAuthToken(page);

            const createRes = await page.request.post("/api/playlists", {
                data: { name: `idor-read-${Date.now()}`, isPublic: false },
                headers: { Authorization: `Bearer ${tokenA}` },
            });
            if (!createRes.ok()) { test.skip(); return; }
            const playlist = await createRes.json();
            const playlistId: string = playlist.id;

            // Admin creates user B
            const createUserRes = await page.request.post("/api/auth/create-user", {
                data: { username: SECURITY_USER, password: SECURITY_PASS, role: "user" },
                headers: { Authorization: `Bearer ${tokenA}` },
            });

            if (!createUserRes.ok()) {
                await page.request.delete(`/api/playlists/${playlistId}`, {
                    headers: { Authorization: `Bearer ${tokenA}` },
                });
                test.skip();
                return;
            }
            const createdUser = await createUserRes.json();
            const userBId: string = createdUser.id;

            // User B logs in and attempts to read user A's private playlist
            const tokenB = await apiLogin(page, SECURITY_USER, SECURITY_PASS);

            const readRes = await page.request.get(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${tokenB}` },
            });

            // Must NOT be 200 -- private playlist is inaccessible to other users
            expect(readRes.status()).not.toBe(200);
            expect([403, 404]).toContain(readRes.status());

            // Cleanup
            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${tokenA}` },
            });
            await page.request.delete(`/api/auth/users/${userBId}`, {
                headers: { Authorization: `Bearer ${tokenA}` },
            }).catch(() => {/* best-effort */});
        });

        test("tampered JWT cannot delete another user's playlist", async ({ page }) => {
            await loginAsTestUser(page);
            const tokenA = await getAuthToken(page);

            const createRes = await page.request.post("/api/playlists", {
                data: { name: `idor-delete-${Date.now()}`, isPublic: false },
                headers: { Authorization: `Bearer ${tokenA}` },
            });
            if (!createRes.ok()) { test.skip(); return; }
            const playlist = await createRes.json();
            const playlistId: string = playlist.id;

            // Attempt delete with a structurally valid but wrongly-signed token
            const fakeToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJmYWtlLXVzZXItaWQiLCJ1c2VybmFtZSI6ImZha2UiLCJyb2xlIjoidXNlciIsImlhdCI6MTcwMDAwMDAwMH0.fake_sig";
            const deleteRes = await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${fakeToken}` },
            });

            // Bad signature must be rejected
            expect(deleteRes.status()).toBeGreaterThanOrEqual(401);
            expect(deleteRes.status()).toBeLessThan(500);

            // Playlist must still exist under the real owner
            const verifyRes = await page.request.get(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${tokenA}` },
            });
            expect(verifyRes.status()).toBe(200);

            // Cleanup
            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${tokenA}` },
            });
        });
    });

    test.describe("XSS -- playlist name rendering", () => {
        test("script tag in playlist name does not execute", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);

            const xssPayload = `<script>window.__xss_fired=true</script>xss-${Date.now()}`;
            const createRes = await page.request.post("/api/playlists", {
                data: { name: xssPayload, isPublic: false },
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!createRes.ok()) { test.skip(); return; }
            const playlist = await createRes.json();
            const playlistId: string = playlist.id;

            await page.goto("/playlists");
            await page.waitForLoadState("domcontentloaded");
            await page.waitForTimeout(1_000);

            // The injected script must NOT have executed
            const xssExecuted = await page.evaluate(
                () => !!(window as unknown as Record<string, unknown>).__xss_fired,
            );
            expect(xssExecuted).toBe(false);

            // No live <script> tags injected into the DOM with our payload
            const injectedScripts = await page.locator("script").evaluateAll(
                (els: Element[]) =>
                    els.filter((el) => el.textContent?.includes("__xss_fired")).length,
            );
            expect(injectedScripts).toBe(0);

            // Cleanup
            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
        });
    });

    test.describe("Input validation", () => {
        test("POST /api/playlists with missing name returns 400 or 422", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);

            const res = await page.request.post("/api/playlists", {
                data: { isPublic: false },
                headers: { Authorization: `Bearer ${token}` },
            });
            expect([400, 422]).toContain(res.status());
        });

        test("POST /api/playlists with empty name returns 400 or 422", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);

            const res = await page.request.post("/api/playlists", {
                data: { name: "", isPublic: false },
                headers: { Authorization: `Bearer ${token}` },
            });
            expect([400, 422]).toContain(res.status());
        });

        test("POST /api/auth/login with missing password returns 400 or 422", async ({ page }) => {
            const res = await page.request.post("/api/auth/login", {
                data: { username: "chevron7" },
            });
            expect([400, 422]).toContain(res.status());
        });

        test("wrong password returns 401 and does not leak hash or stack trace", async ({ page }) => {
            const res = await page.request.post("/api/auth/login", {
                data: { username: "chevron7", password: "definitelywrong" },
            });
            expect(res.status()).toBe(401);
            const body = await res.json();
            expect(body.error).toBeTruthy();
            const bodyStr = JSON.stringify(body);
            expect(bodyStr).not.toMatch(/\$2b\$/); // no bcrypt hash in response
            expect(bodyStr).not.toMatch(/at Object\.|at Function\.|\.ts:\d+/); // no stack trace
        });
    });

    test.describe("Mass assignment", () => {
        test("POST /api/playlists ignores injected userId field", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);

            const res = await page.request.post("/api/playlists", {
                data: {
                    name: `mass-assign-${Date.now()}`,
                    isPublic: false,
                    userId: "injected-attacker-id",
                    role: "admin",
                },
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok()) { test.skip(); return; }
            const playlist = await res.json();

            // Playlist must belong to the authenticated user, not the injected ID
            expect(playlist.userId).not.toBe("injected-attacker-id");
            expect(playlist.userId).toBeTruthy();

            // Cleanup
            await page.request.delete(`/api/playlists/${playlist.id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
        });
    });
});
