
import { Context, service, TerminalError } from "@restatedev/restate-sdk";
import { hc } from 'hono/client'
import type { App } from "./ui";

export type AcquireSandboxRequest = {
  agentId: string;
};

export type AcquireSandboxResponse = {
  sandboxId: string;
  sandboxUrl: string;
};

// an hono RPC client to talk to the UI in a type safe way
const sandboxAPI = hc<App>("http://localhost:3000");

/**
 * A placeholder for the sandbox service.
 * Does nothing and simply returns a sandboxId and sandboxUrl.
 */
export const sandbox = service({
  name: "sandbox",
  description:
    "Service to manage the provisioning and releasing of code sandboxes.",
  handlers: {
    acquire: async (
      ctx: Context,
      req: AcquireSandboxRequest
    ): Promise<AcquireSandboxResponse> => {
      // This is a placeholder for the lease handler.
      // Implement your lease logic here.
      const sandboxId = ctx.rand.uuidv4();
      
      const { id: callback, promise } = ctx.awakeable<{ type: "ok" | "failure" }>();

      await ctx.run(
        "provision",
        async () => {
          const res = await sandboxAPI.provision[":id"][":callback"].$post({
            param: {
              id: sandboxId,
              callback,
            },
          });
          if (!res.ok) {
            throw new Error("transient error provisioning a sandbox");
          }

          const state = await res.json();

          switch (state.type) {
            case "unknown":
            case "ok":
            case "starting":
              return;
            case "failed": {
              throw new TerminalError(
                `Failed to provision a sandbox ${state.error}`
              );
            }
            case "stopped": {
              throw new TerminalError(
                `Failed to provision a sandbox, it seems to be stopped already.`
              );
            }
          }
        },
        { maxRetryAttempts: 5 }
      );
      
      const { type } = await promise.orTimeout({ minutes: 2 });
      if (type !== "ok") {
        throw new TerminalError("could not provision a sandbox");
      }

      return {
        sandboxId,
        sandboxUrl: `http://localhost:3000/execute/${sandboxId}`,
      };
    },

    release: async (
      ctx: Context,
      req: { sandboxId: string }
    ): Promise<void> => {
      const { sandboxId } = req;

      await ctx.run(
        "release",
        async () => {
          const res = await fetch(
            `http://localhost:3000/release/${sandboxId}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
            }
          );

          if (!res.ok) {
            throw new Error(`Failed to release sandbox: ${res.statusText}`);
          }
        },
        { maxRetryAttempts: 5 }
      );
    },
  },
  options: {
    journalRetention: { hours: 1 },
    idempotencyRetention: { hours: 1 },
  },
});