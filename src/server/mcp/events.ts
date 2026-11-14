import { request, type ClientRequest, type IncomingMessage } from "node:http";
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

/** How long a stream may take to open with `ready` before it is given up. */
const READY_TIMEOUT_MS = 5_000;
/** How long after a stream ends, or fails to open, it is first opened again; each further failure doubles it, up to the maximum. */
const REOPEN_DELAY_MS = 250;
const MAX_REOPEN_DELAY_MS = 30_000;

/**
 * Follows one of the API's server-sent event streams over real HTTP as `caller`, calling
 * `onEvent` for each event after the opening `ready`, until the returned function is called.
 * Resolves once the stream is first ready, or first fails to open.
 *
 * A stream the API ends, or that couldn't be opened, is opened again after a short delay,
 * backing off while it keeps failing. The API ends a stream when the caller loses access, but
 * also when it can't check that access (a database blip), so opening it again is what tells the
 * two apart: the API refusing it with a client error (a revoked token, an ended Agent Session)
 * stops it for good.
 */
export async function followEvents(baseUrl: string, caller: Caller, path: string, onEvent: (event: LiveEvent) => void): Promise<() => void> {
  let stopped = false;
  let closeStream = () => {};
  let reopening: NodeJS.Timeout | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(reopening);
    closeStream();
  };

  let delay = REOPEN_DELAY_MS;
  // Opens the stream, and settles once it is open or has failed to; after either, it is opened again once it ends.
  const follow = async (): Promise<void> => {
    const opened = await openStream(baseUrl, caller, path, onEvent, (close) => (closeStream = close));
    if (stopped || opened === "refused") return;
    if (opened === "failed") {
      reopenIn(delay);
      delay = Math.min(delay * 2, MAX_REOPEN_DELAY_MS);
      return;
    }
    delay = REOPEN_DELAY_MS;
    void opened.ended.then(() => reopenIn(delay));
  };
  const reopenIn = (ms: number) => {
    if (!stopped) reopening = setTimeout(() => void follow(), ms).unref();
  };
  await follow();
  return stop;
}

/**
 * Opens the stream once, handing `setClose` a function that closes it as soon as there is one.
 * Answers how it went: open, with a promise that settles when the stream ends; refused by the
 * API with a client error, so opening it again would be refused too; or failed otherwise (the API
 * answered with a server error, couldn't be reached, or wasn't ready in time).
 */
async function openStream(
  baseUrl: string,
  caller: Caller,
  path: string,
  onEvent: (event: LiveEvent) => void,
  setClose: (close: () => void) => void,
): Promise<{ ended: Promise<void> } | "refused" | "failed"> {
  // A connection of its own, closed with the stream.
  const req: ClientRequest = request(new URL(path, baseUrl), { agent: false, headers: { accept: "text/event-stream", ...callerHeaders(caller) } });
  const close = () => void req.destroy();
  setClose(close);
  // A stream that doesn't get ready in time is given up, so the caller isn't held up waiting for it.
  const givingUp = setTimeout(close, READY_TIMEOUT_MS);
  try {
    const res = await new Promise<IncomingMessage>((resolve, reject) => req.on("response", resolve).on("error", reject).end());
    const status = res.statusCode ?? 0;
    if (status !== 200) {
      close();
      // 408 and 429 ask to be tried again later; every other client error would only be repeated.
      return status >= 400 && status < 500 && status !== 408 && status !== 429 ? "refused" : "failed";
    }
    const events = readEvents(res)[Symbol.asyncIterator]();
    const first = await events.next();
    if (first.done || first.value.event !== "ready") {
      close();
      return "failed";
    }
    const ended = (async () => {
      for (let e = await events.next(); !e.done; e = await events.next()) onEvent(e.value);
    })()
      .catch(() => {})
      .finally(close);
    return { ended };
  } catch {
    close();
    return "failed";
  } finally {
    clearTimeout(givingUp);
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
