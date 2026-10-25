import { spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { prepareContext, type ContextRequest } from "./context.js";
import { parseTestCases } from "./csv.js";
import { createEventMapper, extractCsvPath, type RunEvent } from "./events.js";
import { explainFailure } from "./failure.js";
import { fetchPage, type FetchPage } from "./fetchPage.js";
import {
  MAX_LOG_BYTES,
  appendEvent,
  appendLog,
  createRunId,
  csvPath,
  effectiveCsv,
  initRun,
  readMeta,
  runDir,
  saveCsvCopy,
  updateMeta,
  type CsvSource,
  type RunMeta,
  type StoredEvent,
} from "./store.js";
import { parsePushSummary, redactSecrets } from "./summary.js";
import { buildGeneratePrompt, buildPushPrompt } from "./validate.js";

export class BusyError extends Error {}
export class NotFoundError extends Error {}
export class NotReadyError extends Error {}

type Listener = (event: StoredEvent) => void;

type Finished = {
  exitCode: number | null;
  resultText: string;
  resultIsError: boolean;
  stderrTail: string;
  startedAtMs: number;
};

type ActiveRun = {
  id: string;
  child: ChildProcess | null;
  events: StoredEvent[];
  listeners: Set<Listener>;
  cancelled: boolean;
  timedOut: boolean;
};

// Only one run at a time: the pipeline writes date-named files into output/, so two runs would collide.
let active: ActiveRun | null = null;

export const getActiveRunId = (): string | null => active?.id ?? null;

export const subscribe = (id: string, listener: Listener): { backlog: StoredEvent[]; unsubscribe: () => void } | null => {
  if (!active || active.id !== id) return null;
  const run = active;
  const backlog = [...run.events];
  run.listeners.add(listener);
  return { backlog, unsubscribe: () => run.listeners.delete(listener) };
};

const killTree = (child: ChildProcess | null): void => {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    // `claude` starts helper processes; /T takes the whole tree down.
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
};

export const cancelRun = (id: string): boolean => {
  if (!active || active.id !== id) return false;
  active.cancelled = true;
  killTree(active.child);
  return true;
};

export const shutdown = (): void => {
  if (active) {
    active.cancelled = true;
    killTree(active.child);
  }
};

const isInside = (parent: string, candidate: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const locateGeneratedCsv = async (resultText: string, startedAtMs: number): Promise<string | null> => {
  const mentioned = extractCsvPath(resultText);
  if (mentioned) {
    const absolute = path.resolve(config.repoRoot, mentioned);
    if (isInside(config.outputDir, absolute)) {
      try {
        await stat(absolute);
        return absolute;
      } catch {
        // fall through to the scan
      }
    }
  }
  try {
    const candidates = await Promise.all(
      (await readdir(config.outputDir))
        .filter((name) => /^tc_[\w-]+\.csv$/.test(name))
        .map(async (name) => ({ file: path.join(config.outputDir, name), mtime: (await stat(path.join(config.outputDir, name))).mtimeMs })),
    );
    const fresh = candidates.filter((c) => c.mtime >= startedAtMs - 2000).sort((a, b) => b.mtime - a.mtime);
    return fresh[0]?.file ?? null;
  } catch {
    return null;
  }
};

type Launch = {
  meta: RunMeta;
  prompt: string;
  onSuccess: (finished: Finished) => Promise<Partial<RunMeta>>;
};

const launch = async ({ meta, prompt, onSuccess }: Launch): Promise<string> => {
  if (active) throw new BusyError("Another run is already in progress.");
  // Reserve the slot synchronously, before any await, so two requests cannot both pass the check.
  const run: ActiveRun = { id: meta.id, child: null, events: [], listeners: new Set(), cancelled: false, timedOut: false };
  active = run;

  let writeQueue: Promise<void> = Promise.resolve();
  const emit = (event: StoredEvent): void => {
    run.events.push(event);
    for (const listener of run.listeners) listener(event);
    writeQueue = writeQueue.then(() => appendEvent(meta.id, event)).catch(() => undefined);
  };

  try {
    await initRun(meta);
  } catch (error) {
    active = null;
    throw error;
  }

  // The raw output of the claude process, kept per run so a failure can be investigated afterwards.
  // Secrets are removed before anything is written, and the file stops growing at MAX_LOG_BYTES.
  let logQueue: Promise<void> = Promise.resolve();
  let logBytes = 0;
  let logFull = false;
  const writeLog = (text: string): void => {
    if (logFull) return;
    const safe = redactSecrets(text);
    logBytes += Buffer.byteLength(safe);
    const toWrite = logBytes > MAX_LOG_BYTES ? `[ui] log stopped: it reached ${MAX_LOG_BYTES} bytes\n` : safe;
    if (logBytes > MAX_LOG_BYTES) logFull = true;
    logQueue = logQueue.then(() => appendLog(meta.id, toWrite)).catch(() => undefined);
  };
  writeLog(`[ui] ${new Date().toISOString()} ${meta.kind} run ${meta.id} started: claude -p ${prompt}\n`);

  const startedAtMs = Date.now();
  const mapper = createEventMapper();
  let lastResult: Extract<RunEvent, { kind: "result" }> | null = null;
  let stderrTail = "";
  let buffer = "";
  let finishedOnce = false;

  const handleLine = (line: string): void => {
    if (line.trim() !== "") writeLog(`${line}\n`);
    for (const event of mapper.map(line)) {
      if (event.kind === "result") lastResult = event;
      emit(event);
    }
  };

  const finalize = async (exitCode: number | null): Promise<void> => {
    if (finishedOnce) return;
    finishedOnce = true;
    clearTimeout(timer);
    if (buffer.trim() !== "") handleLine(buffer);

    const result = lastResult as Extract<RunEvent, { kind: "result" }> | null;
    const resultText = redactSecrets(result?.text ?? "");
    const succeeded = exitCode === 0 && result !== null && !result.isError && !run.cancelled && !run.timedOut;
    for (const event of mapper.finish(succeeded ? "done" : "failed")) emit(event);

    let patch: Partial<RunMeta> = {};
    if (run.cancelled) {
      patch = { status: "cancelled", errorMessage: "Cancelled." };
    } else if (run.timedOut) {
      patch = { status: "failed", errorMessage: `Timed out after ${Math.round(config.runTimeoutMs / 1000)} seconds.` };
    } else if (!succeeded) {
      patch = {
        status: "failed",
        errorMessage: redactSecrets(resultText || stderrTail || `claude exited with code ${exitCode}`).slice(0, 2000),
      };
    } else {
      try {
        patch = await onSuccess({ exitCode, resultText, resultIsError: false, stderrTail, startedAtMs });
      } catch (error) {
        patch = { status: "failed", errorMessage: error instanceof Error ? error.message : String(error) };
      }
    }

    // A plain-language cause, matched on everything we know: Claude's own explanation often says why
    // (for example that the ado server timed out) even when the run only "fails" for lack of a CSV.
    if (patch.status === "failed") {
      const hint = explainFailure(resultText, patch.errorMessage, stderrTail);
      if (hint) patch.errorHint = hint;
    }
    // The run's own status, not the process exit: claude can exit cleanly and the run still fail (no CSV).
    const outcome = run.cancelled ? "cancelled" : run.timedOut ? "timed out" : patch.status === "failed" ? "failed" : "finished";
    writeLog(`[ui] ${new Date().toISOString()} ${outcome}, exit code ${exitCode ?? "none"}${patch.errorMessage ? `: ${patch.errorMessage}` : ""}\n`);

    // Release the lock BEFORE the final status becomes visible: whoever sees "done" must be able to start the
    // next run (or a push) straight away. All file work for this run is finished by now.
    await writeQueue; // flush events first, so a replay of this run sees all of them
    await logQueue;
    active = null;

    const finalMeta = await updateMeta(meta.id, {
      resultText,
      durationMs: result?.durationMs ?? null,
      costUsd: result?.costUsd ?? null,
      finishedAt: new Date().toISOString(),
      ...patch,
    });
    emit({ kind: "done", status: finalMeta.status });
    await writeQueue;
  };

  const timer = setTimeout(() => {
    run.timedOut = true;
    killTree(run.child);
  }, config.runTimeoutMs);

  const child = spawn(config.claudeBin, [...config.claudeArgsPrefix, "-p", prompt, "--output-format", "stream-json", "--verbose"], {
    cwd: config.repoRoot,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  run.child = child;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
    const lines = chunk.split("\n").filter((line) => line.trim() !== "");
    if (lines.length > 0) writeLog(`${lines.map((line) => `[stderr] ${line}`).join("\n")}\n`);
  });
  child.on("error", (error) => {
    stderrTail = `Could not start "${config.claudeBin}": ${error.message}`;
    writeLog(`[ui] ${stderrTail}\n`);
    void finalize(null);
  });
  child.on("close", (code) => void finalize(code));

  emit({ kind: "state", status: "running" });
  return meta.id;
};

export const startGenerate = async (
  pbis: number[],
  contextRequests: ContextRequest[],
  fetchContextPage: FetchPage = fetchPage,
): Promise<string> => {
  if (active) throw new BusyError("Another run is already in progress."); // before any download
  const id = createRunId();
  const startedAt = new Date().toISOString();
  let prepared: Awaited<ReturnType<typeof prepareContext>>;
  try {
    prepared = await prepareContext(id, contextRequests, fetchContextPage);
  } catch (error) {
    await rm(runDir(id), { recursive: true, force: true }); // do not leave half-written context behind
    throw error;
  }
  return launch({
    meta: { id, kind: "generate", status: "running", startedAt, pbis, context: prepared.used },
    prompt: buildGeneratePrompt(pbis, contextRequests.map((request) => request.kind), prepared.files),
    onSuccess: async ({ resultText, startedAtMs }) => {
      const produced = await locateGeneratedCsv(resultText, startedAtMs);
      if (!produced) throw new Error("The run finished but no CSV file was found in output/.");
      await saveCsvCopy(id, produced);
      const testCases = parseTestCases(await readFile(csvPath(id), "utf8"));
      return { status: "done", hasCsv: true, testCaseCount: testCases.length };
    },
  });
};

export const startPush = async (
  parentRunId: string,
  expectedCount: number,
): Promise<{ runId: string; source: CsvSource; count: number }> => {
  const parent = await readMeta(parentRunId);
  if (!parent) throw new NotFoundError("Unknown run.");
  if (parent.kind !== "generate" || parent.status !== "done" || !parent.hasCsv) {
    throw new NotReadyError("Only a finished generate run with a CSV can be pushed.");
  }
  const chosen = await effectiveCsv(parentRunId);
  if (!chosen) throw new NotReadyError("The CSV for this run is missing.");
  const actual = parseTestCases(chosen.text).length;
  if (actual !== expectedCount) {
    throw new NotReadyError(`The ${chosen.source} CSV contains ${actual} test cases, but the request expected ${expectedCount}.`);
  }
  const id = createRunId();
  const relativeRunsDir = path.relative(config.repoRoot, config.dataDir).split(path.sep).join("/");
  await launch({
    meta: { id, kind: "push", status: "running", startedAt: new Date().toISOString(), parentRunId, pushSource: chosen.source, pushCount: actual },
    prompt: buildPushPrompt(parentRunId, relativeRunsDir, chosen.fileName),
    onSuccess: async ({ resultText }) => ({ status: "done", push: parsePushSummary(resultText) }),
  });
  return { runId: id, source: chosen.source, count: actual };
};
