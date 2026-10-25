import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { GeneratorPage } from "./pages/GeneratorPage";

test.describe("test case generator UI", () => {
  let generator: GeneratorPage;

  test.beforeEach(async ({ page }) => {
    generator = new GeneratorPage(page);
    await generator.goto();
  });

  test("shows the configured project and no environment warning", async () => {
    await expect(generator.projectName).toHaveText("TestProject");
    await expect(generator.envBanner).toBeHidden();
  });

  test("rejects a bad PBI id with a clear message", async () => {
    await generator.generate("abc");
    await expect(generator.errorBanner).toContainText("Invalid PBI id");
  });

  test("generates test cases and shows progress per step", async () => {
    await generator.generateAndWaitForResults();

    await expect(generator.steps.filter({ hasText: "Fetching PBIs from Azure DevOps" })).toHaveAttribute("data-state", "done");
    await expect(generator.steps.filter({ hasText: "Generating test cases for PBI 2" })).toHaveAttribute("data-state", "done");
    await expect(generator.steps.filter({ hasText: "Generating test cases for PBI 3" })).toHaveAttribute("data-state", "done");
    await expect(generator.steps.filter({ hasText: "Merging and writing the CSV" })).toHaveAttribute("data-state", "done");
    expect(await generator.testCases.count()).toBeGreaterThan(20);
    await expect(generator.history.first()).toContainText("generate · done");
  });

  test("shows what each context option points at before anything is chosen", async () => {
    await expect(generator.contextOptions("hld")).toBeHidden();

    await generator.contextInclude("hld").check();
    await expect(generator.contextOptions("hld")).toContainText("Use context/hld.md");
    await expect(generator.contextSource("hld", "repo")).toBeChecked();
    await expect(generator.contextOptions("hld")).toContainText("Preview context/hld.md");
    await generator.contextOptions("hld").getByText("Preview context/hld.md").click();
    await expect(generator.contextOptions("hld")).toContainText("Sessions expire after 30 minutes");

    await generator.contextInclude("regression").check();
    await expect(generator.contextOptions("regression")).toContainText("Use context/regression-scripts.md");
  });

  test("uses the repo's context file when that is what was chosen", async () => {
    await generator.useContext("hld", "repo");
    await generator.generateAndWaitForResults();
    await expect(generator.contextUsed).toContainText("HLD — context/hld.md");
  });

  test("runs with an uploaded document and says so in the review", async () => {
    await generator.useContext("hld", "upload");
    await generator.contextFile("hld").setInputFiles({ name: "my-hld.md", mimeType: "text/markdown", buffer: Buffer.from("# My HLD\n\nLock after 5 attempts.") });
    await expect(generator.contextFileInfo("hld")).toContainText("my-hld.md");

    await generator.generateAndWaitForResults();

    await expect(generator.contextUsed).toContainText('HLD — your uploaded file "my-hld.md"');
  });

  test("asks for a document or a URL when that source is chosen but left empty", async () => {
    await generator.useContext("hld", "upload");
    await generator.generate("2");
    await expect(generator.errorBanner).toContainText("HLD: choose a document");

    await generator.contextSource("hld", "url").check();
    await generator.generateButton.click();
    await expect(generator.errorBanner).toContainText("HLD: enter a URL");
    await expect(generator.progressSection).toBeHidden();
  });

  test("refuses a URL that points at this machine, and does not start a run", async () => {
    await generator.useContext("hld", "url");
    await generator.contextUrlInput("hld").fill("http://127.0.0.1/internal-admin");
    await generator.generate("2");

    await expect(generator.errorBanner).toContainText("HLD:");
    await expect(generator.errorBanner).toContainText("private or internal");
    await expect(generator.progressSection).toBeHidden();
    await expect(generator.generateButton).toBeEnabled();
  });

  test("turns away a document that is too large before sending it", async () => {
    await generator.useContext("hld", "upload");
    await generator.contextFile("hld").setInputFiles({ name: "huge.txt", mimeType: "text/plain", buffer: Buffer.alloc(300 * 1024, "a") });
    await expect(generator.contextFileInfo("hld")).toContainText("the limit is 200 KB");
  });

  test("shows a progress bar that counts the steps and ends full", async () => {
    await generator.generate("2, 3");

    // Two PBIs: fetch + schema + 2 generators + merge = 5 steps, known before the first one finishes.
    await expect(generator.progressBar).toHaveAttribute("max", "5");
    await expect(generator.progressLabel).toContainText("of 5 steps");

    await expect(generator.summary).toContainText("test cases", { timeout: 20_000 });
    await expect(generator.progressBar).toHaveAttribute("value", "5");
    await expect(generator.progressLabel).toContainText("Finished in");
  });

  test("shows markup in a test case as plain text and never runs it", async ({ page }) => {
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });

    await generator.generateAndWaitForResults();
    const testCase = generator.testCaseByTitle("EDGE-99");
    await testCase.locator("summary").click();

    await expect(testCase).toContainText("<script>alert(1)</script>");
    expect(await page.locator("#testcases script").count()).toBe(0);
    expect(dialogs).toEqual([]);
  });

  test("filters by type and by text", async () => {
    await generator.generateAndWaitForResults();
    const all = await generator.testCases.count();

    await generator.typeFilter.selectOption("Edge Case");
    const edgeCount = await generator.testCases.count();
    expect(edgeCount).toBeGreaterThan(0);
    expect(edgeCount).toBeLessThan(all);

    await generator.typeFilter.selectOption("");
    await generator.textFilter.fill("EDGE-99");
    await expect(generator.testCases).toHaveCount(1);
  });

  test("downloads the ADO CSV with its UTF-8 BOM and header", async ({ page }) => {
    await generator.generateAndWaitForResults();
    const [download] = await Promise.all([page.waitForEvent("download"), generator.downloadLink.click()]);
    const file = await download.path();
    const bytes = await readFile(file);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toContain("ID,Work Item Type,Title,State");
  });

  test("allows only one run at a time", async ({ page }) => {
    await generator.generate("2, 3");
    await expect(generator.cancelButton).toBeVisible();
    const second = await page.request.post("/api/runs", { data: { pbis: [2] } });
    expect(second.status()).toBe(409);
    await expect(generator.summary).toContainText("test cases", { timeout: 20_000 });
  });

  // One hand-written test case appended to the downloaded file, using the file's own line ending.
  const withCase = (csv: string, pbiId: number): string => {
    const eol = csv.includes(String.fromCharCode(13, 10)) ? String.fromCharCode(13, 10) : String.fromCharCode(10);
    const row = `,Test Case,[TC-${pbiId}-POS-99] Added by hand,Design,,2,positive,,Not Automated,None,N/A,Positive,1,Do a thing,TEST PASS — done`;
    return (csv.endsWith(eol) ? csv : csv + eol) + row + eol;
  };

  test("pushes an uploaded edited file instead of the original", async () => {
    await generator.generateAndWaitForResults();
    const original = await generator.downloadedCsv();

    await generator.uploadCsv("my-edits.csv", withCase(original, 2));

    await expect(generator.uploadPanel).toContainText("my-edits.csv");
    await expect(generator.uploadPanel).toContainText("1 added");
    await expect(generator.summary).toContainText("Your uploaded file");
    await generator.textFilter.fill("POS-99");
    await expect(generator.testCases).toHaveCount(1);

    await generator.pushWith("TestProject");
    await expect(generator.pushDialogText).toContainText("your uploaded file");
    await generator.pushConfirmButton.click();
    await expect(generator.pushSummary).toContainText("Pushed your uploaded file — Created 24", { timeout: 20_000 });
  });

  test("explains how to fix a file that Excel saved in the wrong encoding", async () => {
    await generator.generateAndWaitForResults();
    const original = await generator.downloadedCsv();

    await generator.uploadCsv("ansi.csv", Buffer.from(original.replaceAll("•", String.fromCharCode(0x95)), "latin1"));

    await expect(generator.errorBanner).toContainText("CSV UTF-8");
    await expect(generator.uploadPanel).toBeHidden();
  });

  test("goes back to the original when the upload is removed", async () => {
    await generator.generateAndWaitForResults();
    const original = await generator.downloadedCsv();
    await generator.uploadCsv("my-edits.csv", withCase(original, 2));
    await expect(generator.uploadPanel).toBeVisible();

    await generator.removeUploadButton.click();

    await expect(generator.uploadPanel).toBeHidden();
    await expect(generator.summary).not.toContainText("Your uploaded file");
    await generator.pushButton.click();
    await expect(generator.pushDialogText).toContainText("the original generated file");
  });

  test("warns when the edited file has test cases for a PBI that was not in the run", async () => {
    await generator.generateAndWaitForResults();
    const original = await generator.downloadedCsv();

    await generator.uploadCsv("other-pbi.csv", withCase(original, 77));

    await expect(generator.uploadWarnings).toContainText("PBI 77");
  });

  test("pushes only after the project name is typed exactly", async () => {
    await generator.generateAndWaitForResults();

    await generator.pushWith("testproject");
    await expect(generator.pushDialog).toBeVisible();
    await expect(generator.pushConfirmButton).toBeDisabled();

    await generator.pushConfirmInput.fill("TestProject");
    await expect(generator.pushConfirmButton).toBeEnabled();
    await generator.pushConfirmButton.click();

    await expect(generator.pushSummary).toContainText("Created 24 · linked 24 · failed: none", { timeout: 20_000 });
    await expect(generator.pushButton).toBeDisabled();
    await expect(generator.pushProgressLabel).toContainText("Finished in");
    await expect(generator.pushProgressBar).toHaveAttribute("value", "1");
  });

  test("shows the full log of a run and offers it, with the diagnostics, as downloads", async () => {
    await generator.generateAndWaitForResults();

    // The viewer shows the end of the log; the download has all of it, including the first line.
    await generator.openLog();
    await expect(generator.logView).toContainText("finished, exit code 0");

    const log = await generator.textOf(generator.logDownload);
    expect(log).toContain("started: claude -p /generate-test-cases --pbis 2,3");
    expect(log).toContain('"type":"result"');
    const diagnostics = await generator.textOf(generator.diagnosticsDownload);
    expect(diagnostics).toContain("ADO_PAT_B64: set");
    expect(diagnostics).toContain("== Full log ==");

    // The same two downloads stay available from the review, for a run opened later from the history.
    expect(await generator.textOf(generator.resultsLogLink)).toContain("finished, exit code 0");
  });

  test("explains an Azure DevOps connection failure in plain words and keeps the raw reason", async ({ page }) => {
    await generator.generate("99");

    await expect(generator.errorTitle).toHaveText("Couldn't connect to Azure DevOps", { timeout: 20_000 });
    await expect(generator.errorSteps).toContainText("ADO_PAT_B64");
    // The raw reason is folded away until asked for.
    await expect(generator.errorRaw).toBeHidden();
    await page.getByText("Technical details").click();
    await expect(generator.errorRaw).toContainText("no CSV file was found");

    expect(await generator.textOf(generator.errorLogLink)).toContain("CONNECT_TIMEOUT");
    expect(await generator.textOf(generator.errorDiagnosticsLink)).toContain("likely cause: Couldn't connect to Azure DevOps");
  });

  test("says which ids were skipped as not PBIs, and shows nothing when none were", async () => {
    await generator.generateAndWaitForResults("2, 97");
    await expect(generator.skipped).toBeVisible();
    await expect(generator.skipped).toContainText("Skipped PBI 97: Bug is not a PBI.");
    expect(await generator.testCases.count()).toBeGreaterThan(20);

    await generator.generateAndWaitForResults("2, 3");
    await expect(generator.skipped).toBeHidden();
  });

  test("explains that a Bug is not a PBI when every id was one", async () => {
    // The app accepts a CSV written in the last two seconds, so clear the one the previous test left behind.
    rmSync(path.resolve(".e2e-sandbox", "output"), { recursive: true, force: true });
    await generator.generate("98");

    await expect(generator.errorTitle).toHaveText("That work item is not a PBI", { timeout: 20_000 });
    await expect(generator.errorSteps).toContainText("Product Backlog Item");
    await expect(generator.testCases).toHaveCount(0);
  });

  test("keeps the line breaks and the table in Claude's notes", async ({ page }) => {
    await generator.generate("99");
    await expect(generator.errorTitle).toBeVisible({ timeout: 20_000 });

    await page.getByText("Claude's notes", { exact: true }).click();
    const note = generator.notes.first();
    await expect(note).toContainText("| Type | Count |");
    await expect(note).toHaveCSS("white-space", "pre-wrap");
    expect(await note.innerText()).toContain("\n|---|---|\n");
  });
});
