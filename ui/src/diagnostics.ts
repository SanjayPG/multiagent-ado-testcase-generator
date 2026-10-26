import { config, getEnvStatus, getOrgName, getProjectName } from "./config.js";
import { readEvents, readLog, readMeta } from "./store.js";
import { redactSecrets } from "./summary.js";

const yesNo = (value: boolean): string => (value ? "set" : "MISSING");

// One plain-text file a teammate can send: what the run was, what it concluded, and everything it printed.
// It never contains secret values, only whether each setting is set.
export const buildDiagnostics = async (id: string): Promise<string | null> => {
  const meta = await readMeta(id);
  if (!meta) return null;
  const events = await readEvents(id);
  const log = await readLog(id);
  const env = getEnvStatus();

  const steps = new Map<string, { label: string; state: string }>();
  const notes: string[] = [];
  for (const event of events) {
    if (event.kind === "step") {
      const known = steps.get(event.id);
      steps.set(event.id, { label: event.label || known?.label || event.id, state: event.state });
    } else if (event.kind === "note") {
      notes.push(event.text);
    }
  }

  const lines = [
    "tc-generator diagnostics",
    `generated: ${new Date().toISOString()}`,
    "Review this file before you share it: it can contain project and work item details.",
    "",
    "== Run ==",
    `id: ${meta.id}`,
    `kind: ${meta.kind}`,
    `status: ${meta.status}`,
    `started: ${meta.startedAt}`,
    `finished: ${meta.finishedAt ?? "-"}`,
    `PBIs: ${meta.pbis?.join(", ") ?? "-"}`,
    `error: ${meta.errorMessage ?? "-"}`,
    `likely cause: ${meta.errorHint ? `${meta.errorHint.title}\n  - ${meta.errorHint.steps.join("\n  - ")}` : "-"}`,
    "",
    "== Environment ==",
    `node: ${process.version} on ${process.platform}`,
    `claude command: ${config.claudeBin}`,
    `repo root: ${config.repoRoot}`,
    `ADO_ORG: ${getOrgName() || "MISSING"}`,
    `ADO_PROJECT: ${getProjectName() || "MISSING"}`,
    `ADO_PAT_B64: ${yesNo(env.pat)}`,
    "",
    "== Steps ==",
    ...(steps.size > 0 ? [...steps.values()].map((step) => `[${step.state}] ${step.label}`) : ["(none recorded)"]),
    "",
    "== Claude's notes ==",
    ...(notes.length > 0 ? notes : ["(none recorded)"]),
    "",
    "== Other places to look ==",
    "Claude Code keeps its own full transcript of every run: ~/.claude/projects/<this project's folder>/*.jsonl",
    "The Azure DevOps connection log: %LOCALAPPDATA%\\claude-cli-nodejs\\Cache\\<this project's folder>\\mcp-logs-ado\\",
    "",
    "== Full log ==",
    log ?? "(no log was saved for this run)",
  ];
  // Belt and braces: the log is already redacted line by line, and this covers everything else.
  return redactSecrets(lines.join("\n"));
};
