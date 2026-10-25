import type { TestCase } from "./csv.js";

export type ChangeSummary = {
  originalCount: number;
  editedCount: number;
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
  newPbiIds: number[]; // PBI ids that appear in the edited file but not in the original run
};

const MAX_LISTED = 100;

const fingerprint = (testCase: TestCase): string =>
  JSON.stringify([
    testCase.testType,
    testCase.priority,
    testCase.tags,
    testCase.description,
    testCase.testData,
    testCase.steps.map((step) => [step.action, step.expected]),
  ]);

// Test cases are matched by title: that is also how the push skips duplicates.
export const diffTestCases = (original: TestCase[], edited: TestCase[]): ChangeSummary => {
  const originalByTitle = new Map(original.map((testCase) => [testCase.title, testCase]));
  const editedTitles = new Set(edited.map((testCase) => testCase.title));

  const added: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  for (const testCase of edited) {
    const before = originalByTitle.get(testCase.title);
    if (!before) added.push(testCase.title);
    else if (fingerprint(before) !== fingerprint(testCase)) changed.push(testCase.title);
    else unchanged += 1;
  }
  const removed = original.filter((testCase) => !editedTitles.has(testCase.title)).map((testCase) => testCase.title);

  const originalPbis = new Set(original.map((testCase) => testCase.pbiId));
  const newPbiIds = [...new Set(edited.map((testCase) => testCase.pbiId))]
    .filter((id): id is number => id !== null && !originalPbis.has(id))
    .sort((a, b) => a - b);

  return {
    originalCount: original.length,
    editedCount: edited.length,
    added: added.slice(0, MAX_LISTED),
    removed: removed.slice(0, MAX_LISTED),
    changed: changed.slice(0, MAX_LISTED),
    unchanged,
    newPbiIds,
  };
};
