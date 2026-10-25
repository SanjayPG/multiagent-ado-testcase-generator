import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FetchPage } from "../src/fetchPage.js";

const sandbox = mkdtempSync(path.join(os.tmpdir(), "tc-ui-paste-"));
const RUN_ID = "run-20261018-abc999";
const neverFetch: FetchPage = async () => {
  throw new Error("a pasted document must not download anything");
};

type ContextModule = typeof import("../src/context.js");
let context: ContextModule;

beforeAll(async () => {
  process.env.UI_REPO_ROOT = sandbox;
  process.env.UI_DATA_DIR = path.join(sandbox, "runs");
  mkdirSync(path.join(sandbox, "context"), { recursive: true });
  writeFileSync(path.join(sandbox, "context", "hld.md"), "# Repo HLD");
  context = await import("../src/context.js");
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("pasted text as context", () => {
  it("is accepted as a source", () => {
    expect(context.parseContextRequests([{ kind: "hld", source: "paste", text: "Lock after 5 attempts." }])).toEqual([
      { kind: "hld", source: "paste", text: "Lock after 5 attempts." },
    ]);
  });

  it.each([
    ["nothing", "", /paste some text/],
    ["only spaces and line breaks", "   \n\t  ", /paste some text/],
    ["more than 200 KB", "word ".repeat(50_000), /over the 200 KB limit/],
    ["binary data", "abc\u0000def", /binary/],
  ])("refuses %s", (_name, text, message) => {
    expect(() => context.parseContextRequests([{ kind: "hld", source: "paste", text }])).toThrow(message);
  });

  it("refuses a missing or non-text value", () => {
    expect(() => context.parseContextRequests([{ kind: "hld", source: "paste" }])).toThrow(/paste some text/);
    expect(() => context.parseContextRequests([{ kind: "hld", source: "paste", text: 42 }])).toThrow(/paste some text/);
  });

  it("is written into the run's own folder, labelled as pasted, without touching the repo file", async () => {
    const requests = context.parseContextRequests([{ kind: "hld", source: "paste", text: "  Sessions expire after 30 minutes.  \n" }]);
    const { used, files } = await context.prepareContext(RUN_ID, requests, neverFetch);

    expect(used).toEqual([expect.objectContaining({ kind: "hld", source: "paste", label: "pasted text" })]);
    const written = readFileSync(path.join(sandbox, files.hld ?? "missing"), "utf8");
    expect(written).toBe("Source: pasted text\n\nSessions expire after 30 minutes.\n");
    expect(files.hld).toBe(`runs/${RUN_ID}/context-hld.md`);
    expect(readFileSync(path.join(sandbox, "context", "hld.md"), "utf8")).toBe("# Repo HLD");
  });

  it("can be mixed with the repo's own file for the other kind", () => {
    const parsed = context.parseContextRequests([
      { kind: "regression", source: "repo" },
      { kind: "hld", source: "paste", text: "Design notes." },
    ]);
    expect(parsed.map((request) => `${request.kind}:${request.source}`)).toEqual(["hld:paste", "regression:repo"]);
  });
});
