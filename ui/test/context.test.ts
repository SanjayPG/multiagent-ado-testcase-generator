import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FetchError, type FetchPage } from "../src/fetchPage.js";

const sandbox = mkdtempSync(path.join(os.tmpdir(), "tc-ui-context-"));
const RUN_ID = "run-20261018-abc123";

type ContextModule = typeof import("../src/context.js");
let context: ContextModule;

const stubPage: FetchPage = async (url) => ({ text: "Lock after 5 attempts.", finalUrl: `${url}/final`, contentType: "text/html", bytes: 22 });

beforeAll(async () => {
  process.env.UI_REPO_ROOT = sandbox;
  process.env.UI_DATA_DIR = path.join(sandbox, "runs");
  mkdirSync(path.join(sandbox, "context"), { recursive: true });
  writeFileSync(path.join(sandbox, "context", "hld.md"), "# Repo HLD\n\nSession lasts 30 minutes.\n");
  context = await import("../src/context.js");
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("parseContextRequests", () => {
  it("defaults to no context", () => {
    expect(context.parseContextRequests(undefined)).toEqual([]);
  });

  it("treats a bare flag as the repo's default file, as the terminal flow always did", () => {
    expect(context.parseContextRequests(["hld"])).toEqual([{ kind: "hld", source: "repo" }]);
  });

  it("keeps a stable order whatever order they were sent in", () => {
    const parsed = context.parseContextRequests([
      { kind: "regression", source: "repo" },
      { kind: "hld", source: "url", url: "https://example.com/hld" },
    ]);
    expect(parsed.map((request) => request.kind)).toEqual(["hld", "regression"]);
  });

  it.each([
    ["an unknown flag", ["hld", "../../etc/passwd"], /Unknown context flag/],
    ["an unknown kind", [{ kind: "secrets", source: "repo" }], /Unknown context kind/],
    ["the same kind twice", ["hld", { kind: "hld", source: "repo" }], /given twice/],
    ["no source", [{ kind: "hld" }], /choose a source/],
    ["a file with no name", [{ kind: "hld", source: "upload", name: " ", text: "x" }], /needs a name/],
    ["a Word document", [{ kind: "hld", source: "upload", name: "hld.docx", text: "x" }], /Word or PDF documents as text or Markdown/],
    ["a PDF", [{ kind: "hld", source: "upload", name: "hld.pdf", text: "x" }], /not supported/],
    ["a binary file", [{ kind: "hld", source: "upload", name: "hld.txt", text: "ab\u0000cd" }], /binary file/],
    ["an empty URL", [{ kind: "hld", source: "url", url: "  " }], /enter a URL/],
    ["something that is not a list", "hld", /must be a list/],
  ])("rejects %s", (_name, input, message) => {
    expect(() => context.parseContextRequests(input)).toThrow(message);
  });
});

describe("prepareContext", () => {
  it("uses the repo's default file as is, without copying it", async () => {
    const { used, files } = await context.prepareContext(RUN_ID, [{ kind: "hld", source: "repo" }], stubPage);
    expect(used).toEqual([expect.objectContaining({ kind: "hld", source: "repo", label: "context/hld.md" })]);
    expect(files).toEqual({});
  });

  it("explains what to do when the repo's default file is missing", async () => {
    await expect(context.prepareContext(RUN_ID, [{ kind: "regression", source: "repo" }], stubPage)).rejects.toThrow(
      /context\/regression-scripts\.md was not found.*Upload a document or give a URL/,
    );
  });

  it("writes an uploaded document into the run's own folder, leaving the repo file alone", async () => {
    const { used, files } = await context.prepareContext(
      RUN_ID,
      [{ kind: "hld", source: "upload", name: "my-hld.md", text: "# New HLD\n\nLock after 5 attempts." }],
      stubPage,
    );
    expect(files.hld).toBe(`runs/${RUN_ID}/context-hld.md`);
    expect(used[0]).toMatchObject({ source: "upload", label: "my-hld.md" });
    const written = readFileSync(path.join(sandbox, files.hld as string), "utf8");
    expect(written).toBe('Source: my-hld.md\n\n# New HLD\n\nLock after 5 attempts.\n');
    expect(readFileSync(path.join(sandbox, "context", "hld.md"), "utf8")).toContain("# Repo HLD");
  });

  it("converts an uploaded HTML page to plain text", async () => {
    const { files } = await context.prepareContext(
      RUN_ID,
      [{ kind: "hld", source: "upload", name: "page.html", text: "<h1>Login</h1><script>steal()</script><p>Locks after 5.</p>" }],
      stubPage,
    );
    const written = readFileSync(path.join(sandbox, files.hld as string), "utf8");
    expect(written).toContain("# Login");
    expect(written).toContain("Locks after 5.");
    expect(written).not.toContain("steal");
  });

  it("downloads a URL and records where it ended up", async () => {
    const { used, files } = await context.prepareContext(RUN_ID, [{ kind: "hld", source: "url", url: "https://example.com/hld" }], stubPage);
    expect(used[0]).toMatchObject({ source: "url", label: "https://example.com/hld/final" });
    expect(readFileSync(path.join(sandbox, files.hld as string), "utf8")).toContain("Source: https://example.com/hld/final");
  });

  it("turns a failed download into a message that names the document", async () => {
    const failing: FetchPage = async () => {
      throw new FetchError("The page needs a login, which is not supported.");
    };
    await expect(context.prepareContext(RUN_ID, [{ kind: "hld", source: "url", url: "https://example.com/x" }], failing)).rejects.toThrow(
      /^HLD: The page needs a login/,
    );
  });

  it("rejects a document that is too large for the coordinator to read", async () => {
    const big = "word ".repeat(50_000); // about 250 KB
    await expect(
      context.prepareContext(RUN_ID, [{ kind: "hld", source: "upload", name: "big.txt", text: big }], stubPage),
    ).rejects.toThrow(/limit is 200 KB/);
  });

  it("rejects a document with nothing in it", async () => {
    await expect(
      context.prepareContext(RUN_ID, [{ kind: "hld", source: "upload", name: "empty.html", text: "<div></div>" }], stubPage),
    ).rejects.toThrow(/no readable text/);
  });
});

describe("repoContextStatus", () => {
  it("reports what the terminal flow would read today", async () => {
    const [hld, regression] = await context.repoContextStatus();
    expect(hld).toMatchObject({ kind: "hld", path: "context/hld.md", exists: true });
    expect(hld.preview).toContain("# Repo HLD");
    expect(hld.bytes).toBeGreaterThan(0);
    expect(regression).toMatchObject({ kind: "regression", exists: false, preview: "" });
  });
});
