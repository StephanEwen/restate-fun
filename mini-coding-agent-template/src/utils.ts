import { Serde, serde, TerminalError } from "@restatedev/restate-sdk"
import type { ExecResult, ProvisionResult, WriteFileResult } from "./ui";

export const jsonPassThroughSerde: Serde<Uint8Array> = {
    contentType: "application/json",
    serialize: serde.binary.serialize ,
    deserialize: serde.binary.deserialize
}

export function rethrowIfNotTerminal(e: unknown) {
    if (!(e instanceof TerminalError)) {
        throw e;
    }
}

export const pubsubClient = async (topic: string) => {

  const ws = new WebSocket(`ws://localhost:3000/ws/publish/${topic}`);
  const { promise, resolve, reject } = Promise.withResolvers<void>();

  ws.onopen = () => {
    resolve();
  };
  ws.onerror = (error) => {
    reject(new Error(`WebSocket error: ${error.message}`));
  };
  ws.onclose = () => {
    if (ws.readyState !== WebSocket.CLOSED) {
      reject(new Error("WebSocket closed unexpectedly"));
    }
  };

  await promise;

  return {
    publish: (message: any) => {
      ws.send(JSON.stringify(message));
    },

    close: () => {
      ws.close();
    },
  };
};

const baseUrl = "http://localhost:3000";

export const api = {
  provision: async (id: string, callback: string): Promise<ProvisionResult> => {
    const res = await fetch(
      `${baseUrl}/provision/${id}/${callback}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
    if (!res.ok) {
      throw new Error("Transient error provisioning a sandbox");
    }
    return await (res.json() as Promise<ProvisionResult>);
  },
  
  release: async (id: string): Promise<void> => {
    const res = await fetch(`${baseUrl}/release/${id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      throw new Error("Transient error releasing a sandbox");
    }
  },
  
  execute: async (
    id: string,
    command: string
  ): Promise<ExecResult> => {
    const res = await fetch(`${baseUrl}/execute/${id}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
      body: command,
    });
    if (!res.ok) {
      throw new Error("Transient error executing command in sandbox");
    }
    return await (res.json() as Promise<ExecResult>);
  },

  writeFile: async (
    id: string,
    filePath: string,
    content: string
  ): Promise<WriteFileResult> => {
    const res = await fetch(`${baseUrl}/writeFile/${id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ filePath, content }),
    });
    if (!res.ok) {
      throw new Error("Transient error writing file in sandbox");
    }
    return await (res.json() as Promise<WriteFileResult>);
  },

  status: async (id: string): Promise<{ status: string }> => {
    const res = await fetch(`${baseUrl}/status/${id}`);
    if (!res.ok) {
      throw new Error("Transient error getting sandbox status");
    }
    return await (res.json() as Promise<{ status: string }>);
  },
  
};
