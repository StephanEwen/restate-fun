import * as restate from "@restatedev/restate-sdk";
import { ciPipeline } from "./pipeline";

restate.serve({
  services: [ciPipeline],
  // Not the SDK default 9080: the sdk-build container runs with host
  // networking and the SDK's own example/test services bind 9080 there.
  port: 9081,
});
