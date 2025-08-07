import { serve  } from "@restatedev/restate-sdk";
import { agent } from "./agent";
import { agentExecutor } from "./agent_executor";
import { sandbox } from "./sandbox";

serve({
  services: [agent, agentExecutor, sandbox],
});