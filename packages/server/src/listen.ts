import { serve, type ServerType } from "@hono/node-server";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { Instance } from "./instance.ts";

export interface ListenOptions {
  port?: number;
  /** Defaults to `127.0.0.1`, so a development instance is not reachable from other machines. */
  hostname?: string;
}

export interface Listening {
  readonly url: string;
  close(): Promise<void>;
}

function upgradeRequest(incoming: IncomingMessage, fallbackHost: string) {
  const headers = new Headers();
  for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index];
    const value = incoming.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  const host = incoming.headers.host ?? fallbackHost;
  return new Request(new URL(incoming.url ?? "/", `http://${host}`), {
    method: incoming.method ?? "GET",
    headers,
  });
}

/** Serves an instance over HTTP on Node, including upgrade requests such as WebSockets. */
export function listen(
  instance: Instance,
  options: ListenOptions = {},
): Promise<Listening> {
  const hostname = options.hostname ?? "127.0.0.1";
  const upgraded = new Set<Duplex>();
  return new Promise((resolveListening) => {
    const server: ServerType = serve(
      {
        fetch: (request, env) => {
          const clientAddress = env.incoming.socket.remoteAddress;
          return instance.fetch(
            request,
            clientAddress ? { clientAddress } : {},
          );
        },
        port: options.port ?? 3000,
        hostname,
      },
      (info: AddressInfo) => {
        const fallbackHost = `${hostname}:${info.port}`;
        server.on(
          "upgrade",
          (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
            upgraded.add(socket);
            socket.once("close", () => upgraded.delete(socket));
            socket.on("error", () => socket.destroy());
            const clientAddress = incoming.socket.remoteAddress;
            instance
              .upgrade(
                upgradeRequest(incoming, fallbackHost),
                { incoming, socket, head },
                clientAddress ? { clientAddress } : {},
              )
              .catch((error: unknown) => {
                socket.destroy();
                instance.ctx.logger("http").error(error);
              });
          },
        );
        resolveListening({
          url: `http://${fallbackHost}`,
          close: () =>
            new Promise<void>((resolveClose, reject) => {
              server.close((error) => (error ? reject(error) : resolveClose()));
              // `close` waits for every connection to end, and upgraded
              // sockets (WebSockets) stay open until their peer leaves.
              for (const socket of upgraded) socket.destroy();
            }),
        });
      },
    );
  });
}
