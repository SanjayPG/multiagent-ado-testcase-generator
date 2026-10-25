import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { htmlToText } from "./htmlText.js";

// Downloads one public web page as text. This runs on the user's machine, so the main risk is being tricked into
// reaching something private (localhost, the office network, a cloud metadata address). Every check below exists
// for that reason, and each redirect is checked again.

export class FetchError extends Error {}

export type FetchedPage = { text: string; finalUrl: string; contentType: string; bytes: number };
export type FetchPage = (url: string) => Promise<FetchedPage>;

export type FetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  // Tests only: allows a server on 127.0.0.1 on any port. Nothing in the application sets this.
  unsafeForTests?: boolean;
};

export const MAX_FETCH_BYTES = 1024 * 1024;
const MAX_URL_LENGTH = 2000;
const ALLOWED_PORTS = new Set(["", "80", "443"]); // the URL parser reports a default port as ""
const TEXT_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "text/x-markdown"]);

const blockedRanges = new net.BlockList();
const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const BLOCKED_V6: Array<[string, number]> = [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible form
  ["64:ff9b::", 96],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];
for (const [network, prefix] of BLOCKED_V4) blockedRanges.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of BLOCKED_V6) blockedRanges.addSubnet(network, prefix, "ipv6");

export const isBlockedAddress = (address: string): boolean => {
  const family = net.isIP(address);
  if (family === 0) return true; // not an address at all: refuse
  if (family === 6) {
    // IPv4 written as IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1) could smuggle in a private address. It is refused
    // here rather than as a BlockList range, because BlockList treats every IPv4 address as IPv4-mapped and a
    // ::ffff:0:0/96 rule would then block the whole internet.
    const canonical = new URL(`http://[${address}]/`).hostname.toLowerCase();
    if (canonical.startsWith("[::ffff:")) return true;
  }
  return blockedRanges.check(address, family === 4 ? "ipv4" : "ipv6");
};

export const assertSafeUrl = (text: string, options: FetchOptions = {}): URL => {
  if (text.length > MAX_URL_LENGTH) throw new FetchError("The URL is too long.");
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new FetchError("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchError("Only http and https URLs are supported.");
  if (url.username || url.password) throw new FetchError("URLs that contain a user name or password are not supported.");
  if (!options.unsafeForTests) {
    if (!ALLOWED_PORTS.has(url.port)) throw new FetchError("Only the standard web ports (80 and 443) are allowed.");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) !== 0 && isBlockedAddress(host)) {
      throw new FetchError("That address is on a private or internal network, which is not allowed.");
    }
  }
  return url;
};

// Resolves the name itself and hands back only validated addresses, so the connection goes to the very address that
// was checked (a name that answers differently a second time cannot sneak in a private one).
const guardedLookup =
  (unsafe: boolean): net.LookupFunction =>
  (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error, "", 0);
      const list = addresses as dns.LookupAddress[];
      if (!unsafe && list.some((entry) => isBlockedAddress(entry.address))) {
        return callback(new FetchError("That host resolves to a private or internal address, which is not allowed.") as NodeJS.ErrnoException, "", 0);
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };

const toFetchError = (error: unknown): FetchError => {
  if (error instanceof FetchError) return error;
  const name = (error as { name?: string })?.name;
  const code = (error as { code?: string })?.code;
  if (name === "AbortError" || name === "TimeoutError" || code === "ABORT_ERR") return new FetchError("The page took too long to answer.");
  return new FetchError(`Could not reach the page: ${error instanceof Error ? error.message : String(error)}`);
};

const requestOnce = (url: URL, options: FetchOptions, deadline: number): Promise<http.IncomingMessage> =>
  new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new FetchError("The page took too long to answer."));
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "GET",
        agent: false,
        lookup: guardedLookup(Boolean(options.unsafeForTests)),
        signal: AbortSignal.timeout(remaining), // one deadline for connecting, the headers and the body
        headers: {
          "user-agent": "tc-generator-ui/0.1",
          accept: "text/html,text/plain,text/markdown;q=0.9",
          "accept-encoding": "identity",
        },
      },
      resolve,
    );
    request.on("error", (error) => reject(toFetchError(error)));
    request.end();
  });

const readBody = (response: http.IncomingMessage, maxBytes: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    response.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy();
        reject(new FetchError(`The page is larger than ${Math.round(maxBytes / 1024)} KB.`));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve(Buffer.concat(chunks)));
    response.on("error", (error) => reject(toFetchError(error)));
    response.on("close", () => {
      if (!response.complete) reject(new FetchError("The connection closed before the page was complete."));
    });
  });

export const fetchPage = async (urlText: string, options: FetchOptions = {}): Promise<FetchedPage> => {
  const maxBytes = options.maxBytes ?? MAX_FETCH_BYTES;
  const maxRedirects = options.maxRedirects ?? 3;
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let url = assertSafeUrl(urlText, options);

  for (let hop = 0; ; hop += 1) {
    const response = await requestOnce(url, options, deadline);
    const status = response.statusCode ?? 0;

    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      if (hop >= maxRedirects) throw new FetchError("The URL redirects too many times.");
      try {
        url = assertSafeUrl(new URL(response.headers.location, url).toString(), options);
      } catch (error) {
        throw error instanceof FetchError ? error : new FetchError("The URL redirects somewhere that is not valid.");
      }
      continue;
    }
    if (status === 401 || status === 403) {
      response.resume();
      throw new FetchError("The page needs a login, which is not supported. Download it and upload the file instead.");
    }
    if (status !== 200) {
      response.resume();
      throw new FetchError(`The server answered ${status}.`);
    }

    const header = String(response.headers["content-type"] ?? "");
    const contentType = header.split(";")[0].trim().toLowerCase();
    if (!TEXT_TYPES.has(contentType)) {
      response.resume();
      throw new FetchError(`The page is "${contentType || "of unknown type"}"; only web pages, plain text and Markdown are supported.`);
    }

    const body = await readBody(response, maxBytes);
    const charset = /charset=([\w-]+)/i.exec(header)?.[1] ?? "utf-8";
    let decoded: string;
    try {
      decoded = new TextDecoder(charset).decode(body);
    } catch {
      decoded = new TextDecoder("utf-8").decode(body);
    }
    const text = (contentType.includes("html") ? htmlToText(decoded) : decoded).trim();
    if (!text) throw new FetchError("The page has no readable text.");
    return { text, finalUrl: url.toString(), contentType, bytes: body.length };
  }
};
