import { describe, expect, it } from "vitest";
import { explainFailure } from "../src/failure.js";
import { parseSkipped } from "../src/skipped.js";

describe("parseSkipped", () => {
  it("reads the id and the reason from a skip line", () => {
    expect(parseSkipped("Done.\n[SKIP] PBI-9: Bug is not a PBI\n")).toEqual([{ id: 9, reason: "Bug is not a PBI" }]);
  });

  it("reads several lines, and keeps the first reason for an id that repeats", () => {
    const text = "[SKIP] PBI-9: Bug is not a PBI\n[SKIP] PBI-12: Task is not a PBI\n[SKIP] PBI-9: fetch failed";
    expect(parseSkipped(text)).toEqual([
      { id: 9, reason: "Bug is not a PBI" },
      { id: 12, reason: "Task is not a PBI" },
    ]);
  });

  it("copes with markdown around the line and a trailing full stop", () => {
    expect(parseSkipped("- **[SKIP] PBI-9: Bug is not a PBI**.")).toEqual([{ id: 9, reason: "Bug is not a PBI" }]);
    expect(parseSkipped("`[SKIP] PBI-4: Epic is not a PBI.`")).toEqual([{ id: 4, reason: "Epic is not a PBI" }]);
  });

  it("ignores text that is not a skip line", () => {
    expect(parseSkipped("Generated 8 test cases for PBI 9.")).toEqual([]);
    expect(parseSkipped("[SKIP] PBI-9:")).toEqual([]);
    expect(parseSkipped("")).toEqual([]);
  });

  it("keeps a very long reason short", () => {
    expect(parseSkipped(`[SKIP] PBI-1: ${"x".repeat(500)}`)[0]?.reason.length).toBe(200);
  });
});

describe("the not-a-PBI explanation", () => {
  it("recognises the skip line the coordinator writes", () => {
    const hint = explainFailure("[SKIP] PBI-9: Bug is not a PBI\nNo PBIs were left, so I stopped.");
    expect(hint?.title).toBe("That work item is not a PBI");
    expect(hint?.steps.join(" ")).toContain("Product Backlog Item");
  });

  it("does not claim a PBI that failed to fetch is a non-PBI", () => {
    expect(explainFailure("[SKIP] PBI-9: fetch failed")?.title).not.toBe("That work item is not a PBI");
  });
});
