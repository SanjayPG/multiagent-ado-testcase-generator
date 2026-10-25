import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = 3290;
const sandbox = path.resolve(".e2e-sandbox");

// The app runs against a fake `claude` that replays a recorded run: no Azure DevOps calls, no tokens.
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One run at a time on the server, so the tests share it serially.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "pnpm exec tsx src/server.ts",
    url: `http://127.0.0.1:${PORT}/api/config`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...(process.env as Record<string, string>),
      UI_PORT: String(PORT),
      UI_REPO_ROOT: sandbox,
      UI_DATA_DIR: path.join(sandbox, "runs"),
      CLAUDE_BIN: process.execPath,
      CLAUDE_BIN_ARGS: JSON.stringify([path.resolve("test", "fake-claude.mjs")]),
      FAKE_CLAUDE_DELAY_MS: "15",
      ADO_PROJECT: "TestProject",
      ADO_ORG: "test-org",
      ADO_PAT_B64: "dummy-pat-for-tests",
    },
  },
});
