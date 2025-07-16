import * as restate from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";

import { Task, TaskBundle, TaskResult } from "./tasks"
import type { TaskQueue } from "./queue";

// some aliases, for simpler code later
const handler = restate.handlers.object.exclusive;
const shared = restate.handlers.object.shared;

// the API signature type of the task queue
const Queue = { name: "queueService" } as TaskQueue;

// --------------------------------------------------------
//  task queue
// --------------------------------------------------------

const HEARTBEAT_INTERVAL = 10_000;
const MAX_MISSED_HEARTBEATS = 5;

type WorkerState = {
    queueName: string,
    workerProcessLocation: string,

    taskInProgress: Task,
    pendingTasks: Task[],

    completedTasks: TaskResult[],
    persistedTasks: TaskResult[]
}

export const workerTracker = restate.object({
    name: "workertracker",
    handlers: {

        /**
         * Called when the worker process managed by this VO is started
         */
        startWorker: handler(
            {
                input: serde.zod(z.object({ queueName: z.string(), worker: z.string() })),
                output: serde.zod(z.void())
            },
            async (ctx: restate.ObjectContext<WorkerState>, { queueName, worker }) => {
                await checkNotAlreadyStarted(ctx);
                ctx.set("queueName", queueName);
                ctx.set("workerProcessLocation", worker);

                // start heartbeating the worker process - this is a timed call on ourselves
                ctx.objectSendClient(workerTracker, ctx.key /* self */, { delay: HEARTBEAT_INTERVAL }).makeHeartbeat(0);

                // poll work
                const nextBundle: TaskBundle = await ctx.objectClient(Queue, queueName).pollBundle();
                ctx.set("pendingTasks", nextBundle.tasksToRun);
                ctx.set("persistedTasks", nextBundle.completedResouces);

                await initiateNextTask(ctx);
            }
        ),

        /**
         * Callback from the worker process when a task is done
         */
        taskComplete: handler(
            {
                input: serde.zod(TaskResult), output: serde.zod(z.void())
            },
            async (ctx: restate.ObjectContext<WorkerState>, taskResult) => {
                const completedTasks = (await ctx.get("completedTasks")) ?? []
                completedTasks.push(taskResult);
                ctx.clear("taskInProgress");

                // do next task, if more are available
                const pendingTasks = (await ctx.get("pendingTasks"))!
                if (pendingTasks.length > 0) {
                    await initiateNextTask(ctx);
                    return;
                }

                // assume last task is final result, persist and notify
                try {
                    const persistedResult = await persistTaskResult(ctx, taskResult);

                    // for this notification, we don't limit retries, meaning it runs until
                    // explicit cancellation (which also triggers that catch() clause)
                    await ctx.run("notify task bundle result", () => {
                        // API call to whoever picks up the final result
                        // ...
                        console.log(`Final result is ${taskResult.task.name} @ ${persistedResult}`)
                    })
                } catch (e) {
                    if (e instanceof restate.TerminalError) {
                        // send message to self that this is failed
                        ctx.objectSendClient(workerTracker, ctx.key).reportFailed();
                        return;
                    } else {
                        throw e;
                    }
                }
                
                ctx.clear("pendingTasks");
                ctx.clear("completedTasks");
                ctx.clear("persistedTasks");

                // poll the next bundle
                const queueName = (await ctx.get("queueName"))!
                const nextBundle: TaskBundle = await ctx.objectClient(Queue, queueName).pollBundle();
                ctx.set("pendingTasks", nextBundle.tasksToRun);
                ctx.set("persistedTasks", nextBundle.completedResouces);

                await initiateNextTask(ctx);
            }
        ),

        /**
         * Called to perist any local resources to a durable storage, like S3.
         * Means future tasks can recover from there without re-computing.
         */
        checkpointResults: handler(
            {
                input: serde.zod(z.undefined()),
                output: serde.zod(z.void())
            },
            async (ctx: restate.ObjectContext<WorkerState>) => {
                const results = (await ctx.get("completedTasks")) ?? [];
                const persisted = (await ctx.get("persistedTasks")) ?? [];

                let nextResult: TaskResult | undefined;
                while ((nextResult = results.shift()) !== undefined) {
                    const persistedResource = await persistTaskResult(ctx, nextResult);
                    persisted.push({ task: nextResult.task, resource: persistedResource });
                }

                ctx.set("persistedTasks", persisted);
                ctx.set("completedTasks", []);

                // the above could be adjusted in different ways, e.g.,
                // - saga: clean up previous partially persisted results in case whole checkpoint fails
                // - store each bit in state immediately, to remember any persisted results 
            }
        ),

        /**
         * Called when the worker process (managed by this VO) is deemed to be failed
         */
        reportFailed: handler(
            {
                input: serde.zod(z.undefined()),
                output: serde.zod(z.void())
            },
            async (ctx: restate.ObjectContext<WorkerState>) => {
                // we assume we lost all non-persisted state
                const toRestart = ((await ctx.get("completedTasks")) ?? [])
                    .map((result) => result.task);

                const pendingTasks = (await ctx.get("pendingTasks")) ?? [];
                pendingTasks.unshift(...toRestart);

                const persisted = (await ctx.get("persistedTasks")) ?? [];

                // push that work back into the queue
                const bundle: TaskBundle = { 
                    tasksToRun: pendingTasks,
                    completedResouces: persisted
                }
                const queueName = (await ctx.get("queueName"))!
                ctx.objectSendClient(Queue, queueName).pushBackBundle(bundle);

                ctx.clearAll();

                // ensure the process is actually killed / released
                await ctx.run("kill and cleanup process", () => { /* ... */ });
            }
        ),

        /**
         * Utility handler for scheduled heartbeat operations.
         * This could probably be in a separate service, but it is convenient here.
         */
        makeHeartbeat: shared(
            async (ctx: restate.ObjectSharedContext, numMissedSoFar: number) => {
                const worker = (await ctx.get("workerProcessLocation"))!
                const success = await ctx.run("make heartbeat", () => {
                    // check if process is alive
                    return true;
                })

                const missed = success ? 0 : numMissedSoFar + 1;
                if (missed >= MAX_MISSED_HEARTBEATS) {
                    ctx.objectSendClient(workerTracker, ctx.key /* self */)
                        .reportFailed();
                } else {
                    // schedule a call for the next heartbeat
                    ctx.objectSendClient(workerTracker, ctx.key /* self */, { delay: HEARTBEAT_INTERVAL })
                        .makeHeartbeat(missed);
                }
            }
        )
    }
});

