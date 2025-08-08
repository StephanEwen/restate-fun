import { type Context } from "@restatedev/restate-sdk";

import {
  CoreMessage,
  generateObject,
  streamText,
  streamObject,
  ToolResultPart,
} from "ai";
import { AgentTask, PlanStep, StepInput, StepResult } from "./types";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

// --------------------------------------------------------
//  The actual agentic planning and plan step execution
// --------------------------------------------------------

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
  task: AgentTask,
  abortSignal: AbortSignal
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

  // Call the LLM to generate a plan using streaming with structured output
  // This demonstrates how to use streaming while maintaining structured output with schema validation
  const plan = await streamStructuredModel(
    abortSignal,
    messages,
    z.object({
      steps: z.array(PlanStep),
    }),
    "plan",
    task.agentId
  );

  return plan.steps;
}


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
export async function loopAgent(
  restate: Context,
  { taskId, task, step, topic, stepResults }: StepInput
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

  // we always start with an empty history
  // and we will append messages to it as we go

  const history: CoreMessage[] = [
    {
      role: "system",
      content: `You are an AI assistant that executes a coding task step.
        The step is: ${step.title}
        The step description is: ${step.description}
        The step prompt is: ${step.prompt}
        You will receive updates from the agent about the task progress.
        Please execute the step and provide the results.
        If you need to call tools, use the provided tools.
        The following are the results of the previous steps:
        ${stepResults.join("\n")}
        `,
    },
    {
      role: "user",
      content: task.prompt,
    },
  ];


  for (let i = 0; i < 7; i++) {
    // -----------------------------------------------------
    // 1. Call the LLM to generate a response or tool calls
    // -----------------------------------------------------

    const { calls, messages, finished } = await restate.run(
      `execute ${step.title} iteration ${i + 1}`,
      () => streamModel(abortSignal, history, step.id, topic),
      { maxRetryAttempts: 3 }
    );

    history.push(...messages);

    if (finished === "stop") {
      console.log("LLM finished generating response, exiting loop.");
      return lastMessageContent(messages);
    }

    // -----------------------------------------------------
    // 2. Process the actual tool calls
    // -----------------------------------------------------

    for (const call of calls) {
      if (call.toolName === "searchCode") {
        const { query } = call.args;
        const result = await restate.run("code search", () =>
          executeCodeSearch(query)
        );
        const content: ToolResultPart = {
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result,
        };
        history.push({
          role: "tool",
          content: [content],
        });
      } else if (call.toolName === "getFileContent") {
        const { filePath } = call.args;
        const result = await restate.run("get file content", () =>
          getFileContent(filePath)
        );
        const content: ToolResultPart = {
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result,
        };
        history.push({
          role: "tool",
          content: [content],
        });
      } else if (call.toolName === "executeCommand") {
        const { command } = call.args;
        const result = await restate.run("execute command", () =>
          executeCommand(command)
        );
        const content: ToolResultPart = {
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result,
        };
        history.push({
          role: "tool",
          content: [content],
        });
      }
    }
  }

  return "<I failed to execute this step>";
}

async function streamModel(
  abortSignal: AbortSignal,
  history: CoreMessage[],
  stepId: string,
  topic: string
) {
  const { textStream, toolCalls, response, finishReason } = streamText({
    model: openai("gpt-4o-mini", { structuredOutputs: true }),
    messages: history,
    abortSignal,
    tools: TOOLS,
  });

  const streamToUi = browserStream(abortSignal, topic, stepId);

  for await (const textPart of textStream) {
    await streamToUi(textPart);
  }

  await streamToUi("\n ------------------------------------- \n");

  const { messages } = await response;
  const calls = await toolCalls;
  const finished = await finishReason;

  return {
    finished,
    calls,
    messages, // <-- this might be large, and if we want we can store this offband, for example in S3, and provide a link to it instead.
  };
}

/**
 * Streams structured output with schema validation.
 */
async function streamStructuredModel<T>(
  abortSignal: AbortSignal,
  history: CoreMessage[],
  schema: z.ZodSchema<T>,
  stepId: string,
  topic: string
): Promise<T> {

  const { object, textStream } = streamObject({
    model: openai("gpt-4o", { structuredOutputs: true }),
    schema,
    messages: history,
    abortSignal
  });

  const streamToUi = browserStream(abortSignal, topic, stepId);

  await streamToUi("\n\n >>>>>>>> Begin Planning... <<<<<<<<\n\n");
  for await (const textPart of textStream) {
    await streamToUi(textPart);
  }
  await streamToUi("\n\n >>>>>>>>> End Planning... <<<<<<<<<\n\n");

  return await object;
}

async function executeCodeSearch(query: string): Promise<string> {
  // Here you would implement the logic to search for code snippets in the remote environment
  // For example, you might use an RPC call to a remote service that retrieves the code snippets.
  return `Found code snippets for query: ${query}`;
}

async function getFileContent(filePath: string): Promise<string> {
  // Here you would implement the logic to fetch the file content from the remote environment
  // For example, you might use an RPC call to a remote service that retrieves the file content.
  return `Content of file at path: ${filePath}`;
}

async function executeCommand(command: string): Promise<string> {
  // Here you would implement the logic to execute a command in the remote environment
  // For example, you might use an RPC call to a remote service that executes the command.
  return `Executed command: ${command}`;
}

// Utility function to get the last message content
// There must be a better way.
function lastMessageContent(messages: CoreMessage[]): string {
  if (messages.length === 0) {
    return "<No messages generated>";
  }
  const lastMessage = messages[messages.length - 1];
  if (lastMessage.role !== "assistant") {
    return "<Last message was not from the assistant>";
  }
  if (typeof lastMessage.content === "string") {
    return lastMessage.content;
  }
  if (Array.isArray(lastMessage.content) && lastMessage.content.length > 0) {
    return lastMessage.content[0].type === "text"
      ? lastMessage.content[0].text
      : "<No text in last message>";
  }
  return "<Last message content is not text>";
}

function browserStream(abortSignal: AbortSignal, topic: string, stepId: string): (nextText: string) => Promise<void> {
  return async (message: string) => {
    // do a few local retries, but never let an error bubble up to not
    // fail the step just if this stream fails
    for (let i = 0; i < 3; i++) {
      try {
        await fetch(`http://localhost:3000/publish/${topic}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            taskId: "n/a",
            stepId,
            message,
            topic,
          }),
          signal: abortSignal,
        });
        return;
      } catch (error) {
        // ignore
      }
    }
  };
}