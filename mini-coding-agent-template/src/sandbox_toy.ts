import { TerminalError } from "@restatedev/restate-sdk";
import { GenericContainer, PullPolicy, StartedTestContainer } from "testcontainers";

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

export const sandboxManager = new SandboxManager();

export const toySandboxRPC = (id: string) => ({
  
  async exec(command: string) {
    return sandboxManager.exec(id, command);
  },
  

});