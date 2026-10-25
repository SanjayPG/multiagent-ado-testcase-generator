import { computeProgress, progressLabel, type Outcome, type StepState as ProgressState } from "./progress.js";

// Browser code. All text that comes from the pipeline or from Azure DevOps is inserted with textContent / text
// nodes only (never innerHTML): generated test cases deliberately contain strings like "<script>alert(1)</script>".

type StepState = "running" | "done" | "failed";
type RunStatus = "running" | "done" | "failed" | "cancelled";

type Config = {
  project: string;
  org: string;
  envOk: { pat: boolean; org: boolean; project: boolean };
  activeRunId: string | null;
  limits: { maxPbis: number };
};

type PushSummary = { created: number | null; linked: number | null; failed: string | null };

type ChangeSummary = {
  originalCount: number;
  editedCount: number;
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
  newPbiIds: number[];
};

type Source = "original" | "uploaded";

type ContextKind = "hld" | "regression";

type RepoContext = {
  kind: ContextKind;
  label: string;
  path: string;
  exists: boolean;
  bytes: number;
  modifiedAt: string | null;
  preview: string;
};

type ContextRequest =
  | { kind: ContextKind; source: "repo" }
  | { kind: ContextKind; source: "upload"; name: string; text: string }
  | { kind: ContextKind; source: "url"; url: string };

type ContextUsed = { kind: ContextKind; source: "repo" | "upload" | "url"; label: string; bytes: number };

type RunMeta = {
  id: string;
  kind: "generate" | "push";
  status: RunStatus;
  startedAt: string;
  pbis?: number[];
  parentRunId?: string;
  resultText?: string;
  errorMessage?: string;
  hasCsv?: boolean;
  testCaseCount?: number;
  durationMs?: number | null;
  costUsd?: number | null;
  push?: PushSummary;
  upload?: { name: string; uploadedAt: string; testCaseCount: number; changes: ChangeSummary };
  pushSource?: Source;
  context?: ContextUsed[];
};

type TestStep = { n: number; action: string; expected: string };

type TestCase = {
  title: string;
  pbiId: number | null;
  testType: string;
  priority: string;
  tags: string;
  description: string;
  testData: string;
  steps: TestStep[];
};

type ServerEvent =
  | { kind: "step"; id: string; label: string; state: StepState }
  | { kind: "note"; text: string }
  | { kind: "result"; text: string }
  | { kind: "state"; status: RunStatus }
  | { kind: "done"; status: RunStatus };

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
};

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  for (const child of children) element.append(typeof child === "string" ? document.createTextNode(child) : child);
  return element;
};

const api = async <T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? `Request failed (${response.status})`);
  }
  return body as T;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------- elements ----------
const projectName = byId("project-name");
const envBanner = byId("env-banner");
const errorBanner = byId("error");
const form = byId<HTMLFormElement>("generate-form");
const pbiInput = byId<HTMLInputElement>("pbi-input");
const contextCardsBox = byId("context-cards");
const contextUsedText = byId("context-used");
const generateButton = byId<HTMLButtonElement>("generate-button");
const cancelButton = byId<HTMLButtonElement>("cancel-button");
const progressSection = byId("progress-section");
const progressBar = byId<HTMLProgressElement>("progress-bar");
const progressLabelEl = byId("progress-label");
const pushProgressBar = byId<HTMLProgressElement>("push-progress-bar");
const pushProgressLabel = byId("push-progress-label");
const stepsList = byId("steps");
const notesList = byId("notes");
const resultsSection = byId("results-section");
const summaryText = byId("summary");
const filterType = byId<HTMLSelectElement>("filter-type");
const filterPbi = byId<HTMLSelectElement>("filter-pbi");
const filterText = byId<HTMLInputElement>("filter-text");
const testCasesBox = byId("testcases");
const downloadLink = byId<HTMLAnchorElement>("download-link");
const uploadInput = byId<HTMLInputElement>("upload-input");
const uploadPanel = byId("upload-panel");
const uploadText = byId("upload-text");
const uploadWarnings = byId("upload-warnings");
const uploadChanges = byId("upload-changes");
const removeUploadButton = byId<HTMLButtonElement>("remove-upload-button");
const pushButton = byId<HTMLButtonElement>("push-button");
const pushSection = byId("push-section");
const pushSteps = byId("push-steps");
const pushSummary = byId("push-summary");
const pushRaw = byId("push-raw");
const historyList = byId("history");
const pushDialog = byId<HTMLDialogElement>("push-dialog");
const pushForm = byId<HTMLFormElement>("push-form");
const pushDialogText = byId("push-dialog-text");
const pushConfirmInput = byId<HTMLInputElement>("push-confirm-input");
const pushConfirmButton = byId<HTMLButtonElement>("push-confirm-button");
const pushCancelButton = byId<HTMLButtonElement>("push-cancel-button");

