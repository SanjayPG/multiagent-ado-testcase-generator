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

// Never echo a secret back to the browser, even inside an error message.
export const redactSecrets = (text: string): string => {
  const secrets = [process.env.ADO_PAT_B64].filter((value): value is string => Boolean(value) && value!.length > 8);
  return secrets.reduce((acc, secret) => acc.split(secret).join("***"), text);
};
