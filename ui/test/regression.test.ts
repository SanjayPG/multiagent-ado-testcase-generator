import { describe, expect, it } from "vitest";
import { hasRegressionTag, matchedScript } from "../src/client/regression.js";

describe("hasRegressionTag", () => {
  it("finds the tag among the others, whatever the case or spacing", () => {
    expect(hasRegressionTag("positive, auth, login, smoke, regression")).toBe(true);
    expect(hasRegressionTag("regression")).toBe(true);
    expect(hasRegressionTag("positive,Regression ,auth")).toBe(true);
  });

  it("does not match a tag that only contains the word", () => {
    expect(hasRegressionTag("positive, auth, regression-risk")).toBe(false);
    expect(hasRegressionTag("non-regression")).toBe(false);
  });

  it("is false for no tags", () => {
    expect(hasRegressionTag("")).toBe(false);
    expect(hasRegressionTag("positive, auth")).toBe(false);
  });
});

describe("matchedScript", () => {
  it("reads the script name from the description bullet", () => {
    const description = "• User is on the login page\n• Matches regression script: test_login_with_valid_credentials\n• Account is active";
    expect(matchedScript(description)).toBe("test_login_with_valid_credentials");
  });

  it("copes with markdown and a full stop after the name", () => {
    expect(matchedScript("• Matches regression script: `test_session_expires_after_30_minutes`.")).toBe("test_session_expires_after_30_minutes");
  });

  it("is null when no script is named", () => {
    expect(matchedScript("• User is on the login page")).toBeNull();
    expect(matchedScript("")).toBeNull();
    expect(matchedScript("• Matches regression script:   ")).toBeNull();
  });
});
