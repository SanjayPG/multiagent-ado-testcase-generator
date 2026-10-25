import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CsvFormatError, MAX_UPLOAD_BYTES, parseTestCases, validateUpload } from "../src/csv.js";
import { diffTestCases } from "../src/diff.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleBytes = readFileSync(path.join(here, "fixtures", "tc-sample.csv"));
const sampleText = sampleBytes.toString("utf8");
const originalCases = parseTestCases(sampleText);

describe("validateUpload", () => {
  it("accepts the pipeline's own CSV and keeps the bytes as uploaded", () => {
    const { text, testCases } = validateUpload(sampleBytes);
    expect(testCases).toHaveLength(originalCases.length);
    expect(text).toBe(sampleText);
  });

  it("accepts a file whose text was edited", () => {
    const edited = Buffer.from(sampleText.replace("Navigate to https://app.example.com/login", "Open https://app.example.com/login"));
    expect(validateUpload(edited).testCases).toHaveLength(originalCases.length);
  });

  it("rejects an empty file and an oversized file", () => {
    expect(() => validateUpload(Buffer.alloc(0))).toThrow(/empty/);
    expect(() => validateUpload(Buffer.alloc(MAX_UPLOAD_BYTES + 1, 65))).toThrow(/larger than/);
  });

  it("rejects Excel's default ANSI export with a fix", () => {
    const ansi = Buffer.from(sampleText.replaceAll("•", "\x95"), "latin1");
    expect(() => validateUpload(ansi)).toThrow(/not valid UTF-8.*CSV UTF-8/);
  });

  it("rejects semicolon-separated files with a fix", () => {
    const semicolons = Buffer.from(sampleText.replace(/^[^\r\n]*/, (header) => header.replaceAll(",", ";")));
    expect(() => validateUpload(semicolons)).toThrow(/semicolons/);
  });

  it("rejects a different header and a file with no test cases", () => {
    expect(() => validateUpload(Buffer.from("a,b,c\n1,2,3\n"))).toThrow(CsvFormatError);
    const headerOnly = sampleText.split(/\r?\n/)[0];
    expect(() => validateUpload(Buffer.from(`${headerOnly}\n`))).toThrow(/no test cases/);
  });

  it("rejects rows with the wrong number of columns", () => {
    expect(() => validateUpload(Buffer.from(`${sampleText}\n,Test Case,[TC-2-X-1] short row\n`))).toThrow(/could not be read as CSV/);
  });

  it("rejects a title without a PBI id, because the push links by that id", () => {
    const renamed = sampleText.replace("[TC-2-POS-01] Login succeeds with valid email and password", "Login succeeds");
    expect(() => validateUpload(Buffer.from(renamed))).toThrow(/must start with \[TC-<PBI id>/);
  });

  it("rejects a step with no action", () => {
    const eol = sampleText.includes("\r\n") ? "\r\n" : "\n";
    const lines = sampleText.split(eol);
    const header = lines[0];
    const row = `,Test Case,[TC-5-POS-01] No action,Design,,1,positive,,Not Automated,None,N/A,Positive,1,,Something happens${eol}`;
    expect(() => validateUpload(Buffer.from(header + eol + row))).toThrow(/step with no action/);
  });
});

describe("diffTestCases", () => {
  it("reports no changes for identical files", () => {
    const summary = diffTestCases(originalCases, parseTestCases(sampleText));
    expect(summary).toMatchObject({ added: [], removed: [], changed: [], newPbiIds: [], unchanged: originalCases.length });
  });

  it("detects changed, added and removed test cases and PBI ids that were not in the run", () => {
    const edited = structuredClone(originalCases);
    const [first, second] = edited;
    first.steps[0].action = "Open the login page";
    const removedTitle = second.title;
    edited.splice(1, 1);
    edited.push({ ...first, title: "[TC-99-POS-01] A new case for another PBI", pbiId: 99 });

    const summary = diffTestCases(originalCases, edited);
    expect(summary.changed).toEqual([first.title]);
    expect(summary.removed).toEqual([removedTitle]);
    expect(summary.added).toEqual(["[TC-99-POS-01] A new case for another PBI"]);
    expect(summary.newPbiIds).toEqual([99]);
    expect(summary.originalCount).toBe(originalCases.length);
    expect(summary.editedCount).toBe(originalCases.length);
  });
});
