import * as restate from "@restatedev/restate-sdk"
import { serde } from "@restatedev/restate-sdk-zod"
import { z } from "zod";

const handler = restate.handlers.object.exclusive;
const shared = restate.handlers.object.shared;

type Entry = {
    role: "agent" | "user",
    message: string
}

type State = {
    messages: Entry[],
    currentTaskId: string | null,
}

export const agent = restate.object({
    name: "agent",
    handlers: {

        /**
         * Handler for all user messages (prompts, GitHub webhooks)
         * Could also have specialized handlers for different types of input.
         */
        handleUserMessage: handler(
            {
                input: serde.zod(z.string()),
                output: serde.zod(z.void())
            },
            async (restate: restate.ObjectContext<State>, message) => {

                // store message
                const messages = (await restate.get("messages")) ?? [];
                messages.push({ role: "user", message });
                restate.set("messages", messages);

                // abort ongoing task
                const ongoingTask = await restate.get("currentTaskId");
                if (ongoingTask) {
                    await cancelTask(restate, ongoingTask, { seconds: 30 });
                    restate.clear("currentTaskId");
                }

                // assemble a task and send it off
            }
        ),

        taskComplete: handler(
            {
                // we don't define a schema here, to show you can also use just TS type
                // system, but then you don't get runtime type checking

                ingressPrivate: true // not part of public API
            },
            async (restate: restate.ObjectContext<State>, req: { message: string, taskId: string }) => {
                // we double check that this was not received just the moment sent a
                // cancellation and has been subsumed by a new task
                const ongoingTask = await restate.get("currentTaskId");
                if (ongoingTask !== req.taskId) {
                    return;
                }
                restate.clear("currentTaskId");

                const messages = (await restate.get("messages"))!
                messages.push({ role: "agent", message: req.message });
                restate.set("messages", messages);

                await restate.run("notify task done", () => {
                    // make some API call, if necessary
                    console.log("🥳🥳🥳 Task complete!");
                })
            }
        ),

        addArtifactFromRun: handler(
            {
                input: restate.serde.binary,
                output: serde.zod(z.void()),
                ingressPrivate: true // not part of public API
            },
            async (restate: restate.ObjectContext<State>, artifact) => {

            }
        ),

        getMessages: shared(
            async (restate: restate.ObjectSharedContext<State>) => {
                return (await restate.get("messages")) ?? [];
            }
        )
    },
    options: {
        journalRetention: { days: 7 },
        idempotencyRetention: { days: 7 },
    }
})

export type Agent = typeof agent;



async function cancelTask(
        ctx: restate.Context,
        invocationId: string,
        timeout: restate.Duration) {
    const handle = restate.InvocationIdParser.fromString(invocationId);

    // cancel ongoing invocation
    ctx.cancel(handle);

    // wait for it to gracefully complete for a bit
    const donePromise = ctx.attach(handle);
    try {
        await donePromise.orTimeout(timeout);
    } catch (e) {
        if (!(e instanceof restate.TimeoutError)) {
            throw e;
        }

        // did not complete in time, we keep it running, it will still do its cleanup
        ctx.console.warn(`Cancelled agent task taking longer to complete than ${JSON.stringify(timeout)}`)
    }
}