// ---------- state ----------
let config: Config;
let currentRunId: string | null = null;
let currentTestCases: TestCase[] = [];
let currentSource: Source = "original";
let stream: EventSource | null = null;

// ---------- small helpers ----------
const showError = (message: string | null): void => {
  errorBanner.hidden = message === null;
  errorBanner.textContent = message ?? "";
};

const setRunning = (running: boolean): void => {
  generateButton.disabled = running || !(config.envOk.pat && config.envOk.org && config.envOk.project);
  cancelButton.hidden = !running;
};

const upsertStep = (list: HTMLElement, event: Extract<ServerEvent, { kind: "step" }>): void => {
  let item = Array.from(list.children).find((child) => child.getAttribute("data-step-id") === event.id) as HTMLElement | undefined;
  if (!item) {
    item = h("li", { "data-step-id": event.id, "data-testid": "step" });
    list.append(item);
  }
  item.setAttribute("data-state", event.state);
  if (event.label) item.textContent = event.label; // closing events carry no label; keep the earlier one
};

// Drives one progress bar from the step events of one run. Safe to feed the same step twice (the stream replays).
const createTracker = (bar: HTMLProgressElement, label: HTMLElement, expectedSteps: number | null, startedAtMs: number) => {
  const states = new Map<string, ProgressState>();
  let outcome: Outcome = "running";
  let finishedAtMs: number | null = null;

  const render = (): void => {
    const progress = computeProgress([...states.values()], expectedSteps);
    bar.dataset.state = progress.failed || outcome === "failed" || outcome === "cancelled" ? "failed" : "ok";
    if (outcome === "done") {
      bar.max = Math.max(progress.total, 1);
      bar.value = bar.max;
    } else if (progress.indeterminate) {
      bar.removeAttribute("value"); // no value attribute = the browser's own "working" animation
    } else {
      bar.max = progress.total;
      bar.value = progress.done;
    }
    label.textContent = progressLabel(progress, (finishedAtMs ?? Date.now()) - startedAtMs, outcome);
  };

  const timer = setInterval(render, 1000); // keeps the elapsed time moving between step events
  render();

  return {
    onStep: (event: { id: string; state: ProgressState }): void => {
      states.set(event.id, event.state);
      render();
    },
    finish: (result: Exclude<Outcome, "running">): void => {
      if (outcome !== "running") return;
      outcome = result;
      finishedAtMs = Date.now();
      clearInterval(timer);
      render();
    },
  };
};

const toOutcome = (status: RunStatus): Exclude<Outcome, "running"> =>
  status === "done" ? "done" : status === "cancelled" ? "cancelled" : "failed";

const follow = (
  runId: string,
  list: HTMLElement,
  notes: HTMLElement | null,
  onStep?: (event: Extract<ServerEvent, { kind: "step" }>) => void,
): Promise<void> =>
  new Promise((resolve) => {
    stream?.close();
    const source = new EventSource(`/api/runs/${runId}/events`);
    stream = source;
    source.onmessage = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as ServerEvent;
      if (event.kind === "step") {
        upsertStep(list, event);
        onStep?.(event);
      } else if (event.kind === "note" && notes) notes.append(h("li", {}, event.text));
      else if (event.kind === "done") {
        source.close();
        resolve();
      }
    };
    // The caller always re-reads the run's stored status afterwards, so a dropped stream is not fatal.
    source.onerror = () => {
      source.close();
      resolve();
    };
  });

const formatDuration = (ms: number | null | undefined): string => (ms ? `${Math.round(ms / 1000)}s` : "");
const formatCost = (usd: number | null | undefined): string => (usd ? `$${usd.toFixed(2)}` : "");

// ---------- results ----------
const countBy = (items: string[]): Record<string, number> =>
  items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item]: (acc[item] ?? 0) + 1 }), {});

