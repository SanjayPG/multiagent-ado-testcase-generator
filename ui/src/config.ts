import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ (tsx) and dist/ (built) both sit one level below ui/, which sits one level below the repo root.
const uiRoot = path.resolve(here, "..");
// UI_REPO_ROOT / UI_DATA_DIR exist so tests can run against a throwaway folder instead of the real repo.
const repoRoot = process.env.UI_REPO_ROOT ? path.resolve(process.env.UI_REPO_ROOT) : path.resolve(uiRoot, "..");

const parseArgsPrefix = (raw: string | undefined): string[] => {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((part) => typeof part === "string")) {
    throw new Error("CLAUDE_BIN_ARGS must be a JSON array of strings");
  }
  return parsed;
};

export const config = {
  host: "127.0.0.1",
  port: Number(process.env.UI_PORT ?? 3210),
  uiRoot,
  repoRoot,
  publicDir: path.join(uiRoot, "public"),
  dataDir: process.env.UI_DATA_DIR ? path.resolve(process.env.UI_DATA_DIR) : path.join(uiRoot, ".data", "runs"),
  outputDir: path.join(repoRoot, "output"),
  // CLAUDE_BIN / CLAUDE_BIN_ARGS let tests swap in a fake binary without touching real ADO.
  claudeBin: process.env.CLAUDE_BIN ?? "claude",
  claudeArgsPrefix: parseArgsPrefix(process.env.CLAUDE_BIN_ARGS),
  maxPbis: 20,
  runTimeoutMs: Number(process.env.UI_RUN_TIMEOUT_MS ?? 10 * 60 * 1000),
} as const;

// Booleans only: secrets must never leave the server.
export const getEnvStatus = () => ({
  pat: Boolean(process.env.ADO_PAT_B64),
  org: Boolean(process.env.ADO_ORG),
  project: Boolean(process.env.ADO_PROJECT),
});

export const getProjectName = (): string => process.env.ADO_PROJECT ?? "";
export const getOrgName = (): string => process.env.ADO_ORG ?? "";
