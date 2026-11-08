import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../server/server.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
    server.on("error", reject);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("server: serves index.html with default metadata when no ?url is passed", async () => {
  const appServer = createServer();
  const baseUrl = await listen(appServer);

  try {
    const res = await fetch(baseUrl + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");

    const body = await res.text();
    assert.ok(body.includes("<title>Markdown Viewer</title>"));
    assert.ok(body.includes('<meta property="og:title" content="Markdown Viewer">'));
  } finally {
    await close(appServer);
  }
});

test("server: injects dynamic OpenGraph metadata when ?url= points to markdown", async () => {
  // Start a mock remote server with markdown content
  const mockRemote = http.createServer((req, res) => {
    if (req.url === "/my-doc.md") {
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end("# Custom Remote Guide\n\nThis is a custom preview description for Telegram.\n\n![Hero](https://cdn.example.com/hero.png)\n");
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  const remoteUrl = await listen(mockRemote);

  // We allow overriding fetch or using custom fetch in createServer for testing
  const mockFetch = async (url, opts) => {
    // Intercept mock remote requests
    if (url.startsWith(remoteUrl)) {
      const path = url.slice(remoteUrl.length);
      return new Promise((resolve) => {
        http.get(`${remoteUrl}${path}`, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            resolve({
              ok: res.statusCode === 200,
              text: async () => data,
            });
          });
        });
      });
    }
    return fetch(url, opts);
  };

  const appServer = createServer({ fetchFn: mockFetch, allowTestLoopback: true });
  const baseUrl = await listen(appServer);

  try {
    const targetDocUrl = `${remoteUrl}/my-doc.md`;
    const shareUrl = `${baseUrl}/?url=${encodeURIComponent(targetDocUrl)}`;

    const res = await fetch(shareUrl);
    assert.equal(res.status, 200);
    const body = await res.text();

    assert.ok(body.includes("<title>Custom Remote Guide — Markdown Viewer</title>"));
    assert.ok(body.includes('<meta property="og:title" content="Custom Remote Guide">'));
    assert.ok(body.includes('<meta property="og:description" content="This is a custom preview description for Telegram.">'));
    assert.ok(body.includes('<meta property="og:image" content="https://cdn.example.com/hero.png">'));
    assert.ok(body.includes('<meta name="twitter:title" content="Custom Remote Guide">'));
    assert.ok(body.includes('<meta name="twitter:description" content="This is a custom preview description for Telegram.">'));
    assert.ok(body.includes('<meta name="twitter:image" content="https://cdn.example.com/hero.png">'));
  } finally {
    await close(appServer);
    await close(mockRemote);
  }
});

test("server: serves static assets like app.js and icons", async () => {
  const appServer = createServer();
  const baseUrl = await listen(appServer);

  try {
    const res = await fetch(baseUrl + "/app.js");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /javascript/);
    const text = await res.text();
    assert.ok(text.includes("isAccepted"));
  } finally {
    await close(appServer);
  }
});

test("server: injects fallback metadata when ?name= is present without ?url=", async () => {
  const appServer = createServer();
  const baseUrl = await listen(appServer);

  try {
    const res = await fetch(baseUrl + "/?name=my-article.md");
    assert.equal(res.status, 200);
    const body = await res.text();

    assert.ok(body.includes("<title>my-article.md — Markdown Viewer</title>"));
    assert.ok(body.includes('<meta property="og:title" content="my-article.md">'));
    assert.ok(body.includes('<meta property="og:description" content="Shared Markdown document: my-article.md">'));
  } finally {
    await close(appServer);
  }
});