const renderTestCase = (testCase: TestCase): HTMLElement => {
  const rows = testCase.steps.map((step) =>
    h("tr", {}, h("td", {}, String(step.n)), h("td", {}, step.action), h("td", {}, step.expected)),
  );
  const table = h(
    "table",
    { class: "step-table" },
    h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Action"), h("th", {}, "Expected result"))),
    h("tbody", {}, ...rows),
  );
  const details = h("dl", {});
  const addRow = (label: string, value: string): void => {
    if (value) details.append(h("dt", {}, label), h("dd", {}, value));
  };
  addRow("Preconditions", testCase.description);
  addRow("Test data", testCase.testData);
  addRow("Tags", testCase.tags);

  return h(
    "details",
    { "data-testid": "testcase" },
    h(
      "summary",
      {},
      h("span", { class: "tc-title" }, testCase.title),
      h("span", { class: "badge" }, testCase.testType),
      h("span", { class: "badge" }, testCase.pbiId === null ? "PBI ?" : `PBI ${testCase.pbiId}`),
      h("span", { class: "badge" }, `P${testCase.priority}`),
      h("span", { class: "badge" }, `${testCase.steps.length} ${testCase.steps.length === 1 ? "step" : "steps"}`),
    ),
    h("div", { class: "tc-body" }, details, table),
  );
};

const renderList = (): void => {
  const type = filterType.value;
  const pbi = filterPbi.value;
  const needle = filterText.value.trim().toLowerCase();
  const visible = currentTestCases.filter((testCase) => {
    if (type && testCase.testType !== type) return false;
    if (pbi && String(testCase.pbiId) !== pbi) return false;
    if (!needle) return true;
    const haystack = [testCase.title, ...testCase.steps.flatMap((step) => [step.action, step.expected])].join(" ").toLowerCase();
    return haystack.includes(needle);
  });
  testCasesBox.replaceChildren(...visible.map(renderTestCase));
  if (visible.length === 0) testCasesBox.append(h("p", { class: "hint" }, "No test cases match the filters."));
};

const fillSelect = (select: HTMLSelectElement, values: string[]): void => {
  select.replaceChildren(h("option", { value: "" }, "All"), ...values.map((value) => h("option", { value }, value)));
};

// ---------- context cards ----------
const MAX_CONTEXT_BYTES = 200 * 1024;
const CONTEXT_FILE_TYPES = ".md,.markdown,.txt,.text,.html,.htm";
const KIND_LABELS: Record<ContextKind, string> = { hld: "HLD", regression: "Regression scripts" };

const formatBytes = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

const describeContextUsed = (used: ContextUsed[]): string => {
  if (used.length === 0) return "Context: none";
  const parts = used.map((entry) => {
    const how =
      entry.source === "upload" ? `your uploaded file "${entry.label}"` : entry.source === "url" ? `downloaded from ${entry.label}` : entry.label;
    return `${KIND_LABELS[entry.kind]} — ${how} (${formatBytes(entry.bytes)})`;
  });
  return `Context: ${parts.join("; ")}`;
};

type ContextCard = { request: () => Promise<ContextRequest | null> };
const contextCards: ContextCard[] = [];

