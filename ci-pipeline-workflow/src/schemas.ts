import { z } from "zod";

// Input for CiPipeline/run. All fields have defaults; pass `{}` for a default run.
export const PipelineInput = z.object({
  // Branch, tag or commit SHA of restatedev/sdk-typescript to build.
  sdkGitRef: z.string().default("main"),
  // Branch, tag or commit SHA of restatedev/e2e to run the conformance tests from.
  e2eGitRef: z.string().default("main"),
  // Upper bound for the SDK build/test container before the run is failed.
  sdkBuildTimeoutMinutes: z.number().int().positive().default(60),
  // Backstop for the e2e awakeable callback: if the e2e container dies before
  // calling back, the workflow fails after this timeout instead of hanging.
  e2eTimeoutMinutes: z.number().int().positive().default(45),
});
export type PipelineInput = z.infer<typeof PipelineInput>;

// Input for the CiPipeline/approve shared handler (human callback).
export const Approval = z.object({
  approved: z.boolean(),
  by: z.string().optional(),
});
export type Approval = z.infer<typeof Approval>;

// Payload the e2e container POSTs to the awakeable resolve endpoint (machine callback).
export const E2eResult = z.object({
  passed: z.boolean(),
  report: z.string().optional(),
});
export type E2eResult = z.infer<typeof E2eResult>;

export type Stage =
  | "pending"
  | "build-sdk"
  | "build-image"
  | "awaiting-approval"
  | "e2e"
  | "cleanup"
  | "done"
  | "failed";

// Stored in workflow state via ctx.set("status", ...) and read by getStatus.
export interface PipelineStatus {
  stage: Stage;
  stages: Record<string, string>; // per-stage outcome, e.g. { "build-sdk": "passed" }
  serviceImage?: string;
  logsDir?: string;
  error?: string;
}
