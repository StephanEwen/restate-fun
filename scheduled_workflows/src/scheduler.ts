import * as restate from "@restatedev/restate-sdk";
import { ObjectContext } from "@restatedev/restate-sdk";
import { z } from "zod";

import { CreateScheduleRequest, CreateScheduleResponse, DeleteScheduleRequest, ScheduleView } from "./types";

/**
 * A high-cardinality scheduler for Restate Workflows.
 *
 * One Virtual Object key == one user. All of a user's schedules live in that
 * key's state, and the whole user is driven by *one* delayed self-invocation
 * that is armed for the earliest upcoming run. Nothing polls, nothing sleeps in
 * a loop: an idle user costs one row of state and one pending timer, so the
 * number of users is bounded only by the Restate cluster.
 */

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

const CADENCE_MS = {
  minutely: 60_000,
  hourly: 60 * 60_000,
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
} as const;
type Cadence = keyof typeof CADENCE_MS;

/** A single schedule of a workflow */
type Schedule = {
  id: string;
  service: string;
  handler: string;
  cadence: Cadence;
  payload?: unknown;
  startAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  runs: number;
};

/** The scheduled invocation, per Object, that drives the scheduler. */
type Timer = {
  invocationId: restate.InvocationId;
  wakeUpAt: number;
};

/** The state maintained in a Virtual Object, per key (user) */
type SchedulerState = {
  schedules: Record<string, Schedule>;
  timer: Timer;
};

/** The envelope every scheduled workflow invocation receives. */
export type ScheduledRun = {
  userId: string;
  scheduleId: string;
  /** ISO-8601 timestamp of the occurrence this run stands for. */
  scheduledFor: string;
  payload?: unknown;
};

// ---------------------------------------------------------------------------
// Scheduler Virtual Object -- one key per user
// ---------------------------------------------------------------------------

export const scheduler = restate.object({
  name: "Scheduler",
  handlers: {
    /**
     * Register a recurring workflow invocation. Returns the generated schedule
     * ID and the time of the first run.
     */
    createSchedule: restate.createObjectHandler(
      {
        input: restate.serde.schema(CreateScheduleRequest),
        output: restate.serde.schema(CreateScheduleResponse),
        journalRetention: 0,  // bookkeeping call: don't keep after completion
      },
      async (ctx: ObjectContext<SchedulerState>, req) => {
        const now = await ctx.date.now();

        const startAt = req.startAt === undefined ? now : Date.parse(req.startAt);
        if (Number.isNaN(startAt)) {
          throw new restate.TerminalError(`startAt is not a valid ISO-8601 timestamp: ${req.startAt}`, {
            errorCode: 400,
          });
        }

        const schedule: Schedule = {
          id: ctx.rand.uuidv4(),
          service: req.service,
          handler: req.handler,
          cadence: req.cadence,
          payload: req.payload,
          startAt,
          nextRunAt: nextRunTime(startAt, CADENCE_MS[req.cadence], now),
          runs: 0,
        };

        const schedules = (await ctx.get("schedules")) ?? {};
        schedules[schedule.id] = schedule;
        saveSchedules(ctx, schedules);

        await deleteTimer(ctx); // delete possibly outdated timer
        await setNextTimer(ctx, schedules, now);

        return {
          scheduleId: schedule.id,
          nextRunAt: new Date(schedule.nextRunAt).toISOString(),
        };
      },
    ),

    /** List this user's schedules. Concurrent with writes, hence shared. */
    listSchedules: restate.createObjectSharedHandler(
      {
        output: restate.serde.schema(z.array(ScheduleView)),
        journalRetention: 0,  // bookkeeping call: don't keep after completion
      },
      async (ctx: restate.ObjectSharedContext<SchedulerState>) => {
        const schedules = (await ctx.get("schedules")) ?? {};
        return Object.values(schedules).map((s) => ({
          scheduleId: s.id,
          service: s.service,
          handler: s.handler,
          cadence: s.cadence,
          startAt: new Date(s.startAt).toISOString(),
          nextRunAt: new Date(s.nextRunAt).toISOString(),
          lastRunAt: s.lastRunAt === undefined ? undefined : new Date(s.lastRunAt).toISOString(),
          runs: s.runs,
        }));
      },
    ),

    /**
     * Drop a schedule. Workflows already started keep running; only future
     * occurrences disappear.
     */
    deleteSchedule: restate.createObjectHandler(
      {
        input: restate.serde.schema(DeleteScheduleRequest),
        journalRetention: 0,  // bookkeeping call: don't keep after completion
      },
      async (ctx: ObjectContext<SchedulerState>, req) => {
        const schedules = (await ctx.get("schedules")) ?? {};
        if (schedules[req.scheduleId] === undefined) {
          throw new restate.TerminalError(`No such schedule: ${req.scheduleId}`, { errorCode: 404 });
        }

        delete schedules[req.scheduleId];
        saveSchedules(ctx, schedules);

        await deleteTimer(ctx); // delete possibly outdated timer
        await setNextTimer(ctx, schedules, await ctx.date.now()); // schedule, at least one schedule remains
      },
    ),

    /**
     * The scheduler's heartbeat, invoked by the timer that `armTimer` set. Runs
     * every due occurrence, then re-arms itself for the next one.
     *
     * Private: this is an internal transition, not part of the user-facing API.
     */
    driveScheduler: restate.createObjectHandler(
      {
        ingressPrivate: true,  // not triggered from outside, only from within
        journalRetention: { hours: 6 },  // keep history to see in the UI which runs a wake-up kicked off.
      },
      async (ctx: ObjectContext<SchedulerState>) => {
        const schedules = (await ctx.get("schedules")) ?? {};
        const now = await ctx.date.now();

        for (const schedule of Object.values(schedules)) {
          if (schedule.nextRunAt > now) {
            continue;
          }
          startWorkflow(ctx, schedule);

          schedule.lastRunAt = schedule.nextRunAt;
          schedule.runs += 1;
          // Occurrences missed while the scheduler was down collapse into the
          // single run above; we always jump to the next future occurrence.
          schedule.nextRunAt = nextRunTime(schedule.startAt, CADENCE_MS[schedule.cadence], now + 1);
        }

        saveSchedules(ctx, schedules);
        await setNextTimer(ctx, schedules, now);
      },
    ),
  },
});

