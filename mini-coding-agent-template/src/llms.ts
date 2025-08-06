import { generateObject, streamText } from "ai";
import { AgentTask, PlanStep } from "./types";
import { openai } from "@ai-sdk/openai";
import {z} from "zod";

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

  const prompt = `You are an AI assistant that generates a plan for executing a coding task.
    The task is: ${task.prompt}
    The context is: ${task.context.map((c) => c.message).join("\n")},
    Please break down the task into steps, such as gathering information, writing code, testing, etc.
    Describe each step in detail, including the specific prompt to provide to the LLM,
    for further planning of the individual steps
    Do not generate more than 5 steps at once.
    Each step starts as pending.
    `;

  // Call the LLM to generate a plan
  const { object: plan } = await generateObject({
    model: openai("gpt-4o", { structuredOutputs: true }),
    schema: z.object({
      steps: z.array(PlanStep),
    }),
    abortSignal,
    prompt,
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
 * @param abortSignal - The signal to abort the operation if needed.
 * @returns A promise that resolves to an array of messages generated during the step execution.
 */
export async function executePlanStep(
  taskId: string,
  task: AgentTask,
  step: PlanStep,
  abortSignal: any
): Promise<string[]> {
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

  for await (const textPart of textStream) {
    await fetch(`http://localhost:3000/publish/${task.agentId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ taskId, stepId: step.id, message: textPart }),
      signal: abortSignal,
    });
    texts.push(textPart);
  }

  return [texts.join("")];
}
