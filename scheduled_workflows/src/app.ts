import * as restate from "@restatedev/restate-sdk";
import { scheduler } from "./scheduler";

// The scheduler is deployed on its own. The workflows it drives are registered
// separately -- see src/sample_workflows for an example of such a deployment.
restate.serve({
  services: [scheduler],
  port: 9080,
});
