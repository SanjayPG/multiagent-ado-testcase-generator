// The coordinator reports ids it left out as `[SKIP] PBI-9: Bug is not a PBI` (see CLAUDE.md, Step 7).
export type SkippedItem = { id: number; reason: string };

const SKIP_LINE = /\[SKIP\]\s*PBI-(\d+):\s*([^\n]+)/g;
const MAX_REASON_LENGTH = 200;

export const parseSkipped = (text: string): SkippedItem[] => {
  const found = new Map<number, string>();
  for (const match of text.matchAll(SKIP_LINE)) {
    const id = Number(match[1]);
    // Claude often wraps the line in markdown (`**`, backticks) or ends it with a full stop.
    const reason = (match[2] ?? "").replace(/[*`]/g, "").trim().replace(/\.$/, "").slice(0, MAX_REASON_LENGTH);
    if (!found.has(id) && reason !== "") found.set(id, reason);
  }
  return [...found].map(([id, reason]) => ({ id, reason }));
};
