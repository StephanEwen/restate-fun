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



export const pubsub = new Pubsub();

createServer((req, res) => {
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