const buildContextCard = (repo: RepoContext): ContextCard => {
  const kind = repo.kind;
  const label = repo.label;

  const include = h("input", { type: "checkbox", "data-testid": `ctx-${kind}` });
  const radio = (value: "repo" | "upload" | "url"): HTMLInputElement =>
    h("input", { type: "radio", name: `ctx-${kind}-source`, value, "data-testid": `ctx-${kind}-${value}` });
  const repoRadio = radio("repo");
  const uploadRadio = radio("upload");
  const urlRadio = radio("url");

  const repoText = repo.exists
    ? `Use ${repo.path} (${formatBytes(repo.bytes)}, updated ${new Date(repo.modifiedAt ?? "").toLocaleDateString()})`
    : `${repo.path} (not found)`;
  repoRadio.disabled = !repo.exists;
  (repo.exists ? repoRadio : uploadRadio).checked = true;

  // A chosen file is read in the browser; the server never receives a path from the page.
  let chosen: { name: string; text: string } | null = null;
  let reading: Promise<void> = Promise.resolve();
  const fileInfo = h("span", { class: "hint", "data-testid": `ctx-${kind}-file-info` });
  const fileInput = h("input", { type: "file", accept: CONTEXT_FILE_TYPES, "aria-label": `${label} document`, "data-testid": `ctx-${kind}-file` });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    chosen = null;
    fileInfo.textContent = "";
    if (!file) return;
    if (file.size > MAX_CONTEXT_BYTES) {
      fileInfo.textContent = `${file.name} is ${formatBytes(file.size)}; the limit is ${MAX_CONTEXT_BYTES / 1024} KB. Upload just the relevant section.`;
      fileInput.value = "";
      return;
    }
    reading = file.text().then((text) => {
      chosen = { name: file.name, text };
      fileInfo.textContent = `${file.name} — ${formatBytes(file.size)}`;
    });
  });
  const uploadBox = h("div", { class: "context-input" }, fileInput, " ", fileInfo, h("div", { class: "hint" }, "A .md, .txt or .html file, up to 200 KB. Save Word or PDF documents as text first."));

  const urlInput = h("input", { type: "url", placeholder: "https://… (a public page)", "aria-label": `${label} URL`, "data-testid": `ctx-${kind}-url-input` });
  const urlBox = h("div", { class: "context-input" }, urlInput, h("div", { class: "hint" }, "Pages that need a login will not work. Only use pages you trust."));

  const preview = repo.exists
    ? h("details", {}, h("summary", {}, `Preview ${repo.path}`), h("pre", { class: "raw" }, repo.preview))
    : null;

  const options = h(
    "div",
    { class: "context-options", "data-testid": `ctx-${kind}-options` },
    h("label", {}, repoRadio, ` ${repoText}`),
    ...(preview ? [preview] : []),
    h("label", {}, uploadRadio, " Upload a document"),
    uploadBox,
    h("label", {}, urlRadio, " From a URL"),
    urlBox,
  );

  const sync = (): void => {
    options.hidden = !include.checked;
    uploadBox.hidden = !uploadRadio.checked;
    urlBox.hidden = !urlRadio.checked;
    if (preview) preview.hidden = !repoRadio.checked;
  };
  [include, repoRadio, uploadRadio, urlRadio].forEach((control) => control.addEventListener("change", sync));
  sync();

  contextCardsBox.append(h("div", { class: "context-card" }, h("label", { class: "inline" }, include, ` ${label}`), options));

  return {
    request: async () => {
      if (!include.checked) return null;
      if (repoRadio.checked) return { kind, source: "repo" };
      if (urlRadio.checked) {
        const url = urlInput.value.trim();
        if (!url) throw new Error(`${label}: enter a URL, or choose another source.`);
        return { kind, source: "url", url };
      }
      await reading;
      if (!chosen) throw new Error(`${label}: choose a document, or choose another source.`);
      return { kind, source: "upload", name: chosen.name, text: chosen.text };
    },
  };
};

const changeList = (title: string, titles: string[]): HTMLElement[] =>
  titles.length === 0
    ? []
    : [h("h3", {}, `${title} (${titles.length})`), h("ul", { class: "changes" }, ...titles.map((text) => h("li", {}, text)))];

const renderUpload = (meta: RunMeta): void => {
  const upload = meta.upload;
  uploadPanel.hidden = !upload;
  downloadLink.textContent = upload ? "Download original CSV" : "Download CSV";
  if (!upload) return;
  const { changes } = upload;
  uploadText.textContent =
    `Using your uploaded file "${upload.name}": ${upload.testCaseCount} test cases ` +
    `(${changes.added.length} added, ${changes.removed.length} removed, ${changes.changed.length} changed, ${changes.unchanged} unchanged). ` +
    "This file will be pushed instead of the original.";
  uploadWarnings.replaceChildren();
  if (changes.newPbiIds.length > 0) {
    uploadWarnings.append(
      h("li", {}, `It contains test cases for PBI ${changes.newPbiIds.join(", ")}, which were not in the original run. They will be linked to those PBIs.`),
    );
  }
  uploadChanges.replaceChildren(
    ...changeList("Added", changes.added),
    ...changeList("Removed", changes.removed),
    ...changeList("Changed", changes.changed),
  );
  if (changes.added.length + changes.removed.length + changes.changed.length === 0) {
    uploadChanges.append(h("p", { class: "hint" }, "No differences from the original."));
  }
};

