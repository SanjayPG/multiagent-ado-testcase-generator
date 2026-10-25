import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchPage } from "../src/fetchPage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3299;
const HOST = { host: `127.0.0.1:${PORT}` };
const PAT = "dummy-pat-value-that-must-never-be-returned";

const sandbox = mkdtempSync(path.join(os.tmpdir(), "tc-ui-test-"));
const logFile = path.join(sandbox, "prompts.log");

let app: FastifyInstance;
let realFetchPage: FetchPage;
let fetchStub: FetchPage; // tests replace this to control what a "downloaded" page contains

const waitForStatus = async (runId: string, wanted: string[], timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: HOST });
    const body = response.json();
    if (wanted.includes(body.meta.status)) return body;
    if (Date.now() > deadline) throw new Error(`Run ${runId} stayed ${body.meta.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, headers: { ...HOST, ...headers }, payload: payload as object });

const generate = async (pbis: number[] = [2, 3]) => {
  const response = await post("/api/runs", { pbis });
  expect(response.statusCode).toBe(202);
  return response.json().runId as string;
};

beforeAll(async () => {
  process.env.UI_PORT = String(PORT);
  process.env.UI_REPO_ROOT = sandbox;
  process.env.UI_DATA_DIR = path.join(sandbox, "runs");
  process.env.CLAUDE_BIN = process.execPath;
  process.env.CLAUDE_BIN_ARGS = JSON.stringify([path.join(here, "fake-claude.mjs")]);
  process.env.FAKE_CLAUDE_LOG = logFile;
  process.env.ADO_PROJECT = "TestProject";
  process.env.ADO_ORG = "test-org";
  process.env.ADO_PAT_B64 = PAT;
  mkdirSync(path.join(sandbox, "context"), { recursive: true });
  writeFileSync(path.join(sandbox, "context", "hld.md"), "# Repo HLD");
  writeFileSync(path.join(sandbox, "context", "regression-scripts.md"), "login_smoke - checks the happy path");
  const { buildApp } = await import("../src/app.js");
  ({ fetchPage: realFetchPage } = await import("../src/fetchPage.js"));
  fetchStub = realFetchPage;
  app = await buildApp({ fetchPage: (url) => fetchStub(url) });
});

beforeEach(() => {
  fetchStub = realFetchPage;
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

describe("request guards", () => {
  it("refuses a request with an unexpected Host header", async () => {
    const response = await app.inject({ method: "GET", url: "/api/config", headers: { host: "evil.example" } });
    expect(response.statusCode).toBe(403);
  });

  it("refuses a cross-origin POST", async () => {
    const response = await post("/api/runs", { pbis: [2] }, { origin: "https://evil.example" });
    expect(response.statusCode).toBe(403);
  });

  it("sends a strict content security policy", async () => {
    const response = await app.inject({ method: "GET", url: "/api/config", headers: HOST });
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("reports which variables are set but never their values", async () => {
    const response = await app.inject({ method: "GET", url: "/api/config", headers: HOST });
    expect(response.json().envOk).toEqual({ pat: true, org: true, project: true });
    expect(response.body).not.toContain(PAT);
  });
});

describe("input validation", () => {
  it.each([[["1;rm -rf /"]], [[-3]], [[]], ["2,3"]])("rejects pbis %j", async (pbis) => {
    const response = await post("/api/runs", { pbis });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an unknown context flag", async () => {
    const response = await post("/api/runs", { pbis: [2], context: ["../../secrets"] });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a path-like run id", async () => {
    const response = await app.inject({ method: "GET", url: "/api/runs/..%2F..%2Fx", headers: HOST });
    expect(response.statusCode).toBe(400);
  });
});

describe("generate flow", () => {
  it("runs the pipeline, stores the CSV, and parses the test cases", async () => {
    const runId = await generate();
    const { meta, testCases } = await waitForStatus(runId, ["done", "failed"]);
    expect(meta.status).toBe("done");
    expect(meta.testCaseCount).toBe(testCases.length);
    expect(testCases.length).toBeGreaterThan(20);
    expect(testCases.some((tc: { title: string }) => tc.title.includes("EDGE-99"))).toBe(true);
    expect(readFileSync(logFile, "utf8")).toContain("/generate-test-cases --pbis 2,3\n");
  });

  it("serves the CSV with its UTF-8 BOM", async () => {
    const runId = await generate();
    await waitForStatus(runId, ["done"]);
    const response = await app.inject({ method: "GET", url: `/api/runs/${runId}/csv`, headers: HOST });
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(response.body).toContain("ID,Work Item Type,Title");
  });

  it("replays stored progress events for a finished run", async () => {
    const runId = await generate();
    await waitForStatus(runId, ["done"]);
    const response = await app.inject({ method: "GET", url: `/api/runs/${runId}/events`, headers: HOST });
    expect(response.body).toContain("Generating test cases for PBI 2");
    expect(response.body).toContain('"kind":"done"');
  });

  it("reports a failed run with the error text", async () => {
    process.env.FAKE_CLAUDE_MODE = "fail";
    const runId = await generate();
    const { meta } = await waitForStatus(runId, ["failed"]);
    expect(meta.errorMessage).toContain("simulated failure");
  });

  it("allows only one run at a time", async () => {
    process.env.FAKE_CLAUDE_DELAY_MS = "40";
    const runId = await generate();
    const second = await post("/api/runs", { pbis: [2] });
    expect(second.statusCode).toBe(409);
    await waitForStatus(runId, ["done"], 30000);
  }, 30000);

  it("has released the lock by the moment a run's stored status says done", async () => {
    const { readMeta } = await import("../src/store.js");
    const { getActiveRunId } = await import("../src/runner.js");
    process.env.FAKE_CLAUDE_DELAY_MS = "2";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const runId = await generate();
      // Poll as fast as possible, so a window of a few milliseconds between "done" and "free" would be seen.
      for (;;) {
        const meta = await readMeta(runId);
        if (meta && meta.status !== "running") {
          expect(meta.status).toBe("done");
          expect(getActiveRunId()).toBeNull();
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }, 30000);

  it("cancels a run that is stuck", async () => {
    process.env.FAKE_CLAUDE_MODE = "hang";
    const runId = await generate();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const cancel = await post(`/api/runs/${runId}/cancel`, {});
    expect(cancel.json().cancelled).toBe(true);
    const { meta } = await waitForStatus(runId, ["cancelled", "failed"]);
    expect(meta.status).toBe("cancelled");
  }, 20000);
});

describe("push gates", () => {
  const goodBody = (count: number) => ({ confirm: true, expectedCount: count, project: "TestProject" });

  it("refuses without confirmation, with the wrong project, or with a wrong count", async () => {
    const runId = await generate();
    const { meta } = await waitForStatus(runId, ["done"]);

    expect((await post(`/api/runs/${runId}/push`, { ...goodBody(meta.testCaseCount), confirm: false })).statusCode).toBe(400);
    expect((await post(`/api/runs/${runId}/push`, { ...goodBody(meta.testCaseCount), project: "Other" })).statusCode).toBe(400);
    expect((await post(`/api/runs/${runId}/push`, goodBody(meta.testCaseCount + 1))).statusCode).toBe(422);
  });

  it("refuses to push a run that has no CSV", async () => {
    process.env.FAKE_CLAUDE_MODE = "fail";
    const runId = await generate();
    await waitForStatus(runId, ["failed"]);
    expect((await post(`/api/runs/${runId}/push`, goodBody(1))).statusCode).toBe(422);
  });

  it("pushes once every gate passes, using the stored CSV and the --yes flag", async () => {
    const runId = await generate();
    const { meta } = await waitForStatus(runId, ["done"]);
    const response = await post(`/api/runs/${runId}/push`, goodBody(meta.testCaseCount));
    expect(response.statusCode).toBe(202);
    const pushed = await waitForStatus(response.json().runId, ["done", "failed"]);
    expect(pushed.meta.status).toBe("done");
    expect(pushed.meta.push).toEqual({ created: 24, linked: 24, failed: "none" });
    expect(readFileSync(logFile, "utf8")).toContain(`/push-test-cases --file runs/${runId}/tc.csv --yes`);
  });
});

describe("edited CSV upload", () => {
  const CRLF = String.fromCharCode(13, 10);

  const uploadTo = (runId: string, body: Buffer | string, name = "edited.csv") =>
    app.inject({
      method: "POST",
      url: `/api/runs/${runId}/upload`,
      headers: { ...HOST, "content-type": "text/csv", "x-filename": encodeURIComponent(name) },
      payload: body,
    });

  const finishedRun = async () => {
    const runId = await generate();
    const { meta } = await waitForStatus(runId, ["done"]);
    const originalCsv = readFileSync(path.join(sandbox, "runs", runId, "tc.csv"), "utf8");
    return { runId, originalCount: meta.testCaseCount as number, originalCsv };
  };

  // One hand-written test case appended to the file, using the file's own line ending.
  const withExtraCase = (csv: string): string => {
    const eol = csv.includes(CRLF) ? CRLF : String.fromCharCode(10);
    const row = ",Test Case,[TC-2-POS-99] Added by hand,Design,,2,positive,,Not Automated,None,N/A,Positive,1,Do a thing,TEST PASS — done";
    return (csv.endsWith(eol) ? csv : csv + eol) + row + eol;
  };

  const push = (runId: string, count: number) =>
    post(`/api/runs/${runId}/push`, { confirm: true, expectedCount: count, project: "TestProject" });

  it("accepts an edited file and summarises what changed, without touching the original", async () => {
    const { runId, originalCount, originalCsv } = await finishedRun();
    const edited = originalCsv.replace("Navigate to https://app.example.com/login", "Open https://app.example.com/login");

    const response = await uploadTo(runId, edited, "my edits.csv");
    expect(response.statusCode).toBe(200);
    const { meta } = response.json();
    expect(meta.upload.name).toBe("my edits.csv");
    expect(meta.upload.testCaseCount).toBe(originalCount);
    expect(meta.upload.changes).toMatchObject({ added: [], removed: [], newPbiIds: [] });
    expect(meta.upload.changes.changed).toHaveLength(1);

    const run = (await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: HOST })).json();
    expect(run.source).toBe("uploaded");
    expect(readFileSync(path.join(sandbox, "runs", runId, "tc.csv"), "utf8")).toBe(originalCsv);
  });

  it("pushes the uploaded file, and checks the count against it", async () => {
    const { runId, originalCount, originalCsv } = await finishedRun();
    const upload = await uploadTo(runId, withExtraCase(originalCsv));
    expect(upload.json().meta.upload.changes.added).toEqual(["[TC-2-POS-99] Added by hand"]);

    expect((await push(runId, originalCount)).statusCode).toBe(422); // the original's count no longer matches
    const accepted = await push(runId, originalCount + 1);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ source: "uploaded", count: originalCount + 1 });

    const pushed = await waitForStatus(accepted.json().runId, ["done"]);
    expect(pushed.meta.pushSource).toBe("uploaded");
    expect(readFileSync(logFile, "utf8")).toContain(`/push-test-cases --file runs/${runId}/upload.csv --yes`);
  });

  it("goes back to the original when the upload is removed", async () => {
    const { runId, originalCount, originalCsv } = await finishedRun();
    await uploadTo(runId, withExtraCase(originalCsv));

    const removed = await app.inject({ method: "DELETE", url: `/api/runs/${runId}/upload`, headers: HOST });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().meta.upload).toBeUndefined();

    const accepted = await push(runId, originalCount);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().source).toBe("original");
    await waitForStatus(accepted.json().runId, ["done"]);
    expect(readFileSync(logFile, "utf8")).toContain(`/push-test-cases --file runs/${runId}/tc.csv --yes`);
  });

  it("rejects an unreadable file with a message that says how to fix it, and keeps the original", async () => {
    const { runId, originalCsv } = await finishedRun();
    const ansi = Buffer.from(originalCsv.replaceAll("•", String.fromCharCode(0x95)), "latin1");

    const response = await uploadTo(runId, ansi);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("CSV UTF-8");
    const run = (await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: HOST })).json();
    expect(run.source).toBe("original");
  });

  it("refuses a JSON body, an oversized body and an unknown run", async () => {
    const { runId } = await finishedRun();
    expect((await post(`/api/runs/${runId}/upload`, { not: "a file" })).statusCode).toBe(400);
    expect((await uploadTo(runId, Buffer.alloc(5 * 1024 * 1024 + 10, 65))).statusCode).toBe(413);
    expect((await uploadTo("run-20260101-abcdef", "x")).statusCode).toBe(404);
  });

  it("will not change the upload while a run is in progress", async () => {
    const { runId, originalCsv } = await finishedRun();
    process.env.FAKE_CLAUDE_DELAY_MS = "40";
    const busyRunId = await generate();
    expect((await uploadTo(runId, originalCsv)).statusCode).toBe(409);
    await waitForStatus(busyRunId, ["done"], 30000);
  }, 40000);
});

describe("context sources", () => {
  const runsDir = () => path.join(sandbox, "runs");
  const startWith = (context: unknown) => post("/api/runs", { pbis: [2], context });
  const finish = async (response: { statusCode: number; json: () => { runId: string } }) => {
    expect(response.statusCode).toBe(202);
    return waitForStatus(response.json().runId, ["done"]);
  };

  it("lists the default files the terminal flow would read", async () => {
    const response = await app.inject({ method: "GET", url: "/api/context", headers: HOST });
    const [hld, regression] = response.json().files;
    expect(hld).toMatchObject({ kind: "hld", path: "context/hld.md", exists: true });
    expect(hld.preview).toContain("# Repo HLD");
    expect(regression).toMatchObject({ kind: "regression", exists: true });
  });

  it("still accepts the plain flags and passes no file path for them", async () => {
    const { meta } = await finish(await startWith(["hld"]));
    expect(meta.context).toEqual([expect.objectContaining({ kind: "hld", source: "repo", label: "context/hld.md" })]);
    expect(readFileSync(logFile, "utf8")).toContain("/generate-test-cases --pbis 2 --context hld\n");
  });

  it("runs with an uploaded document in the run's own folder, and leaves the repo file alone", async () => {
    const response = await startWith([{ kind: "hld", source: "upload", name: "my-hld.md", text: "# Uploaded HLD. Lock after 5 attempts." }]);
    const { meta } = await finish(response);

    expect(meta.context).toEqual([expect.objectContaining({ kind: "hld", source: "upload", label: "my-hld.md" })]);
    const written = readFileSync(path.join(runsDir(), meta.id, "context-hld.md"), "utf8");
    expect(written).toContain("Source: my-hld.md");
    expect(written).toContain("Lock after 5 attempts.");
    expect(readFileSync(path.join(sandbox, "context", "hld.md"), "utf8")).toBe("# Repo HLD");
    expect(readFileSync(logFile, "utf8")).toContain(`--context hld --hld-file runs/${meta.id}/context-hld.md`);
  });

  it("mixes sources: an uploaded HLD and the repo's regression list", async () => {
    const response = await startWith([
      { kind: "regression", source: "repo" },
      { kind: "hld", source: "upload", name: "hld.txt", text: "Sessions expire after 30 minutes." },
    ]);
    const { meta } = await finish(response);
    expect(meta.context.map((used: { kind: string }) => used.kind)).toEqual(["hld", "regression"]);
    const prompt = readFileSync(logFile, "utf8");
    expect(prompt).toContain(`--context hld,regression --hld-file runs/${meta.id}/context-hld.md`);
    expect(prompt).not.toContain(`--regression-file runs/${meta.id}`);
  });

  it("downloads a URL and records the final address", async () => {
    fetchStub = async (url) => ({ text: "HLD from the web", finalUrl: `${url}/final`, contentType: "text/html", bytes: 16 });
    const { meta } = await finish(await startWith([{ kind: "hld", source: "url", url: "https://example.com/hld" }]));
    expect(meta.context[0]).toMatchObject({ source: "url", label: "https://example.com/hld/final" });
    expect(readFileSync(path.join(runsDir(), meta.id, "context-hld.md"), "utf8")).toContain("Source: https://example.com/hld/final");
  });

  it("refuses a URL that points at this machine, using the real safety checks", async () => {
    const response = await startWith([{ kind: "hld", source: "url", url: "http://127.0.0.1:3299/api/config" }]);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/^HLD: .*(standard web ports|private or internal)/);
  });

  it("explains a download that failed, and leaves no run behind", async () => {
    const { FetchError } = await import("../src/fetchPage.js");
    fetchStub = async () => {
      throw new FetchError("The page needs a login, which is not supported.");
    };
    const before = readdirSync(runsDir()).length;
    const response = await startWith([{ kind: "hld", source: "url", url: "https://example.com/private" }]);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/^HLD: The page needs a login/);
    expect(readdirSync(runsDir()).length).toBe(before);
  });

  it("does not leave a half-written context file when the second document is the bad one", async () => {
    const before = readdirSync(runsDir()).length;
    const response = await startWith([
      { kind: "hld", source: "upload", name: "ok.md", text: "fine" },
      { kind: "regression", source: "upload", name: "bad.docx", text: "x" },
    ]);
    expect(response.statusCode).toBe(400);
    expect(readdirSync(runsDir()).length).toBe(before);
  });

  it("says so when the repo's default file is missing", async () => {
    const file = path.join(sandbox, "context", "regression-scripts.md");
    const content = readFileSync(file, "utf8");
    rmSync(file);
    try {
      const response = await startWith([{ kind: "regression", source: "repo" }]);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("Upload a document or give a URL instead");
    } finally {
      writeFileSync(file, content);
    }
  });

  it.each([
    ["a Word document", [{ kind: "hld", source: "upload", name: "hld.docx", text: "x" }], /Word or PDF/],
    ["a file over the size limit", [{ kind: "hld", source: "upload", name: "big.txt", text: "word ".repeat(50_000) }], /limit is 200 KB/],
    ["the same kind twice", [{ kind: "hld", source: "repo" }, { kind: "hld", source: "repo" }], /given twice/],
  ])("rejects %s with a readable message", async (_name, context, message) => {
    const response = await startWith(context);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(message);
  });

  it("converts an uploaded HTML page to text before the coordinator reads it", async () => {
    const html = "<h1>Login design</h1><script>stealTheToken()</script><p>Locks after 5 attempts.</p>";
    const { meta } = await finish(await startWith([{ kind: "hld", source: "upload", name: "hld.html", text: html }]));
    const written = readFileSync(path.join(runsDir(), meta.id, "context-hld.md"), "utf8");
    expect(written).toContain("# Login design");
    expect(written).not.toContain("stealTheToken");
    expect(existsSync(path.join(runsDir(), meta.id, "context-hld.md"))).toBe(true);
  });
});
