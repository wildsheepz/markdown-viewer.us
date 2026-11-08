import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getRemoteMetadata, injectMetadata } from "./metadata.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
  ".txt": "text/plain",
};

function getMime(p) {
  const dot = p.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return MIME[p.slice(dot).toLowerCase()] || "application/octet-stream";
}

function loadSecurityHeaders() {
  const headers = {};
  const headersPath = join(ROOT, "_headers");
  if (existsSync(headersPath)) {
    const lines = readFileSync(headersPath, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^[ \t]+([A-Za-z0-9-]+):[ \t]*(.+?)\s*$/);
      if (m && !line.trim().startsWith("#")) {
        headers[m[1].toLowerCase()] = m[2];
      }
    }
  }
  return headers;
}

const SECURITY_HEADERS = loadSecurityHeaders();

export function createServer(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const allowTestLoopback = Boolean(options.allowTestLoopback);

  return http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      let pathname = decodeURIComponent(parsedUrl.pathname);

      if (pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
        return;
      }

      if (pathname === "/" || pathname === "/index.html") {
        const indexPath = join(ROOT, "index.html");
        let html = readFileSync(indexPath, "utf8");

        const targetUrl = parsedUrl.searchParams.get("url");
        if (targetUrl) {
          const meta = await getRemoteMetadata(targetUrl, fetchFn, { allowTestLoopback });
          if (meta) {
            const canonicalUrl = `https://markdown-viewer.us/?url=${encodeURIComponent(targetUrl)}`;
            html = injectMetadata(html, { ...meta, url: canonicalUrl });
          }
        }

        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "content-type": "text/html; charset=utf-8",
        });
        res.end(html);
        return;
      }

      let filePath = join(ROOT, pathname);
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      if (existsSync(filePath) && statSync(filePath).isFile()) {
        const mimeType = getMime(filePath);
        const headers = {
          ...SECURITY_HEADERS,
          "content-type": mimeType,
        };

        if (/\.(?:woff2|png|ico|svg|webmanifest)$/i.test(filePath)) {
          headers["cache-control"] = "public, max-age=604800";
        }

        const data = readFileSync(filePath);
        res.writeHead(200, headers);
        res.end(data);
        return;
      }

      // Not found
      const notFoundPath = join(ROOT, "404.html");
      if (existsSync(notFoundPath)) {
        res.writeHead(404, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(notFoundPath, "utf8"));
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  });
}
