// Pure helpers — no Restate context, no side effects.
// Deterministic, so they are safe to call outside of `ctx.run`.

import { createHash } from "node:crypto";
import { parse } from "node-html-parser";

/**
 * Canonicalize a URL so the same page always maps to the same key:
 *  - resolve relative URLs against `base`
 *  - reject non-http(s) schemes (mailto:, javascript:, tel:, ...)
 *  - drop the #fragment, lowercase the host, drop default ports
 *  - trim a trailing slash on non-root paths
 *  - keep the query string (different queries are different pages)
 *
 * Throws on unsupported schemes / unparseable URLs; callers filter those out.
 */
export function canonicalizeUrl(raw: string, base?: string): string {
  const u = base ? new URL(raw, base) : new URL(raw);

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`unsupported scheme: ${u.protocol}`);
  }

  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

/** Deterministic SHA-256 hex digest of a (canonical) URL. */
export function hashUrl(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl).digest("hex");
}

export interface PageContent {
  text: string;
  /** Absolute, canonicalized, de-duplicated links found on the page. */
  links: string[];
}

/**
 * Parse HTML into visible text plus the set of links it points to.
 * Pure given (html, baseUrl).
 */
export function extractPage(html: string, baseUrl: string): PageContent {
  // Don't fold <script>/<style> contents into the page text.
  const root = parse(html, { blockTextElements: { script: false, style: false } });

  const text = root.structuredText.replace(/\s+/g, " ").trim();

  const seen = new Set<string>();
  const links: string[] = [];
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    let canonical: string;
    try {
      canonical = canonicalizeUrl(href, baseUrl);
    } catch {
      continue; // relative-to-nothing, mailto:, javascript:, malformed, ...
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      links.push(canonical);
    }
  }

  return { text, links };
}
