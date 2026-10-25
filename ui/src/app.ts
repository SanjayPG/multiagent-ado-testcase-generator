import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { config, getEnvStatus, getOrgName, getProjectName } from "./config.js";
import { CsvFormatError, MAX_UPLOAD_BYTES, parseTestCases, validateUpload } from "./csv.js";
import { parseContextRequests, repoContextStatus } from "./context.js";
import { diffTestCases } from "./diff.js";
import type { FetchPage } from "./fetchPage.js";
import {
  BusyError,
  NotFoundError,
  NotReadyError,
  cancelRun,
  getActiveRunId,
  startGenerate,
  startPush,
  subscribe,
} from "./runner.js";
import {
  effectiveCsv,
  listRuns,
  readCsvText,
  readEvents,
  readMeta,
  removeUploadFile,
  saveUpload,
  updateMeta,
  type StoredEvent,
} from "./store.js";
import { ValidationError, isRunId, parsePbis } from "./validate.js";

const SECURITY_HEADERS = {
  // Everything the page needs is served from this origin; nothing inline, so injected markup cannot run.
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
} as const;

type RunParams = { Params: { id: string } };

// The file name is shown in the page only; it is never used to build a path.
const displayName = (header: string | string[] | undefined): string => {
  const raw = Array.isArray(header) ? header[0] : header;
  let decoded = raw ?? "";
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep the raw header
  }
  const base = decoded.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100).trim();
  return clean || "uploaded.csv";
};

