import * as restate from "@restatedev/restate-sdk"
import { serde } from "@restatedev/restate-sdk-zod"
import { z } from "zod";
import { Agent } from "./agent";
import { AgentTask, Entry } from "./types";
import { rethrowIfNotTerminal } from "./utils";

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

                // this is our task ID, so we can let the agent know who sent the request
                const taskId = restate.request().id; 

                // to call the agent back
                const agent = restate.objectSendClient<Agent>({ name: "agent" }, task.agentId);

                try {
                    for (let iteration = 0; iteration < task.maxIterations; iteration++) {
                        let toolCalls = 5 - iteration;

                        // TODO - here is where we put the actual step
                        // TODO: stream model call and tee to router to webUI and into durable step

                        await restate.sleep(10_000);

                        agent.addUpdate({taskId, entry: { role: "agent", message: `update ${iteration}` }});

                        if (toolCalls === 0) {
                            agent.taskComplete({ taskId, message:"I finished the task" });
                            return;
                        }
                    }
                }
                catch (e) {
                    rethrowIfNotTerminal(e);
                    // this code path is also hit during cancellation
                    // clean up things
                    console.log("--------- CLEANING UP THINGS ----------")

                    // TODO, some real cleanup. some delay to simulate that
                    await new Promise((resolve) => setTimeout(resolve, 2_000))
                }
            }
        )
    },
    options: {
        journalRetention: { days: 1 },
        idempotencyRetention: { days: 1 },
        inactivityTimeout: { minutes: 15 }, // inactivity (nor producing restate actions) after which Restate triggers suspension
        abortTimeout: { minutes: 30 }, // inactivity after which invocation is disconnected and retried (from journal)
        ingressPrivate: true // this cannot be triggered externally via http, only from agent 
    }

})

export type AgentExecutor = typeof agentExecutor;