// ---------------------------------------------------------------------------
// Scheduling mechanics
// ---------------------------------------------------------------------------

/** Persist the schedule set, leaving no state behind for users without any. */
function saveSchedules(ctx: ObjectContext<SchedulerState>, schedules: Record<string, Schedule>) {
  if (Object.keys(schedules).length === 0) {
    ctx.clear("schedules");
  } else {
    ctx.set("schedules", schedules);
  }
}

/**
 * Kick off one run of the target workflow. The workflow ID is derived from the
 * occurrence, so a retry of `driveScheduler` can never start the same run
 * twice: Restate deduplicates on the workflow key.
 */
function startWorkflow(ctx: ObjectContext<SchedulerState>, schedule: Schedule) {
  const run: ScheduledRun = {
    userId: ctx.key,
    scheduleId: schedule.id,
    scheduledFor: new Date(schedule.nextRunAt).toISOString(),
    payload: schedule.payload,
  };

  // Generic send: the scheduler has no compile-time knowledge of the target.
  ctx.genericSend({
    service: schedule.service,
    method: schedule.handler,
    key: `${ctx.key}-${schedule.id}-${schedule.nextRunAt}`, // unique workflow ID
    parameter: run,
    inputSerde: restate.serde.json,
  });
}

/**
 * Sets the timer for the next earliest schedule. This method assumes no other timer is currently set.
 */
async function setNextTimer(ctx: ObjectContext<SchedulerState>, schedules: Record<string, Schedule>, now: number): Promise<void> {
  // find the earliest time in the list of schedules
  const wakeUpAt = Object.values(schedules).reduce<number | undefined>(
    (earliest, s) => (earliest === undefined || s.nextRunAt < earliest ? s.nextRunAt : earliest),
    undefined,
  );

  if (wakeUpAt === undefined) {
    return;
  }

  // schedule a call to ourselves at the time when the next schedule is due
  const handle = ctx
    .objectSendClient(scheduler, ctx.key)
    .driveScheduler(restate.rpc.sendOpts({ delay: Math.max(0, wakeUpAt - now) }));

  ctx.set("timer", { invocationId: await handle.invocationId, wakeUpAt });
}

async function deleteTimer(ctx: ObjectContext<SchedulerState>) {
  const timer = await ctx.get("timer");
  if (timer) {
    ctx.clear("timer");
    ctx.invocation(timer.invocationId).cancel();
  }
}

function nextRunTime(startAt: number, periodMs: number, earliestTime: number): number {
  // if start is in the future, take that
  if (startAt >= earliestTime) {
    return startAt;
  }

  // take the first time that is in the future and n*period after the start time
  return startAt + Math.ceil((earliestTime - startAt) / periodMs) * periodMs;
}
