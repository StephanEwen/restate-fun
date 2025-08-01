import * as restate from "@restatedev/restate-sdk"
import { serde } from "@restatedev/restate-sdk-zod"
import { z } from "zod";
import { Agent } from "./agent";
import { AgentTask } from "./types";

const handler = restate.handlers.handler;

export const agentExecutor = restate.service({
    name: "agent_executor",
    handlers: {
        runTask: handler(
            {
                input: serde.zod(AgentTask),
                output: serde.zod(z.void()),
                journalRetention: { days: 1 }
            },
            async (restate: restate.Context, task) => {

                const taskId = restate.request().id; // this is to let the agent know who sends the request
                const agent = restate.objectSendClient<Agent>({ name: "agent" }, task.agentId);

                for (let iteration = 0; iteration < task.maxIterations; iteration++) {
                    let toolCalls = 5 - iteration;

                    await restate.sleep(10_000);

                    agent.addUpdate({taskId, message: `update ${iteration}`});

                    if (toolCalls === 0) {
                        agent.taskComplete({ taskId, message: "I finished the task" });
                        return;
                    }
                }

                // this should result in a failure notification, TODO

            }
        )
    },
    options: {
        ingressPrivate: true // this cannot be triggered externally via http, only from agent 
    }

})

export type AgentExecutor = typeof agentExecutor;
