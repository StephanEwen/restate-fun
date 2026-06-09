/*
 * CiPipeline — a CI pipeline as a Restate workflow, following the
 * "orchestration control plane" pattern (Pattern A):
 *
 *   - The workflow owns the pipeline DAG, retries, approval gate and status.
 *   - The actual build work runs in Docker containers (the execution layer);
 *     the workflow only starts and observes them via the docker CLI.
 *
 * Completion detection demonstrates both styles:
 *   - Stage 1 (SDK build+test):   status POLLING — a non-durable poll loop
 *     inside a single durable ctx.run step.
 *   - Stage 3 (approval gate):    durable promise resolved by a human via the
 *     `approve` shared handler.
 *   - Stage 4 (e2e conformance):  AWAKEABLE — the workflow suspends; the e2e
 *     container curls the ingress resolve endpoint as its last act, with a
 *     durable timeout as backstop in case the container dies silently.
 */
import * as restate from "@restatedev/restate-sdk";
import * as path from "node:path";
import * as docker from "./docker";
import {
  BUILD_DATA_DIR,
  INGRESS_URL_FOR_CONTAINERS,
  SCRIPTS_DIR,
  ensureRunDirs,
  logsDir,
  workspaceDir,
} from "./paths";
import { Approval, E2eResult, PipelineInput, PipelineStatus, Stage } from "./schemas";

const SDK_BUILD_IMAGE = "node:22";
const E2E_RUNNER_IMAGE = "eclipse-temurin:21";
// Dockerfile (relative to the sdk-typescript checkout) that packages the e2e
// test services with the freshly built SDK from the workspace.
const SERVICE_IMAGE_DOCKERFILE = "packages/tests/restate-e2e-services/Dockerfile";

const sharedMounts = [
  // Same path inside and outside: see the comment in paths.ts.
  { host: BUILD_DATA_DIR, container: BUILD_DATA_DIR },
  { host: SCRIPTS_DIR, container: "/ci-scripts", readonly: true },
];

/*
 * --------------------------------------------------------------
 *   The main CI workflow code - this is the interesting part!
 * --------------------------------------------------------------	
 */
export const ciPipeline = restate.workflow({
  name: "CiPipeline",
  options: {
    inactivityTimeout: { minutes: 2 },   // leads to suspensions on long steps, but with immediate graceful restore
    abortTimeout: { hours: 2 },          // any stage longer than 2h leads to an abort
    journalRetention: { days: 1 },       // keep the journal history for 1 day
  },
  handlers: {
    run: restate.createWorkflowHandler(
      { input: restate.serde.schema(PipelineInput) },

      async (ctx: restate.WorkflowContext, input) => {
        
        const runId = ctx.key;
        // The run id lands in container names and host paths.
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId.includes("..")) {
          throw new restate.TerminalError(`invalid run id: ${runId}`);
        }
        const serviceImage = `restatedev/node-test-services:ci-${runId}`;
        const containers = { sdkBuild: `ci-${runId}-sdk-build`, e2e: `ci-${runId}-e2e` };

        // some in-line helpers
        const status: PipelineStatus = {
          stage: "build-sdk",
          stages: {},
          serviceImage,
          logsDir: logsDir(runId),
        };
        const setStage = (stage: Stage, stageResults?: Record<string, string>): void => {
          status.stage = stage;
          Object.assign(status.stages, stageResults);
          ctx.set("status", status);
        };
        const fail = (stage: string, message: string): never => {
          status.error = `[${stage}] ${message}`;
          setStage("failed", { [stage]: "failed" });
          // Failed runs keep their containers around for debugging; see README.
          throw new restate.TerminalError(`CI run failed at ${stage}: ${message}`);
        };

        setStage("build-sdk");

        // ── Stage 1: build the TS SDK and run its tests (POLLING) ──────────
        // The container is started idempotently; the poll loop itself is not
        // durable — only its outcome (the exit code) is journaled.
        const sdkExit = await ctx.run(
          "build & test sdk",
          async () => {
            ensureRunDirs(runId);
            const logFile = await startSdkBuildContainer(
              containers.sdkBuild,
              runId,
              input.sdkGitRef,
            );
            const exit = await docker.waitForContainer(containers.sdkBuild, {
              timeoutMs: input.sdkBuildTimeoutMinutes * 60_000,
            });
            if (typeof exit === "number") await docker.dumpLogsToFile(containers.sdkBuild, logFile);
            return exit;
          },
          { maxRetryAttempts: 3 }, // retry transient infra failures
        );
        if (sdkExit === "timeout") {
          fail("build-sdk", `no result after ${input.sdkBuildTimeoutMinutes} minutes`);
        }
        if (sdkExit !== 0) {
          fail("build-sdk", `container exited with code ${sdkExit} (see sdk-build.log)`);
        }
        setStage("build-image", { "build-sdk": "passed" });

        // ── Stage 2: package the e2e services with the fresh SDK ───────────
        // Runs on the host docker daemon against the workspace checkout.
        const imageExit = await ctx.run(
          "build service image",
          () =>
            docker.buildImage(
              path.join(workspaceDir(runId), "sdk-typescript"),
              SERVICE_IMAGE_DOCKERFILE,
              serviceImage,
              path.join(logsDir(runId), "build-image.log"),
            ),
          { maxRetryAttempts: 3 },
        );
        if (imageExit !== 0) {
          fail("build-image", `docker build exited with code ${imageExit} (see build-image.log)`);
        }
        setStage("awaiting-approval", { "build-image": "passed" });

        // ── Stage 3: approval gate (durable promise, human callback) ───────
        // The workflow suspends here until `approve` resolves the promise.
        const decision = await ctx.promise<Approval>("approval");
        if (!decision.approved) {
          fail("approval", `rejected by ${decision.by ?? "unknown"}`);
        }
        setStage("e2e", { approval: `approved by ${decision.by ?? "unknown"}` });

        // ── Stage 4: e2e conformance tests (AWAKEABLE, machine callback) ───
        // The container gets the awakeable id and resolves it over the ingress
        // when gradle finishes; meanwhile the workflow is fully suspended.
        const e2eDone = ctx.awakeable<E2eResult>();
        await ctx.run(
          "start e2e container",
          () =>
            startE2eContainer(containers.e2e, runId, {
              e2eGitRef: input.e2eGitRef,
              serviceImage,
              awakeableId: e2eDone.id,
            }),
          { maxRetryAttempts: 3 },
        );

        let e2e: E2eResult;
        try {
          e2e = await e2eDone.promise.orTimeout({ minutes: input.e2eTimeoutMinutes });
        } catch (err) {
          if (err instanceof restate.TimeoutError) {
            fail("e2e", `container never called back within ${input.e2eTimeoutMinutes} minutes (see e2e.log)`);
          }
          throw err;
        }
        await ctx.run("dump e2e logs", () =>
          docker.dumpLogsToFile(containers.e2e, path.join(logsDir(runId), "e2e.log")),
        );
        if (!e2e.passed) {
          fail("e2e", e2e.report ?? "e2e tests failed (see e2e.log)");
        }
        setStage("cleanup", { e2e: "passed" });

        // ── Stage 5: cleanup (success only — failed runs keep containers) ──
        // The service image and the build_data workspace are the artifacts and
        // are kept.
        await ctx.run("cleanup containers", async () => {
          await docker.removeContainer(containers.sdkBuild);
          await docker.removeContainer(containers.e2e);
        });
        setStage("done");

        return {
          runId,
          result: "passed" as const,
          serviceImage,
          workspace: workspaceDir(runId),
          logs: logsDir(runId),
          e2eReport: e2e.report,
        };
      },
    ),

    /** Human callback: resolves the durable promise the run handler awaits. */
    approve: restate.createWorkflowSharedHandler(
      { input: restate.serde.schema(Approval) },
      async (ctx: restate.WorkflowSharedContext, decision) => {
        await ctx.promise<Approval>("approval").resolve(decision);
        return { recorded: decision };
      },
    ),

    /** Progress of this run, readable at any time (also after completion). */
    getStatus: restate.createWorkflowSharedHandler(
      { journalRetention: { days: 0 } },	// don't keep any history here, it's not interesting
      async (ctx: restate.WorkflowSharedContext): Promise<PipelineStatus> =>
        (await ctx.get<PipelineStatus>("status")) ?? { stage: "pending", stages: {} },
    ),
  },
});


