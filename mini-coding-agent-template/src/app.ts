import { serve  } from "@restatedev/restate-sdk";
import { agent } from "./agent";
import { agentExecutor } from "./agent_executor";

serve({
  services: [ agent, agentExecutor]
})