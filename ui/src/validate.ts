export class ValidationError extends Error {}

export const CONTEXT_FLAGS = ["hld", "regression"] as const;
export type ContextFlag = (typeof CONTEXT_FLAGS)[number];

const RUN_ID_PATTERN = /^[a-z0-9-]{8,64}$/;

export const parsePbis = (input: unknown, max: number): number[] => {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ValidationError("Enter at least one PBI id.");
  }
  const ids = input.map((value) => {
    const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) {
      throw new ValidationError(`Invalid PBI id: ${JSON.stringify(value)}. PBI ids must be positive whole numbers.`);
    }
    return n;
  });
  const unique = [...new Set(ids)];
  if (unique.length > max) {
    throw new ValidationError(`Too many PBIs (${unique.length}). The limit is ${max} per run.`);
  }
  return unique;
};

export const isRunId = (value: unknown): value is string =>
  typeof value === "string" && RUN_ID_PATTERN.test(value);

// Only validated values reach these builders, so nothing user-typed is ever interpreted by a shell.
export const buildGeneratePrompt = (
  pbis: number[],
  context: ContextFlag[],
  files: Partial<Record<ContextFlag, string>> = {},
): string => {
  const base = `/generate-test-cases --pbis ${pbis.join(",")}`;
  if (context.length === 0) return base;
  // The file paths are repo-relative paths under this run's own folder (run ids contain no spaces).
  const fileFlags = context.filter((kind) => files[kind]).map((kind) => ` --${kind}-file ${files[kind]}`);
  return `${base} --context ${context.join(",")}${fileFlags.join("")}`;
};

// The path is repo-relative with forward slashes; runId is validated, so it contains no spaces or separators.
export const buildPushPrompt = (
  runId: string,
  relativeRunsDir = "ui/.data/runs",
  fileName: "tc.csv" | "upload.csv" = "tc.csv",
): string => {
  if (!isRunId(runId)) throw new ValidationError("Invalid run id.");
  return `/push-test-cases --file ${relativeRunsDir}/${runId}/${fileName} --yes`;
};
