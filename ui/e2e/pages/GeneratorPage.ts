import { expect, type Locator, type Page } from "@playwright/test";

export type ContextKind = "hld" | "regression";
export type ContextSource = "repo" | "upload" | "url";

export class GeneratorPage {
  readonly projectName: Locator;
  readonly envBanner: Locator;
  readonly errorBanner: Locator;
  readonly pbiInput: Locator;
  readonly hldCheckbox: Locator;
  readonly generateButton: Locator;
  readonly cancelButton: Locator;
  readonly steps: Locator;
  readonly progressSection: Locator;
  readonly contextUsed: Locator;
  readonly progressBar: Locator;
  readonly progressLabel: Locator;
  readonly pushProgressBar: Locator;
  readonly pushProgressLabel: Locator;
  readonly summary: Locator;
  readonly typeFilter: Locator;
  readonly textFilter: Locator;
  readonly testCases: Locator;
  readonly downloadLink: Locator;
  readonly pushButton: Locator;
  readonly pushDialog: Locator;
  readonly pushConfirmInput: Locator;
  readonly pushConfirmButton: Locator;
  readonly pushSummary: Locator;
  readonly pushDialogText: Locator;
  readonly uploadInput: Locator;
  readonly uploadPanel: Locator;
  readonly uploadWarnings: Locator;
  readonly removeUploadButton: Locator;
  readonly history: Locator;

  constructor(private readonly page: Page) {
    this.projectName = page.getByTestId("project-name");
    this.envBanner = page.getByTestId("env-banner");
    this.errorBanner = page.getByTestId("error");
    this.pbiInput = page.getByRole("textbox", { name: /PBI ids/ });
    this.hldCheckbox = page.getByRole("checkbox", { name: "HLD" });
    this.generateButton = page.getByRole("button", { name: "Generate test cases" });
    this.cancelButton = page.getByRole("button", { name: "Cancel run" });
    this.steps = page.getByTestId("steps").getByTestId("step");
    this.progressSection = page.getByTestId("progress-section");
    this.contextUsed = page.getByTestId("context-used");
    this.progressBar = page.getByRole("progressbar", { name: "Run progress" });
    this.progressLabel = page.getByTestId("progress-label");
    this.pushProgressBar = page.getByRole("progressbar", { name: "Push progress" });
    this.pushProgressLabel = page.getByTestId("push-progress-label");
    this.summary = page.getByTestId("summary");
    this.typeFilter = page.getByTestId("filter-type");
    this.textFilter = page.getByTestId("filter-text");
    this.testCases = page.getByTestId("testcase");
    this.downloadLink = page.getByTestId("download-link");
    this.pushButton = page.getByTestId("push-button");
    this.pushDialog = page.getByRole("dialog");
    this.pushConfirmInput = page.getByTestId("push-confirm-input");
    this.pushConfirmButton = page.getByTestId("push-confirm-button");
    this.pushSummary = page.getByTestId("push-summary");
    this.pushDialogText = page.getByTestId("push-dialog-text");
    this.uploadInput = page.getByLabel(/Edited the file in Excel/);
    this.uploadPanel = page.getByTestId("upload-panel");
    this.uploadWarnings = page.getByTestId("upload-warnings");
    this.removeUploadButton = page.getByRole("button", { name: /Remove upload/ });
    this.history = page.getByTestId("history-item");
  }

  goto = async (): Promise<void> => {
    await this.page.goto("/");
    await expect(this.projectName).not.toHaveText("—");
  };

  generate = async (pbis: string): Promise<void> => {
    await this.pbiInput.fill(pbis);
    await this.generateButton.click();
  };

  generateAndWaitForResults = async (pbis = "2, 3"): Promise<void> => {
    await this.generate(pbis);
    await expect(this.summary).toContainText("test cases", { timeout: 20_000 });
  };

  testCaseByTitle = (text: string): Locator => this.testCases.filter({ hasText: text });

  contextInclude = (kind: ContextKind): Locator => this.page.getByTestId(`ctx-${kind}`);
  contextOptions = (kind: ContextKind): Locator => this.page.getByTestId(`ctx-${kind}-options`);
  contextSource = (kind: ContextKind, source: ContextSource): Locator => this.page.getByTestId(`ctx-${kind}-${source}`);
  contextFile = (kind: ContextKind): Locator => this.page.getByTestId(`ctx-${kind}-file`);
  contextFileInfo = (kind: ContextKind): Locator => this.page.getByTestId(`ctx-${kind}-file-info`);
  contextUrlInput = (kind: ContextKind): Locator => this.page.getByTestId(`ctx-${kind}-url-input`);

  // Ticks the box and picks where the document comes from.
  useContext = async (kind: ContextKind, source: ContextSource): Promise<void> => {
    await this.contextInclude(kind).check();
    await this.contextSource(kind, source).check();
  };

  // The CSV exactly as the page offers it for download, i.e. what a user would open in Excel.
  downloadedCsv = async (): Promise<string> => {
    const href = await this.downloadLink.getAttribute("href");
    const response = await this.page.request.get(href ?? "");
    return response.text();
  };

  uploadCsv = async (name: string, content: Buffer | string): Promise<void> => {
    const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    await this.uploadInput.setInputFiles({ name, mimeType: "text/csv", buffer });
  };

  pushWith = async (typedProject: string): Promise<void> => {
    await this.pushButton.click();
    await this.pushConfirmInput.fill(typedProject);
  };
}
