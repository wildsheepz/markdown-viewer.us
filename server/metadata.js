import { URL } from "node:url";

const DEFAULT_TITLE = "Markdown Viewer";
const DEFAULT_DESC = "A fast, single-file Markdown and text viewer that renders files instantly in your browser.";
const DEFAULT_IMAGE = "https://markdown-viewer.us/og.png";

/**
 * Rewrites GitHub, GitLab, and Gist URLs to raw content endpoints.
 */
export function rewriteRepoUrl(rawUrl) {
  if (!rawUrl) return "";
  const url = rawUrl.trim();
  const gh = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i.exec(url);
  if (gh) {
    return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}/${gh[4]}`;
  }
  const gl = /^https?:\/\/gitlab\.com\/([^/]+)\/([^/]+)\/-\/blob\/([^/]+)\/(.+)$/i.exec(url);
  if (gl) {
    return `https://gitlab.com/${gl[1]}/${gl[2]}/-/raw/${gl[3]}/${gl[4]}`;
  }
  const gist = /^https?:\/\/gist\.github\.com\/([^/]+)\/([a-f0-9]+)(?:\/)?$/i.exec(url);
  if (gist) {
    return `https://gist.githubusercontent.com/${gist[1]}/${gist[2]}/raw`;
  }
  return url;
}

/**
 * Checks if an IP or hostname is private/internal (SSRF guardrail).
 */
export function isBlockedUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return true;
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "0.0.0.0" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "::"
    ) {
      return true;
    }

    // Check IPv4 private and link-local ranges
    const ipv4Parts = host.split(".").map(Number);
    if (ipv4Parts.length === 4 && ipv4Parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
      const [b0, b1] = ipv4Parts;
      if (b0 === 127) return true; // 127.0.0.0/8 loopback
      if (b0 === 10) return true; // 10.0.0.0/8 private
      if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12 private
      if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16 private
      if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16 link-local
      if (b0 === 0) return true; // 0.0.0.0/8
    }

    // Check IPv6 unique local (fc00::/7) or link-local (fe80::/10)
    if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) {
      return true;
    }

    return false;
  } catch (_) {
    return true;
  }
}

/**
 * Extracts title from URL path as fallback.
 */
function filenameFromUrl(u) {
  try {
    const pathname = new URL(u).pathname;
    const segs = pathname.split("/").filter(Boolean);
    const last = segs.length ? segs[segs.length - 1] : "";
    return decodeURIComponent(last) || DEFAULT_TITLE;
  } catch (_) {
    return DEFAULT_TITLE;
  }
}

/**
 * Clean inline markdown syntax (links, bold, code, images, etc.).
 */
function stripMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> link text
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)(.*?)\1/g, "$2") // italic
    .replace(/~~(.*?)~~/g, "$1") // strikethrough
    .replace(/^\s{0,3}>\s?/gm, "") // blockquotes
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parses markdown to extract title, description, and image.
 */
export function extractMetadata(markdownText, targetUrl) {
  const text = markdownText || "";
  let title = "";
  let description = "";
  let image = "";

  const lines = text.split(/\r?\n/);
  const bodyParagraphs = [];
  let currentPara = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();

    // Check for title heading (# Title)
    if (!title) {
      const headingMatch = /^#{1,6}\s+(.+)$/.exec(rawLine);
      if (headingMatch) {
        title = stripMarkdown(headingMatch[1]);
        continue;
      }
    }

    // Check for first image
    if (!image) {
      const imgMatch = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/.exec(rawLine);
      if (imgMatch) {
        const rawSrc = imgMatch[1];
        try {
          image = new URL(rawSrc, targetUrl).href;
        } catch (_) {
          image = rawSrc;
        }
      }
    }

    // Collect paragraphs (skip lines that start with heading hashes)
    if (rawLine === "") {
      if (currentPara.length > 0) {
        bodyParagraphs.push(currentPara.join(" "));
        currentPara = [];
      }
    } else if (!/^#{1,6}\s+/.test(rawLine)) {
      currentPara.push(rawLine);
    }
  }

  if (currentPara.length > 0) {
    bodyParagraphs.push(currentPara.join(" "));
  }

  // Fallback title
  if (!title) {
    title = filenameFromUrl(targetUrl);
  }

  // First non-empty paragraph for description
  for (const para of bodyParagraphs) {
    const cleaned = stripMarkdown(para);
    if (/^(?:source|url|link):\s*https?:\/\//i.test(cleaned) || /^keywords\b/i.test(cleaned)) {
      continue;
    }
    if (cleaned.length > 0) {
      description = cleaned.length > 200 ? cleaned.slice(0, 197).trim() + "…" : cleaned;
      break;
    }
  }
  // Fallback to any non-empty paragraph if all were metadata
  if (!description) {
    for (const para of bodyParagraphs) {
      const cleaned = stripMarkdown(para);
      if (cleaned.length > 0) {
        description = cleaned.length > 200 ? cleaned.slice(0, 197).trim() + "…" : cleaned;
        break;
      }
    }
  }

  if (!description) {
    description = DEFAULT_DESC;
  }

  if (!image) {
    image = DEFAULT_IMAGE;
  }

  return { title, description, image };
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Injects OpenGraph, Twitter, and document title meta tags into index.html.
 */
export function injectMetadata(html, { title, description, image, url }) {
  const safeTitle = escapeHtml(title);
  const safeFullTitle = escapeHtml(`${title} — ${DEFAULT_TITLE}`);
  const safeDesc = escapeHtml(description);
  const safeImg = escapeHtml(image);
  const safeUrl = escapeHtml(url);

  let result = html;

  result = result.replace(/<title>.*?<\/title>/i, `<title>${safeFullTitle}</title>`);
  result = result.replace(
    /<meta\s+property=["']og:title["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta property="og:title" content="${safeTitle}">`
  );
  result = result.replace(
    /<meta\s+property=["']og:description["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta property="og:description" content="${safeDesc}">`
  );
  result = result.replace(
    /<meta\s+property=["']og:image["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta property="og:image" content="${safeImg}">`
  );
  result = result.replace(
    /<meta\s+property=["']og:url["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta property="og:url" content="${safeUrl}">`
  );

  result = result.replace(
    /<meta\s+name=["']twitter:title["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta name="twitter:title" content="${safeTitle}">`
  );
  result = result.replace(
    /<meta\s+name=["']twitter:description["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta name="twitter:description" content="${safeDesc}">`
  );
  result = result.replace(
    /<meta\s+name=["']twitter:image["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta name="twitter:image" content="${safeImg}">`
  );

  return result;
}

// In-memory TTL cache (10 minutes)
const metadataCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Fetches remote markdown safely and returns extracted metadata.
 */
export async function getRemoteMetadata(targetUrl, fetchFn = fetch, options = {}) {
  if (isBlockedUrl(targetUrl) && !options.allowTestLoopback) {
    return null;
  }

  const cached = metadataCache.get(targetUrl);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const fetchUrl = rewriteRepoUrl(targetUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  try {
    const res = await fetchFn(fetchUrl, {
      signal: controller.signal,
      headers: {
        Accept: "text/markdown, text/plain, */*",
        "User-Agent": "MarkdownViewerPreviewBot/1.0",
      },
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return null;
    }

    // Read up to 256KB
    const text = await res.text();
    const truncatedText = text.slice(0, 262144);
    const meta = extractMetadata(truncatedText, targetUrl);

    metadataCache.set(targetUrl, {
      timestamp: Date.now(),
      data: meta,
    });

    return meta;
  } catch (_) {
    clearTimeout(timeoutId);
    return null;
  }
}
