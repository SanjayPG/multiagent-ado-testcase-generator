import { describe, expect, it } from "vitest";
import { htmlToText } from "../src/htmlText.js";

describe("htmlToText", () => {
  it("keeps the readable text, headings and list items", () => {
    const html = `<html><head><title>Login design</title></head><body>
      <h1>Overview</h1><p>Users sign in with <b>email</b> and password.</p>
      <ul><li>Lock after 5 attempts</li><li>Session lasts 30 minutes</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("# Login design");
    expect(text).toContain("# Overview");
    expect(text).toContain("Users sign in with email and password.");
    expect(text).toContain("- Lock after 5 attempts");
    expect(text).toContain("- Session lasts 30 minutes");
  });

  it("drops scripts, styles, comments and hidden template content", () => {
    const html = `<style>.x{color:red}</style><script>alert('hi')</script><!-- secret note --><template><p>tmpl</p></template><p>Visible</p>`;
    const text = htmlToText(html);
    expect(text).toBe("Visible");
  });

  it("decodes entities, and does not turn encoded markup back into markup", () => {
    const text = htmlToText("<p>Fish &amp; chips &mdash; &lt;script&gt;alert(1)&lt;/script&gt; &#65;&#x42;</p>");
    expect(text).toBe("Fish & chips — <script>alert(1)</script> AB");
  });

  it("leaves an unknown or invalid entity alone", () => {
    expect(htmlToText("<p>&notanentity; &#99999999999;</p>")).toBe("&notanentity; &#99999999999;");
  });

  it("separates table cells and rows", () => {
    const text = htmlToText("<table><tr><td>Code</td><td>Meaning</td></tr><tr><td>401</td><td>Unauthorized</td></tr></table>");
    expect(text).toContain("Code | Meaning |");
    expect(text).toContain("401 | Unauthorized |");
  });

  it("collapses whitespace and blank lines", () => {
    expect(htmlToText("<p>a   b</p>\n\n\n\n<p>c</p>")).toBe("a b\n\nc");
  });

  it("returns an empty string for a page with no text", () => {
    expect(htmlToText("<div><img src='x.png'></div>")).toBe("");
  });
});