const renderResults = (meta: RunMeta, testCases: TestCase[], source: Source): void => {
  currentRunId = meta.id;
  currentTestCases = testCases;
  currentSource = source;
  renderUpload(meta);
  const steps = testCases.reduce((sum, testCase) => sum + testCase.steps.length, 0);
  const byType = Object.entries(countBy(testCases.map((testCase) => testCase.testType)))
    .map(([type, count]) => `${type} ${count}`)
    .join(" · ");
  const extras = [formatDuration(meta.durationMs), formatCost(meta.costUsd)].filter(Boolean).join(" · ");
  contextUsedText.textContent = describeContextUsed(meta.context ?? []);
  const heading = source === "uploaded" ? `Your uploaded file: ${testCases.length} test cases` : `${testCases.length} test cases`;
  summaryText.textContent = [heading, `${steps} steps`, byType, extras].filter(Boolean).join(" — ");

  fillSelect(filterType, Object.keys(countBy(testCases.map((testCase) => testCase.testType))));
  fillSelect(filterPbi, Object.keys(countBy(testCases.map((testCase) => String(testCase.pbiId)))));
  filterText.value = "";
  renderList();

  downloadLink.href = `/api/runs/${meta.id}/csv`;
  pushButton.disabled = false;
  resultsSection.hidden = false;
};

const loadRun = async (runId: string): Promise<RunMeta> => {
  const { meta, testCases, source } = await api<{ meta: RunMeta; testCases: TestCase[]; source: Source | null }>(`/api/runs/${runId}`);
  if (meta.kind === "generate" && meta.status === "done") {
    renderResults(meta, testCases, source ?? "original");
  } else if (meta.status === "failed" || meta.status === "cancelled") {
    resultsSection.hidden = true;
    showError(meta.errorMessage ?? `The run ${meta.status}.`);
  }
  return meta;
};

// ---------- history ----------
const refreshHistory = async (): Promise<void> => {
  const { runs } = await api<{ runs: RunMeta[] }>("/api/runs");
  historyList.replaceChildren(
    ...runs.map((run) => {
      const label = `${run.kind} · ${run.status}${run.pbis ? ` · PBIs ${run.pbis.join(", ")}` : ""} · ${new Date(run.startedAt).toLocaleString()}`;
      const item = h("li", { "data-testid": "history-item" }, h("span", {}, label));
      if (run.kind === "generate" && run.status === "done") {
        const open = h("button", { type: "button", class: "secondary" }, "Open");
        open.addEventListener("click", () => {
          showError(null);
          pushSection.hidden = true;
          void loadRun(run.id).catch((error) => showError(errorText(error)));
        });
        item.append(open);
      }
      return item;
    }),
  );
  if (runs.length === 0) historyList.append(h("li", { class: "hint" }, "No runs yet."));
};

// ---------- generate ----------
const startGenerate = async (): Promise<void> => {
  showError(null);
  const pbis = pbiInput.value.split(/[\s,;]+/).filter(Boolean);
  const context: ContextRequest[] = [];
  for (const card of contextCards) {
    const request = await card.request();
    if (request) context.push(request);
  }
  // A URL is downloaded by the server before the run starts, which can take a few seconds.
  const needsPreparing = context.some((request) => request.source !== "repo");
  const idleText = generateButton.textContent;
  if (needsPreparing) {
    generateButton.disabled = true;
    generateButton.textContent = "Preparing context…";
  }
  let runId: string;
  try {
    ({ runId } = await api<{ runId: string }>("/api/runs", { method: "POST", body: { pbis, context } }));
  } finally {
    generateButton.textContent = idleText;
    generateButton.disabled = false;
  }
  // Fetch + schema + one step per PBI + merge.
  await watchGenerate(runId, new Set(pbis.map(Number)).size + 3, Date.now());
};

const watchGenerate = async (runId: string, expectedSteps: number | null, startedAtMs: number): Promise<void> => {
  currentRunId = runId;
  stepsList.replaceChildren();
  notesList.replaceChildren();
  resultsSection.hidden = true;
  pushSection.hidden = true;
  progressSection.hidden = false;
  setRunning(true);
  const tracker = createTracker(progressBar, progressLabelEl, expectedSteps, startedAtMs);
  try {
    await follow(runId, stepsList, notesList, (event) => tracker.onStep(event));
    const meta = await loadRun(runId);
    tracker.finish(toOutcome(meta.status));
  } finally {
    tracker.finish("failed"); // no-op when already finished; covers an exception on the way
    setRunning(false);
    void refreshHistory();
  }
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  startGenerate().catch((error) => showError(errorText(error)));
});

cancelButton.addEventListener("click", () => {
  if (!currentRunId) return;
  api(`/api/runs/${currentRunId}/cancel`, { method: "POST", body: {} }).catch((error) => showError(errorText(error)));
});

[filterType, filterPbi].forEach((control) => control.addEventListener("change", renderList));
filterText.addEventListener("input", renderList);

