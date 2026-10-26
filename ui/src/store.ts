import { randomBytes } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { ContextUsed } from "./context.js";
import type { ChangeSummary } from "./diff.js";
import type { RunEvent } from "./events.js";
import type { ErrorHint } from "./failure.js";
import type { SkippedItem } from "./skipped.js";
import { isRunId } from "./validate.js";

export type RunKind = "generate" | "push";
export type RunStatus = "running" | "done" | "failed" | "cancelled";

export type PushSummary = { created: number | null; linked: number | null; failed: string | null };

export type CsvSource = "original" | "uploaded";

export type UploadInfo = {
  name: string; // display only — never used as a path
  uploadedAt: string;
  testCaseCount: number;
  changes: ChangeSummary;
};

export type RunMeta = {
  id: string;
  kind: RunKind;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  pbis?: number[];
  context?: ContextUsed[];
  parentRunId?: string; // for a push: the generate run whose CSV was pushed
  resultText?: string;
  errorMessage?: string;
  errorHint?: ErrorHint; // a plain-language cause and next steps, when the failure is one we recognise
  skipped?: SkippedItem[]; // ids the pipeline left out, with the reason (for example a Bug)
  hasCsv?: boolean;
  testCaseCount?: number;
  durationMs?: number | null;
  costUsd?: number | null;
  push?: PushSummary;
  upload?: UploadInfo; // an edited CSV the user uploaded for this run
  pushSource?: CsvSource; // for a push run: which file was pushed
  pushCount?: number;
};

export type StoredEvent = RunEvent | { kind: "state"; status: RunStatus } | { kind: "done"; status: RunStatus };

export const createRunId = (): string => {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `run-${date}-${randomBytes(3).toString("hex")}`;
};

const assertRunId = (id: string): string => {
  if (!isRunId(id)) throw new Error("Invalid run id.");
  return id;
};

export const runDir = (id: string): string => path.join(config.dataDir, assertRunId(id));
export const csvPath = (id: string): string => path.join(runDir(id), "tc.csv");
export const uploadPath = (id: string): string => path.join(runDir(id), "upload.csv");
const metaPath = (id: string): string => path.join(runDir(id), "meta.json");
const eventsPath = (id: string): string => path.join(runDir(id), "events.jsonl");
const logPath = (id: string): string => path.join(runDir(id), "run.log");

// Not atomic on purpose: renaming over a file a reader has open fails with EPERM on Windows.
// readMeta retries instead, so a poll that lands mid-write just waits a few milliseconds.
const writeMeta = async (meta: RunMeta): Promise<void> => {
  await writeFile(metaPath(meta.id), JSON.stringify(meta, null, 2));
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const initRun = async (meta: RunMeta): Promise<void> => {
  await mkdir(runDir(meta.id), { recursive: true });
  await writeMeta(meta);
};

export const readMeta = async (id: string): Promise<RunMeta | null> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return JSON.parse(await readFile(metaPath(id), "utf8")) as RunMeta;
    } catch {
      await sleep(20); // missing file, or a write in progress
    }
  }
  return null;
};

export const updateMeta = async (id: string, patch: Partial<RunMeta>): Promise<RunMeta> => {
  const current = await readMeta(id);
  if (!current) throw new Error(`Unknown run ${id}`);
  const next = { ...current, ...patch };
  await writeMeta(next);
  return next;
};

export const appendEvent = async (id: string, event: StoredEvent): Promise<void> => {
  await appendFile(eventsPath(id), `${JSON.stringify(event)}\n`);
};

// Raw output of the claude process (secrets already removed by the caller), kept so a failure can be investigated.
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_TAIL_CHARS = 200_000;

export const appendLog = async (id: string, text: string): Promise<void> => {
  await appendFile(logPath(id), text);
};

// tailLines keeps the page light: only the end of a long log, and never more than MAX_TAIL_CHARS of it.
export const readLog = async (id: string, options: { tailLines?: number } = {}): Promise<string | null> => {
  let text: string;
  try {
    text = await readFile(logPath(id), "utf8");
  } catch {
    return null;
  }
  if (options.tailLines === undefined) return text;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // the file ends with a newline
  const tail = lines.slice(-options.tailLines).join("\n");
  if (tail.length <= MAX_TAIL_CHARS) return tail;
  // Start at a line boundary, so the view never begins in the middle of a line.
  const cut = tail.slice(-MAX_TAIL_CHARS);
  const firstBreak = cut.indexOf("\n");
  return firstBreak >= 0 ? cut.slice(firstBreak + 1) : cut;
};

export const readEvents = async (id: string): Promise<StoredEvent[]> => {
  try {
    const text = await readFile(eventsPath(id), "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as StoredEvent);
  } catch {
    return [];
  }
};

// Copy the CSV the pipeline produced into the run's own folder, so a same-day re-run cannot overwrite it.
export const saveCsvCopy = async (id: string, source: string): Promise<void> => {
  await copyFile(source, csvPath(id));
};

export const readCsvText = async (id: string): Promise<string | null> => {
  try {
    return await readFile(csvPath(id), "utf8");
  } catch {
    return null;
  }
};

export const listRuns = async (limit = 20): Promise<RunMeta[]> => {
  let ids: string[] = [];
  try {
    ids = (await readdir(config.dataDir)).filter(isRunId);
  } catch {
    return [];
  }
  const metas = await Promise.all(ids.map((id) => readMeta(id)));
  return metas
    .filter((meta): meta is RunMeta => meta !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
};

// Deletes every saved run (its CSV, log and context files). Only folders shaped like a run id are touched.
export const clearRuns = async (): Promise<number> => {
  let ids: string[] = [];
  try {
    ids = (await readdir(config.dataDir)).filter(isRunId);
  } catch {
    return 0;
  }
  await Promise.all(ids.map((id) => rm(runDir(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })));
  return ids.length;
};

export const saveUpload = async (id: string, bytes: Buffer): Promise<void> => {
  await writeFile(uploadPath(id), bytes);
};

export const removeUploadFile = async (id: string): Promise<void> => {
  await rm(uploadPath(id), { force: true });
};

// The server, not the browser, decides what gets pushed: the uploaded file if there is one, else the original.
export const effectiveCsv = async (id: string): Promise<{ source: CsvSource; fileName: "tc.csv" | "upload.csv"; text: string } | null> => {
  const meta = await readMeta(id);
  if (!meta) return null;
  if (meta.upload) {
    try {
      return { source: "uploaded", fileName: "upload.csv", text: await readFile(uploadPath(id), "utf8") };
    } catch {
      return null; // metadata says there is an upload but the file is gone: refuse rather than push the original silently
    }
  }
  const text = await readCsvText(id);
  return text === null ? null : { source: "original", fileName: "tc.csv", text };
};
