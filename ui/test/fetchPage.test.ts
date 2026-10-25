import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FetchError, assertSafeUrl, fetchPage, isBlockedAddress } from "../src/fetchPage.js";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"])("allows the public address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("refuses anything that is not an address", () => {
    expect(isBlockedAddress("localhost")).toBe(true);
  });
});

describe("assertSafeUrl", () => {
  it.each([
    ["ftp://example.com/file", /Only http and https/],
    ["file:///etc/passwd", /Only http and https/],
    ["javascript:alert(1)", /Only http and https/],
    ["not a url", /not a valid URL/],
    ["https://user:pass@example.com/", /user name or password/],
    ["http://example.com:8080/", /standard web ports/],
    ["http://127.0.0.1/admin", /private or internal/],
    ["http://[::1]/", /private or internal/],
    ["http://169.254.169.254/latest/meta-data/", /private or internal/],
    ["http://10.0.0.5/", /private or internal/],
    ["http://192.168.0.1/", /private or internal/],
    ["http://2130706433/", /private or internal/], // 127.0.0.1 written as one number
    ["http://0x7f.0.0.1/", /private or internal/], // hex form
    [`https://example.com/${"a".repeat(2100)}`, /too long/],
  ])("rejects %s", (url, message) => {
    expect(() => assertSafeUrl(url)).toThrow(message);
  });

  it("accepts an ordinary public URL", () => {
    expect(assertSafeUrl("https://example.com/docs/hld.html").hostname).toBe("example.com");
  });
});

describe("fetchPage in the real network mode", () => {
  it("refuses localhost by name, because it resolves to a private address", async () => {
    await expect(fetchPage("http://localhost/")).rejects.toThrow(/private or internal/);
  });

  it("refuses private literals before opening any connection", async () => {
    await expect(fetchPage("http://127.0.0.1/")).rejects.toBeInstanceOf(FetchError);
  });
});

describe("fetchPage against a local test server", () => {
  let server: http.Server;
  let base: string;
  const unsafe = { unsafeForTests: true };

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const path = request.url ?? "/";
      if (path === "/page") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<html><head><title>HLD</title></head><body><h1>Login</h1><p>Lock after 5 &amp; 15 minutes</p></body></html>");
      } else if (path === "/notes.md") {
        response.writeHead(200, { "content-type": "text/markdown" });
        response.end("# Notes\n\n- one\n- two\n");
      } else if (path === "/data.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      } else if (path === "/big") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("x".repeat(5000));
      } else if (path === "/empty") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<div></div>");
      } else if (path === "/login") {
        response.writeHead(401);
        response.end();
      } else if (path === "/missing") {
        response.writeHead(404);
        response.end();
      } else if (path === "/redirect") {
        response.writeHead(302, { location: "/page" });
        response.end();
      } else if (path === "/loop") {
        response.writeHead(302, { location: "/loop" });
        response.end();
      } else if (path === "/to-metadata") {
        response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        response.end();
      } else if (path === "/hang") {
        // never answers
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("returns a web page as plain text", async () => {
    const page = await fetchPage(`${base}/page`, unsafe);
    expect(page.text).toBe("# HLD\n\n# Login\n\nLock after 5 & 15 minutes");
    expect(page.contentType).toBe("text/html");
    expect(page.finalUrl).toBe(`${base}/page`);
  });

  it("returns Markdown unchanged", async () => {
    expect((await fetchPage(`${base}/notes.md`, unsafe)).text).toBe("# Notes\n\n- one\n- two");
  });

  it("follows a redirect", async () => {
    const page = await fetchPage(`${base}/redirect`, unsafe);
    expect(page.finalUrl).toBe(`${base}/page`);
  });

  it("gives up on a redirect loop", async () => {
    await expect(fetchPage(`${base}/loop`, unsafe)).rejects.toThrow(/redirects too many times/);
  });

  it.each([
    ["/data.json", /only web pages, plain text and Markdown/],
    ["/login", /needs a login/],
    ["/missing", /answered 404/],
    ["/empty", /no readable text/],
  ])("explains why %s cannot be used", async (path, message) => {
    await expect(fetchPage(`${base}${path}`, unsafe)).rejects.toThrow(message);
  });

  it("stops downloading past the size limit", async () => {
    await expect(fetchPage(`${base}/big`, { ...unsafe, maxBytes: 1000 })).rejects.toThrow(/larger than/);
  });

  it("gives up on a server that never answers", async () => {
    await expect(fetchPage(`${base}/hang`, { ...unsafe, timeoutMs: 300 })).rejects.toThrow(/took too long/);
  });

  it("checks the target of every redirect, not just the first URL", () => {
    // The redirect handler runs the same check on each Location, so a public page cannot bounce you inward.
    expect(() => assertSafeUrl(new URL("http://169.254.169.254/latest/meta-data/", "https://example.com/").toString())).toThrow(
      /private or internal/,
    );
    expect(() => assertSafeUrl(new URL("//127.0.0.1/", "https://example.com/").toString())).toThrow(/private or internal/);
  });
});
