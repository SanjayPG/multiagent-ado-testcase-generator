import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { CsvFormatError, parseTestCases, pbiIdFromTitle } from "../src/csv.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(path.join(here, "fixtures", "tc-sample.csv"), "utf8");

describe("parseTestCases", () => {
  const testCases = parseTestCases(sample);
  const rawRows: string[][] = parse(sample, { bom: true, skip_empty_lines: true });

  it("keeps the UTF-8 BOM in the fixture, as the pipeline writes it", () => {
    expect(sample.charCodeAt(0)).toBe(0xfeff);
  });

  it("groups step rows under their test case", () => {
    const testCaseRows = rawRows.slice(1).filter((row) => row[1] === "Test Case").length;
    expect(testCases).toHaveLength(testCaseRows);
    expect(testCases.reduce((sum, tc) => sum + tc.steps.length, 0)).toBe(rawRows.length - 1);
  });

  it("reads the metadata from the first row of each test case", () => {
    for (const tc of testCases) {
      expect(tc.title).toMatch(/^\[TC-\d+-(POS|NEG|EDGE|PERF|BOUND)-\d+\]/);
      expect(tc.pbiId).not.toBeNull();
      expect(tc.steps.length).toBeGreaterThan(0);
      expect(tc.steps[0].n).toBe(1);
    }
  });

  it("ends every test case with a TEST PASS step", () => {
    for (const tc of testCases) {
      expect(tc.steps[tc.steps.length - 1].expected).toContain("TEST PASS");
    }
  });

  it("keeps a script-injection string as plain text for the UI to escape", () => {
    const header = rawRows[0].join(",");
    const risky = `${header}\n,Test Case,[TC-9-EDGE-01] Handles script text,Design,,2,edge-case,,Not Automated,None,N/A,Edge Case,1,"Type ""<script>alert(1)</script>"" into the Email field",Text is shown literally\n`;
    const [tc] = parseTestCases(risky);
    expect(tc.steps[0].action).toContain("<script>alert(1)</script>");
    expect(tc.pbiId).toBe(9);
  });
});

describe("parseTestCases errors", () => {
  it("rejects a CSV with the wrong header", () => {
    expect(() => parseTestCases("a,b,c\n1,2,3\n")).toThrow(CsvFormatError);
  });

  it("rejects an empty file", () => {
    expect(() => parseTestCases("")).toThrow(CsvFormatError);
  });
});

describe("pbiIdFromTitle", () => {
  it("extracts the PBI id", () => {
    expect(pbiIdFromTitle("[TC-2-POS-01] Login succeeds")).toBe(2);
    expect(pbiIdFromTitle("no id here")).toBeNull();
  });
});
