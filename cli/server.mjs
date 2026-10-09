// @ts-check
// The form's local server. It listens on 127.0.0.1 only, serves the static form from out/, and
// answers /api/* only to the one tab that traded the link's key for a session.
// The key is single-use: POST /api/session swaps it for two secrets, so a key seen later (a
// browser's argv, history, a shoulder) opens nothing:
//   - an HttpOnly, SameSite=Strict cookie, which page scripts cannot read;
//   - a token in the response body, which the page keeps in sessionStorage (scoped to this
//     scheme, host and port, and to the one tab) and sends as the x-qq-setup header.
// Every other /api/* call needs both. Browsers send cookies to every port on 127.0.0.1, so the
// cookie alone could leak to another local listener; the token never does. A custom header also
// means no other origin can call without a CORS preflight, which this server never answers.
// The GitHub token never reaches the page: the page only sees names the command already read.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  // Next's static export inlines its bootstrap scripts, hence 'unsafe-inline' for scripts and styles;
  // nothing may load from or connect to anywhere but this server.
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const MAX_BODY = 16 * 1024;

/**
 * @typedef {{
 *   state: () => Promise<unknown>,
 *   repos: (org: string) => Promise<unknown>,
 *   submit: (body: unknown) => Promise<{ ok: true } | { ok: false, error: string, status?: number }>,
 * }} Handlers
 */

/**
 * Start the form server. Resolves once it listens.
 * @param {{ root: string, handlers: Handlers, port?: number, onSession?: () => void, onRefusedTrade?: () => void }} opts
 *   onSession runs once, when a page has traded the key; onRefusedTrade runs on each later try.
 * @returns {Promise<{ url: string, key: string, port: number, close: () => void }>}
 */
export async function startServer({ root, handlers, port = 0, onSession = () => {}, onRefusedTrade = () => {} }) {
  const key = randomBytes(24).toString("base64url");
  const keyBuf = Buffer.from(key);
  /** The cookie's value and the header token, once the key has been used; until then nothing opens /api/*. */
  /** @type {{ cookie: Buffer, token: Buffer } | null} */
  let session = null;
  const outRoot = resolve(root);
  /** @type {number} */
  let boundPort = 0;

  const server = createServer(async (req, res) => {
    try {
      // DNS rebinding: a page on another name that resolves to 127.0.0.1 sends its own Host.
      if (req.headers.host !== `127.0.0.1:${boundPort}`) return send(res, 421, { error: "wrong host" });
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);

      if (url.pathname.startsWith("/api/")) {
        const origin = req.headers.origin;
        const ours = `http://127.0.0.1:${boundPort}`;
        if (origin !== undefined && origin !== ours) return send(res, 403, { error: "wrong origin" });
        // A custom header: another origin cannot send it without a CORS preflight, which gets a 404.
        const header = String(req.headers["x-qq-setup"] ?? "");
        if (!header) return send(res, 403, { error: "missing x-qq-setup header" });
        const cookieName = `qq_setup_${boundPort}`;

        if (url.pathname === "/api/session") {
          if (req.method !== "POST" || origin !== ours || header !== "1") return send(res, 403, { error: "wrong origin" });
          const given = Buffer.from(String(req.headers["x-qq-setup-key"] ?? ""));
          if (session || given.length !== keyBuf.length || !timingSafeEqual(given, keyBuf)) {
            if (session) onRefusedTrade();
            return send(res, 403, { error: "this link was already used, or is not the one the terminal printed" });
          }
          const cookie = randomBytes(32).toString("base64url");
          const token = randomBytes(32).toString("base64url");
          session = { cookie: Buffer.from(cookie), token: Buffer.from(token) };
          onSession();
          return send(res, 200, { ok: true, token }, {
            "Set-Cookie": `${cookieName}=${cookie}; Path=/api; HttpOnly; SameSite=Strict`,
          });
        }

        const s = session;
        if (!s || !same(Buffer.from(header), s.token) || !readCookies(req.headers.cookie, cookieName).some((c) => same(c, s.cookie))) {
          return send(res, 401, { error: "this page is not the one the terminal opened; use the link it printed" });
        }
        if (req.method === "POST" && origin !== ours) return send(res, 403, { error: "wrong origin" });

        if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, await handlers.state());
        if (req.method === "GET" && url.pathname === "/api/repos") {
          return send(res, 200, await handlers.repos(url.searchParams.get("org") ?? ""));
        }
        if (req.method === "POST" && url.pathname === "/api/answers") {
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
            return send(res, 415, { error: "expected application/json" });
          }
          const body = await readBody(req);
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            return send(res, 400, { error: "not JSON" });
          }
          const result = await handlers.submit(parsed);
          if (result.ok) return send(res, 200, result);
          return send(res, result.status ?? 400, { ok: false, error: result.error });
        }
        return send(res, 404, { error: "no such endpoint" });
      }

      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" });
      return serveStatic(res, outRoot, url.pathname, req.method === "HEAD");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return send(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok(undefined));
  });
  const addr = server.address();
  boundPort = typeof addr === "object" && addr ? addr.port : 0;
  return {
    // The key travels in the fragment: browsers never send it to a server or in a Referer.
    url: `http://127.0.0.1:${boundPort}/#key=${key}`,
    key,
    port: boundPort,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {import("node:http").IncomingMessage} req @returns {Promise<string>} */
function readBody(req) {
  return new Promise((ok, fail) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) return fail(new HttpError(413, "answer too large")); // later data is dropped
      chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {string} outRoot @param {string} pathname @param {boolean} head
 */
async function serveStatic(res, outRoot, pathname, head) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { error: "bad path" });
  }
  if (rel.endsWith("/")) rel += "index.html";
  let file = resolve(join(outRoot, rel));
  if (file !== outRoot && !file.startsWith(outRoot + sep)) return send(res, 404, { error: "not found" });
  // Next exports /foo as foo.html.
  if (!extname(file)) file += ".html";
  try {
    const s = await stat(file);
    if (!s.isFile()) return send(res, 404, { error: "not found" });
  } catch {
    return send(res, 404, { error: "not found" });
  }
  const body = await readFile(file);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": TYPES[/** @type {keyof typeof TYPES} */ (extname(file))] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(head ? undefined : body);
}

/**
 * Every value sent for one cookie name. A page on another port can set a same-named cookie with a
 * longer path, which browsers send first, so taking only the first would lock the real page out.
 * @param {string | undefined} header @param {string} name
 */
function readCookies(header, name) {
  /** @type {Buffer[]} */
  const out = [];
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) out.push(Buffer.from(part.slice(eq + 1).trim()));
  }
  return out;
}

/** Constant-time equality for secrets of any length. @param {Buffer} a @param {Buffer} b */
function same(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body
 * @param {Record<string, string>} [extra]  more headers
 */
function send(res, status, body, extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    ...extra,
    ...SECURITY_HEADERS,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...(status === 413 ? { Connection: "close" } : {}),
  });
  res.end(JSON.stringify(body));
}
