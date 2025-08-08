
import { Context, service, TerminalError } from "@restatedev/restate-sdk";

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

      await ctx.run(
        "provision",
        async () => {
          const res = await fetch(
            `http://localhost:3000/provision/${sandboxId}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({}),
            }
          );
          if (!res.ok) {
            throw new Error(
              `Failed to provision sandbox: ${res.statusText}`
            );
          }
        },
        { maxRetryAttempts: 5 }
      );

      return {
        sandboxId,
        sandboxUrl: `http://localhost:3000/execute/${sandboxId}`,
      };
    },

    release: async (
      ctx: Context,
      req: { sandboxId: string }
    ): Promise<void> => {
      // This is a placeholder for the release handler.
      // Implement your release logic here.
      const { sandboxId } = req;

      await ctx.run("release", async () => {
        const res = await fetch(`http://localhost:3000/release/${sandboxId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        })
        
        if (!res.ok) {
          throw new TerminalError(
            `Failed to release sandbox: ${res.statusText}`
          );
        }
      });
    },
  },
  options: {
    journalRetention: { hours: 1 },
    idempotencyRetention: { hours: 1 },
  },
});