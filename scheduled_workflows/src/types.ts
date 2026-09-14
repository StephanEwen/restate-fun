import { z } from "zod";

export const CreateScheduleRequest = z.object({
  /** Name of the target workflow service, e.g. `"InboxTriage"`. */
  service: z.string().min(1),
  /** Handler on that workflow. Defaults to the workflow's `run` handler. */
  handler: z.string().min(1).default("run"),
  /** Interval in the workflow should run. */
  cadence: z.enum(["minutely", "hourly", "daily", "weekly"]),
  /** ISO-8601 timestamp of the first run. Defaults to "now". */
  startAt: z.string().optional(),
  /** Opaque payload handed to the workflow on every run. */
  payload: z.unknown().optional(),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequest>

export const CreateScheduleResponse = z.object({
  scheduleId: z.string(),
  nextRunAt: z.string(),
});
export type CreateScheduleResponse = z.infer<typeof CreateScheduleResponse>

export const DeleteScheduleRequest = z.object({ scheduleId: z.string().min(1) });
export type DeleteScheduleRequest = z.infer<typeof DeleteScheduleRequest>

export const ScheduleView = z.object({
  scheduleId: z.string(),
  service: z.string(),
  handler: z.string(),
  cadence: z.string(),
  startAt: z.string(),
  nextRunAt: z.string(),
  lastRunAt: z.string().optional(),
  runs: z.number(),
});
export type ScheduleView = z.infer<typeof ScheduleView>

