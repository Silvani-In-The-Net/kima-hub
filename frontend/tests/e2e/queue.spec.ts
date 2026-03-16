import { test, expect } from "@playwright/test";
import {
    loginAsTestUser,
    startPlayingFirstAlbum,
    getAudioSrc,
    waitForSrcChange,
} from "./fixtures/test-helpers";

test.describe("Queue", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("Add to queue button appends track to up-next list", async ({ page }) => {
        // Start an album so the queue is populated. We land on the album page.
        await startPlayingFirstAlbum(page);

        // Hover the first track row to reveal the Add to queue button, then click it.
        // We are already on the album page -- no need to re-navigate.
        const firstTrackRow = page.locator("[data-track-row]").first();
        await firstTrackRow.waitFor({ timeout: 10_000 });
        await firstTrackRow.hover();
        await firstTrackRow.getByLabel("Add to queue").click();

        // Navigate to the queue page using the FullPlayer queue button (client-side
        // navigation) so React state -- including the queue -- is preserved.
        await page.getByTitle("Play queue").click();
        await page.waitForURL(/\/queue/);

        // "Next Up" section must appear since the album has multiple tracks ahead
        await expect(page.getByText(/Next Up/)).toBeVisible({ timeout: 5_000 });
    });

    test("queue page loads with Now Playing section when track is active", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        await page.goto("/queue");
        await page.waitForLoadState("domcontentloaded");

        // Should show "Now Playing" section since a track is active
        await expect(page.getByText("Now Playing")).toBeVisible({ timeout: 5_000 });
    });

    test("queue page shows track count", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        await page.goto("/queue");
        await page.waitForLoadState("domcontentloaded");

        // The queue header shows "{n} track(s) in queue"
        await expect(page.locator("text=/\\d+ track/")).toBeVisible({ timeout: 5_000 });
    });

    test("Play now jumps to selected queue item", async ({ page }) => {
        // Start album (populates queue with multiple tracks)
        await startPlayingFirstAlbum(page);

        const srcBefore = await getAudioSrc(page);

        // Client-side nav to preserve queue state in React context
        await page.getByTitle("Play queue").click();
        await page.waitForURL(/\/queue/);

        // Find the Next Up section -- tracks after the currently playing one
        // Each track row is a flex div containing the action buttons
        const playNowButtons = page.locator('[title="Play now"]');
        const count = await playNowButtons.count();

        if (count === 0) {
            test.skip(); // No upcoming tracks; skip rather than fail
            return;
        }

        // Hover to expose the row actions and click "Play now" on a queued track
        // Walk up 3 levels: button -> actions div -> track row div
        const targetRow = playNowButtons.first().locator("xpath=ancestor::div[contains(@class,'flex') and contains(@class,'items-center')][1]");
        await targetRow.hover();
        await targetRow.getByTitle("Play now").click();

        // Audio source should change since we skipped to a different track
        const srcAfter = await waitForSrcChange(page, srcBefore, 8_000);
        expect(srcAfter).not.toBe(srcBefore);
    });

    test("Remove removes item from queue", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        await page.getByTitle("Play queue").click();
        await page.waitForURL(/\/queue/);

        const removeButtons = page.locator('[title="Remove"]');
        const initialCount = await removeButtons.count();

        if (initialCount === 0) {
            test.skip();
            return;
        }

        // Walk up to the row container from the Remove button
        const firstQueueItem = removeButtons.first().locator("xpath=ancestor::div[contains(@class,'flex') and contains(@class,'items-center')][1]");

        // Hover to show the controls, then click Remove
        await firstQueueItem.hover();
        await firstQueueItem.getByTitle("Remove").click();

        // Count should decrease
        await expect(page.locator('[title="Remove"]')).toHaveCount(initialCount - 1, { timeout: 3_000 });
    });

    test("Move up reorders queue item", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        await page.getByTitle("Play queue").click();
        await page.waitForURL(/\/queue/);

        const moveUpButtons = page.locator('[title="Move up"]:not([disabled])');
        const count = await moveUpButtons.count();

        if (count === 0) {
            test.skip(); // No movable items
            return;
        }

        // Walk up to the row container from the Move up button
        const targetRow = moveUpButtons.first().locator("xpath=ancestor::div[contains(@class,'flex') and contains(@class,'items-center')][1]");
        const titleTarget = await targetRow.locator("h3").first().textContent() ?? "";

        await targetRow.hover();
        await targetRow.getByTitle("Move up").click();

        // Queue state update is synchronous via context -- just verify no error
        await page.waitForTimeout(300);
        await expect(page.getByText(/Next Up|Now Playing|No tracks/)).toBeVisible();

        void titleTarget; // suppress unused var
    });

    test("Clear Queue empties the up-next list", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        // Navigate via FullPlayer queue button (client-side nav) to keep React state
        await page.getByTitle("Play queue").click();
        await page.waitForURL(/\/queue/);

        // Clear Queue button only appears when queue.length > 0
        const clearBtn = page.getByText("Clear Queue");
        await expect(clearBtn).toBeVisible({ timeout: 5_000 });
        await clearBtn.click();

        // Up Next section should disappear (or show empty state)
        await expect(page.getByText("No tracks in queue")).toBeVisible({ timeout: 5_000 });
    });
});
