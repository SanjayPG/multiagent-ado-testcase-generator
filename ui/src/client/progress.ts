// Pure progress maths for the progress bar. No DOM here, so it can be unit-tested.

export type StepState = "running" | "done" | "failed";
export type Outcome = "running" | "done" | "failed" | "cancelled";

export type Progress = {
  done: number; // steps that have finished (successfully or not)
  total: number; // steps expected, or the number seen so far if that is larger
  indeterminate: boolean; // nothing is known yet
  failed: boolean;
};

// The pipeline always has the same shape (fetch, schema, one step per PBI, merge), so the total is known up front.
// If more steps show up than expected, the total grows with them rather than the bar going past 100%.
export const computeProgress = (states: StepState[], expectedSteps: number | null): Progress => {
  const total = Math.max(expectedSteps ?? 0, states.length);
  return {
    done: states.filter((state) => state !== "running").length,
    total,
    indeterminate: total === 0,
    failed: states.includes("failed"),
  };
};

export const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export const progressLabel = (progress: Progress, elapsedMs: number, outcome: Outcome): string => {
  const elapsed = formatElapsed(elapsedMs);
  if (outcome === "done") return `Finished in ${elapsed}`;
  if (outcome === "failed") return `Failed after ${elapsed}`;
  if (outcome === "cancelled") return `Cancelled after ${elapsed}`;
  if (progress.indeterminate) return `Starting… ${elapsed}`;
  return `${progress.done} of ${progress.total} steps · ${elapsed}`;
};
