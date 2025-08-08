import { Serde, serde, TerminalError } from "@restatedev/restate-sdk"

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
