import * as restate from "@restatedev/restate-sdk"
import { TerminalError } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod"
import { z } from "zod";
import { type Agent } from "./agent";
import { AgentTask, Entry  } from "./types";
import assert from "node:assert";
import { preparePlan, executePlanStep } from "./llms";

const handler = restate.handlers.handler;

export const agentExecutor = restate.service({
  name: "agent_executor",
  handlers: {
    runTask: handler(
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

        // let's first compute a plan for the task
        const plan = await restate.run(
          "compute a plan",
          () => preparePlan({ task, abortSignal }),
          { maxRetryAttempts: 3 }
        );
        
        // notify the agent that we have a plan
        const newEntries: Entry[] = plan.map((step) => ({
          role: "agent",
          message: `Step ${step.id}: ${step.title} - ${step.description}`,
        }));

        agent.addUpdate({
          taskId,
          entries: newEntries,
        });

        // handle the plan steps
        for (const step of plan) {
          agent.addUpdate({
            taskId,
            entries: [
              { role: "agent", message: `Executing step ${step.id}: ${step.title}` },
            ],
          });
          
          // here is the place where we can setup various resources 
          // like an S3 bucket, a database, etc'.
          // we can make sure that they are cleaned up after the task is done.
          // In this demo we don't use any resources, but you can imagine that this is where
          // we can compute stable names that will persist across retries.
          // and ephemeral names like a staging area.

          let messages: string[] = [];
          try {
            // Make an LLM call to start the task execution.
            // The LLM will stream updates off-band, so that the user can see the progress.
            // Once the LLM is done, we can send to the agent
            // to decide on the next steps.
            messages = await restate.run(
              "call an LLM step",
              () => executePlanStep(taskId, task, step, abortSignal),
              {
                maxRetryAttempts: 2,
              }
            );
          } catch (e) {
            // the LLM call failed, we can notify the agent.
            assert(e instanceof TerminalError);
            // if the error is a terminal error, we can let the agent know
            agent.taskFailed({
              taskId,
              message: `Task failed at step ${step.id}: ${e.message}`,
            });
            throw e;
          }

          // send the updates to the agent
          agent.addUpdate({
            taskId,
            entries: messages.map((message) => ({ role: "agent", message })),
          });
        }
        // we are done
        agent.taskComplete({ taskId, message: "finished" });
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
