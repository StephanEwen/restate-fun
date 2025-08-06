import * as restate from "@restatedev/restate-sdk"
import { serde } from "@restatedev/restate-sdk-zod"
import { z } from "zod";
import { Entry, type AgentTask, type ContextArtifact } from "./types";
import { AgentExecutor } from "./agent_executor";
import { jsonPassThroughSerde } from "./utils";

// aliases / shortcuts
const handler = restate.handlers.object.exclusive;
const shared = restate.handlers.object.shared;
const binarySerDe = restate.serde.binary;
const opts = restate.rpc.sendOpts;

type Artifacts = {
    [key: `a_${string}`]: ContextArtifact;
};

type State = Artifacts & {
    messages: Entry[],
    currentTaskId: restate.InvocationId | null
    // more to come
} 

export const agent = restate.object({
  name: "agent",
  handlers: {
    /**
     * Handler for all messages (user prompts, GitHub webhooks)
     * Could also have specialized handlers for different types of input.
     */
    newMessage: handler(
      {
        journalRetention: { days: 1 },
        input: serde.zod(z.string()),
        output: serde.zod(z.void()),
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

        const task: AgentTask = {
          agentId: restate.key,
          prompt: message,
          context: messages,
          maxIterations: 10,
        };

        const handle = restate
          .serviceSendClient<AgentExecutor>({ name: "agent_executor" })
          .runTask(task, opts({ idempotencyKey: restate.rand.uuidv4() }));
        // note that the idempotency key is not actually needed for idmepotency, but it is a
        // current limitation that re-attaching to handlers only works when an idempotency key is present

        const invocationId = await handle.invocationId;
        restate.set("currentTaskId", invocationId);

        // TODO, possible schedule a timer to cancel the task if it takes too long?
      }
    ),

    taskComplete: handler(
      {
        // we don't define a schema here, to show you can also use just TS type
        // system, but then you don't get runtime type checking

        ingressPrivate: true, // not part of public API
      },
      async (
        restate: restate.ObjectContext<State>,
        req: { message: string; taskId: string }
      ) => {
        // we double check that this was not received just the moment sent a
        // cancellation and has been subsumed by a new task
        const ongoingTask = await restate.get("currentTaskId");
        if (ongoingTask !== req.taskId) {
          return;
        }
        restate.clear("currentTaskId");

        const messages = (await restate.get("messages"))!;
        messages.push({ role: "agent", message: req.message });
        restate.set("messages", messages);

        await restate.run("notify task done", () => {
          // maokake some API call, if necessary
          console.log("🥳🥳🥳 Task complete!");
        });
      }
    ),

    taskFailed: handler(
      {
        // we don't define a schema here, to show you can also use just TS type
        // system, but then you don't get runtime type checking

        ingressPrivate: true, // not part of public API
      },
      async (
        restate: restate.ObjectContext<State>,
        req: { message: string; taskId: string }
      ) => {
        // we double check that this was not received just the moment sent a
        // cancellation and has been subsumed by a new task
        const ongoingTask = await restate.get("currentTaskId");
        if (ongoingTask !== req.taskId) {
          return;
        }
        restate.clear("currentTaskId");

        const messages = (await restate.get("messages"))!;
        messages.push({ role: "agent", message: req.message });
        restate.set("messages", messages);

        await restate.run("notify task done", () => {
          // make some API call, if necessary
          console.log(" Task complete!");
        });
      }
    ),

    addUpdate: handler(
      {
        input: serde.zod(
          z.object({ taskId: z.string(), entries: z.array(Entry) })
        ),
        ingressPrivate: true, // not part of public API
        journalRetention: { days: 0 }, // no need to keep a history of this handler
      },
      async (restate: restate.ObjectContext<State>, { taskId, entries }) => {
        // we double check that this was not a message enqueued by a handler that
        // has since been cancelled
        const ongoingTask = await restate.get("currentTaskId");
        if (ongoingTask !== taskId) {
          return;
        }

        // store message
        const messages = (await restate.get("messages")) ?? [];
        messages.push(...entries);
        restate.set("messages", messages);
      }
    ),

    getMessages: shared(
      {
        input: restate.serde.empty,
        output: jsonPassThroughSerde, // pass binary through, but declare as JSON
        journalRetention: { days: 0 }, // no need to keep a history of this handler
      },
      async (restate: restate.ObjectSharedContext) => {
        // we just pass the bytes back, no need to parse JSON and the re-encode JSON
        return await restate.get("messages", binarySerDe);
      }
    ),
  },
  options: {
    // default retention, unless overridden at the handler level
    journalRetention: { days: 1 },
    idempotencyRetention: { days: 1 },
  },
});

export type Agent = typeof agent;



async function cancelTask(
        ctx: restate.Context,
        invocationId: restate.InvocationId,
        timeout: restate.Duration) {

    // cancel ongoing invocation
    ctx.cancel(invocationId);

    // wait for it to gracefully complete for a bit
    const donePromise = ctx.attach(invocationId);
    try {
        await donePromise.orTimeout(timeout);
    } catch (e) {
        if (e instanceof restate.TerminalError && e.code === 409) {
            // cancelled
            return
        }
        if (e instanceof restate.TimeoutError) {
            // did not complete in time, we keep it running, it will still do its cleanup
            ctx.console.warn(`Cancelled agent task taking longer to complete than ${JSON.stringify(timeout)}`)
            return;
        }

        throw e;
    }
}