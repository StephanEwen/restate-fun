# Large-value offloading for Restate

A small utility that transparently offloads large `ctx.run(...)` results to an
object store (S3, or any custom store) so they don't bloat the Restate journal.

Restate journals the result of every `ctx.run(...)` step so it can replay your
handler deterministically after a failure. That's exactly what you want — until
a step returns a multi-megabyte payload, at which point every replay has to
shuffle that payload through the journal. This utility keeps the journal lean:
results above a size threshold are written to an object store and the journal
only keeps a tiny reference (`s3://bucket/key`); smaller results are journaled
inline as before. The calling handler doesn't have to know or care which path
was taken.

## How to use

Wrap the action you would normally pass to `ctx.run(...)` in `mayBeOffload`,
giving it an `ObjectStore` to offload to:

```ts
import * as restate from "@restatedev/restate-sdk";
import { mayBeOffload } from "./offload";
import { S3ObjectStore } from "./s3_object_store";

const objectStore = new S3ObjectStore({ bucket: "my-bucket", region: "us-east-1" });

const myService = restate.service({
  name: "myService",
  handlers: {
    process: async (ctx: restate.Context) => {
      // Same shape as ctx.run("step-name", action), plus the object store.
      const { value } = await mayBeOffload(ctx, objectStore, "fetch-report", async () => {
        return await fetchPotentiallyHugeReport(); // any JSON-serializable value
      });

      // `value` is always the real, in-memory value — whether it was
      // offloaded under the hood or not.
      return summarize(value);
    },
  },
});
```

`mayBeOffload` returns a `Result<T>` with two fields:

- **`value: T`** — the actual value, always materialized in memory. Use this in
  your handler logic.
- **`maybeOffloadedValue: T | Offload`** — either the inline value or a small
  `{ _isOffload: true, url }` reference. Pass *this* to other handlers when you
  want to hand off a reference to a large payload without moving the bytes
  through Restate's invocation path.

### Picking an object store

The utility talks to any store implementing the two-method `ObjectStore`
interface (`uploadToObjectStore` / `downloadFromObjectStore`):

- [`S3ObjectStore`](./src/s3_object_store.ts) — production S3 backend.
  Construct with `{ bucket, keyPrefix?, region?, maxRetries? }`.
- [`LocalFileObjectStore`](./src/test_object_store.ts) — writes to the OS temp
  dir; handy for local development and tests.

You can plug in your own (GCS, Azure Blob, a database BLOB column, …) by
implementing the same interface.

## Running the example

[`src/app.ts`](./src/app.ts) is a runnable service with two handlers —
`smallPayload` (stays inline) and `largePayload` (gets offloaded) — backed by
the local file store.

```bash
npm install
npm run dev      # serves the service on :9080

# in another terminal, register with a running Restate server
restate deployments register http://localhost:9080

curl localhost:8080/test/smallPayload
curl localhost:8080/test/largePayload
```

The example deliberately throws once (`maybeFail`) *after* the offload step, so
the handler is forced to replay. On replay the value is restored from the
journal — read back from the object store if it was offloaded — which lets you
watch the round-trip actually work.

## The interesting parts of the code

[`src/offload.ts`](./src/offload.ts) is the whole utility (~90 lines). The
parts worth reading:

- **Eager serialization inside `ctx.run`** — the action runs, and its result is
  serialized *immediately* with a binary serde so we can measure the byte size
  and decide whether to offload, all within the single journaled step. Only the
  reference (or the inline bytes) is returned to Restate.
- **The side channel that avoids a needless download** — when we offload, we
  also stash the just-computed in-memory value in a local `result` variable.
  On the first execution we return that directly, so we never download what we
  just uploaded. The download path only runs when the value is *restored from
  the journal* (i.e. on a later replay), where the in-memory value is gone.
- **The `Offload` reference type and `isOffload` guard** — the tiny tagged
  `{ _isOffload: true, url }` object is what stands in for the payload in the
  journal and in `maybeOffloadedValue`.

[`src/s3_object_store.ts`](./src/s3_object_store.ts) is worth a look for how it
maps S3 failures onto Restate's retry model: the AWS SDK's own retries are
disabled (`maxAttempts: 1`) so the store can classify errors itself —
permanent ones (bad credentials, missing bucket, 4xx) become a `TerminalError`
that stops Restate from retrying, while transient ones are retried with
exponential backoff.

## Limitations

- Currently only the **JSON serde** is supported (the util serializes to binary
  internally but expects JSON-serializable values). Extending it to other serde
  types is a natural next step.
- The offload threshold is a fixed constant (`OFFLOAD_THRESHOLD`, 1 MiB) in
  `offload.ts`.
- Offloaded objects are **not garbage-collected** — there's no lifecycle policy
  here for deleting objects once an invocation completes.
