//
// Simple in memory pubsub/and sandbox server for demo purposes
//

import { StartedTestContainer, GenericContainer } from "testcontainers";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFile } from "fs/promises";
import { createNodeWebSocket } from "@hono/node-ws";

// -------------------------------------------------------------------------------------
// Pubsub
// -------------------------------------------------------------------------------------

class Channel {
  messages: any[] = [];
  subscribers: Set<(message: any) => void> = new Set();

  subscribe(callback: (message: any) => void): void {
    this.messages.forEach((message) => callback(message));
    this.subscribers.add(callback);
  }

  publish(message: any): void {
    this.messages.push(message);
    this.subscribers.forEach((callback) => callback(message));
  }
}

class Pubsub {
  channels: Map<string, Channel> = new Map();

  subscribe(topic: string, cb: (message: any) => void) {
    if (!this.channels.has(topic)) {
      this.channels.set(topic, new Channel());
    }
    const channel = this.channels.get(topic)!;
    channel.subscribe(cb);
  }

  publish(topic: string, message: any): void {
    if (!this.channels.has(topic)) {
      this.channels.set(topic, new Channel());
    }
    this.channels.get(topic)!.publish(message);
  }
}

// -------------------------------------------------------------------------------------
// Sandbox
// -------------------------------------------------------------------------------------

type SandboxState =
  | {
      type: "running";
      container: StartedTestContainer;
    }
  | { type: "starting" }
  | { type: "failed"; error: any }
  | { type: "unknown" }
  | { type: "stopped" };
  

export type CommonResult =
  | { type: "starting" }
  | { type: "failed"; error: any }
  | { type: "unknown" }
  | { type: "stopped" };
  
export type ProvisionResult =
  | {
      type: "ok";
    }
  | CommonResult;

export type ExecResult =
  | {
      type: "result";
      result: {
        statusCode: number;
        output: string;
        error: string;
      };
    }
  | CommonResult;
  
export type WriteFileResult =
  | { type: "ok" }
  | CommonResult; 
  
  
function deliverCallback(callbackUrl: string, message: object) {
 fetch(callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  }).then(() => {
    console.log(`Callback delivered to ${callbackUrl} with message:`, message);
  }).catch(()=>{});
}

class SandboxManager {
  image: string;
  sandboxes: Map<string, SandboxState>;

  constructor(image = "debian:latest") {
    this.image = image;
    this.sandboxes = new Map(); // id → container
  }

  getState(id: string): SandboxState {
    const state = this.sandboxes.get(id);
    if (state === undefined) {
      return { type: "unknown" };
    }
    return state;
  }

  provision(id: string, callbackUrl: string): ProvisionResult {
    const state = this.getState(id);
    switch (state.type) {
      case "running": {
        return { type: "ok" };
      }
      case "starting": {
        return { type: "ok" };
      }
      case "failed": {
       return { type: "failed", error: state.error };
      }
      case "unknown":
        break;
    }

    this.sandboxes.set(id, { type: "starting" });

    const startupLogic = async () => {
      // create a new container that hangs forever.
      try {
        const container = await new GenericContainer(this.image)
          .withEntrypoint(["/bin/bash"])
          .withCommand(["-c", "while true; do sleep 1000; done"])
          .withPullPolicy({
            shouldPull() {
              return true;
            },
          })
          .start();
        
        // run some commands to prepare the container
        await container.exec(["bash", "-c", "apt-get update"])

        const currentState = this.getState(id);

        switch (currentState.type) {
          case "running":
          case "failed":
          case "unknown": {
            console.warn(
              "This is a demo bug, it sure is hard to nail it without restate. Don't be like me, use restate!"
            );
            break;
          }
          case "stopped": {
            container.stop().catch((e) => {});
            break;
          }
        }

        this.sandboxes.set(id, { type: "running", container });

        console.log(
          `Sandbox '${id}' provisioned from image '${
            this.image
          }' with id '${container.getId()}'`
        );

        deliverCallback(callbackUrl, { type: "ok" });
      } catch (error) {
        console.log(`Sandbox ${id} failed to start`, error);
        this.sandboxes.set(id, { type: "failed", error });
        deliverCallback(callbackUrl, { type: "error", error });
      }
    };

    // lunch the logic in the background
    startupLogic().catch(() => {});
    return { type: "starting" };
  }
  
  provisionStatus(id: string) {
    const state = this.getState(id);
    return { status: state.type };
  }

  async exec(id: string, command: string): Promise<ExecResult> {
    const state = this.getState(id);
    switch (state.type) {
      case "running": {
        break;
      }
      case "starting": {
        return { type: "starting" };
      }
      case "failed": {
        return { type: "failed", error: state.error };
      }
      case "unknown": {
        return { type: "unknown" };
      }
      case "stopped": {
        return { type: "stopped" };
      }
    }
    const result = await state.container.exec(["bash", "-c", command]);
    const res: ExecResult = {
      type: "result",
      result: {
        statusCode: result.exitCode,
        output: result.output,
        error: result.stderr,
      },
    };
    console.log(`[${id}] $ ${command}\n>`, res);
    return res;
  }