// ---------- upload an edited CSV ----------
uploadInput.addEventListener("change", () => {
  const file = uploadInput.files?.[0];
  if (!file || !currentRunId) return;
  const runId = currentRunId;
  showError(null);
  void (async () => {
    try {
      const response = await fetch(`/api/runs/${runId}/upload`, {
        method: "POST",
        headers: { "content-type": "text/csv", "x-filename": encodeURIComponent(file.name) },
        body: file,
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body as { error?: string }).error ?? `Upload failed (${response.status})`);
      await loadRun(runId);
    } catch (error) {
      showError(errorText(error));
    } finally {
      uploadInput.value = ""; // lets the same file be chosen again after editing it once more
    }
  })();
});

removeUploadButton.addEventListener("click", () => {
  if (!currentRunId) return;
  const runId = currentRunId;
  showError(null);
  api(`/api/runs/${runId}/upload`, { method: "DELETE" })
    .then(() => loadRun(runId))
    .catch((error) => showError(errorText(error)));
});

// ---------- push ----------
pushButton.addEventListener("click", () => {
  const what = currentSource === "uploaded" ? "your uploaded file" : "the original generated file";
  pushDialogText.textContent =
    `This creates ${currentTestCases.length} Test Case work items from ${what} in the Azure DevOps project "${config.project}" and links them to their PBIs. ` +
    "Pushing only creates: a test case whose title you changed after an earlier push is created again, not updated.";
  pushConfirmInput.value = "";
  pushConfirmButton.disabled = true;
  pushDialog.showModal();
  pushConfirmInput.focus();
});

pushConfirmInput.addEventListener("input", () => {
  pushConfirmButton.disabled = config.project === "" || pushConfirmInput.value !== config.project;
});

pushCancelButton.addEventListener("click", () => pushDialog.close());

pushForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (pushConfirmInput.value !== config.project || !currentRunId) return;
  const typedProject = pushConfirmInput.value;
  pushDialog.close();
  void doPush(currentRunId, typedProject).catch((error) => showError(errorText(error)));
});

const doPush = async (runId: string, typedProject: string): Promise<void> => {
  showError(null);
  pushButton.disabled = true; // one deliberate push per review; open the run again to push again
  const { runId: pushRunId } = await api<{ runId: string }>(`/api/runs/${runId}/push`, {
    method: "POST",
    body: { confirm: true, expectedCount: currentTestCases.length, project: typedProject },
  });
  pushSteps.replaceChildren();
  pushSummary.textContent = "";
  pushRaw.textContent = "";
  pushSection.hidden = false;
  setRunning(true);
  const tracker = createTracker(pushProgressBar, pushProgressLabel, 1, Date.now());
  try {
    await follow(pushRunId, pushSteps, null, (event) => tracker.onStep(event));
    const { meta } = await api<{ meta: RunMeta }>(`/api/runs/${pushRunId}`);
    tracker.finish(toOutcome(meta.status));
    if (meta.status !== "done") showError(meta.errorMessage ?? `The push ${meta.status}.`);
    const result = meta.push;
    const pushed = meta.pushSource === "uploaded" ? "Pushed your uploaded file — " : "";
    pushSummary.textContent = result
      ? `${pushed}Created ${result.created ?? "?"} · linked ${result.linked ?? "?"} · failed: ${result.failed ?? "none reported"}`
      : "";
    pushRaw.textContent = meta.resultText ?? "";
  } finally {
    tracker.finish("failed");
    setRunning(false);
    void refreshHistory();
  }
};

// ---------- start-up ----------
const init = async (): Promise<void> => {
  config = await api<Config>("/api/config");
  projectName.textContent = config.project || "(ADO_PROJECT not set)";
  const missing = [
    config.envOk.pat ? null : "ADO_PAT_B64",
    config.envOk.org ? null : "ADO_ORG",
    config.envOk.project ? null : "ADO_PROJECT",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    envBanner.hidden = false;
    envBanner.textContent = `Missing environment variables: ${missing.join(", ")}. Set them in the terminal that starts this server, then restart it.`;
  }
  const { files } = await api<{ files: RepoContext[] }>("/api/context");
  for (const repoFile of files) contextCards.push(buildContextCard(repoFile));
  setRunning(false);
  await refreshHistory();

  if (config.activeRunId) {
    const { meta } = await api<{ meta: RunMeta }>(`/api/runs/${config.activeRunId}`);
    if (meta.kind === "generate") {
      await watchGenerate(meta.id, meta.pbis ? meta.pbis.length + 3 : null, Date.parse(meta.startedAt));
    }
  }
};

init().catch((error) => showError(errorText(error)));

export {};
