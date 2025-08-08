
import { Context, service } from "@restatedev/restate-sdk";

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
      return {
        sandboxId: "some-sandbox-id",
        sandboxUrl: "https://example.com/sandbox",
      };
    },

    release: async (
      ctx: Context,
      req: { sandboxId: string }
    ): Promise<void> => {
      // This is a placeholder for the release handler.
      // Implement your release logic here.
    },
  },
});