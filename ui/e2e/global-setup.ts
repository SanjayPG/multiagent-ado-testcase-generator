import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const globalSetup = async (): Promise<void> => {
  const sandbox = path.resolve(".e2e-sandbox");
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(path.join(sandbox, "context"), { recursive: true });
  // Stand-ins for the repo's own context files, so the page has something to show for "use the repo file".
  writeFileSync(path.join(sandbox, "context", "hld.md"), "# E2E HLD\n\nSessions expire after 30 minutes of inactivity.\n");
  writeFileSync(path.join(sandbox, "context", "regression-scripts.md"), "login_smoke - checks the happy path\n");
};

// Playwright requires a default export for global setup files.
export default globalSetup;