// fetchPage can be swapped in tests; the real one is used when it is not given.
export const buildApp = async (options: { fetchPage?: FetchPage } = {}): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);

  // Anyone can make your browser call http://127.0.0.1; only accept requests meant for this exact origin.
  app.addHook("onRequest", async (request, reply) => {
    if (!allowedHosts.has(request.headers.host ?? "")) {
      return reply.code(403).send({ error: "Unexpected Host header." });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.origin;
      if (origin !== undefined && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) {
        return reply.code(403).send({ error: "Cross-origin request refused." });
      }
    }
  });

  app.addHook("onSend", async (_request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
    if (error instanceof BusyError) return reply.code(409).send({ error: error.message, activeRunId: getActiveRunId() });
    if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
    if (error instanceof NotReadyError) return reply.code(422).send({ error: error.message });
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: (error as Error).message });
    app.log.error(error);
    return reply.code(500).send({ error: "Internal error." });
  });

  // Edited CSVs arrive as the raw request body; bodyLimit enforces the size cap before anything is parsed.
  app.addContentTypeParser(["text/csv", "application/octet-stream"], { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES }, (_request, body, done) => {
    done(null, body);
  });

  await app.register(fastifyStatic, { root: config.publicDir });

  app.get("/api/config", async () => ({
    project: getProjectName(),
    org: getOrgName(),
    envOk: getEnvStatus(),
    activeRunId: getActiveRunId(),
    limits: { maxPbis: config.maxPbis },
  }));

  // The default context files the terminal flow would read, so the page can say what "HLD" currently means.
  app.get("/api/context", async () => ({ files: await repoContextStatus() }));

  app.get("/api/runs", async () => ({ runs: await listRuns() }));

  app.post("/api/runs", async (request, reply) => {
    const body = (request.body ?? {}) as { pbis?: unknown; context?: unknown };
    const pbis = parsePbis(body.pbis, config.maxPbis);
    const context = parseContextRequests(body.context);
    const runId = await startGenerate(pbis, context, options.fetchPage);
    return reply.code(202).send({ runId });
  });

  app.get<RunParams>("/api/runs/:id", async (request) => {
    const { id } = request.params;
    if (!isRunId(id)) throw new ValidationError("Invalid run id.");
    const meta = await readMeta(id);
    if (!meta) throw new NotFoundError("Unknown run.");
    // The review table shows what would be pushed: the uploaded file if there is one, else the original.
    const effective = meta.hasCsv ? await effectiveCsv(id) : null;
    return { meta, source: effective?.source ?? null, testCases: effective ? parseTestCases(effective.text) : [] };
  });

  const requireFinishedGenerateRun = async (id: string) => {
    if (!isRunId(id)) throw new ValidationError("Invalid run id.");
    if (getActiveRunId() !== null) throw new BusyError("Wait for the current run to finish before changing the upload.");
    const meta = await readMeta(id);
    if (!meta) throw new NotFoundError("Unknown run.");
    if (meta.kind !== "generate" || meta.status !== "done" || !meta.hasCsv) {
      throw new NotReadyError("Only a finished generate run can take an uploaded CSV.");
    }
    return meta;
  };

  app.post<RunParams>("/api/runs/:id/upload", async (request) => {
    const { id } = request.params;
    await requireFinishedGenerateRun(id);
    if (!Buffer.isBuffer(request.body)) {
      throw new ValidationError("Send the CSV file as the request body with Content-Type: text/csv.");
    }
    let validated: ReturnType<typeof validateUpload>;
    try {
      validated = validateUpload(request.body);
    } catch (error) {
      if (error instanceof CsvFormatError) throw new ValidationError(error.message);
      throw error;
    }
    const original = parseTestCases((await readCsvText(id)) ?? "");
    const changes = diffTestCases(original, validated.testCases);
    await saveUpload(id, request.body);
    const meta = await updateMeta(id, {
      upload: {
        name: displayName(request.headers["x-filename"]),
        uploadedAt: new Date().toISOString(),
        testCaseCount: validated.testCases.length,
        changes,
      },
    });
    return { meta, source: "uploaded", testCases: validated.testCases };
  });

  app.delete<RunParams>("/api/runs/:id/upload", async (request) => {
    const { id } = request.params;
    await requireFinishedGenerateRun(id);
    await removeUploadFile(id);
    const meta = await updateMeta(id, { upload: undefined });
    return { meta };
  });

  app.get<RunParams>("/api/runs/:id/csv", async (request, reply) => {
    const { id } = request.params;
    if (!isRunId(id)) throw new ValidationError("Invalid run id.");
    const csvText = await readCsvText(id);
    if (csvText === null) throw new NotFoundError("This run has no CSV.");
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="tc_${id}.csv"`)
      .send(csvText); // keeps the UTF-8 BOM so Excel shows • and — correctly
  });

  app.post<RunParams>("/api/runs/:id/cancel", async (request) => {
    const { id } = request.params;
    if (!isRunId(id)) throw new ValidationError("Invalid run id.");
    return { cancelled: cancelRun(id) };
  });

  // Pushing creates real work items in Azure DevOps, so the server re-checks every gate the UI shows.
  app.post<RunParams>("/api/runs/:id/push", async (request, reply) => {
    const { id } = request.params;
    if (!isRunId(id)) throw new ValidationError("Invalid run id.");
    const body = (request.body ?? {}) as { confirm?: unknown; expectedCount?: unknown; project?: unknown };
    if (body.confirm !== true) throw new ValidationError("Pushing needs an explicit confirmation.");
    if (!Number.isInteger(body.expectedCount) || (body.expectedCount as number) <= 0) {
      throw new ValidationError("expectedCount must be the number of test cases being pushed.");
    }
    const project = getProjectName();
    if (project === "") throw new NotReadyError("ADO_PROJECT is not set on the server.");
    if (body.project !== project) throw new ValidationError("The typed project name does not match.");
    const started = await startPush(id, body.expectedCount as number);
    return reply.code(202).send(started);
  });

  app.get<RunParams>("/api/runs/:id/events", async (request, reply) => {
    const { id } = request.params;
    if (!isRunId(id)) throw new ValidationError("Invalid run id.");
    const meta = await readMeta(id);
    if (!meta) throw new NotFoundError("Unknown run.");

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive",
    });
    const send = (event: StoredEvent): void => {
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.kind === "done") raw.end();
    };

    const live = subscribe(id, send);
    if (live) {
      raw.on("close", live.unsubscribe);
      live.backlog.forEach(send);
      return;
    }
    // Finished run: replay what was stored, then close.
    const stored = await readEvents(id);
    stored.forEach(send);
    if (!stored.some((event) => event.kind === "done")) raw.end();
  });

  return app;
};
