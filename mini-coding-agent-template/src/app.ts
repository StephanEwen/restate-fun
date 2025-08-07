import { env } from "node:process";

import { serve  } from "@restatedev/restate-sdk";
import { agent } from "./agent";
import { agentExecutor } from "./agent_executor";
import { sandbox } from "./sandbox";


if (env.OPENAI_API_KEY === undefined) {
  console.warn(`
    ----------------------------------------------------------
    | WARNING: OPENAI_API_KEY is not set in the environment. |
    ----------------------------------------------------------
    `);
}

serve({
  services: [agent, agentExecutor, sandbox],
  port: 9080,
});