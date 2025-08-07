import {type Context}  from "@restatedev/restate-sdk";

import { CoreMessage, generateObject, streamText } from "ai";
import { AgentTask, PlanStep, StepInput, StepResult } from "./types";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";


/**
 * Deconstructs a task into a plan of steps.
 * This function prepares a plan for executing a coding task by breaking it down into manageable steps.
 * Each step includes a description, a prompt for the LLM, and a status indicating its
 *
 * @param params - The parameters for preparing a plan.
 * @param params.task - The task for which to prepare the plan.
 * @param params.abortSignal - The signal to abort the operation if needed.
 * @returns A promise that resolves to an array of PlanStep objects representing the plan for the task.
 */
export async function preparePlan(params: {
  task: AgentTask;
  abortSignal: any;
}): Promise<PlanStep[]> {
  const { task, abortSignal } = params;

  const system = `You are an AI assistant that generates a plan for executing a coding task.
    The task is: ${task.prompt}
    Please break down the task into steps, such as gathering information, writing code, testing, etc.
    Describe each step in detail, including the specific prompt to provide to the LLM for further execution of the step,
    Do not generate more than 5 steps at once.
    Each step starts as pending.
    `;

  const messages: CoreMessage[] = [];
  messages.push({
    role: "system",
    content: system,
  });
  for (const entry of task.context) {
    if (entry.role === "user") {
      messages.push({
        role: "user",
        content: entry.message,
      });
    } else {
      messages.push({
        role: "assistant",
        content: entry.message,
      });
    }
  }

  // Call the LLM to generate a plan
  const { object: plan } = await generateObject({
    model: openai("gpt-4o", { structuredOutputs: true }),
    schema: z.object({
      steps: z.array(PlanStep),
    }),
    abortSignal,
    messages,
  });

  return plan.steps;
}

// A set of tools that the LLM can use to execute the steps
const TOOLS = {
  getFileContent: {
    parameters: z.object({
      filePath: z.string(),
    }),
    description: "Get the content of a file from the remote environment.",
  },
  searchCode: {
    parameters: z.object({
      query: z.string(),
    }),
    description: "Search for code snippets in the remote environment.",
  },
  executeCommand: {
    parameters: z.object({
      command: z.string(),
    }),
    description: "Execute a command in the remote environment.",
  },
};

/**
 * Executes a PlanStep.
 * This function executes a main coding loop, which involves calling the LLM to generate responses or tool calls.
 *
 * @param restate - The Restate context for service client interactions.
 * @param params - The parameters for executing the step.
 * @param params.taskId - The ID of the task being executed.
 * @param params.task - The task object containing details about the task.
 * @param params.step - The step to be executed.
 * @param params.topic - The topic for updates related to this step.
 * @returns A promise that resolves to a StepResult containing the step ID and messages generated during execution.
 */
export async function executePlanStepLoop(
  restate: Context,
  { taskId, task, step, topic }: StepInput,
): Promise<StepResult> {
  console.log(`
    Executing LLM step for: ${task.agentId} with the task ID: ${taskId}
        Step ID: ${step.id}
        Step Title: ${step.title}
        Step Description: ${step.description}
        Step Prompt: ${step.prompt}

    🤖 follow the updates at:
      curl http://localhost:3000/subscribe/${task.agentId}
    `);
    
  const abortSignal = restate.request().attemptCompletedSignal;

  const history: CoreMessage[] = [
    {
      role: "system",
      content: `You are an AI assistant that executes a coding task step.
        The step is: ${step.title}
        The step description is: ${step.description}
        The step prompt is: ${step.prompt}
        You will receive updates from the agent about the task progress.
        Please execute the step and provide the results.
        If you need to call tools, use the provided tools.`,
    },
    {
      role: "user",
      content: task.prompt,
    },
  ];

  for (let i = 0; i < 5; i++) {
    //
    // Call the LLM to generate a response or tool calls
    //
    const {
      calls,
      messages: newMessage,
      finished,
    } = await restate.run(
      `execute ${step.title} iteration ${i + 1}`,
      async () => {
        const { textStream, toolCalls, text, response, finishReason } =
          streamText({
            model: openai("gpt-4o-mini", { structuredOutputs: true }),
            messages: history,
            abortSignal,
            tools: TOOLS,
          });

        // Stream the text the user
        for await (const textPart of textStream) {
          await fetch(`http://localhost:3000/publish/${task.agentId}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              taskId,
              stepId: step.id,
              message: textPart,
              topic,
            }),
            signal: abortSignal,
          });
        }

        const { messages } = await response;
        const calls = await toolCalls;
        const buffer = await text;
        const finished = await finishReason;

        return {
          finished,
          calls,
          messages, // <-- this might be large, and if we want we can store this offband, for example in S3, and provide a link to it instead.
        };
      }
    );

    history.push(...newMessage);

    if (finished === "stop") {
      console.log("LLM finished generating response, exiting loop.");
      break;
    }

    //
    // now we can process the tool calls
    //
    for (const call of calls) {
      if (call.toolName === "searchCode") {
        const { query } = call.args;
        // Here you would implement the logic to search for code snippets in the remote environment

        console.log(`Searching for code snippets with query: ${query}`);

        history.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              result: `Found code snippets for query: ${query}`,
            },
          ],
        });
      } else if (call.toolName === "getFileContent") {
        const { filePath } = call.args;
        // Here you would implement the logic to fetch the file content from the remote environment
        // For example, you might use an RPC call to a remote service that retrieves the file content.
        history.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              result: `Found file content for path: ${filePath}`,
            },
          ],
        });
        console.log(`Fetching file content for path: ${filePath}`);
      } else if (call.toolName === "executeCommand") {
        const { command } = call.args;
        // Here you would implement the logic to execute a command in the remote environment
        // For example, you might use an RPC call to a remote service that executes the command.
        // sandboxClient.execute({
        //   sandboxId: step.sandboxId,
        //   code: step.code,
        // });
        //
        history.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              result: `Executed command: ${command}`,
            },
          ],
        });
        console.log(`Executing command: ${command}`);
      }
    }
  }

  return {
    stepId: step.id,
    messages: [
      {
        role: "assistant",
        content: "<response>",
      },
    ],
  };
}
