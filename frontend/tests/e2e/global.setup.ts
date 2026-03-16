/**
 * Playwright global setup -- runs once before all tests.
 *
 * Verifies the E2E test user exists and can authenticate.
 * If login fails with the configured credentials, prints setup instructions and aborts.
 *
 * Required env vars (set in .env.test or export before running):
 *   KIMA_TEST_USERNAME  -- username of the dedicated E2E test user
 *   KIMA_TEST_PASSWORD  -- password of the dedicated E2E test user
 *   KIMA_UI_BASE_URL    -- base URL of the running app (default: http://127.0.0.1:3030)
 */
import { chromium } from "@playwright/test";

async function globalSetup(): Promise<void> {
    const username = process.env.KIMA_TEST_USERNAME;
    const password = process.env.KIMA_TEST_PASSWORD;
    const baseUrl = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3030";

    if (!username || !password) {
        throw new Error(
            "E2E test user credentials not set.\n" +
            "Set KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD before running E2E tests.\n" +
            "To create a test user, run: bash scripts/create-e2e-user.sh"
        );
    }

    // Verify the test user can log in via browser (also saves auth state)
    const browser = await chromium.launch();
    const page = await browser.newPage();

    try {
        await page.goto(`${baseUrl}/login`);
        await page.locator("#username").fill(username);
        await page.locator("#password").fill(password);
        await page.getByRole("button", { name: "Sign In" }).click();

        // Wait for redirect to the home page (matches /, /?..., /home)
        // Same pattern used by loginAsTestUser in test-helpers.ts
        try {
            await page.waitForURL(/\/($|\?|home)/, { timeout: 20_000 });
        } catch {
            const url = page.url();
            throw new Error(
                `Login failed for E2E test user '${username}'. Still on: ${url}\n` +
                "Create the user by running: bash scripts/create-e2e-user.sh"
            );
        }

        await page.context().storageState({ path: "tests/e2e/.auth/user.json" });
        console.log(`[setup] E2E test user '${username}' verified, auth state saved.`);
    } finally {
        await browser.close();
    }
}

export default globalSetup;
