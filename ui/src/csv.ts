import { parse } from "csv-parse/sync";

export const ADO_HEADER = [
  "ID",
  "Work Item Type",
  "Title",
  "State",
  "Assigned To",
  "Priority",
  "Tags",
  "Area Path",
  "Automated Status",
  "Description",
  "Test Data",
  "Test Type",
  "Step #",
  "Step Action",
  "Step Expected Result",
] as const;

export type TestStep = { n: number; action: string; expected: string };

export type TestCase = {
  title: string;
  pbiId: number | null;
  testType: string;
  priority: string;
  tags: string;
  description: string;
  testData: string;
  steps: TestStep[];
};

export class CsvFormatError extends Error {}

export const pbiIdFromTitle = (title: string): number | null => {
  const match = /^\[TC-(\d+)-/.exec(title.trim());
  return match ? Number(match[1]) : null;
};

// One test case spans several rows: the first carries the metadata, the rest only Step # / Action / Expected.
export const parseTestCases = (csvText: string): TestCase[] => {
  const rows: string[][] = parse(csvText, { bom: true, skip_empty_lines: true, relax_column_count: false });
  if (rows.length === 0) throw new CsvFormatError("The CSV is empty.");
  const [header, ...body] = rows;
  if (header.length !== ADO_HEADER.length || !ADO_HEADER.every((name, i) => header[i] === name)) {
    throw new CsvFormatError("The CSV header does not match the ADO import format.");
  }

  const testCases: TestCase[] = [];
  for (const row of body) {
    const [, workItemType, title, , , priority, tags, , , description, testData, testType, stepNo, action, expected] = row;
    if (workItemType === "Test Case") {
      testCases.push({
        title,
        pbiId: pbiIdFromTitle(title),
        testType,
        priority,
        tags,
        description,
        testData,
        steps: [],
      });
    }
    const current = testCases[testCases.length - 1];
    if (!current) throw new CsvFormatError("A step row appears before any test case row.");
    current.steps.push({ n: Number(stepNo), action, expected });
  }
  return testCases;
};

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// An uploaded file is untrusted and usually comes out of Excel, so be strict and say exactly how to fix it.
export const validateUpload = (bytes: Buffer): { text: string; testCases: TestCase[] } => {
  if (bytes.length === 0) throw new CsvFormatError("The file is empty.");
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new CsvFormatError(`The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`);
  }

  let text: string;
  try {
    // ignoreBOM keeps a leading BOM in the text so the stored file stays byte-for-byte what was uploaded.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CsvFormatError('The file is not valid UTF-8. In Excel use Save As → "CSV UTF-8 (Comma delimited)".');
  }

  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.includes(",") && firstLine.includes(";")) {
    throw new CsvFormatError('The file uses semicolons. In Excel use Save As → "CSV UTF-8 (Comma delimited)".');
  }

  let testCases: TestCase[];
  try {
    testCases = parseTestCases(text);
  } catch (error) {
    if (error instanceof CsvFormatError) throw error;
    throw new CsvFormatError(`The file could not be read as CSV: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (testCases.length === 0) throw new CsvFormatError("The file has no test cases.");
  for (const testCase of testCases) {
    if (testCase.pbiId === null) {
      throw new CsvFormatError(`"${testCase.title}" must start with [TC-<PBI id>-…]: the push links each test case to its PBI by that id.`);
    }
    if (testCase.steps.some((step) => step.action.trim() === "")) {
      throw new CsvFormatError(`"${testCase.title}" has a step with no action.`);
    }
  }
  return { text, testCases };
};
