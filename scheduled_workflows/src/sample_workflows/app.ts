import * as restate from "@restatedev/restate-sdk";
import { inboxTriage } from "./inbox-triage";

// A separate deployment from the scheduler: the scheduler only ever learns the
// service and handler name, at schedule-creation time.
restate.serve({
  services: [inboxTriage],
  port: 9081,
});
