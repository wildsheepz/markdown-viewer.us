// Headless-Chromium harness — serves this viewer with the *real* security
// headers (incl. CSP) from `_headers` and drives index.html, per the dev
// standards (§15). Exit 1 on any failure.
import { chromium } from "playwright";
import http from "node:http";
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT) || 8099;

// -- ?name= fixture: real markdown, so render() genuinely runs marked +
// DOMPurify rather than the checks below passing over an empty document.
const FIX = mkdtempSync(join(tmpdir(), "md-harness-"));
const FIXTURE_MD = join(FIX, "sample.md");
writeFileSync(FIXTURE_MD, "# Hello\n\nA *fixture* document with a [link](https://example.com).\n");

// -- Hostile document fixture for the DOMPurify pass in render().
// Every payload is RAW HTML on purpose: `marked` passes raw HTML through
// untouched, so what survives to the DOM is DOMPurify's doing and nothing
// else. Markdown link syntax would have been the wrong vector — marked has
// its own opinions about javascript: in [](), and a test it neutralizes
// would pass with the sanitizer deleted.
// Shares the tmpdir above rather than declaring a second `const FIX`, which
// is what naively keeping both conflict sides would have produced.
const HOSTILE_DOC = join(FIX, "hostile.md");
writeFileSync(HOSTILE_DOC, [
  "# Hostile fixture",
  "",
  "<script>window.__xssScript = true;</script>",
  "",
  '<img id="x-img" src="does-not-exist.png" onerror="window.__xssImg = true">',
  "",
  '<a id="x-a" href="javascript:void(window.__xssHref = true)">raw anchor</a>',
  "",
  '<iframe id="x-frame" src="about:blank"></iframe>',
  "",
  '<p onclick="window.__xssClick = true">handler on a paragraph</p>',
  "",
].join("\n"));

