# restate-fun

A collection of personal examples and utilities for [Restate](https://restate.dev),
built with the TypeScript SDK.

## Examples

### [`object-offload/`](./object-offload) — Transparent large-payload offloading

A utility that wraps `ctx.run(...)` so that any result exceeding a size threshold
is transparently offloaded to an object store (e.g. S3) and replaced in the
journal by a small reference, while smaller results are journaled inline. This
keeps the durable journal lean when steps produce large payloads, without the
handler code having to care where the value lives.

**Most interesting file:** [`src/offload.ts`](./object-offload/src/offload.ts) —
the `mayBeOffload` helper. Note the side-channel trick that returns the in-memory
value on the first run to avoid re-downloading what was just uploaded.

### [`ci-pipeline-workflow/`](./ci-pipeline-workflow) — A CI pipeline as a Restate workflow

A CI pipeline modeled as a durable Restate workflow that acts as the control
plane: it builds and tests [`sdk-typescript`](https://github.com/restatedev/sdk-typescript),
packages the e2e service image, gates on a human approval, and runs the
conformance suite — with the actual build steps executing in Docker containers
that the workflow starts and observes. It demonstrates two completion-detection
styles in one place: non-durable polling inside a single `ctx.run`, and
callbacks via a durable promise (human approval) and an awakeable (container
calls back over the ingress).

**Most interesting file:** [`src/pipeline.ts`](./ci-pipeline-workflow/src/pipeline.ts) —
the `CiPipeline` workflow tying the stages together. See its
[README](./ci-pipeline-workflow/README.md) for architecture and a runbook.

### [`crawler/`](./crawler) — A recursive web crawler

A resilient recursive web crawler: one self-recursive handler crawls a page,
saves its text, and recurses into same-host links in parallel, while a Virtual
Object keyed by the URL hash tracks each page's lifecycle. The Virtual Object
atomically claims each URL so no page is crawled twice and link cycles can't
loop forever; depth-tagged idempotency keys keep a back-link from deadlocking a
parent against its own descendant. It's a compact illustration of using Restate
state for dedup and req/resp self-calls to preserve the call tree.

**Most interesting file:** [`src/crawler.ts`](./crawler/src/crawler.ts) — the
`crawl` handler (claim → durable fetch → save → mark completed → recurse). See
its [README](./crawler/README.md) for the two-keys design that avoids both
double-crawling and deadlock.
