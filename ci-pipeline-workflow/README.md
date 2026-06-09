# CI pipeline on Restate — Pattern A (orchestration control plane)

A CI pipeline built as a **Restate workflow**: the workflow is the durable
control plane; the build steps execute in **Docker containers** that the
workflow starts and observes via the docker CLI. The pipeline builds
[restatedev/sdk-typescript](https://github.com/restatedev/sdk-typescript), runs
its test suite, packages the e2e test services with the fresh SDK, and runs the
SDK conformance tests from [restatedev/e2e](https://github.com/restatedev/e2e)
against that image.

## Architecture

```
CiPipeline workflow (key = runId)            Docker (execution layer)
─────────────────────────────────            ────────────────────────
1. ctx.run("build & test sdk")   ──start──▶  ci-<runId>-sdk-build (node:22)
   non-durable poll inside the   ◀─inspect─    clone sdk-typescript, pnpm
   single durable step                         install / build / test
2. ctx.run("build service image")──docker build──▶ restatedev/node-test-services:ci-<runId>
3. await ctx.promise("approval") ◀─resolve── human: POST .../approve
4. ctx.awakeable() + start e2e   ──start──▶  ci-<runId>-e2e (temurin:21, docker.sock)
   workflow SUSPENDS             ◀─curl────    gradlew :sdk-tests:run <image>,
   (orTimeout backstop)                        then resolves the awakeable
5. ctx.run("cleanup containers")
```

Two completion-detection styles on purpose:

- **Polling** (stage 1): a `docker inspect` loop. The loop itself is *not*
  durable — it lives inside one `ctx.run` and only the exit code is journaled.
  Container starts are idempotent (deterministic names), so a service restart
  mid-poll just re-attaches.
- **Callbacks**: a **durable promise** resolved by a human (`approve`, stage 3)
  and an **awakeable** resolved by the e2e container itself over the ingress
  (stage 4). While waiting, the workflow is suspended — no compute held. The
  awakeable is raced against a durable timeout in case the container dies
  before calling back.

## Layout

- `src/pipeline.ts` — the `CiPipeline` workflow (`run`, `approve`, `getStatus`)
- `src/docker.ts` — docker CLI helpers (idempotent start, poll, build, logs)
- `src/paths.ts` / `src/schemas.ts` — config paths and zod schemas
- `scripts/build-sdk.sh` / `scripts/e2e-run.sh` — container entrypoints
- `../build_data/<runId>/` — workspace, logs and test reports per run

## Prerequisites

- Docker daemon running; `node` >= 22 on the host.
- A Restate server (>= 1.4) running with ingress on `:8080` and admin on
  `:9070`, **listening on 0.0.0.0** — the e2e container calls the ingress via
  `host.docker.internal` to resolve the awakeable.

## Runbook

```bash
# 1. start + register the pipeline service
npm install
npm run dev                 # serves on :9081
npm run register            # or: curl localhost:9070/deployments --json '{"uri":"http://localhost:9081"}'

## GO to the Web UI (localhost:9070) to continuously explore the execution

# 2. submit a run (workflow key = run id; resubmits of the same key dedupe)
curl localhost:8080/CiPipeline/run-001/run/send \
  --json '{"sdkGitRef":"main","e2eGitRef":"main"}'

# 3. watch progress
curl localhost:8080/CiPipeline/run-001/getStatus
tail -f ../build_data/run-001/logs/sdk-build.log     # later: e2e.log

# 4. approve the gate (pipeline is suspended on a durable promise)
curl localhost:8080/CiPipeline/run-001/approve --json '{"approved":true,"by":"stephan"}'

# 5. fetch the final result (blocks until the workflow completes)
curl localhost:8080/restate/workflow/CiPipeline/run-001/attach
```

Input fields (all optional): `sdkGitRef`, `e2eGitRef` (branch/tag/SHA, default
`main`), `sdkBuildTimeoutMinutes` (default 60), `e2eTimeoutMinutes` (awakeable
backstop, default 45).

## Notes & troubleshooting

- **Failed runs keep their containers** for debugging. Clean up with:
  `docker rm -f $(docker ps -aq -f label=ci-run=<runId>)`.
- Both build containers run **docker-out-of-docker**: they mount
  `/var/run/docker.sock` (the SDK's own tests and the e2e suite use
  testcontainers, spawning restate/service containers as *siblings* on the
  host daemon) and use `--network=host` so processes inside them can reach the
  host-mapped ports of the containers they spawn — exactly like a bare-metal
  CI runner. `build_data` is mounted at the **same path** inside the
  containers, so paths stay valid host-side. If the testcontainers reaper
  misbehaves, set `TESTCONTAINERS_RYUK_DISABLED=true` in `e2e-run.sh`.
- The conformance suite runs with `--image-pull-policy=CACHED` so it uses the
  locally built service image instead of pulling it.
- Containers write `build_data` as root; removing it may need `sudo`.
- **Stale `latest` images**: the SDK's own testcontainers tests pull
  `docker.io/restatedev/restate:latest` only *if absent*. If your daemon has an
  old cached `latest`, tests relying on newer server flags fail mysteriously —
  `docker pull docker.io/restatedev/restate:latest` to refresh.
- Gradle distributions/dependencies and the pnpm store are cached under
  `build_data/.gradle-home` and `build_data/.pnpm-store` to speed up repeat runs.
