import { mkdir, open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { FetchError, type FetchPage } from "./fetchPage.js";
import { htmlToText } from "./htmlText.js";
import { runDir } from "./store.js";
import { CONTEXT_FLAGS, ValidationError, type ContextFlag } from "./validate.js";

export const MAX_CONTEXT_BYTES = 200 * 1024; // what the coordinator will have to read and summarise
const MAX_RAW_UPLOAD_BYTES = 1024 * 1024; // an HTML page is larger than the text inside it
const UPLOAD_EXTENSIONS = [".md", ".markdown", ".txt", ".text", ".html", ".htm"];
const HTML_EXTENSIONS = [".html", ".htm"];

export const DEFAULT_CONTEXT_FILES: Record<ContextFlag, string> = {
  hld: "context/hld.md",
  regression: "context/regression-scripts.md",
};
export const CONTEXT_LABELS: Record<ContextFlag, string> = { hld: "HLD", regression: "Regression scripts" };

export type ContextSource = "repo" | "paste" | "upload" | "url";

export type ContextRequest =
  | { kind: ContextFlag; source: "repo" }
  | { kind: ContextFlag; source: "paste"; text: string }
  | { kind: ContextFlag; source: "upload"; name: string; text: string }
  | { kind: ContextFlag; source: "url"; url: string };

// What a run actually used, kept with the run so the review screen can show it.
export type ContextUsed = { kind: ContextFlag; source: ContextSource; label: string; bytes: number; file?: string };

const isKind = (value: unknown): value is ContextFlag =>
  typeof value === "string" && (CONTEXT_FLAGS as readonly string[]).includes(value);

const hasExtension = (name: string, extensions: string[]): boolean => extensions.some((ext) => name.toLowerCase().endsWith(ext));

const parseEntry = (entry: unknown): ContextRequest => {
  // A bare flag ("hld") means "the default file in context/", which is what the terminal flow has always done.
  if (typeof entry === "string") {
    if (!isKind(entry)) throw new ValidationError(`Unknown context flag: ${JSON.stringify(entry)}. Allowed: ${CONTEXT_FLAGS.join(", ")}.`);
    return { kind: entry, source: "repo" };
  }
  if (typeof entry !== "object" || entry === null) throw new ValidationError("Each context entry must be a flag or an object.");
  const { kind, source } = entry as { kind?: unknown; source?: unknown };
  if (!isKind(kind)) throw new ValidationError(`Unknown context kind: ${JSON.stringify(kind)}. Allowed: ${CONTEXT_FLAGS.join(", ")}.`);
  const label = CONTEXT_LABELS[kind];

  if (source === "repo") return { kind, source };

  if (source === "paste") {
    const { text } = entry as { text?: unknown };
    if (typeof text !== "string" || text.trim() === "") throw new ValidationError(`${label}: paste some text, or choose another source.`);
    if (Buffer.byteLength(text, "utf8") > MAX_CONTEXT_BYTES) {
      throw new ValidationError(`${label}: the pasted text is over the ${MAX_CONTEXT_BYTES / 1024} KB limit. Paste just the relevant section.`);
    }
    if (text.includes("\u0000")) throw new ValidationError(`${label}: the pasted text looks like binary data, not text.`);
    return { kind, source, text };
  }

  if (source === "upload") {
    const { name, text } = entry as { name?: unknown; text?: unknown };
    if (typeof name !== "string" || name.trim() === "" || name.length > 200) throw new ValidationError(`${label}: the file needs a name.`);
    if (!hasExtension(name, UPLOAD_EXTENSIONS)) {
      throw new ValidationError(`${label}: "${name}" is not supported. Use a ${UPLOAD_EXTENSIONS.join(", ")} file (save Word or PDF documents as text or Markdown first).`);
    }
    if (typeof text !== "string") throw new ValidationError(`${label}: the file has no content.`);
    if (Buffer.byteLength(text, "utf8") > MAX_RAW_UPLOAD_BYTES) throw new ValidationError(`${label}: the file is too large.`);
    if (text.includes("\u0000")) throw new ValidationError(`${label}: "${name}" looks like a binary file, not text.`);
    return { kind, source, name: name.trim(), text };
  }

  if (source === "url") {
    const { url } = entry as { url?: unknown };
    if (typeof url !== "string" || url.trim() === "") throw new ValidationError(`${label}: enter a URL.`);
    return { kind, source, url: url.trim() };
  }

  throw new ValidationError(`${label}: choose a source (repo, paste, upload or url).`);
};

export const parseContextRequests = (input: unknown): ContextRequest[] => {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new ValidationError("context must be a list.");
  const byKind = new Map<ContextFlag, ContextRequest>();
  for (const entry of input) {
    const request = parseEntry(entry);
    if (byKind.has(request.kind)) throw new ValidationError(`${CONTEXT_LABELS[request.kind]} was given twice.`);
    byKind.set(request.kind, request);
  }
  return CONTEXT_FLAGS.flatMap((kind) => byKind.get(kind) ?? []);
};

// Writes this run's own context files into its folder. The repo's context/ files are never modified.
export const prepareContext = async (
  runId: string,
  requests: ContextRequest[],
  fetchContextPage: FetchPage,
): Promise<{ used: ContextUsed[]; files: Partial<Record<ContextFlag, string>> }> => {
  const used: ContextUsed[] = [];
  const files: Partial<Record<ContextFlag, string>> = {};

  for (const request of requests) {
    const label = CONTEXT_LABELS[request.kind];

    if (request.source === "repo") {
      const relative = DEFAULT_CONTEXT_FILES[request.kind];
      let size: number;
      try {
        size = (await stat(path.join(config.repoRoot, relative))).size;
      } catch {
        throw new ValidationError(`${label}: ${relative} was not found. Upload a document or give a URL instead.`);
      }
      used.push({ kind: request.kind, source: "repo", label: relative, bytes: size });
      continue;
    }

    let text: string;
    let sourceLabel: string;
    if (request.source === "paste") {
      text = request.text;
      sourceLabel = "pasted text";
    } else if (request.source === "upload") {
      text = hasExtension(request.name, HTML_EXTENSIONS) ? htmlToText(request.text) : request.text;
      sourceLabel = request.name;
    } else {
      try {
        const page = await fetchContextPage(request.url);
        text = page.text;
        sourceLabel = page.finalUrl;
      } catch (error) {
        if (error instanceof FetchError) throw new ValidationError(`${label}: ${error.message}`);
        throw error;
      }
    }

    text = text.trim();
    if (text === "") throw new ValidationError(`${label}: the document has no readable text.`);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_CONTEXT_BYTES) {
      throw new ValidationError(
        `${label}: the document is ${Math.round(bytes / 1024)} KB and the limit is ${MAX_CONTEXT_BYTES / 1024} KB. Upload just the relevant section.`,
      );
    }

    await mkdir(runDir(runId), { recursive: true });
    const file = path.join(runDir(runId), `context-${request.kind}.md`);
    await writeFile(file, `Source: ${sourceLabel}\n\n${text}\n`);
    const relativeFile = path.relative(config.repoRoot, file).split(path.sep).join("/");
    files[request.kind] = relativeFile;
    used.push({ kind: request.kind, source: request.source, label: sourceLabel, bytes, file: relativeFile });
  }
  return { used, files };
};

