// Maps `claude -p --output-format stream-json --verbose` lines to the few events the UI cares about.
// Shapes were taken from a real captured run (test/fixtures/stream-sample.jsonl):
//  - subagents are top-level `Agent` tool_use blocks with `input.subagent_type`
//  - events from inside a subagent carry `parent_tool_use_id` and are ignored here
//  - several `result` lines can appear; the last one is the final answer

export type StepState = "running" | "done" | "failed";

export type RunEvent =
  | { kind: "step"; id: string; label: string; state: StepState }
  | { kind: "note"; text: string }
  | { kind: "result"; text: string; isError: boolean; durationMs: number | null; costUsd: number | null };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null;

const MERGE_STEP_ID = "merge-and-write";
const MAX_NOTE_LENGTH = 300;

const labelForSubagent = (subagentType: string, prompt: string): string => {
  if (subagentType === "ado-fetcher") return "Fetching PBIs from Azure DevOps";
  if (subagentType === "tc-subagent") {
    const pbiId = /"pbi_id"\s*:\s*(\d+)/.exec(prompt)?.[1];
    return pbiId ? `Generating test cases for PBI ${pbiId}` : "Generating test cases";
  }
  if (subagentType === "push-agent") return "Pushing test cases to Azure DevOps";
  return `Running ${subagentType}`;
};

export const createEventMapper = () => {
  const openSteps = new Set<string>();
  let generationStarted = false;
  let mergeStarted = false;

  const map = (line: string): RunEvent[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObject(parsed)) return [];
    const events: RunEvent[] = [];

    if (parsed.type === "result") {
      events.push({
        kind: "result",
        text: typeof parsed.result === "string" ? parsed.result : "",
        isError: parsed.is_error === true,
        durationMs: typeof parsed.duration_ms === "number" ? parsed.duration_ms : null,
        costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
      });
      return events;
    }

    // Anything that happens inside a subagent belongs to that subagent's step, not to the run overview.
    if (parsed.parent_tool_use_id) return events;
    if (!isObject(parsed.message) || !Array.isArray(parsed.message.content)) return events;

    for (const block of parsed.message.content) {
      if (!isObject(block)) continue;

      if (parsed.type === "assistant" && block.type === "text" && typeof block.text === "string") {
        const text = block.text.trim();
        if (text) events.push({ kind: "note", text: text.slice(0, MAX_NOTE_LENGTH) });
      }

      if (parsed.type === "assistant" && block.type === "tool_use" && typeof block.id === "string") {
        const input = isObject(block.input) ? block.input : {};
        const id = block.id;
        const name = String(block.name);

        if ((name === "Agent" || name === "Task") && typeof input.subagent_type === "string") {
          if (input.subagent_type === "tc-subagent") generationStarted = true;
          openSteps.add(id);
          events.push({
            kind: "step",
            id,
            label: labelForSubagent(input.subagent_type, String(input.prompt ?? "")),
            state: "running",
          });
        } else if (name === "Skill" && input.skill === "ado-schema") {
          openSteps.add(id);
          events.push({ kind: "step", id, label: "Loading the ADO schema", state: "running" });
        } else if (generationStarted && !mergeStarted && ["Write", "PowerShell", "Bash"].includes(name)) {
          // After the per-PBI subagents the coordinator merges and writes the CSV with plain tools.
          mergeStarted = true;
          openSteps.add(MERGE_STEP_ID);
          events.push({ kind: "step", id: MERGE_STEP_ID, label: "Merging and writing the CSV", state: "running" });
        }
      }

      if (parsed.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
        if (openSteps.delete(block.tool_use_id)) {
          const failed = block.is_error === true;
          events.push({
            kind: "step",
            id: block.tool_use_id,
            label: "",
            state: failed ? "failed" : "done",
          });
        }
      }
    }
    return events;
  };

  // Called when the process exits: anything still open is closed so the UI does not spin forever.
  // Closing events carry an empty label; the client keeps the label from the "running" event.
  const finish = (state: Exclude<StepState, "running">): RunEvent[] => {
    const closing = [...openSteps].map((id): RunEvent => ({ kind: "step", id, label: "", state }));
    openSteps.clear();
    return closing;
  };

  return { map, finish };
};

const CSV_PATH_PATTERN = /output\/tc_\d{4}-\d{2}-\d{2}(?:_v\d+)?\.csv/;

export const extractCsvPath = (resultText: string): string | null =>
  CSV_PATH_PATTERN.exec(resultText.replace(/\\/g, "/"))?.[0] ?? null;
