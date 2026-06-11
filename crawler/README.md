# Web crawler — Restate TypeScript example

A small recursive web crawler built on the [Restate](https://docs.restate.dev) TypeScript SDK.
It crawls a site starting from a URL, saves each page's text, and follows links —
resiliently, with no double-crawling and no risk of deadlock.

## How it works

The crawler is one self-recursive handler (`crawler/crawl`) plus a Virtual Object
(`crawl-status`) that tracks each URL's lifecycle.

`crawl({ url, depth, maxDepth })` does the following:

1. **Claim the URL.** It first calls the `crawl-status` Virtual Object — keyed by
   `sha256(canonicalUrl)` — to atomically check-and-claim the page. Because
   exclusive object handlers run one-at-a-time per key, only one crawler can win
   the `pending -> in-progress` transition. If the page is already in-progress,
   completed, or failed, the handler returns early (`outcome: "skipped"`). This is
   what breaks cycles and prevents repeated crawling.
2. **Fetch + extract** the page in a durable step (`ctx.run`). Transient failures
   (5xx, network errors) are thrown and automatically retried by Restate;
   permanent ones (4xx, non-HTML) mark the page `failed` and stop.
3. **Push the text "to an API"** — in this demo, a durable step writes the page
   text to `./downloads/<hash>.txt`.
4. **Mark the page completed** *before* recursing, so a child that links back sees
   `completed` and skips.
5. **Recurse into links** on the same host, in parallel, as **req/resp** calls
   (`ctx.serviceClient`, not fire-and-forget). Req/resp preserves the call tree and
   cancellation, and lets the parent aggregate `pagesCrawled` from its children.

### Two keys, two jobs

- **Virtual Object key = `sha256(canonicalUrl)`** (no depth). Dedups *work*: a given
  URL is fetched and saved at most once, ever.
- **Idempotency key = `${depth}:${sha256(canonicalUrl)}`** (with depth). Dedups
  duplicate *invocations within a depth level*, while guaranteeing a descendant
  call can never latch onto an in-flight **ancestor** invocation of the same URL.
  Without the depth in the key, a back-link could make a parent wait on a child
  that is waiting on the parent — a deadlock. The depth makes those distinct
  invocations; the Virtual Object still ensures the page itself is crawled once.

## Run it

```bash
# 1. Install dependencies
npm install

# 2. Start the Restate server (ingress :8080, admin :9070)
restate-server

# 3. Start the service (serves on :9080)
npm run dev

# 4. Register the deployment with Restate
restate deployments register http://localhost:9080
```

Kick off a crawl through the ingress. The call is req/resp, so it blocks until the
whole tree finishes and returns the aggregated page count:

```bash
curl localhost:8080/crawler/crawl \
  -H 'content-type: application/json' \
  -H 'idempotency-key: root-crawl-1' \
  -d '{"url":"https://docs.restate.dev","depth":0,"maxDepth":2}'
```

Crawled text lands in `./downloads/<sha256>.txt`. Inspect a URL's status:

```bash
curl localhost:8080/crawl-status/<sha256-of-canonical-url>/get
```
