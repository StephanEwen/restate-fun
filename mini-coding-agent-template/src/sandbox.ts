
import { Context, service, TerminalError } from "@restatedev/restate-sdk";
import { api } from "./utils";

export type AcquireSandboxRequest = {
  agentId: string;
};

export type AcquireSandboxResponse = {
  sandboxId: string;
};

export const sandbox = service({
  name: "sandbox",
  description:
    "Service to manage the provisioning and releasing of code sandboxes.",
  handlers: {
    acquire: async (
      ctx: Context,
      req: AcquireSandboxRequest
    ): Promise<AcquireSandboxResponse> => {
      const sandboxId = ctx.rand.uuidv4();

      // The sandbox provising in this demo is asynchronous.
      // Our provisioning API will call us back when the sandbox is ready.
      // In restate this can also be done using an awakeable.

      // 1. create a promise that can be resolved via a callback URL
      //
      // we create an awakeable promise with a unique and stable (across retries) ID
      // Restate provides an API to resolve an awakeable either programmatically or via a callback
      // to the restate ingress given that ID.
      // For example,
      // curl http://localhost:8080/restate/a/<id>/resolve -X POST -d '{"type": "ok"}'
      // once the awakeable is resolved, the promise will be fulfilled.
      const { id, promise } = ctx.awakeable<{ type: "ok" | "failure" }>();

      // 2. register the callback URL with the sandbox API
      await ctx.run(
        "provision",
        async () => {
          const state = await api.provision(sandboxId, id);
          if (state.type === "failed" || state.type === "stopped") {
            throw new TerminalError(`Failed to provision a sandbox`);
          }
        },
        { maxRetryAttempts: 5 }
      );

      // 3. Wait for the callback to arrive.
      const { type } = await promise.orTimeout({ minutes: 2 });
      if (type !== "ok") {
        throw new TerminalError("could not provision a sandbox");
      }

      return {
        sandboxId,
      };
    },

    release: async (
      ctx: Context,
      req: { sandboxId: string }
    ): Promise<void> => {
      const { sandboxId } = req;
      
      await api.release(sandboxId);

    },
  },
  options: {
    journalRetention: { hours: 1 },
    idempotencyRetention: { hours: 1 },
  },
});