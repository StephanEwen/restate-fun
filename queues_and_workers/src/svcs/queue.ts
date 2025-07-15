import * as restate from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";

import { Task, TaskBundle } from  "./tasks"

// alias imports
const exclusive = restate.handlers.object.exclusive;
const shared = restate.handlers.object.shared;


// ----------------------------------------------------------------------------
//  task queue
// ----------------------------------------------------------------------------

type QueueState = {
    closed: boolean,
    queue: TaskBundle[],
    pollers: string[]
}

const TAIL = 0;
const HEAD = 1;
type End = typeof HEAD | typeof TAIL;

export const taskQueue = restate.object({
    name: "queueService",
    handlers: {

        /**
         * Adds a bundle of tasks to the end of the queue.
         */ 
        addBundle: exclusive(
            { input: serde.zod(TaskBundle), output: serde.zod(z.void()) },

            async (ctx: restate.ObjectContext<QueueState>, taskBundle) => {
                if (await ctx.get("closed")) {
                    throw new restate.TerminalError("Queue is closed");
                }
                await enqueue(ctx, taskBundle, TAIL);
            }
        ),

        /**
         * Adds a bundle of tasks back to the beginning of the queue.
         */ 
        pushBackBundle: exclusive(
            { input: serde.zod(TaskBundle), output: serde.zod(z.void()) },

            async (ctx: restate.ObjectContext<QueueState>, taskBundle) => {
                // pushing back qork works on closed queues!
                await enqueue(ctx, taskBundle, HEAD);
            }
        ),

        /**
         * Polls work from the queue and blocks when the queue is empty.
         */ 
        pollBundle: shared(
            { input: serde.zod(z.void()), output: serde.zod(TaskBundle) },
            async (ctx: restate.ObjectSharedContext<QueueState>) => {
                // this method is a helper, because we
                //  - cannot block an exclusive handler (blocks all progress)
                //  - do not have write (and exclusive) access in a shared handler
                // so we create a durable promise and register it and await it
                const { id, promise } = ctx.awakeable<TaskBundle>();
                ctx.objectSendClient(taskQueue, ctx.key).registerCallback(id);
                return await promise;
            }
        ),

        /**
         * Registers an async callback for when there is work in the queue.
         */ 
        registerCallback: exclusive(
            { input: serde.zod(z.string()), output: serde.zod(z.void()) },

            async (ctx: restate.ObjectContext<QueueState>, callbackId) => {
                // do we have something in the queue right now?
                const queue = (await ctx.get("queue")) ?? [];
                const task = queue.shift();
                if (task !== undefined) {
                    ctx.set("queue", queue);
                    ctx.resolveAwakeable(callbackId, task);
                    return;
                }

                // will something new ever come?
                if (await ctx.get("closed")) {
                    ctx.rejectAwakeable(callbackId, "Queue is closed");
                    return;
                }

                // remember the callback for the poller
                const pollers = (await ctx.get("pollers")) ?? [];
                pollers.push(callbackId);
                ctx.set("pollers", pollers);
            }
        ),

        /**
         * When this is called, the queue will not accept any further tasks for enqueueing.
         */ 
        seal: async (ctx: restate.ObjectContext<QueueState>) => {
            ctx.set("closed", true);

            // if any workers are currently awaiting work, fail those requests
            const waiting = (await ctx.get("pollers")) ?? [];
            for (const callbackId of waiting) {
                ctx.rejectAwakeable(callbackId, "queue closed");
            }
        }
    }
})

export type TaskQueue = typeof taskQueue;


async function enqueue(
        ctx: restate.ObjectContext<QueueState>,
        taskBundle: TaskBundle,
        end: End) {

    // do we have waiting pollers?
    const waiting = (await ctx.get("pollers")) ?? [];
    if (waiting.length > 0) {
        // notify waiting worker
        const callback = waiting[0];
        ctx.set("pollers", waiting.slice(1))
        ctx.resolveAwakeable(callback, taskBundle);
        return;
    }

    // store in the queue
    const queue = (await ctx.get("queue")) ?? [];
    if (end === HEAD) {
        queue.unshift(taskBundle);
    } else {
        queue.push(taskBundle);
    }
    ctx.set("queue", queue);
    return;
}
