//
// simple in memory pubsub server for demo purposes
//
// open in your browser at http://localhost:3000 to subscribe to a topic
// and publish messages to it
// you can use curl to test it as well
//
// curl http://localhost:3000/publish/example --json '{"message": "Hello World!"}',
//
// or
// curl http://localhost:3000/subscribe/example
//

import { createServer } from "node:http";
import { readFile } from "node:fs";
import { TerminalError } from "@restatedev/restate-sdk";
import { StartedTestContainer, GenericContainer, PullPolicy } from "testcontainers";

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
      throw new TerminalError(`No sandbox found with id '${id}'`);
    }
    const result = await container.exec(["bash", "-c", command]);
    if (result.exitCode !== 0) {
      return `Error executing command: ${result.stderr.toString()}`;
    }
    const output = result.output;
    console.log(`[${id}] $ ${command}\n> ${output}`);
    return output;
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// -------------------------------------------------------------------------------------
// Server State
// -------------------------------------------------------------------------------------

export const sandboxManager = new SandboxManager();
export const pubsub = new Pubsub();

const server = createServer((req, res) => {
  // ----------
  // subscribe
  // ----------
  if (req.url?.startsWith("/subscribe")) {
    const topic = req.url.slice("/subscribe/".length);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    pubsub.subscribe(topic, (message) => {
      res.write(`data: ${message}\n\n`);
    });
    return;
  }
  // ----------
  // publish
  // ----------
  if (req.url?.startsWith("/publish")) {
    const topic = req.url.slice("/publish/".length);
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      pubsub.publish(topic, body);
      res.writeHead(204);
      res.end();
    });
    return;
  }
  // ----------
  // provision sandbox
  // ----------
  if (req.url?.startsWith("/provision")) {
    const id = req.url.slice("/provision/".length);
    sandboxManager.provision(id).then(() => {
      res.writeHead(200);
      res.end();
    }).catch((err) => {
      console.error(`Error provisioning sandbox: ${err}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Error provisioning sandbox: ${err}`);
    });
    return;
  }
  // ----------
  // release sandbox
  // ----------
  if (req.url?.startsWith("/release")) {
    const id = req.url.slice("/release/".length);
    sandboxManager.release(id).then(() => {
      res.writeHead(204);
      res.end();
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Error releasing sandbox: ${err}`);
    });
    return;
  }
  // ----------
  // release sandbox
  // ----------
  if (req.url?.startsWith("/execute")) {
    const id = req.url.slice("/execute/".length);

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("No command provided");
        return;
      }
      sandboxManager
        .exec(id, body)
        .then((output) => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(output);
        })
        .catch((err) => {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`${err}`);
        });
    });
    return;
  }
  // -----------------
  // serve index.html
  // -----------------
  if (req.url === "/") {
    readFile("src/index.html", "utf-8", (err, indexHtml) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error reading index.html");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(indexHtml);
    });
    return;
  }
  // ----------
  // serve 404
  // ----------
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
  return;
}).listen(3000);

console.log(
  `Pubsub server running on :3000
  curl http://localhost:3000/subscribe/example
  curl http://localhost:3000/publish/example --json '{"message": "Hello, World!"}'
  `
);


// close everything on Ctrl+C
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  server.close();
  await sandboxManager.releaseAll();
  console.log("All sandboxes released");
  process.exit(0);
} );