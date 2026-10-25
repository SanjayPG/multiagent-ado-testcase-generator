import { describe, expect, it } from "vitest";
import {
  ValidationError,
  buildGeneratePrompt,
  buildPushPrompt,
  isRunId,
  parsePbis,
} from "../src/validate.js";

describe("parsePbis", () => {
  it("accepts numbers and digit strings, and removes duplicates", () => {
    expect(parsePbis([2, "3", 2], 20)).toEqual([2, 3]);
  });

  it.each([
    ["empty list", []],
    ["not a list", "2,3"],
    ["zero", [0]],
    ["negative", [-1]],
    ["decimal", [1.5]],
    ["shell injection", ["1;rm -rf /"]],
    ["flag injection", ["2 --dangerous"]],
    ["object", [{ id: 2 }]],
  ])("rejects %s", (_name, input) => {
    expect(() => parsePbis(input, 20)).toThrow(ValidationError);
  });

  it("enforces the per-run limit", () => {
    const many = Array.from({ length: 21 }, (_, i) => i + 1);
    expect(() => parsePbis(many, 20)).toThrow(/Too many PBIs/);
  });
});

describe("prompt builders", () => {
  it("builds the generate command exactly like the terminal slash command", () => {
    expect(buildGeneratePrompt([2, 3], [])).toBe("/generate-test-cases --pbis 2,3");
    expect(buildGeneratePrompt([2, 3], ["hld", "regression"])).toBe(
      "/generate-test-cases --pbis 2,3 --context hld,regression",
    );
  });

  it("points a context kind at its own file only when one was prepared", () => {
    expect(buildGeneratePrompt([2], ["hld", "regression"], { hld: "ui/.data/runs/run-20261018-abc123/context-hld.md" })).toBe(
      "/generate-test-cases --pbis 2 --context hld,regression --hld-file ui/.data/runs/run-20261018-abc123/context-hld.md",
    );
  });

  it("never adds a file flag for a kind that is not in the context list", () => {
    expect(buildGeneratePrompt([2], [], { hld: "x/context-hld.md" })).toBe("/generate-test-cases --pbis 2");
  });

  it("builds the push command from a validated run id only", () => {
    expect(buildPushPrompt("run-20261018-abc123")).toBe(
      "/push-test-cases --file ui/.data/runs/run-20261018-abc123/tc.csv --yes",
    );
    expect(() => buildPushPrompt("../../output/x")).toThrow(ValidationError);
  });
});

describe("isRunId", () => {
  it("accepts generated ids and rejects path-like input", () => {
    expect(isRunId("run-20261018-abc123")).toBe(true);
    expect(isRunId("../x")).toBe(false);
    expect(isRunId("RUN-UPPER")).toBe(false);
    expect(isRunId(undefined)).toBe(false);
  });
});