export type WorkerTracker = typeof workerTracker;


async function initiateNextTask(ctx: restate.ObjectContext<WorkerState>): Promise<boolean> {
    const pendingTasks = await ctx.get("pendingTasks")
    const nextTask = pendingTasks?.shift();
    if (nextTask === undefined) {
        return false;
    }

    ctx.set("taskInProgress", nextTask);
    
    // notify worker process
    await ctx.run("sending work to worker", () => {
            console.log("send task to process: " + JSON.stringify(nextTask));
                // the task process should eventually call taskComplete
        },
        { maxRetryAttempts: 5, initialRetryInterval: { seconds: 1 } }
    );

    return true;
}

async function persistTaskResult(ctx: restate.Context, taskResult: TaskResult) {
    // imagine this like uploadign to S3 or other storage, for downloading or streaming
    const persistedResourceUrl = await ctx.run("persist result from " + taskResult.task.name, async () =>
        {
            // upload stuff - takes a bit of time
            console.log(`persisting ${taskResult.task.name}-${taskResult.resource}`)
            await new Promise((resolve) => setTimeout(resolve, 2000)); // sleep

            return `s3://myBucket/${taskResult.task.name}-${taskResult.resource}-${crypto.randomUUID()}`;
        },
        { maxRetryAttempts: 5, initialRetryInterval: { seconds: 2 } }
    )

    return persistedResourceUrl;
}

async function checkNotAlreadyStarted(ctx: restate.ObjectContext<WorkerState>) {
    const queue = await ctx.get("queueName");
    if (queue) {
        throw new restate.TerminalError("Worker already started");
    }
}