export type RepoContextStatus = {
  kind: ContextFlag;
  label: string;
  path: string;
  exists: boolean;
  bytes: number;
  modifiedAt: string | null;
  preview: string;
};

const PREVIEW_BYTES = 1500;

// What the terminal flow would use today, so the page can show it instead of an unexplained checkbox.
export const repoContextStatus = async (): Promise<RepoContextStatus[]> =>
  Promise.all(
    CONTEXT_FLAGS.map(async (kind): Promise<RepoContextStatus> => {
      const relative = DEFAULT_CONTEXT_FILES[kind];
      const base = { kind, label: CONTEXT_LABELS[kind], path: relative };
      try {
        const absolute = path.join(config.repoRoot, relative);
        const info = await stat(absolute);
        const handle = await open(absolute, "r");
        try {
          const buffer = Buffer.alloc(Math.min(PREVIEW_BYTES, info.size));
          await handle.read(buffer, 0, buffer.length, 0);
          return { ...base, exists: true, bytes: info.size, modifiedAt: info.mtime.toISOString(), preview: buffer.toString("utf8").replace(/�$/, "") };
        } finally {
          await handle.close();
        }
      } catch {
        return { ...base, exists: false, bytes: 0, modifiedAt: null, preview: "" };
      }
    }),
  );
