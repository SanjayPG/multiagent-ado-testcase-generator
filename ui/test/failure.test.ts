import { afterEach, describe, expect, it } from "vitest";
import { createEventMapper } from "../src/events.js";
import { explainFailure } from "../src/failure.js";
import { redactSecrets } from "../src/summary.js";

describe("explainFailure", () => {
  it.each([
    ["the ado server timing out", "The `ado` MCP server timed out when connecting (`CONNECT_TIMEOUT` after 30 seconds)", "Couldn't connect to Azure DevOps"],
    ["no tools for the fetcher", "so the ado-fetcher agent had no tools", "Couldn't connect to Azure DevOps"],
    ["a rejected token", "TF400813: The user is not authorized to access this resource", "Azure DevOps refused the sign-in"],
    ["an HTTP 401", "Request failed with status 401", "Azure DevOps refused the sign-in"],
    ["a signed-out Claude", "Not logged in · Please run /login", "Claude Code is not signed in"],
    ["a missing claude command", 'Could not start "claude": spawn claude ENOENT', "Claude Code could not be started"],
    ["a missing work item", "TF401232: Work item 4242 does not exist", "A PBI could not be found"],
    ["the run timeout", "Timed out after 600 seconds.", "The run took too long and was stopped"],
  ])("recognises %s", (_name, text, title) => {
    const hint = explainFailure(text);
    expect(hint?.title).toBe(title);
    expect(hint?.steps.length).toBeGreaterThan(0);
  });

  it("looks at every piece of text it is given, not only the first", () => {
    expect(explainFailure("The run finished but no CSV file was found in output/.", undefined, "CONNECT_TIMEOUT")?.title).toBe(
      "Couldn't connect to Azure DevOps",
    );
  });

  it("says nothing when it does not recognise the failure", () => {
    expect(explainFailure("something unexpected happened")).toBeNull();
    expect(explainFailure(undefined, "")).toBeNull();
  });

  it("does not mistake an ordinary number for an HTTP status", () => {
    expect(explainFailure("Generated 4010 steps in 14030 ms")).toBeNull();
  });
});

describe("redactSecrets", () => {
  const original = process.env.ADO_PAT_B64;
  afterEach(() => {
    if (original === undefined) delete process.env.ADO_PAT_B64;
    else process.env.ADO_PAT_B64 = original;
  });

  const encode = (pair: string): string => Buffer.from(pair, "utf8").toString("base64");

  it("hides the encoded value, the decoded pair, and the bare token", () => {
    const pair = "me@example.com:abcdefghijklmnopqrstuvwxyz0123456789";
    process.env.ADO_PAT_B64 = encode(pair);
    const text = `b64=${encode(pair)} pair=${pair} token=abcdefghijklmnopqrstuvwxyz0123456789`;
    const cleaned = redactSecrets(text);
    expect(cleaned).toBe("b64=*** pair=*** token=***");
  });

  it("leaves text alone when no token is set", () => {
    delete process.env.ADO_PAT_B64;
    expect(redactSecrets("nothing to hide")).toBe("nothing to hide");
  });

  it("does not treat a short or non-pair value as several secrets", () => {
    process.env.ADO_PAT_B64 = "not-a-base64-pair-value";
    expect(redactSecrets("keep me but hide not-a-base64-pair-value")).toBe("keep me but hide ***");
  });
});

describe("notes in the run log", () => {
  const noteFor = (text: string) => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
    const event = createEventMapper().map(line)[0];
    return event?.kind === "note" ? event.text : null;
  };

  it("keeps a final summary with its table instead of cutting it at 300 characters", () => {
    const summary = `Summary of the run.\n\n| Type | Count |\n|---|---|\n| Positive | 2 |\n${"detail ".repeat(100)}`;
    expect(noteFor(summary)).toBe(summary.trim());
  });

  it("still caps a very long note", () => {
    expect(noteFor("x".repeat(5000))?.length).toBe(2000);
  });
});