  async writeFile(
    id: string,
    filePath: string,
    content: string
  ): Promise<WriteFileResult> {
    const state = this.getState(id);
    switch (state.type) {
      case "running":
        break;
      case "starting": {
        return { type: "starting" };
      }
      case "failed": {
        return { type: "failed", error: state.error };
      }
      case "unknown": {
        return { type: "unknown" };
      }
      case "stopped":
        return { type: "stopped" };
    }
    try {
      const container = state.container;
      await container.copyContentToContainer([
        {
          content: content,
          target: filePath,
        },
      ]);

      console.log(
        `[${id}] Created file '${filePath}' with content: ${content}`
      );

      return { type: "ok" };
    } catch (error) {
      console.log(
        `[${id}] Failed creating a file '${filePath}' with content: ${content}`,
        error
      );

      return { type: "failed", error };
    }
  }

  release(id: string) {
    const state = this.getState(id);
    switch (state.type) {
      case "stopped":
      case "unknown":
      case "failed":
        break;
      case "starting":
        {
          this.sandboxes.set(id, { type: "stopped" });
        }
        break;
      case "running": {
        console.log(`Sandbox '${id}' is scheduled for deletion in 5 minutes`);

        this.sandboxes.set(id, { type: "stopped" });
        
        // remove the state from memory after 7 minutes
        setTimeout(() => {
          this.sandboxes.delete(id);
        }, 6 * 60 * 1000);

        // stop the container after 5 minutes
        setTimeout(() => {
          state.container.stop().then(() => {
            console.log(`sandbox ${id} has stopped.`);
          });
        }, 5 * 60 * 1000);
        
        break;
      }
    }
  }

  async releaseAll() {
    for (const [id, sandbox] of this.sandboxes.entries()) {
      if (sandbox && sandbox.type === "running") {
        sandbox.container.stop();
        console.log(`Sandbox '${id}' released`);
      }
    }
    this.sandboxes.clear();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
   
}

// -------------------------------------------------------------------------------------
// Server State
// -------------------------------------------------------------------------------------

export const sandboxManager = new SandboxManager();
export const pubsub = new Pubsub();

// -------------------------------------------------------------------------------------
// Hono application
// -------------------------------------------------------------------------------------

const app = new Hono()
  .post("/provision/:id/:callback", async (c) => {
    const id = c.req.param("id");
    const callback = c.req.param("callback");
    const res = sandboxManager.provision(
      id,
      `http://localhost:8080/restate/a/${callback}/resolve`
    );
    return c.json(res, 200);
  })
  .get("/status/:id", async (c) => {
    const id = c.req.param("id");
    const res = sandboxManager.provisionStatus(id);
    return c.json(res, 200);
  })
  .post("/release/:id", async (c) => {
    const id = c.req.param("id");
    sandboxManager.release(id);
    return c.body(null, 204);
  })
  .post("/execute/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.text();
    if (!body) {
      return c.text("No command provided", 400);
    }
    try {
      const output = await sandboxManager.exec(id, body);
      return c.json(output);
    } catch (err) {
      return c.text(`${err}`, 500);
    }
  })
  .post("/writeFile/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const json = await c.req.json<{ content: string; filePath: string }>();
      if (!json) {
        return c.text("No command provided", 400);
      }
      const { content, filePath } = json;
      const output = await sandboxManager.writeFile(id, filePath, content);
      return c.json(output);
    } catch (err) {
      return c.text(`${err}`, 500);
    }
  })
  .get("/", async (c) => {
    const content = await readFile("src/index.html", "utf-8");
    return c.html(content);
  })
  .notFound((c) => c.text("Not Found", 404))
  .onError((error, c) => {
    if (typeof error === "object") {
      return c.json(error, 500);
    } else {
      console.log(error);
      return c.text("Error processing " + c.req.url, 500);
    }
  });

// -----------------------------------------------------------------------------------------
// Setup websocket
// -----------------------------------------------------------------------------------------

const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

app
  .get(
    "/ws/subscribe/:topic",
    upgradeWebSocket!((c) => {
      const topic = c.req.param("topic");
      return {
        onOpen: (_, ws) => {
          pubsub.subscribe(topic, (message) => {
            ws.send(message);
          });
        },
        onClose: () => {
          console.log("Client disconnected");
        },
        onError: (err) => {
          console.error("WebSocket error", err);
        },
      };
    })
  )
  .get(
    "/ws/publish/:topic",
    upgradeWebSocket!((c) => {
      const topic = c.req.param("topic");
      return {
        onOpen: (_, ws) => {},
        onMessage: async (message, ws) => {
          pubsub.publish(topic, message.data);
        },
        onClose: () => {
          console.log("Client disconnected");
        },
        onError: (err) => {
          console.error("WebSocket error", err);
        },
      };
    })
  );
  
const server = serve({ ...app, port: 3000 }, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);
});
  

injectWebSocket(server);

console.log(
  `Server running on :3000
  curl http://localhost:3000/subscribe/example
  curl http://localhost:3000/publish/example --json '{"message": "Hello, World!"}'
  curl http://localhost:3000/provision/example
  curl http://localhost:3000/execute/example --data 'echo Hello'
  curl http://localhost:3000/writeFile/example --json '{"filePath": "/tmp/test.txt", "content": "Hello, World!"}'
`
);

// close everything on Ctrl+C
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await sandboxManager.releaseAll();
  console.log("All sandboxes released");
  process.exit(0);
});
