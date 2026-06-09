import * as path from "node:path";
import * as fs from "node:fs";

// Repo root, derived from this module's location so the pipeline runs from any
// checkout. __dirname is <base>/ts/src (tsx/dev) or <base>/ts/dist (compiled);
// both are two levels below the base directory.
const BASE_DIR = path.resolve(__dirname, "..", "..");

// Host directory shared with the build containers. It is mounted at the SAME
// path inside the containers: the e2e stage talks to the HOST docker daemon
// through the mounted socket, so any path that ends up in a docker call (bind
// mounts, report dirs, ...) must be valid on the host too. Since the service
// runs on the host, the __dirname-derived path is a valid host path.
export const BUILD_DATA_DIR =
  process.env.CI_BUILD_DATA_DIR ?? path.join(BASE_DIR, "build_data");

// Container entrypoint scripts, mounted read-only into the build containers.
export const SCRIPTS_DIR = path.resolve(__dirname, "..", "scripts");

// How build containers reach the Restate ingress on the host (awakeable callback).
export const INGRESS_URL_FOR_CONTAINERS =
  process.env.CI_INGRESS_URL_FOR_CONTAINERS ?? "http://host.docker.internal:8080";

export const runDir = (runId: string) => path.join(BUILD_DATA_DIR, runId);
export const workspaceDir = (runId: string) => path.join(runDir(runId), "workspace");
export const logsDir = (runId: string) => path.join(runDir(runId), "logs");

export function ensureRunDirs(runId: string): void {
  fs.mkdirSync(workspaceDir(runId), { recursive: true });
  fs.mkdirSync(logsDir(runId), { recursive: true });
}
