import { request, type IncomingMessage } from "node:http";
import type { FastifyInstance } from "fastify";
import type { LiveEvent } from "../live/live-updates.js";
import { callerHeaders, type Caller } from "./api.js";

/**
 * Cronk's own base URL, from the address it listens on, or undefined when it doesn't listen
 * (its requests are only injected, as in some tests). A wildcard address is reached on loopback.
 */
export function ownBaseUrl(app: FastifyInstance): string | undefined {
  const address = app.server.address();
  if (!address || typeof address === "string") return undefined;
  const host = address.address === "0.0.0.0" ? "127.0.0.1" : address.address === "::" ? "::1" : address.address;
  return `http://${address.family === "IPv6" ? `[${host}]` : host}:${address.port}`;
}

/**
 * Follows one of the API's server-sent event streams over real HTTP as `caller`, calling
 * `onEvent` for each event after the opening `ready`. Resolves once the stream is ready,
 * with a function that closes it, or with undefined if the API refused or couldn't be reached.
 * The stream ends on its own when the API ends it, as when the caller loses access.
 */
export async function followEvents(baseUrl: string, caller: Caller, path: string, onEvent: (event: LiveEvent) => void): Promise<(() => void) | undefined> {
  // A connection of its own, closed with the stream.
  const req = request(new URL(path, baseUrl), {
    agent: false,
    headers: { accept: "text/event-stream", ...callerHeaders(caller) },
  });
  const close = () => void req.destroy();
  try {
    const res = await new Promise<IncomingMessage>((resolve, reject) => req.on("response", resolve).on("error", reject).end());
    if (res.statusCode !== 200) {
      close();
      return undefined;
    }
    const events = readEvents(res)[Symbol.asyncIterator]();
    const first = await events.next();
    if (first.done || first.value.event !== "ready") {
      close();
      return undefined;
    }
    void (async () => {
      for (let e = await events.next(); !e.done; e = await events.next()) onEvent(e.value);
    })().catch(() => {});
    return close;
  } catch {
    close();
    return undefined;
  }
}

/** The events of a server-sent event stream, as the API writes them: an `event` line, a JSON `data` line, a blank line. */
async function* readEvents(body: AsyncIterable<Buffer>): AsyncGenerator<LiveEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) yield { event, data: JSON.parse(data.join("\n")) };
    }
  }
}
