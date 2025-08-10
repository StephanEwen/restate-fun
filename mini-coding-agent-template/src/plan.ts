import { TerminalError, type Context } from "@restatedev/restate-sdk";

import {
  CoreMessage,
  streamText,
  streamObject,
} from "ai";
import { AgentTask, PlanStep, StepInput, StepResult } from "./types";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { api, pubsubClient } from "./utils";

// --------------------------------------------------------
//  The actual agentic planning and plan step execution
// --------------------------------------------------------

// A set of tools that the LLM can use to execute the steps
const TOOLS = {
  executeCommand: {
    parameters: z.object({
      command: z.string().describe("The shell command to execute."),
    }),
    description: `Executes a non-interactive shell command in an Ubuntu Linux environment. 
This tool is designed for performing file system operations, managing dependencies, and running processes.

# Usage Guidelines:
- Use for commands like 'ls -R', 'mkdir -p my-dir', 'npm install', 'cat file.txt'.
- Commands must not require user input or interactive prompts.
- Each command is executed in a stateless, sessionless environment. Ensure the entire operation is encapsulated in a single command string (e.g., 'cd dist && cat app.js').
- Use this tool for tasks such as:
  - Checking versions (e.g., 'node -v').
  - Creating directories or files.
  - Installing dependencies (e.g., 'npm install').
  - Running scripts or inspecting file contents.
- You run as a superuser, so you can perform any operation that requires elevated privileges. Do not use 'sudo' in commands, as it is not necessary.

# Expected Output:
- Status Code: The exit code of the command (0 for success, non-zero for failure).
- Output: The standard output of the command.
- Error: Any error message produced by the command.

# Best Practices:
- Always validate the output and handle errors appropriately.
- Be explicit about paths and avoid relying on implicit state (e.g., current working directory).`,
  },
  createFile: {
    parameters: z.object({
      filePath: z
        .string()
        .describe(
          "The full path where the file should be created, e.g., 'src/index.js'."
        ),
      content: z.string().describe("The content to write into the file."),
    }),
    description: `A high-level tool to create a new file with specified content. 
This is often more reliable for writing multi-line code than using 'echo' with 'executeCommand'.
- If the file already exists, it will be completely overwritten.
- Use this for writing source code, configuration files, or documentation.`,
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

  const system = `You are an expert coding task planner responsible for breaking down complex programming tasks into executable steps.

# TASK
${task.prompt}

# EXECUTION ENVIRONMENT
- Ubuntu Linux environment
- Git and npm pre-installed
- All commands must be non-interactive (no user input required)
- Example: Use 'echo "content" > file.txt' instead of 'nano file.txt'

# PLAN REQUIREMENTS
1. Generate 3-8 logical steps
2. Each step must include:
   - id: A unique identifier (e.g., "step1")
   - title: A concise title
   - description: Detailed explanation of what needs to be accomplished
   - prompt: Specific instructions for the AI to execute this step
   - status: Always set to "pending"

# STEP CATEGORIES TO CONSIDER
- Environment assessment (checking versions, file structure)
- Project setup (creating directories, initializing repos)
- Dependency management (installing packages)
- Code development (writing specific components)
- Testing and validation (verifying functionality)
- Documentation (adding comments, README files)

# BEST PRACTICES
- Make steps atomic and focused on one specific outcome
- Include error handling considerations
- Ensure logical progression between steps
- Be explicit about file paths and naming conventions
- Provide context in each step about its place in the overall task

The AI will execute each step exactly as instructed, so be thorough and precise.
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
export async function agentLoop(
  restate: Context,
  { taskId, task, step, topic, stepResults, sandboxId }: StepInput
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
      content: `
      You are an AI coding assistant executing a specific step in a larger task.
      
      # Environment
      - Ubuntu machine with git and npm installed
      - Use only non-interactive bash commands (no 'npm start', 'nano', etc.)
      - Always check command output for errors and handle them appropriately
        
      # The larger task that this step is part of
      ${task.prompt}
      
      # Your task
      Step: ${step.title}
      
      Description: 
      ${step.description}
      
      Prompt:
      ${step.prompt}
      
      # Previous steps results
      ${stepResults.map((res) => `- ${res}`).join("\n")}
      
      # Guidelines
      1. Think step-by-step and explain your reasoning
      2. Write clean, well-documented code with error handling
      3. When using tools, explain why you're using them and what you expect
      4. If a command fails, analyze the error and try an alternative approach
      5. Conclude with a clear summary of what you accomplished
      
      Always focus on completing the current step successfully before moving on.
      `,
    },
  ];


  for (let i = 0; i < 25; i++) {
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
      if (call.toolName === "createFile") {
        const result = await restate.run(
          "create file",
          () => writeFileInSandbox(sandboxId, call.args),
          { maxRetryAttempts: 5 }
        );

        history.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              result,
            },
          ],
        });
      }

      if (call.toolName === "executeCommand") {
        const { command } = call.args;
        
        const result = await restate.run(
          "execute command",
          () => runInSandbox(sandboxId, command),
          { maxRetryAttempts: 5 }
        );
        
        history.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              result,
            },
          ],
        });
      }
    }
  }

  return "<I failed to execute this step withn 25 iterations>";
}

async function writeFileInSandbox(
  sandboxId: string,
  args: { filePath: string; content: string }
): Promise<string> {
  const res = await api.writeFile(sandboxId, args.filePath, args.content);
  switch (res.type) {
    case "starting":
      throw new TerminalError("Sandbox is still starting, please retry later.");
    case "failed":
      throw new TerminalError(`Failed to write file: ${res.error}`);
    case "unknown":
      throw new TerminalError("Unknown error occurred while writing file.");
    case "stopped":
      throw new TerminalError("Sandbox execution stopped unexpectedly.");
    case "ok":
      return "File written successfully.";
  }
}

async function runInSandbox(
  sandboxId: string,
  command: string
): Promise<string> {
  const res = await api.execute(sandboxId, command);
  switch (res.type) {
    case "result": {
      return `
      # Status Code
      ${res.result.statusCode}
      
      # Output
      ${res.result.output}

      # Error
      ${res.result.error}`;
    }
    case "stopped":
    case "unknown":
    case "failed":
      throw new TerminalError(`Sandbox execution failed: ${res.type}`);
    case "starting":
      throw new Error("Sandbox is still starting, please retry later.");
  }
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

  const streamToUi = await browserStream(topic, stepId);

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

  const streamToUi = await browserStream(topic, stepId);

  await streamToUi("\n\n >>>>>>>> Begin Planning... <<<<<<<<\n\n");
  for await (const textPart of textStream) {
    await streamToUi(textPart);
  }
  await streamToUi("\n\n >>>>>>>>> End Planning... <<<<<<<<<\n\n");

  return await object;
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

async function browserStream(topic: string, stepId: string) {
  const publisher = await pubsubClient(topic);

  return async (message: string) => {
    
    const body = {
      taskId: "n/a",
      stepId,
      message,
      topic,
    };

    // do a few local retries, but never let an error bubble up to not
    // fail the step just if this stream fails
    for (let i = 0; i < 3; i++) {
      try {
        publisher.publish(body);
        return Promise.resolve();
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    return Promise.reject(new Error("Failed to publish message"));
  };
}