/**
 * Start the SDK build+test container and begin tailing its logs. Idempotent
 * (see startContainerDetached); returns the log file path so the caller can
 * dump the complete logs once the container exits.
 */
async function startSdkBuildContainer(
  name: string,
  runId: string,
  sdkGitRef: string,
): Promise<string> {
  await docker.startContainerDetached({
    name,
    image: SDK_BUILD_IMAGE,
    runId,
    mounts: [
      ...sharedMounts,
      // the SDK test suite itself uses testcontainers
      { host: "/var/run/docker.sock", container: "/var/run/docker.sock" },
    ],
    // The testcontainers tests register in-process service endpoints with
    // sibling restate containers via host.docker.internal; host networking
    // makes this container look like a host CI agent.
    extraArgs: ["--network=host"],
    env: {
      BUILD_DATA_DIR,
      RUN_ID: runId,
      SDK_GIT_REF: sdkGitRef,
    },
    cmd: ["bash", "/ci-scripts/build-sdk.sh"],
  });
  const logFile = path.join(logsDir(runId), "sdk-build.log");
  docker.streamLogsToFile(name, logFile); // live tail
  return logFile;
}

/**
 * Start the e2e conformance container and begin tailing its logs. Idempotent.
 * The container resolves the given awakeable over the ingress when gradle
 * finishes.
 */
async function startE2eContainer(
  name: string,
  runId: string,
  opts: { e2eGitRef: string; serviceImage: string; awakeableId: string },
): Promise<void> {
  await docker.startContainerDetached({
    name,
    image: E2E_RUNNER_IMAGE,
    runId,
    mounts: [
      ...sharedMounts,
      // testcontainers inside gradle drives the HOST docker daemon
      { host: "/var/run/docker.sock", container: "/var/run/docker.sock" },
    ],
    // Host networking so the gradle/testcontainers JVM reaches the host-mapped
    // ports of the restate clusters it spawns (DooD); host.docker.internal
    // still resolves to the host for the awakeable callback.
    extraArgs: ["--network=host", "--add-host=host.docker.internal:host-gateway"],
    env: {
      BUILD_DATA_DIR,
      RUN_ID: runId,
      E2E_GIT_REF: opts.e2eGitRef,
      SERVICE_IMAGE: opts.serviceImage,
      RESTATE_INGRESS_URL: INGRESS_URL_FOR_CONTAINERS,
      AWAKEABLE_ID: opts.awakeableId,
    },
    cmd: ["bash", "/ci-scripts/e2e-run.sh"],
  });
  docker.streamLogsToFile(name, path.join(logsDir(runId), "e2e.log"));
}