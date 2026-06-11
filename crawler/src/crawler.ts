import * as restate from "@restatedev/restate-sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { canonicalizeUrl, hashUrl, extractPage } from "./canonical";
import { crawlStatus, type CrawlStatus } from "./status";

const DOWNLOAD_DIR = path.resolve(process.cwd(), "downloads");

// ------------------------------------------------------------
//  Schema types
// ------------------------------------------------------------

const CrawlArg = z.object({
  url: z.url(),
  /** Depth of this page in the crawl tree; the root is 0. Passed explicitly. */
  depth: z.number().int().min(0),
  maxDepth: z.number().int().min(0),
});
type CrawlArg = z.infer<typeof CrawlArg>;

const CrawlResult = z.object({
  url: z.string(),
  outcome: z.enum(["crawled", "skipped", "failed"]),
  /** This page (if crawled) plus everything crawled beneath it. */
  pagesCrawled: z.number().int(),
});
type CrawlResult = z.infer<typeof CrawlResult>;

// What the durable fetch step reports back. A returned value is journaled and
// never retried; only a *thrown* error triggers Restate's retry machinery.
type FetchOutcome =
  | { kind: "ok"; html: string }
  | { kind: "permanent_failure"; reason: string };

// ------------------------------------------------------------
//   The crawler service
// ------------------------------------------------------------

export const crawler = restate.service({
  name: "crawler",
  handlers: {
    crawl: restate.createServiceHandler(
      { input: restate.serde.schema(CrawlArg), output: restate.serde.schema(CrawlResult) },
      async (ctx: restate.Context, arg: CrawlArg): Promise<CrawlResult> => {
        const canonical = canonicalizeUrl(arg.url); // deterministic — fine outside ctx.run
        const key = hashUrl(canonical);
        const hostname = new URL(canonical).hostname;

        // 1) Atomically claim this URL via the Virtual Object (req/resp). If
        //    another invocation already started or finished it, bail out early.
        const claim = await ctx.objectClient<CrawlStatus>(crawlStatus, key).tryClaim(canonical);
        if (!claim.proceed) {
          return { url: canonical, outcome: "skipped", pagesCrawled: 0 };
        }

        // 2) Durably fetch the page. Transient problems (5xx, network) throw so
        //    Restate retries; permanent ones (4xx, non-HTML) return a value.
        const fetched = await ctx.run<FetchOutcome>("fetch", async () => {
          const res = await fetch(canonical, {
            redirect: "follow",
            headers: { "user-agent": "restate-crawler-demo" },
          });
          if (res.status >= 500) {
            throw new Error(`upstream ${res.status} for ${canonical}`); // retry
          }
          if (!res.ok) {
            return { kind: "permanent_failure", reason: `http ${res.status}` };
          }
          const contentType = res.headers.get("content-type") ?? "";
          if (!contentType.includes("text/html")) {
            return { kind: "permanent_failure", reason: `non-html content-type: ${contentType}` };
          }
          return { kind: "ok", html: await res.text() };
        });

        if (fetched.kind === "permanent_failure") {
          await ctx.objectClient<CrawlStatus>(crawlStatus, key).setStatus("failed");
          return { url: canonical, outcome: "failed", pagesCrawled: 0 };
        }

        // 3) Extract text + links (pure), then push the text "to an API" — here a
        //    durable write of <hash>.txt into ./downloads.
        const { text, links } = extractPage(fetched.html, canonical);
        await ctx.run("save", async () => {
          await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
          await fs.writeFile(
            path.join(DOWNLOAD_DIR, `${encodeURIComponent(canonical)}.txt`),
       
            text,
            "utf8",
          );
        });

        // 4) Mark completed BEFORE recursing, so any child that links back here
        //    sees "completed" and skips instead of waiting on us.
        await ctx.objectClient<CrawlStatus>(crawlStatus, key).setStatus("completed");

        // 5) Recurse into same-host links, in parallel, via req/resp self-calls.
        //    Req/resp (not send) preserves the call tree and cancellation, and
        //    lets us aggregate the pages crawled beneath us.
        const childDepth = arg.depth + 1;
        let childPages = 0;
        if (childDepth <= arg.maxDepth) {
          const calls = links
            .filter((link) => {
              try {
                return new URL(link).hostname === hostname;
              } catch {
                return false;
              }
            })
            .map((childUrl) => {
              const childKey = hashUrl(childUrl); // childUrl is already canonical
              // The idempotency key includes the depth. Same URL at the same depth
              // collapses to one invocation (dedup), but a descendant can never
              // latch onto an in-flight ANCESTOR invocation of the same URL (which
              // would deadlock: parent awaits child awaits parent). The VO — keyed
              // by URL only, no depth — still guarantees the page is fetched once.
              return ctx
                .serviceClient(crawler)
                .crawl(
                  { url: childUrl, depth: childDepth, maxDepth: arg.maxDepth },
                  restate.rpc.opts({ idempotencyKey: `${childDepth}:${childKey}` }),
                );
            });

          if (calls.length > 0) {
            const results = await restate.RestatePromise.all(calls);
            childPages = results.reduce((sum, r) => sum + r.pagesCrawled, 0);
          }
        }

        return { url: canonical, outcome: "crawled", pagesCrawled: 1 + childPages };
      },
    ),
  },
});

export type Crawler = typeof crawler;
