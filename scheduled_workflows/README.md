# Scheduling workflows with Restate

A high-cardinality scheduler for Restate Workflows. It maintains one Virtual Object key per user, with
one scheduled invocation (=timer) per user.

## Mechanism

`Scheduler` (`src/scheduler.ts`) keeps a user's schedules in object state, next to the invocation ID
of a single delayed `driveScheduler` call, set to the earliest upcoming run.

When that timer fires, `driveScheduler` starts every workflow that is due, and advances each
schedule to its next occurrence, and sets the timer to the next earliest schedule.
Any call that might change when the earliest run is (create, delete) cancels the timer
and replaces it.

An user costs one VO and one scheduled invocation, which is a few bytes in RocksDB. Together with
the partitioned scale-out architecture, this scales very far.

## API

Keyed by user ID: `curl localhost:8080/Scheduler/<userId>/<handler> --json '<body>'`

| Handler | Body | Does |
| --- | --- | --- |
| `createSchedule` | `{"service": "InboxTriage", "handler": "run", "cadence": "minutely\|hourly\|daily\|weekly", "startAt": "<ISO-8601>", "payload": {...}}` | Registers a recurrence, returns `{scheduleId, nextRunAt}`. `handler` defaults to `run`, `startAt` to now. |
| `listSchedules` | `{}` | Returns the user's schedules with next/last run times and a run count. |
| `deleteSchedule` | `{"scheduleId": "..."}` | Drops it. Workflows already started keep running. |

Every run invokes the target workflow with
`{userId, scheduleId, scheduledFor, payload}`.

## Running it

You need Restate Server running.
```bash
restate-server
```

Start the scheduler and the sample workflow, in two separate shells
```
npm run dev             # scheduler, on 9080
npm run dev:workflows   # sample workflow, on 9081
```

Use the UI (`:9070`) to register the deployments (http://localhost:9080, http://localhost:9081)

Use the UI (playground) to create schedules, or just send a curl request to the VO's API.
```
curl localhost:8080/Scheduler/yehya/createSchedule \
  --json '{"service":"InboxTriage","cadence":"minutely"}'
```

The UI's Virtual Object view is useful to observe all schedules: `http://localhost:9070/ui/virtual-objects/` 

`src/sample_workflows/inbox-triage.ts` is a mock: read Gmail, classify with an LLM, WhatsApp the
user if something is urgent. The Gmail and WhatsApp parts are pure mocks; the classifier calls OpenAI if
`OPENAI_API_KEY` is set and makes something up otherwise. It exists only to give the scheduler
something to schedule.
