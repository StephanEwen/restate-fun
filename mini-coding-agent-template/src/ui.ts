//
// Simple in memory pubsub/and sandbox server for demo purposes
//

import { StartedTestContainer, GenericContainer, PullPolicy } from "testcontainers";
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
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

class SandboxManager {
  image: string;
  sandboxes: Map<string, StartedTestContainer>;

  constructor(image = "node:22-bullseye") {
    this.image = image;
    this.sandboxes = new Map(); // id → container
  }

  async provision(id: string) {
    if (this.sandboxes.has(id)) {
      return;
    }
    // create a new container that hangs forever
    const container = await new GenericContainer(this.image)
      .withEntrypoint(["/bin/bash"])
      .withCommand(["-c", "while true; do sleep 1000; done"])
      .withPullPolicy(PullPolicy.alwaysPull())
      .start();
    this.sandboxes.set(id, container);
    console.log(`Sandbox '${id}' provisioned from image '${this.image}'`);
  }

  async exec(id: string, command: string) {
    const container = this.sandboxes.get(id);
    if (!container) {
      throw new Error(`No sandbox found with id '${id}'`);
    }
    const result = await container.exec(["bash", "-c", command]);
    if (result.exitCode !== 0) {
      return `Error executing command: ${result.stderr.toString()}`;
    }
    const output = result.output;
    console.log(`[${id}] $ ${command}\n> ${output}`);
    return output;
  }

  async writeFile(id: string, filePath: string, content: string) {
    const container = this.sandboxes.get(id);
    if (!container) {
      throw new Error(`No sandbox found with id '${id}'`);
    }
    await container.copyContentToContainer([
      {
        content: content,
        target: filePath,
      },
    ]);
    console.log(`[${id}] Created file '${filePath}' with content: ${content}`);
    return `File '${filePath}' created successfully`;
  }

  async release(id: string) {
    const container = this.sandboxes.get(id);
    if (!container) {
      return;
    }
    await container.stop();
    this.sandboxes.delete(id);
    console.log(`Sandbox '${id}' released`);
  }

  async releaseAll() {
    for (const [id, container] of this.sandboxes.entries()) {
      container.stop();
      console.log(`Sandbox '${id}' released`);
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

const app = new Hono();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get(
  '/ws/:topic',
  upgradeWebSocket((c) => {
    const topic = c.req.param('topic');
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

app.get('/subscribe/:topic', (c) => {
  const topic = c.req.param('topic');
  
  return stream(c, async (stream) => {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    pubsub.subscribe(topic, (message) => {
      stream.write(`data: ${message}\n\n`);
    });
  });
});

app.post('/publish/:topic', async (c) => {
  const topic = c.req.param('topic');
  const body = await c.req.text();
  
  pubsub.publish(topic, body);
  return c.body(null, 204);
});

app.post('/provision/:id', async (c) => {
  const id = c.req.param('id');
  
  try {
    await sandboxManager.provision(id);
    return c.body(null, 200);
  } catch (err) {
    console.error(`Error provisioning sandbox: ${err}`);
    return c.text(`Error provisioning sandbox: ${err}`, 500);
  }
});

app.post('/release/:id', async (c) => {
  const id = c.req.param('id');
  
  try {
    await sandboxManager.release(id);
    return c.body(null, 204);
  } catch (err) {
    return c.text(`Error releasing sandbox: ${err}`, 500);
  }
});

app.post('/execute/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.text();
  
  if (!body) {
    return c.text('No command provided', 400);
  }
  try {
    const output = await sandboxManager.exec(id, body);
    return c.text(output);
  } catch (err) {
    return c.text(`${err}`, 500);
  }
});

app.post('/writeFile/:id', async (c) => {
  const id = c.req.param("id");
  try {
    const json = await c.req.json<{ content: string; filePath: string }>();
    if (!json) {
      return c.text("No command provided", 400);
    }
    const { content, filePath } = json;
    const output = await sandboxManager.writeFile(id, filePath, content);
    return c.text(output);
  } catch (err) {
    return c.text(`${err}`, 500);
  }
});

app.get("/", async (c) => {
  const content = await readFile("src/index.html", "utf-8");
  return c.html(content);
});

app.notFound((c) => c.text('Not Found', 404));


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
