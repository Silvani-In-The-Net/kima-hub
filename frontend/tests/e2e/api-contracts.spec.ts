import { test, expect } from "@playwright/test";
import { loginAsTestUser, getAuthToken } from "./fixtures/test-helpers";

test.describe("API Contracts", () => {
    test.describe("Auth", () => {
        test("POST /api/auth/login with valid credentials returns token and user shape", async ({ page }) => {
            const res = await page.request.post("/api/auth/login", {
                data: { username: "chevron7", password: "temp123" },
            });
            expect(res.status()).toBe(200);
            const body = await res.json();
            expect(typeof body.token).toBe("string");
            expect(body.token.length).toBeGreaterThan(20);
            expect(body.user).toBeTruthy();
            expect(body.user.username).toBe("chevron7");
            // Password hash must never appear in login response
            expect(JSON.stringify(body)).not.toMatch(/passwordHash|password_hash|\$2b\$/);
        });

        test("POST /api/auth/login with wrong password returns 401", async ({ page }) => {
            const res = await page.request.post("/api/auth/login", {
                data: { username: "chevron7", password: "wrong" },
            });
            expect(res.status()).toBe(401);
        });

        test("GET /api/auth/me with valid token returns user profile without hash", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);

            const res = await page.request.get("/api/auth/me", {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBe(200);
            const body = await res.json();
            expect(body.username).toBe("chevron7");
            expect(body.passwordHash).toBeUndefined();
        });

        test("GET /api/auth/me with invalid token returns 401", async ({ page }) => {
            const res = await page.request.get("/api/auth/me", {
                headers: { Authorization: "Bearer not.a.valid.token" },
            });
            expect(res.status()).toBe(401);
        });
    });

    test.describe("Playlists", () => {
        test("GET /api/playlists returns an array", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);

            const res = await page.request.get("/api/playlists", {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBe(200);
            const body = await res.json();
            // Accept either a bare array or a paginated object with array field
            const items = Array.isArray(body) ? body : (body.playlists ?? body.items ?? body.data ?? body);
            expect(Array.isArray(items)).toBe(true);
        });

        test("POST /api/playlists creates playlist with correct shape", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);
            const name = `contract-create-${Date.now()}`;

            const res = await page.request.post("/api/playlists", {
                data: { name, isPublic: false },
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBe(200);
            const body = await res.json();
            expect(body.id).toBeTruthy();
            expect(body.name).toBe(name);
            expect(body.isPublic).toBe(false);

            // Cleanup
            await page.request.delete(`/api/playlists/${body.id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
        });

        test("GET /api/playlists/:id returns 400 or 404 for nonexistent id", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);

            const res = await page.request.get("/api/playlists/nonexistent-000000", {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect([400, 404]).toContain(res.status());
        });

        test("POST /api/playlists rejects name longer than 200 chars", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);

            const res = await page.request.post("/api/playlists", {
                data: { name: "a".repeat(201), isPublic: false },
                headers: { Authorization: `Bearer ${token}` },
            });
            expect([400, 422]).toContain(res.status());
        });

        test("DELETE /api/playlists/:id removes the playlist", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);

            const createRes = await page.request.post("/api/playlists", {
                data: { name: `contract-delete-${Date.now()}`, isPublic: false },
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!createRes.ok()) { test.skip(); return; }
            const { id } = await createRes.json();

            const deleteRes = await page.request.delete(`/api/playlists/${id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect([200, 204]).toContain(deleteRes.status());

            // Verify gone
            const getRes = await page.request.get(`/api/playlists/${id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect([403, 404]).toContain(getRes.status());
        });

        test("POST /api/playlists/:id/items adds a track", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);

            // Get a real track ID from the library
            const tracksRes = await page.request.get("/api/library/tracks?limit=1", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!tracksRes.ok()) { test.skip(); return; }
            const tracksBody = await tracksRes.json();
            const tracks = tracksBody.tracks ?? tracksBody;
            if (!tracks[0]?.id) { test.skip(); return; }
            const trackId: string = tracks[0].id;

            const createRes = await page.request.post("/api/playlists", {
                data: { name: `contract-addtrack-${Date.now()}`, isPublic: false },
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!createRes.ok()) { test.skip(); return; }
            const playlist = await createRes.json();

            const addRes = await page.request.post(`/api/playlists/${playlist.id}/items`, {
                data: { trackId },
                headers: { Authorization: `Bearer ${token}` },
            });
            expect([200, 201]).toContain(addRes.status());

            // Verify track appears in playlist
            const getRes = await page.request.get(`/api/playlists/${playlist.id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(getRes.status()).toBe(200);
            const updated = await getRes.json();
            const itemIds = (updated.items ?? []).map((i: { trackId?: string; track?: { id: string } }) => i.trackId ?? i.track?.id);
            expect(itemIds).toContain(trackId);

            // Cleanup
            await page.request.delete(`/api/playlists/${playlist.id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
        });
    });

    test.describe("Library", () => {
        test("GET /api/library/tracks returns tracks with id and title fields", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);

            const res = await page.request.get("/api/library/tracks?limit=3", {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBe(200);
            const body = await res.json();
            const tracks = body.tracks ?? body;
            expect(Array.isArray(tracks)).toBe(true);
            if (tracks.length > 0) {
                expect(tracks[0].id).toBeTruthy();
                expect(tracks[0].title ?? tracks[0].name).toBeTruthy();
            }
        });

        test("GET /api/library/albums returns albums with id and name fields", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);

            const res = await page.request.get("/api/library/albums?limit=3", {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBe(200);
            const body = await res.json();
            const albums = body.albums ?? body;
            expect(Array.isArray(albums)).toBe(true);
            if (albums.length > 0) {
                expect(albums[0].id).toBeTruthy();
                expect(albums[0].name ?? albums[0].title).toBeTruthy();
            }
        });
    });

    test.describe("Search", () => {
        test("GET /api/search returns a structured result (not 500)", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);

            const res = await page.request.get("/api/search?q=a&limit=3", {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBeLessThan(500);
            if (res.status() === 200) {
                const body = await res.json();
                expect(typeof body).toBe("object");
                expect(body.error).toBeUndefined();
            }
        });

        test("GET /api/search with limit=0 does not crash", async ({ page }) => {
            await loginAsTestUser(page);
            const token = await getAuthToken(page);

            const res = await page.request.get("/api/search?q=test&limit=0", {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBeLessThan(500);
        });
    });

    test.describe("Health", () => {
        test("GET /api/health returns 200", async ({ page }) => {
            const res = await page.request.get("/api/health");
            expect(res.status()).toBe(200);
        });
    });
});
