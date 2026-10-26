// Pure helpers for the regression tag. No DOM here, so they can be unit-tested.

// Tags is the CSV's comma separated column, for example "positive, auth, login, regression".
export const hasRegressionTag = (tags: string): boolean => tags.split(",").some((tag) => tag.trim().toLowerCase() === "regression");

// The generator names the script it matched in the description: "• Matches regression script: <name>".
export const matchedScript = (description: string): string | null => {
  // Claude often wraps the name in markdown (backticks, bold) or ends the line with a full stop.
  const name = /Matches regression script:\s*([^\n]+)/i.exec(description)?.[1]?.trim().replace(/^[*`]+|[*`.]+$/g, "");
  return name ? name : null;
};
