import * as restate from "@restatedev/restate-sdk";
import * as crypto from "crypto";
import { LocalFileObjectStore } from "./test_object_store";
import { mayBeOffload, OFFLOAD_THRESHOLD } from "./offload";

const objectStore = new LocalFileObjectStore();

function randomText(length: number): string {
  return crypto.randomBytes(length).toString("base64url").slice(0, length);
}

const greeter = restate.service({
  name: "test",
  handlers: {
    smallPayload: async (ctx: restate.Context) => {
      const { value } = await mayBeOffload(ctx, objectStore, "generate-small", async () => {
        const value = randomText(1024);
        console.log("smallPayload original:", value.slice(0, 80), `... (${value.length} chars)`);
        return value;
      });
      maybeFail();
      console.log("smallPayload result:", value.slice(0, 80), `... (${value.length} chars)`);
      return value;
    },
    largePayload: async (ctx: restate.Context) => {
      const { value } = await mayBeOffload(ctx, objectStore, "generate-large", async () => {
        const value = randomText(OFFLOAD_THRESHOLD + 1024);
        console.log("smallPayload result:", value.slice(0, 80), `... (${value.length} chars)`);
        return value;
      });
      maybeFail();
      console.log("largePayload result:", value.slice(0, 80), `... (${value.length} chars)`);
      return value;
    },
  }
});

restate.serve({
  services: [greeter],
  port: 9080,
});


let failNext = true;
function maybeFail() {
  if (failNext) {
    failNext = false;
    throw new Error("Test error");
  }
}
