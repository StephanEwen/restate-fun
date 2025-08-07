import * as restate from "@restatedev/restate-sdk"
import { RestatePromise, TerminalError } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod"
import { z } from "zod";
import { type Agent } from "./agent";
import { AgentTask  } from "./types";
import { preparePlan, executePlanStep, StepInput, StepResult } from "./plan";
import { sandbox } from "./sandbox";

export const agentExecutor = restate.service({
  name: "agent_executor",
  handlers: {
    runTask: restate.createServiceHandler(
      {
        input: serde.zod(AgentTask),
        output: serde.zod(z.void()),
      },
      async (restate: restate.Context, task) => {
        // grab the request's abort signal.
        const abortSignal = restate.request().attemptCompletedSignal;

        // this is our task ID, so we can let the agent know who sent the request
        const taskId = restate.request().id;

        // can we get a handle to the agent, so that we can send updates to it
        const agent = restate.objectSendClient<Agent>(
          { name: "agent" },
          task.agentId
        );

        // First, let's create a plan of how to approach the task.
        // We will use the LLM to generate a plan based on the task description.
        // We store the plan durably in the Restate journal,
        // because we will acquire resources for each step, and we want to make sure that
        // we can clean them up if the task fails or is canceled.

        const plan = await restate.run(
          "compute a plan",
          () => preparePlan({ task, abortSignal }),
          { maxRetryAttempts: 3 }
        );

        // notify the agent that we have a plan
        agent.addUpdate({
          taskId,
          entries: plan.map((step) => ({
            role: "agent",
            message: `Step ${step.id}: ${step.title}`,
          })),
        });

        const stepResults = [];
        const resourcesToClean = [];

        for (const step of plan) {
          // notify the agent that we are executing the step
          agent.addUpdate({
            taskId,
            entries: [
              {
                role: "agent",
                message: `Executing step ${step.id}: ${step.title}`,
              },
            ],
          });

          // here is the place where we can setup various resources
          // like an S3 bucket, a database, a pubsub topic, a sandboxed environment.
          // we can make sure that they are cleaned up after the task is done.
          // In this demo we don't use any resources, but you can imagine that this is where
          // we can compute stable names that will persist across retries.
          // and ephemeral names like a staging area.
          // setup the environment for the step
          const sandboxClient = restate.serviceClient(sandbox);
          const { sandboxId, sandboxUrl } = await sandboxClient.acquire({
            agentId: task.agentId,
          });

          // This is a cleanup saga, we will release all these resources later.
          resourcesToClean.push(() => sandboxClient.release({ sandboxId }));

          // Add here any addtional stateful resource, like a provisioned db, a browser session, etc.
          const stepInput = {
            taskId,
            stepId: step.id,
            task,
            step,
            sandboxUrl,
            sandboxId,
            topic: `${task.agentId}:${taskId}:${step.id}`, // <-- topic for step messages
            s3prefix: `s3://conversation-store-${restate.rand.uuidv4()}`,
            tempDirectory: `task-${taskId}-step-${step.id}`,
            planetScaleUrl: `https://db.example.com/task-${taskId}/step-${step.id}`,
          };

          // In this example, we assume the plan can be run in parallel, in reality this might not be the case.
          // And some steps need to run sequentially, and some in parallel,
          // but for the simplicity of this demo, we will assume that they can be done in parallel.
          const stepPromise = restate
            .serviceClient(agentExecutor)
            .executePlanStep(stepInput);

          // We can also run the steps inline like that:
          //
          //      const stepPromise = restate.run(
          //        `execute ${step.title}`,
          //         () => executePlanStep(stepInput),
          //         {
          //           maxRetryAttempts: 2,
          //         }
          //      );

          // let's remember the promise so that we can wait for it later
          // and things we'd need to clean up after it
          // Note that we provide a timeout of no more than 5 minutes for each step.
          // We can really go overboard here, with indevidual timeouts, and retry policies.
          stepResults.push(stepPromise.orTimeout({ minutes: 5 }));
        }
        try {
          // wait for all steps to complete.
          // If our parent Agent requests a cancelation, the line below will throw a TerminalError
          // if any of the steps fail, we will catch the error and notify the agent.
          // if all steps succeed, we will notify the agent that the task is complete.
          await RestatePromise.all(stepResults);
        } catch (error) {
          const failure = error as TerminalError;
          agent.taskFailed({
            taskId,
            message: `Failed: ${failure.message}`,
          });
          throw failure;
        } finally {
          resourcesToClean.reverse(); // reverse the order to clean up in reverse order
          resourcesToClean.forEach((cleanup) => {
            cleanup();
          });
        }
        // we are done
        agent.taskComplete({ taskId, message: "finished" });
      }
    ),

    executePlanStep: restate.createServiceHandler(
      { ingressPrivate: true },
      async (
        restate: restate.Context,
        stepInput: StepInput
      ): Promise<StepResult> => {
        const abortSignal = restate.request().attemptCompletedSignal;

        return await restate.run(
          `execute ${stepInput.step.title}`,
          () => executePlanStep(stepInput, abortSignal),
          { maxRetryAttempts: 2 }
        );
      }
    ),
  },
  options: {
    journalRetention: { days: 1 },
    idempotencyRetention: { days: 1 },
    inactivityTimeout: { minutes: 15 }, // inactivity (nor producing restate actions) after which Restate triggers suspension
    abortTimeout: { minutes: 30 }, // inactivity after which invocation is disconnected and retried (from journal)
    ingressPrivate: true, // this cannot be triggered externally via http, only from agent
  },
});

export type AgentExecutor = typeof agentExecutor;
