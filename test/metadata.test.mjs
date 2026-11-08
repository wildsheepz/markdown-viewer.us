import test from "node:test";
import assert from "node:assert/strict";
import {
  rewriteRepoUrl,
  isBlockedUrl,
  extractMetadata,
  injectMetadata,
} from "../server/metadata.js";

test("rewriteRepoUrl: converts GitHub, GitLab, and Gist URLs to raw endpoints", () => {
  assert.equal(
    rewriteRepoUrl("https://github.com/wildsheepz/markdown-viewer.us/blob/main/README.md"),
    "https://raw.githubusercontent.com/wildsheepz/markdown-viewer.us/main/README.md"
  );
  assert.equal(
    rewriteRepoUrl("https://gitlab.com/gitlab-org/gitlab/-/blob/master/README.md"),
    "https://gitlab.com/gitlab-org/gitlab/-/raw/master/README.md"
  );
  assert.equal(
    rewriteRepoUrl("https://gist.github.com/username/1234567890abcdef"),
    "https://gist.githubusercontent.com/username/1234567890abcdef/raw"
  );
  assert.equal(
    rewriteRepoUrl("https://example.com/notes/intro.md"),
    "https://example.com/notes/intro.md"
  );
});

test("isBlockedUrl: blocks private/internal IPs, localhost, and non-http protocols (SSRF guardrail)", () => {
  assert.equal(isBlockedUrl("http://localhost:8080/test.md"), true);
  assert.equal(isBlockedUrl("http://127.0.0.1:3000/secret.md"), true);
  assert.equal(isBlockedUrl("http://0.0.0.0/test.md"), true);
  assert.equal(isBlockedUrl("http://[::1]/test.md"), true);
  assert.equal(isBlockedUrl("http://10.0.0.1/internal.md"), true);
  assert.equal(isBlockedUrl("http://192.168.1.10/doc.md"), true);
  assert.equal(isBlockedUrl("http://172.20.0.5/doc.md"), true);
  assert.equal(isBlockedUrl("http://169.254.169.254/latest/meta-data"), true);
  assert.equal(isBlockedUrl("file:///etc/passwd"), true);
  assert.equal(isBlockedUrl("ftp://example.com/test.md"), true);
  assert.equal(isBlockedUrl("javascript:alert(1)"), true);
  assert.equal(isBlockedUrl("not-a-valid-url"), true);

  // Allowed public URLs
  assert.equal(isBlockedUrl("https://example.com/notes.md"), false);
  assert.equal(isBlockedUrl("https://raw.githubusercontent.com/owner/repo/main/README.md"), false);
});

test("extractMetadata: extracts title, description, and image from markdown", () => {
  const md = `# Project Documentation

Welcome to **Project Documentation**! Here is a [quick guide](https://example.com) to getting started.

![Architecture Diagram](https://example.com/images/arch.png)

## Installation

Run \`npm install\` to begin.
`;

  const meta = extractMetadata(md, "https://example.com/docs/readme.md");
  assert.equal(meta.title, "Project Documentation");
  assert.equal(
    meta.description,
    "Welcome to Project Documentation! Here is a quick guide to getting started."
  );
  assert.equal(meta.image, "https://example.com/images/arch.png");
});

test("extractMetadata: resolves relative image URLs against document URL", () => {
  const md = `# Guide
A guide with a relative image.
![Logo](./assets/logo.png)
`;
  const meta = extractMetadata(md, "https://example.com/docs/sub/readme.md");
  assert.equal(meta.image, "https://example.com/docs/sub/assets/logo.png");
});

test("extractMetadata: falls back cleanly when heading or image is absent", () => {
  const md = `Just a plain markdown document without any h1 heading.
Second paragraph is here.
`;
  const meta = extractMetadata(md, "https://example.com/notes/weekly-summary.md");
  assert.equal(meta.title, "weekly-summary.md");
  assert.equal(meta.description, "Just a plain markdown document without any h1 heading. Second paragraph is here.");
  assert.equal(meta.image, "https://markdown-viewer.us/og.png");
});

test("injectMetadata: replaces meta tags and title in HTML template safely", () => {
  const sampleHtml = `<!DOCTYPE html>
<html>
<head>
<meta property="og:title" content="Markdown Viewer">
<meta property="og:description" content="A fast, single-file Markdown viewer.">
<meta property="og:url" content="https://markdown-viewer.us/">
<meta property="og:image" content="https://markdown-viewer.us/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Markdown Viewer">
<meta name="twitter:description" content="Drag & drop a file.">
<meta name="twitter:image" content="https://markdown-viewer.us/og.png">
<title>Markdown Viewer</title>
</head>
<body></body>
</html>`;

  const injected = injectMetadata(sampleHtml, {
    title: 'Custom "Title" & Guide',
    description: 'A special <summary> for "testing" & sharing.',
    image: "https://example.com/cover.png",
    url: "https://markdown-viewer.us/?url=https%3A%2F%2Fexample.com%2Fdoc.md",
  });

  assert.ok(injected.includes("<title>Custom &quot;Title&quot; &amp; Guide — Markdown Viewer</title>"));
  assert.ok(injected.includes('<meta property="og:title" content="Custom &quot;Title&quot; &amp; Guide">'));
  assert.ok(injected.includes('<meta property="og:description" content="A special &lt;summary&gt; for &quot;testing&quot; &amp; sharing.">'));
  assert.ok(injected.includes('<meta property="og:image" content="https://example.com/cover.png">'));
  assert.ok(injected.includes('<meta property="og:url" content="https://markdown-viewer.us/?url=https%3A%2F%2Fexample.com%2Fdoc.md">'));
  assert.ok(injected.includes('<meta name="twitter:title" content="Custom &quot;Title&quot; &amp; Guide">'));
  assert.ok(injected.includes('<meta name="twitter:description" content="A special &lt;summary&gt; for &quot;testing&quot; &amp; sharing.">'));
  assert.ok(injected.includes('<meta name="twitter:image" content="https://example.com/cover.png">'));
});

test("getRemoteMetadata: fetches markdown, extracts metadata, and caches results", async () => {
  let fetchCount = 0;
  const mockFetch = async (_url) => {
    fetchCount++;
    return {
      ok: true,
      text: async () => `# Remote Title\n\nRemote description text here.\n`,
    };
  };

  const { getRemoteMetadata } = await import("../server/metadata.js");

  const meta1 = await getRemoteMetadata("https://example.com/live/doc.md", mockFetch);
  assert.equal(meta1.title, "Remote Title");
  assert.equal(meta1.description, "Remote description text here.");
  assert.equal(fetchCount, 1);

  // Cached call should not trigger another fetch
  const meta2 = await getRemoteMetadata("https://example.com/live/doc.md", mockFetch);
  assert.equal(meta2.title, "Remote Title");
  assert.equal(fetchCount, 1);

  // Blocked URL should return null without fetching
  const metaBlocked = await getRemoteMetadata("http://127.0.0.1/admin.md", mockFetch);
  assert.equal(metaBlocked, null);
  assert.equal(fetchCount, 1);
});

