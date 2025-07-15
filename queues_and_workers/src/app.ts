import * as restate from "@restatedev/restate-sdk";

import { workerTracker } from "./svcs/worker_tracker"
import { taskQueue } from "./svcs/queue"

// an entry-point that binds all services behind the same endpoint
restate
  .endpoint()
  .bind(workerTracker)
  .bind(taskQueue)
  .listen(9080);

