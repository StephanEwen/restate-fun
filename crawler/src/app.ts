import * as restate from "@restatedev/restate-sdk";
import { crawler } from "./crawler";
import { crawlStatus } from "./status";

restate.serve({
  services: [crawler, crawlStatus],
  port: 9080,
});
