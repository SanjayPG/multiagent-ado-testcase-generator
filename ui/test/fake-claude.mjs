// A stand-in for the `claude` CLI so tests never touch Azure DevOps or spend tokens.
// It replays a real captured run (fixtures/stream-sample.jsonl) and writes the matching CSV.
//   FAKE_CLAUDE_MODE=ok (default) | fail | hang | mcp-timeout   (a run for PBI 99 behaves like mcp-timeout)
//   FAKE_CLAUDE_DELAY_MS=<ms between replayed lines>   FAKE_CLAUDE_LOG=<file that receives the prompt>
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] ?? "";
const mode =
  process.env.FAKE_CLAUDE_MODE ?? (/--pbis\s+99\b/.test(prompt) ? "mcp-timeout" : /--pbis\s+98\b/.test(prompt) ? "not-a-pbi" : "ok");
const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 20);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${prompt}\n`);

if (mode === "fail") {
  console.error("fake claude: simulated failure");
  process.exit(1);
}
if (mode === "hang") {
  await new Promise(() => setInterval(() => undefined, 1000));
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (mode === "leak") {
  // A run that prints the token everywhere it could end up, to prove the saved log hides it.
  const token = process.env.ADO_PAT_B64 ?? "";
  console.error(`debug: connecting with ${token}`);
  emit({ type: "assistant", message: { content: [{ type: "text", text: `using ${token}` }] } });
  emit({ type: "result", subtype: "error", is_error: true, duration_ms: 1, total_cost_usd: 0, result: `failed with ${token}` });
  await sleep(100);
  process.exit(1);
}

if (mode === "not-a-pbi") {
  // Every id was a Bug (or similar): the coordinator stops and writes no CSV.
  const text = "I did not generate any test cases.\n[SKIP] PBI-98: Bug is not a PBI\nNo PBIs were left, so I stopped and wrote no CSV.";
  emit({ type: "system", subtype: "init", session_id: "fake" });
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  emit({ type: "result", subtype: "success", is_error: false, duration_ms: 4000, total_cost_usd: 0.01, result: text });
  await sleep(100);
  process.exit(0);
}

if (mode === "mcp-timeout") {
  // What really happened when the ado server could not connect: Claude explains, exits 0, and no CSV exists.
  const explanation = [
    "I couldn't generate test cases for PBI 99. The pipeline stopped at Step 2 (fetching from Azure DevOps).",
    "The `ado` MCP server timed out when connecting (`CONNECT_TIMEOUT` after 30 seconds), so the ado-fetcher agent had no tools.",
    "",
    "| Type | Count |",
    "|---|---|",
    "| Positive | 0 |",
  ].join("\n");
  emit({ type: "system", subtype: "init", session_id: "fake" });
  emit({ type: "assistant", message: { content: [{ type: "text", text: explanation }] } });
  console.error("fake claude: MCP server ado: CONNECT_TIMEOUT");
  emit({ type: "result", subtype: "success", is_error: false, duration_ms: 31000, total_cost_usd: 0.02, result: explanation });
  await sleep(100); // let a piped stdout drain before exiting
  process.exit(0);
}

if (prompt.startsWith("/generate-test-cases")) {
  // Same text as the real pipeline writes, plus one edge case whose steps contain markup,
  // so the UI's escaping is exercised on every run.
  const sample = readFileSync(path.join(here, "fixtures", "tc-sample.csv"), "utf8");
  // The pipeline's CSV uses Windows line endings; a row delimiter that differs from the file's own would merge rows.
  const eol = sample.includes("\r\n") ? "\r\n" : "\n";
  const injection = [
    `,Test Case,[TC-2-EDGE-99] Login handles script text in the Email field,Design,,2,"edge-case, security",,Not Automated,• None,N/A,Edge Case,1,"Type ""<script>alert(1)</script>"" into the Email field",Text is shown literally and no script runs`,
    `,,,,,,,,,,,,2,Observe the page,TEST PASS — no alert dialog appears`,
  ].join(eol) + eol;
  const outDir = path.join(process.cwd(), "output");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "tc_2026-10-18.csv"), (sample.endsWith("\n") ? sample : sample + eol) + injection);

  const lines = readFileSync(path.join(here, "fixtures", "stream-sample.jsonl"), "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
    await sleep(delay);
  }
  // A mixed request such as "2,97": the real pipeline finishes for the PBIs and reports the Bug it left out.
  if (/--pbis\s+[\d,]*\b97\b/.test(prompt)) {
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1000,
      total_cost_usd: 0.1,
      result: "Generated 24 test cases and wrote them to `output/tc_2026-10-18.csv`.\n\n[SKIP] PBI-97: Bug is not a PBI",
    });
  }
} else if (prompt.startsWith("/push-test-cases")) {
  emit({ type: "system", subtype: "init", session_id: "fake" });
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "push1", name: "Agent", input: { subagent_type: "push-agent", prompt: "{}" } }] } });
  await sleep(delay);
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "push1", content: "ok" }] } });
  emit({ type: "result", subtype: "success", is_error: false, duration_ms: 1234, total_cost_usd: 0.1, result: "Push finished: created 24, linked 24, failed: none" });
} else {
  console.error(`fake claude: unsupported prompt ${prompt}`);
  process.exit(2);
}