const H = {};
for (const line of readFileSync(join(ROOT, "_headers"), "utf8").split("\n")) {
  const m = line.match(/^[ \t]+([A-Za-z0-9-]+):[ \t]*(.+?)\s*$/);
  if (m && !line.trim().startsWith("#")) H[m[1]] = m[2];
}
if (!H["Content-Security-Policy"]) {
  console.error("FAIL: no Content-Security-Policy found in _headers");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain",
};
const mime = (p) => MIME[p.slice(p.lastIndexOf("."))] || "application/octet-stream";

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/fixtures/remote.md") {
    res.writeHead(200, { ...H, "Content-Type": "text/markdown; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end("# Remote Markdown\n\n![diagram](./assets/diag.png)\n\n[Another doc](./sub/other.md)\n\n[External](https://example.com)\n");
    return;
  }
  if (p === "/fixtures/404.md") {
    res.writeHead(404, { ...H, "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
    res.end("Not Found");
    return;
  }
  if (p.endsWith("/")) p += "index.html";
  let fp = join(ROOT, p);
  if (!fp.startsWith(ROOT) || !existsSync(fp)) fp = join(ROOT, "index.html");
  try {
    res.writeHead(200, { ...H, "Content-Type": mime(fp) });
    res.end(readFileSync(fp));
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);
const results = [];
const check = (name, ok, detail) => results.push([name, !!ok, detail]);
const errs = [];
const hook = (page) => {
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push(String(e)));
};

// -- main context: light system scheme, full toggle round-trip
const ctx = await browser.newContext({ colorScheme: "light", viewport: { width: 1240, height: 800 } });
const page = await ctx.newPage();
hook(page);
await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => document.fonts.ready);
check("font loads under CSP", await page.evaluate(() => [...document.fonts].some((f) => f.family.includes("JetBrains"))));
check("heading uses JetBrains Mono", await page.evaluate(() => {
  const el = document.querySelector(".doc-title") || document.querySelector(".empty-title");
  return el && getComputedStyle(el).fontFamily.includes("JetBrains Mono");
}));
check("light default with light system scheme", await page.evaluate(() => document.getElementById("bgPicker").value) === "#ffffff");
check("toggle present in toolbar", await page.evaluate(() => {
  const t = document.getElementById("themeToggle");
  return !!t && t.hasAttribute("aria-pressed") && !!t.closest("nav.actions");
}));
check("icons in light mode (sun shown, moon hidden)", await page.evaluate(() => {
  const s = document.getElementById("themeIconSun"), m = document.getElementById("themeIconMoon");
  return !s.hasAttribute("hidden") && m.hasAttribute("hidden");
}));
await page.click("#themeToggle");
check("toggle to dark sets picker #0d1117", await page.evaluate(() => document.getElementById("bgPicker").value) === "#0d1117");
check("aria-pressed true in dark", await page.getAttribute("#themeToggle", "aria-pressed") === "true");
check("icons in dark mode (moon shown, sun hidden)", await page.evaluate(() => {
  const s = document.getElementById("themeIconSun"), m = document.getElementById("themeIconMoon");
  const moonVisible = !m.hasAttribute("hidden") && getComputedStyle(m).display !== "none";
  const sunHidden = s.hasAttribute("hidden") || getComputedStyle(s).display === "none";
  return moonVisible && sunHidden;
}));
check("choice persists (mykk-bg)", await page.evaluate(() => { try { return localStorage.getItem("mykk-bg") === "#0d1117"; } catch (e) { return false; } }));
await page.click("#themeToggle");
check("toggle back to light", await page.evaluate(() => document.getElementById("bgPicker").value) === "#ffffff");
// -- ?name=: loading a file reflects its name into the URL, Clear removes it
await page.setInputFiles("#fileInput", FIXTURE_MD);
await page.waitForFunction(() => document.body.classList.contains("viewing"), null, { timeout: 10000 });
check("load: URL reflects ?name=sample.md", await page.evaluate(() =>
  new URLSearchParams(location.search).get("name")) === "sample.md");
await page.click("#btnClear");
check("clear: ?name= removed from the URL", await page.evaluate(() =>
  new URLSearchParams(location.search).get("name")) === null);

// -- repo-specific: render() is also the paste/drop path, and those callers pass
// title "". Pasted text has no file, so ?name= must be cleared, not left stale.
// This is what distinguishes syncQueryName(title) from syncQueryName(file.name).
await page.setInputFiles("#fileInput", FIXTURE_MD);
await page.waitForFunction(() => new URLSearchParams(location.search).get("name") === "sample.md", null, { timeout: 10000 });
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.setData("text", "# pasted, not a file");
  window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
check("paste after a file load clears ?name= (title is \"\")", await page.evaluate(() =>
  new URLSearchParams(location.search).get("name") === null &&
  document.body.classList.contains("viewing")));
await page.click("#btnClear");
await ctx.close();

// -- direct visit with ?name=: empty-state names the last-viewed file
const p3 = await browser.newContext().then((c) => c.newPage());
hook(p3);
await p3.goto(`http://localhost:${PORT}/?name=${encodeURIComponent("sample.md")}`, { waitUntil: "load", timeout: 30000 });
check("?name=: 'shared for' sub-line names the file", await p3.evaluate(() => {
  const sub = document.querySelector(".empty-sub");
  return /shared for/.test(sub.textContent) && /sample\.md/.test(sub.textContent);
}));
await p3.context().close();

// -- ?name= carrying markup renders as TEXT, never parsed as HTML.
// This repo vendors DOMPurify, so the assertion also records that DOMPurify is
// LOADED while this passes — the point being that it is irrelevant here.
// render() sanitizes #content only; .empty-sub is not in its scope, so
// textContent is the whole defense rather than a second layer behind one.
// The innerHTML control fails with DOMPurify equally present, which is the
// half of the proof that separates the two sinks.
const p4 = await browser.newContext().then((c) => c.newPage());
hook(p4);
const HOSTILE_NAME = "<img src=x onerror=alert(1)>.md";
await p4.goto(`http://localhost:${PORT}/?name=${encodeURIComponent(HOSTILE_NAME)}`, { waitUntil: "load", timeout: 30000 });
check("?name=: hostile markup shows as literal text, never parsed", await p4.evaluate((name) => {
  const sub = document.querySelector(".empty-sub");
  return sub.textContent.includes(name)                 // present, verbatim
    && sub.querySelector("img") === null                // no element was built
    && sub.childNodes.length === 1                      // and the sub-line is
    && sub.childNodes[0].nodeType === 3;                // exactly one text node
}, HOSTILE_NAME));
check("?name=: DOMPurify is loaded, and is not what protected the line above",
  await p4.evaluate(() => typeof window.DOMPurify !== "undefined"));
await p4.context().close();

// -- ?name= with a quote payload: asserted for ENCODING FIDELITY, not for
// attribute escaping. This sink is textContent and the name never lands in
// attribute position, so a quote cannot open an attribute here no matter how
// the value is handled — a test claiming otherwise passes unconditionally and
// was removed rather than shipped (it passed against a raw innerHTML sink).
// What this DOES catch is a naive escaper added upstream: any repo that starts
// pre-escaping the name would show a literal &quot; here and fail.
const QUOTE_NAME = 'a" b\' c & d.md';
const p5 = await browser.newContext().then((c) => c.newPage());
hook(p5);
await p5.goto(`http://localhost:${PORT}/?name=${encodeURIComponent(QUOTE_NAME)}`, { waitUntil: "load", timeout: 30000 });
check("?name=: quotes and ampersands survive verbatim as text", await p5.evaluate((name) => {
  const sub = document.querySelector(".empty-sub");
  return sub.textContent.includes(name);
}, QUOTE_NAME));
await p5.context().close();

// -- fresh context with dark system scheme: must default dark
const ctx2 = await browser.newContext({ colorScheme: "dark" });
const p2 = await ctx2.newPage();
hook(p2);
await p2.goto(`http://localhost:${PORT}/`, { waitUntil: "load", timeout: 30000 });
check("system-dark default (#0d1117)", await p2.evaluate(() => document.getElementById("bgPicker").value) === "#0d1117");
await ctx2.close();

// -- the document sink: marked -> DOMPurify -> #content.
// Distinct from the ?name= sink, which lands in .empty-sub and is NOT covered
// by DOMPurify (render() sanitizes #content only). This block is the one that
// exercises the sanitizer, and every assertion below is written so that it
// FAILS when DOMPurify is removed — see the note under "negative control".
const ctxX = await browser.newContext();
const px = await ctxX.newPage();
hook(px);
await px.goto(`http://localhost:${PORT}/`, { waitUntil: "load", timeout: 30000 });
await px.setInputFiles("#fileInput", HOSTILE_DOC);
await px.waitForFunction(() => document.body.classList.contains("viewing"), null, { timeout: 10000 });

// Guard against a vacuous pass: if the document did not render at all, every
// "hostile element is absent" assertion below would be trivially true.
check("hostile doc actually rendered (h1 present)", await px.evaluate(() =>
  !!document.getElementById("content").querySelector("h1")));

check("sanitizer: <script> element does not survive into #content", await px.evaluate(() =>
  document.getElementById("content").querySelector("script") === null));
check("sanitizer: no onerror/onclick handler attribute survives", await px.evaluate(() => {
  const c = document.getElementById("content");
  return c.querySelector("[onerror]") === null && c.querySelector("[onclick]") === null;
}));
check("sanitizer: javascript: href does not survive", await px.evaluate(() => {
  const a = document.getElementById("content").querySelector("#x-a");
  return !a || !/^javascript:/i.test(a.getAttribute("href") || "");
}));
check("sanitizer: <iframe> does not survive", await px.evaluate(() =>
  document.getElementById("content").querySelector("iframe") === null));
// The img handler is a real execution vector, not a cosmetic one: innerHTML
// does start the image load, so a surviving onerror runs. (A "<script> did not
// execute" assertion would be vacuous here — innerHTML never runs scripts —
// which is why the script check above asserts the ELEMENT is absent instead.)
await px.waitForTimeout(300);
check("sanitizer: img onerror did not fire", await px.evaluate(() => window.__xssImg !== true));
await ctxX.close();

// -- #url= remote document rendering and readonly lock mode
const ctxUrl = await browser.newContext();
const pUrl = await ctxUrl.newPage();
hook(pUrl);
const remoteDocUrl = `http://localhost:${PORT}/fixtures/remote.md`;
await pUrl.goto(`http://localhost:${PORT}/#url=${encodeURIComponent(remoteDocUrl)}`, { waitUntil: "load", timeout: 30000 });
await pUrl.waitForFunction(() => document.body.classList.contains("viewing"), null, { timeout: 10000 });

check("#url=: content renders", await pUrl.evaluate(() => {
  const h1 = document.querySelector("#content h1");
  return h1 && h1.textContent === "Remote Markdown";
}));

check("#url=: title derived from URL filename", await pUrl.evaluate(() => {
  return document.getElementById("docTitle").textContent === "remote.md";
}));

check("#url=: readonly mode active on body", await pUrl.evaluate(() => {
  return document.body.classList.contains("readonly-mode");
}));

check("#url=: Clear button is hidden in readonly mode", await pUrl.evaluate(() => {
  const btn = document.getElementById("btnClear");
  return getComputedStyle(btn).display === "none";
}));

check("#url=: relative image resolved to base URL", await pUrl.evaluate(() => {
  const img = document.querySelector("#content img");
  return img && img.getAttribute("src").startsWith("http://localhost:") && img.getAttribute("src").includes("/fixtures/assets/diag.png");
}));

check("#url=: relative markdown link rewritten to #url=", await pUrl.evaluate(() => {
  const links = Array.from(document.querySelectorAll("#content a"));
  const mdLink = links.find((a) => a.textContent === "Another doc");
  return mdLink && mdLink.getAttribute("href").startsWith("#url=") && mdLink.getAttribute("href").includes("sub%2Fother.md");
}));

check("#url=: external link keeps target=_blank and rel", await pUrl.evaluate(() => {
  const links = Array.from(document.querySelectorAll("#content a"));
  const extLink = links.find((a) => a.textContent === "External");
  return extLink && extLink.getAttribute("target") === "_blank" && extLink.getAttribute("rel") === "noopener noreferrer";
}));

// Test readonly mode locks out drop and paste
await pUrl.evaluate(() => {
  const dt = new DataTransfer();
  dt.setData("text", "# dropped text that should be ignored");
  window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
});
check("#url=: drop ignored in readonly mode", await pUrl.evaluate(() => {
  return !document.getElementById("content").textContent.includes("dropped text that should be ignored");
}));

await pUrl.evaluate(() => {
  const dt = new DataTransfer();
  dt.setData("text", "# pasted text that should be ignored");
  window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
check("#url=: paste ignored in readonly mode", await pUrl.evaluate(() => {
  return !document.getElementById("content").textContent.includes("pasted text that should be ignored");
}));

await ctxUrl.close();

// -- #url= error handling when URL returns 404
const ctxErr = await browser.newContext();
const pErr = await ctxErr.newPage();
hook(pErr);
await pErr.goto(`http://localhost:${PORT}/#url=${encodeURIComponent(`http://localhost:${PORT}/fixtures/404.md`)}`, { waitUntil: "load", timeout: 30000 });
await pErr.waitForFunction(() => !document.getElementById("urlError").hidden, null, { timeout: 10000 });

check("#url= 404: error card displayed", await pErr.evaluate(() => {
  const card = document.getElementById("urlError");
  const msg = document.getElementById("urlErrorMsg");
  return !card.hidden && msg && msg.textContent.includes("404");
}));

// Test dismiss button returns to empty state
await pErr.click("#urlDismissBtn");
check("#url= error dismiss: resets to empty state and clears readonly", await pErr.evaluate(() => {
  const empty = document.getElementById("empty");
  const card = document.getElementById("urlError");
  return !empty.hidden && card.hidden && !document.body.classList.contains("readonly-mode");
}));

await ctxErr.close();


// -- static assertions
const sz = (p) => (existsSync(join(ROOT, p)) ? statSync(join(ROOT, p)).size : 0);
check("fonts present", sz("fonts/JetBrainsMono-Bold.subset.woff2") > 10000 && sz("fonts/JetBrainsMono-ExtraBold.subset.woff2") > 10000 && sz("fonts/OFL.txt") > 0);
check("favicon.ico present", sz("favicon.ico") > 2000);
check("site.webmanifest valid", (() => { try { return !!JSON.parse(readFileSync(join(ROOT, "site.webmanifest"), "utf8")).name; } catch (e) { return false; } })());
check("llms/ads/security.txt present", sz("llms.txt") > 0 && sz("ads.txt") > 0 && sz(".well-known/security.txt") > 0);
const csp = H["Content-Security-Policy"];
check("CSP allows self fonts + manifest", /font-src[^;]*'self'/.test(csp) && /manifest-src 'self'/.test(csp));
const idx = readFileSync(join(ROOT, "index.html"), "utf8");
check("head links (manifest + favicon.ico)", idx.includes('rel="manifest"') && idx.includes("/favicon.ico"));

// External-resource network noise (analytics offline) is allowed; CSP
// violations are worded "Refused to ..." and still fail.
const ALLOW = [/plausible/i, /thompsonblack/i, /net::ERR/i, /Failed to load resource/i];
const real = errs.filter((e) => !ALLOW.some((re) => re.test(e)));
check("no unexpected console/CSP errors", real.length === 0, real[0]);

await browser.close();
server.close();

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  — " + String(detail).slice(0, 160) : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
