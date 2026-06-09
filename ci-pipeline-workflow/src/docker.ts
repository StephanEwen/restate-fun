/*
 * Thin docker-CLI helpers used by the pipeline's durable steps (ctx.run).
 *
 * Error convention: a non-zero exit of a *build container* is a pipeline
 * result, not an infrastructure error — helpers report exit codes and never
 * throw for it. They throw only when docker itself misbehaves (daemon down,
 * invalid invocation), so that ctx.run retries transient infra failures.
 */
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_BUFFER = 16 * 1024 * 1024;

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function docker(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      // err.code is a number when the process ran and exited non-zero, and a
      // string errno (e.g. ENOENT) when it could not be spawned at all.
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (err && typeof code !== "number") {
        reject(err);
        return;
      }
      resolve({ code: err ? (code as unknown as number) : 0, stdout, stderr });
    });
  });
}

export interface ContainerState {
  status: string; // created | running | exited | dead | ...
  exitCode: number;
}

/** Inspect a container by name; undefined if it does not exist. */
export async function containerState(name: string): Promise<ContainerState | undefined> {
  const res = await docker(["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", name]);
  if (res.code !== 0) return undefined;
  const [status, exitCode] = res.stdout.trim().split(" ");
  return { status, exitCode: Number(exitCode) };
}

export interface StartOptions {
  name: string;
  image: string;
  runId: string;
  env?: Record<string, string>;
  mounts?: { host: string; container: string; readonly?: boolean }[];
  extraArgs?: string[];
  cmd: string[];
}

/**
 * Start a container detached. Idempotent: if a container with this name
 * already exists (e.g. a previous ctx.run attempt started it before the
 * service crashed), this is a no-op and the caller resumes waiting on it.
 */
export async function startContainerDetached(opts: StartOptions): Promise<void> {
  if (await containerState(opts.name)) return;
  const args = ["run", "-d", "--name", opts.name, "--label", `ci-run=${opts.runId}`];
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
  for (const m of opts.mounts ?? []) {
    args.push("-v", `${m.host}:${m.container}${m.readonly ? ":ro" : ""}`);
  }
  args.push(...(opts.extraArgs ?? []), opts.image, ...opts.cmd);
  const res = await docker(args);
  if (res.code !== 0) {
    if (res.stderr.includes("is already in use")) return; // lost a start race; fine
    throw new Error(`docker run ${opts.name} failed: ${res.stderr.trim()}`);
  }
}

/**
 * Poll the container until it exits; resolves with its exit code, or "timeout".
 *
 * The poll loop is deliberately NOT durable — it lives inside a single
 * ctx.run and only its final result is journaled. If the service restarts
 * mid-poll, ctx.run re-executes, startContainerDetached no-ops, and polling
 * simply re-attaches to the still-running container.
 */
export async function waitForContainer(
  name: string,
  opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<number | "timeout"> {
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : undefined;
  for (;;) {
    const state = await containerState(name);
    if (!state) throw new Error(`container ${name} vanished while waiting for it`);
    if (state.status === "exited" || state.status === "dead") return state.exitCode;
    if (deadline && Date.now() > deadline) return "timeout";
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

/**
 * Mirror container output to a log file for live tailing (fire-and-forget).
 * Truncates on (re-)attach because `docker logs -f` replays from the start.
 */
export function streamLogsToFile(name: string, file: string): void {
  const out = fs.createWriteStream(file, { flags: "w" });
  const child = spawn("docker", ["logs", "-f", name], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  child.on("close", () => out.end());
  child.on("error", () => out.end());
}

/** One-shot, complete log dump after a container exited (best-effort). */
export function dumpLogsToFile(name: string, file: string): Promise<void> {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(file, { flags: "w" });
    const child = spawn("docker", ["logs", name], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("close", () => {
      out.end();
      resolve();
    });
    child.on("error", () => {
      out.end();
      resolve();
    });
  });
}

/** docker build with output to a log file; resolves with the exit code. */
export function buildImage(
  contextDir: string,
  dockerfileRelPath: string,
  tag: string,
  logFile: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(logFile, { flags: "w" });
    const child = spawn(
      "docker",
      ["build", contextDir, "-f", path.join(contextDir, dockerfileRelPath), "-t", tag],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("error", (err) => {
      out.end();
      reject(err); // docker not spawnable -> infra error -> let ctx.run retry
    });
    child.on("close", (code) => {
      out.end();
      resolve(code ?? 1);
    });
  });
}

/** Best-effort forced removal of a container. */
export async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "-f", name]);
}
