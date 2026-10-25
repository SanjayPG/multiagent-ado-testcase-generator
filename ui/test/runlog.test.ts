import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3298;
const HOST = { host: `127.0.0.1:${PORT}` };
const PAT = "dummy-pat-value-that-must-never-be-returned";

const sandbox = mkdtempSync(path.join(os.tmpdir(), "tc-ui-runlog-"));
const runsDir = path.join(sandbox, "runs");

let app: FastifyInstance;

const get = (url: string) => app.inject({ method: "GET", url, headers: HOST });

const waitForStatus = async (runId: string, wanted: string[], timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await get(`/api/runs/${runId}`)).json();
    if (wanted.includes(body.meta.status)) return body;
    if (Date.now() > deadline) throw new Error(`Run ${runId} stayed ${body.meta.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const startRun = async (pbis: number[]) => {
  const response = await app.inject({ method: "POST", url: "/api/runs", headers: HOST, payload: { pbis } });
  expect(response.statusCode).toBe(202);
  return response.json().runId as string;
};

beforeAll(async () => {
  process.env.UI_PORT = String(PORT);
  process.env.UI_REPO_ROOT = sandbox;
  process.env.UI_DATA_DIR = runsDir;
  process.env.CLAUDE_BIN = process.execPath;
  process.env.CLAUDE_BIN_ARGS = JSON.stringify([path.join(here, "fake-claude.mjs")]);
  process.env.ADO_PROJECT = "TestProject";
  process.env.ADO_ORG = "test-org";
  process.env.ADO_PAT_B64 = PAT;
  mkdirSync(path.join(sandbox, "context"), { recursive: true });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
});

beforeEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  process.env.FAKE_CLAUDE_DELAY_MS = "5";
});

afterAll(async () => {
  const { shutdown } = await import("../src/runner.js");
  shutdown();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await app.close();
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("the saved log", () => {
  it("keeps what the claude process printed, starting with the command and ending with the outcome", async () => {
    const runId = await startRun([2, 3]);
    await waitForStatus(runId, ["done"]);
    const response = await get(`/api/runs/${runId}/log`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    const lines = response.body.trim().split("\n");
    expect(lines[0]).toContain(`generate run ${runId} started: claude -p /generate-test-cases --pbis 2,3`);
    expect(response.body).toContain('"type":"result"');
    expect(lines[lines.length - 1]).toContain("finished, exit code 0");
    expect(existsSync(path.join(runsDir, runId, "run.log"))).toBe(true);
  });

  it("returns only the last lines when asked", async () => {
    const runId = await startRun([2, 3]);
    await waitForStatus(runId, ["done"]);
    const response = await get(`/api/runs/${runId}/log?tail=3`);
    const lines = response.body.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("finished, exit code 0");
  });

  it("offers the file as a download", async () => {
    const runId = await startRun([2, 3]);
    await waitForStatus(runId, ["done"]);
    const response = await get(`/api/runs/${runId}/log?download=1`);
    expect(response.headers["content-disposition"]).toBe(`attachment; filename="${runId}.log"`);
  });

  it.each(["0", "abc", "-5", "1.5", "99999"])("rejects tail=%s", async (tail) => {
    const response = await get(`/api/runs/run-20260101-abcdef/log?tail=${tail}`);
    expect(response.statusCode).toBe(400);
  });

  it("says so when a run has no log, and refuses a path-like id", async () => {
    expect((await get("/api/runs/run-20260101-abcdef/log")).statusCode).toBe(404);
    expect((await get("/api/runs/..%2F..%2Fx/log")).statusCode).toBe(400);
  });

  it("never contains the token, even when the process prints it", async () => {
    process.env.FAKE_CLAUDE_MODE = "leak";
    const runId = await startRun([2]);
    const { meta } = await waitForStatus(runId, ["failed"]);
    const log = (await get(`/api/runs/${runId}/log`)).body;
    expect(log).toContain("***");
    expect(log).not.toContain(PAT);
    expect(JSON.stringify(meta)).not.toContain(PAT);
    expect(readFileSync(path.join(runsDir, runId, "run.log"), "utf8")).not.toContain(PAT);
  });
});

describe("the tail of a very long log", () => {
  it("starts at a whole line, never in the middle of one", async () => {
    const id = "run-20260101-cafe01";
    mkdirSync(path.join(runsDir, id), { recursive: true });
    const line = "x".repeat(120_000);
    writeFileSync(path.join(runsDir, id, "run.log"), `${line}\n${line}\n${line}\n`);
    const { readLog } = await import("../src/store.js");
    const tail = (await readLog(id, { tailLines: 10 })) ?? "";
    // Three lines are 360 000 characters, over the cap; the partial line at the cut is dropped.
    expect(tail.split("\n")).toEqual([line]);
  });
});

describe("the diagnostics file", () => {
  it("summarises the run and holds the full log, without secret values", async () => {
    const runId = await startRun([2, 3]);
    await waitForStatus(runId, ["done"]);
    const response = await get(`/api/runs/${runId}/diagnostics`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toBe(`attachment; filename="${runId}-diagnostics.txt"`);
    expect(response.body).toContain(`id: ${runId}`);
    expect(response.body).toContain("status: done");
    expect(response.body).toContain("ADO_PAT_B64: set");
    expect(response.body).toContain("ADO_PROJECT: TestProject");
    expect(response.body).toContain("[done] Generating test cases for PBI 2");
    expect(response.body).toContain("== Full log ==");
    expect(response.body).toContain('"type":"result"');
    expect(response.body).not.toContain(PAT);
  });

  it("404s for an unknown run and 400s for a bad id", async () => {
    expect((await get("/api/runs/run-20260101-abcdef/diagnostics")).statusCode).toBe(404);
    expect((await get("/api/runs/x/diagnostics")).statusCode).toBe(400);
    expect((await get("/api/runs/..%2F..%2Fx/diagnostics")).statusCode).toBe(400);
  });
});

describe("work items that are not PBIs", () => {
  it("finishes for the PBIs and reports the Bug it left out", async () => {
    const runId = await startRun([2, 97]);
    const body = await waitForStatus(runId, ["done"]);
    expect(body.meta.skipped).toEqual([{ id: 97, reason: "Bug is not a PBI" }]);
    expect(body.testCases.length).toBeGreaterThan(0);
  });

  it("reports nothing skipped for an ordinary run", async () => {
    const runId = await startRun([2, 3]);
    const body = await waitForStatus(runId, ["done"]);
    expect(body.meta.skipped).toBeUndefined();
  });

  it("fails with a plain explanation when every id was a Bug", async () => {
    rmSync(path.join(sandbox, "output"), { recursive: true, force: true });
    const runId = await startRun([98]);
    const { meta } = await waitForStatus(runId, ["failed"]);
    expect(meta.errorHint.title).toBe("That work item is not a PBI");
    expect(meta.errorHint.tone).toBe("warning");
    expect(meta.resultText).toContain("[SKIP] PBI-98: Bug is not a PBI");
    expect(meta.hasCsv).toBeUndefined();
  });
});

describe("a failure caused by the ado server", () => {
  it("explains the cause in plain words, keeps the raw reason, and records it in the log", async () => {
    // The app accepts a CSV written in the last two seconds, so clear the ones earlier tests left behind.
    rmSync(path.join(sandbox, "output"), { recursive: true, force: true });
    const runId = await startRun([99]);
    const { meta } = await waitForStatus(runId, ["failed"]);

    // Claude exited cleanly and explained itself, but no CSV exists: that is the real shape of this failure.
    expect(meta.errorMessage).toContain("no CSV file was found");
    expect(meta.resultText).toContain("CONNECT_TIMEOUT");
    expect(meta.errorHint.title).toBe("Couldn't connect to Azure DevOps");
    expect(meta.errorHint.tone).toBe("error");
    expect(meta.errorHint.steps.join(" ")).toContain("ADO_PAT_B64");

    const log = (await get(`/api/runs/${runId}/log`)).body;
    expect(log).toContain("[stderr] fake claude: MCP server ado: CONNECT_TIMEOUT");
    expect(log).toContain("failed, exit code 0");

    const diagnostics = (await get(`/api/runs/${runId}/diagnostics`)).body;
    expect(diagnostics).toContain("likely cause: Couldn't connect to Azure DevOps");
  });

  it("leaves the hint out when the failure is not one it recognises", async () => {
    process.env.FAKE_CLAUDE_MODE = "fail";
    const runId = await startRun([2]);
    const { meta } = await waitForStatus(runId, ["failed"]);
    expect(meta.errorHint).toBeUndefined();
    expect(meta.errorMessage).toContain("simulated failure");
  });
});
