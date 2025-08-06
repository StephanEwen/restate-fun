import * as restate from "@restatedev/restate-sdk"
import { TerminalError } from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod"
import { z } from "zod";
import { type Agent } from "./agent";
import { AgentTask, Entry } from "./types";
import { streamText, wrapLanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import assert from "node:assert";

const handler = restate.handlers.handler;

function createPrompt(task: AgentTask): string {
  return `You are executing a task. Please provide updates on the task progress.
          The following is the task description: ${task.prompt}\n
          With the following context: ${task.context
            .map((c) => c.message)
            .join("\n")}\n
            
            Please provide updates in the form of a string. If the task is complete, return "finished".
            `;
} 

async function llmStep(taskId: string, task: AgentTask, abortSignal: any): Promise<string[]> {
  console.log(`
    Executing LLM step for: ${task.agentId} with the task ID: ${taskId}

    🤖 follow the updates at:
      curl http://localhost:3000/subscribe/${task.agentId}
    `);

  const { textStream } = streamText({
    model: openai("gpt-4o", { structuredOutputs: true }),
    system: "You are a helpful assistant.",
    prompt: createPrompt(task),
    abortSignal,
  });
  const stepMessages = [];

  for await (const textPart of textStream) {
    stepMessages.push(textPart);

    // also, send the updates to any client that is listening
    await fetch(`http://localhost:3000/publish/${task.agentId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: textPart, taskId }),
      signal: abortSignal,
    });
  }
  return stepMessages;
}

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

        let messages: string[] = [];
        try {
          // Make an LLM call to start the task execution.
          // The LLM will stream updates off-band, so that the user can see the progress.
          // Once the LLM is done, we can send to the agent
          // to decide on the next steps.
          messages = await restate.run(
            "call an LLM step",
            () => llmStep(taskId, task, abortSignal),
            {
              maxRetryAttempts: 3,
            }
          );
        } catch (e) {
          // the LLM call failed, we can notify the agent.
          assert(e instanceof TerminalError);
          // if the error is a terminal error, we can let the agent know
          agent.taskFailed({
            taskId,
            message: `Task failed with terminal error: ${e.message}`,
          });
          throw e;
        }

        // send the updates to the agent
        agent.addUpdate({
          taskId,
          entries: messages.map((message) => ({ role: "agent", message })),
        });

        if (
          messages.length > 0 &&
          messages[messages.length - 1] === "finished"
        ) {
          // if the last message is "finished", we can let the agent know
          agent.taskComplete({ taskId, message: "finished" });
        }
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
