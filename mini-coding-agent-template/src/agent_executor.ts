import * as restate from "@restatedev/restate-sdk"
import { serde } from "@restatedev/restate-sdk-zod"
import { z } from "zod";
import { Agent } from "./agent";
import { AgentTask } from "./types";

const handler = restate.handlers.handler;

export const agentWorkExecutor = restate.service({
    name: "agent_executor",
    handlers: {
        runTask: handler(
            {
                input: serde.zod(AgentTask),
                output: serde.zod(z.string()),
                journalRetention: { days: 1 }
            },
            async (restate: restate.Context, task) => {

                const agent = restate.objectSendClient<Agent>({ name: "agent" }, task.agentId);

                for (let iteration = 0; iteration < task.maxIterations; iteration++) {
                    let toolCalls = 5 - iteration;

                    await restate.sleep(10_000);

                    if (toolCalls === 0) {
                        return "done";
                    }
                }

                return `The task exceeded the maximum number of iterations ${task.maxIterations}`;
            }
        )
    },
    options: {
        ingressPrivate: true // this cannot be triggered externally via http, only from agent 
    }

})

export type AgentWorkExecutor = typeof agentWorkExecutor;
