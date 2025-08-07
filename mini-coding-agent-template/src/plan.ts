import { CoreMessage, generateObject, streamText } from "ai";
import { AgentTask, PlanStep } from "./types";
import { openai } from "@ai-sdk/openai";
import {z} from "zod";

export type StepInput = {
  taskId: string;
  stepId: string;
  sandboxId: string;
  task: AgentTask;
  step: PlanStep;
  s3prefix: string;
  sandboxUrl: string;
  planetScaleUrl: string;
  tempDirectory: string;
  topic: string;
};

export type StepResult = {
  stepId: string;
  messages: CoreMessage[];
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



/**
 * Executes a single step in the plan.
 * This function executes a specific step in the plan by calling the LLM with the step's prompt.
 * And using various tools, like RPC a remote environment to grep, execute tests etc'.
 * In this demo we don't use any tools, but you can imagine that this is where you would integrate them.
 *
 * @param taskId - The ID of the task being executed.
 * @param task - The task object containing relevant information.
 * @param step - The specific step to execute.
 * @returns A promise that resolves to an array of messages generated during the step execution.
 */
export async function executePlanStep(
  { taskId, task, step, topic }: StepInput,
  abortSignal: AbortSignal
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

  const { textStream } = streamText({
    model: openai("gpt-4o-mini", { structuredOutputs: true }),
    system: "You are a helpful assistant.",
    prompt: step.prompt,
    abortSignal,
  });

  const texts: string[] = [];
  
 // chunk encoding upload the stream to a topic
 
  for await (const textPart of textStream) {
    // chunk encoding upload the stream to a topic
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
    texts.push(textPart);
  }

  // imagine doing something with the conversation, like uploading it to S3

  // For example:
  // await uploadToS3({
  //   Bucket: "my-bucket",
  //   Key: `conversations/${taskId}/${step.id}.json`,
  //   Body: JSON.stringify({
  //     taskId,
  //     stepId: step.id,
  //     messages: texts,
  //   }),
  // });

  // and coordinating tool execution, like running tests, or executing code in a sandboxed environment.
  // sandboxClient.execute({
  //   sandboxId: step.sandboxId,
  //   code: step.code,
  // });
  //
  // and coordinating tool execution, like running tests, or executing code in a sandboxed environment.
  // await runTestsInSandbox({
  //   sandboxId: step.sandboxId,
  //   code: texts.join("\n"),
  // });
  //
  //
  return {
    stepId: step.id,
    messages: [
      {
        role: "assistant",
        content: texts.join("\n"),
      },
    ],
  };
}
