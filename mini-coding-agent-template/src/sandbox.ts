
import { Context, service } from "@restatedev/restate-sdk";
import { sandboxManager } from "./sandbox_toy";

export type AcquireSandboxRequest = {
  agentId: string;
};

export type AcquireSandboxResponse = {
  sandboxId: string;
  sandboxUrl: string;
};

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

      await ctx.run("provision", async () => {
        await sandboxManager.provision(sandboxId);
      });

      return {
        sandboxId,
        sandboxUrl: `https://example.com/sandbox/${sandboxId}`,
      };
    },

    release: async (
      ctx: Context,
      req: { sandboxId: string }
    ): Promise<void> => {
      await sandboxManager.release(req.sandboxId);
    },
  },
  options: {
    journalRetention: { hours: 1 },
    idempotencyRetention: { hours: 1 },
  },
});