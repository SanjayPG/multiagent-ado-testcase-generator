import type { PushSummary } from "./store.js";

const firstNumber = (pattern: RegExp, text: string): number | null => {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : null;
};

// Best effort only: the push-agent reports "created N, linked N, failed: [list]" in prose.
// The UI always shows the raw text next to this, so a miss here is never silent.
export const parsePushSummary = (text: string): PushSummary => {
  const failed = /failed\s*:?\s*([^\n]*)/i.exec(text)?.[1]?.trim().replace(/[.*`]+$/g, "") ?? null;
  return {
    created: firstNumber(/created\s*:?\s*\**\s*(\d+)/i, text),
    linked: firstNumber(/linked\s*:?\s*\**\s*(\d+)/i, text),
    failed: failed === "" ? null : failed,
  };
};

// ADO_PAT_B64 is base64 of "<email>:<pat>". Hide that value, the decoded pair, and the bare token,
// because a log can contain any of the three.
const secretValues = (): string[] => {
  const encoded = process.env.ADO_PAT_B64;
  if (!encoded) return [];
  const values = [encoded];
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  // Only trust the decode if it really looks like "<something>:<token>".
  if (/^[^:\s]+:\S+$/.test(decoded)) {
    values.push(decoded, decoded.slice(decoded.indexOf(":") + 1));
  }
  // Longest first, so the pair is replaced before the token inside it.
  return values.filter((value) => value.length > 8).sort((a, b) => b.length - a.length);
};

// Never echo a secret back to the browser, even inside an error message or a log.
export const redactSecrets = (text: string): string =>
  secretValues().reduce((acc, secret) => acc.split(secret).join("***"), text);
