import { describe, expect, it } from "vitest";
import { computeProgress, formatElapsed, progressLabel } from "../src/client/progress.js";

describe("computeProgress", () => {
  it("knows the total from the start, before any step has been seen", () => {
    expect(computeProgress([], 5)).toEqual({ done: 0, total: 5, indeterminate: false, failed: false });
  });

  it("is indeterminate only when nothing is known", () => {
    expect(computeProgress([], null).indeterminate).toBe(true);
    expect(computeProgress([], 0).indeterminate).toBe(true);
  });

  it("counts finished steps, and not the ones still running", () => {
    expect(computeProgress(["done", "running", "running", "done"], 5)).toMatchObject({ done: 2, total: 5 });
  });

  it("grows the total instead of going past 100% when more steps appear than expected", () => {
    const progress = computeProgress(["done", "done", "done", "running"], 3);
    expect(progress.total).toBe(4);
    expect(progress.done).toBeLessThanOrEqual(progress.total);
  });

  it("flags a failed step, and still counts it as finished", () => {
    expect(computeProgress(["done", "failed"], 5)).toMatchObject({ done: 2, failed: true });
  });
});

describe("formatElapsed", () => {
  it.each([
    [0, "0:00"],
    [999, "0:00"],
    [59_999, "0:59"],
    [61_000, "1:01"],
    [109_342, "1:49"],
    [3_600_000, "60:00"],
    [-500, "0:00"],
  ])("formats %i ms as %s", (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});

describe("progressLabel", () => {
  const running = computeProgress(["done", "running"], 5);

  it("shows steps and time while running", () => {
    expect(progressLabel(running, 42_000, "running")).toBe("1 of 5 steps · 0:42");
  });

  it("says it is starting before the first step", () => {
    expect(progressLabel(computeProgress([], null), 1500, "running")).toBe("Starting… 0:01");
  });

  it("reports the outcome and the time once the run is over", () => {
    expect(progressLabel(running, 109_000, "done")).toBe("Finished in 1:49");
    expect(progressLabel(running, 30_000, "failed")).toBe("Failed after 0:30");
    expect(progressLabel(running, 12_000, "cancelled")).toBe("Cancelled after 0:12");
    expect(progressLabel(running, 27_000, "stopped")).toBe("Stopped after 0:27");
  });
});
