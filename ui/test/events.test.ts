import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEventMapper, extractCsvPath, type RunEvent } from "../src/events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(path.join(here, "fixtures", "stream-sample.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "");

const replay = () => {
  const { map, finish } = createEventMapper();
  const events = lines.flatMap((line) => map(line));
  return { events, closing: finish("done") };
};

describe("event mapper on a real captured run", () => {
  const { events, closing } = replay();
  const steps = events.filter((e): e is Extract<RunEvent, { kind: "step" }> => e.kind === "step");
  const started = steps.filter((e) => e.state === "running");

  it("shows the fetcher, the schema, one step per PBI, and the merge", () => {
    const labels = started.map((e) => e.label);
    expect(labels).toContain("Fetching PBIs from Azure DevOps");
    expect(labels).toContain("Loading the ADO schema");
    expect(labels).toContain("Generating test cases for PBI 2");
    expect(labels).toContain("Generating test cases for PBI 3");
    expect(labels).toContain("Merging and writing the CSV");
  });

  it("does not show anything that happened inside a subagent", () => {
    expect(started.filter((e) => e.label.includes("SubagentHandback"))).toHaveLength(0);
    expect(started.filter((e) => e.label.startsWith("Running"))).toHaveLength(0);
  });

  it("finishes every step that it started", () => {
    const finishedIds = new Set([...steps.filter((e) => e.state !== "running"), ...closing].map((e) => (e as { id: string }).id));
    for (const step of started) expect(finishedIds.has(step.id)).toBe(true);
  });

  it("ends with a successful result that names the CSV", () => {
    const results = events.filter((e): e is Extract<RunEvent, { kind: "result" }> => e.kind === "result");
    const last = results[results.length - 1];
    expect(last.isError).toBe(false);
    expect(last.durationMs).toBeGreaterThan(0);
    expect(extractCsvPath(last.text)).toMatch(/^output\/tc_\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("ignores garbage lines", () => {
    const { map } = createEventMapper();
    expect(map("not json")).toEqual([]);
    expect(map("[]")).toEqual([]);
  });
});

describe("extractCsvPath", () => {
  it("finds the path with either slash style and rejects traversal", () => {
    expect(extractCsvPath("wrote output\\tc_2026-10-18_v2.csv today")).toBe("output/tc_2026-10-18_v2.csv");
    expect(extractCsvPath("see ../secrets.csv")).toBeNull();
  });
});
