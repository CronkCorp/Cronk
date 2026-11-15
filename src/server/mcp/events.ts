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
/**
 * How long after a stream ends, or fails to open, it is first opened again; each further try doubles it, up to the
 * maximum, until a stream stays open for that maximum.
 */
const REOPEN_DELAY_MS = 250;
const MAX_REOPEN_DELAY_MS = 30_000;

/**
 * Follows one of the API's server-sent event streams over real HTTP as `caller`, calling
 * `onEvent` for each event but `ready`, until the returned function is called. Resolves once
 * the stream is first ready, or first fails to open.
 *
 * A stream the API ends, or that couldn't be opened, is opened again after a short delay,
 * backing off while it keeps failing. The API ends a stream when the caller loses access, but
 * also when it can't check that access (a database blip), so opening it again is what tells the
 * two apart: the API refusing it with a client error (a revoked token, an ended Agent Session)
 * stops it for good, calling `onRefused`. A stream is opened again from the furthest id of the events that had one
 * (`Last-Event-ID`), so the API can first send what was missed meanwhile, before its `ready`.
 */
export async function followEvents(
  baseUrl: string,
  caller: Caller,
  path: string,
  onEvent: (event: LiveEvent) => void,
  onRefused: () => void = () => {},
): Promise<() => void> {
  let stopped = false;
  let closeStream = () => {};
  let reopening: NodeJS.Timeout | undefined;
  const last: { id?: string } = {};
  const stop = () => {
    stopped = true;
    clearTimeout(reopening);
    closeStream();
  };

  let delay = REOPEN_DELAY_MS;
  // Opens the stream, and settles once it is open or has failed to; after either, it is opened again once it ends.
  const follow = async (): Promise<void> => {
    const opened = await openStream(baseUrl, caller, path, last, onEvent, (close) => (closeStream = close));
    if (stopped) return;
    if (opened === "refused") return onRefused();
    if (opened === "failed") return reopenLater();
    const openedAt = Date.now();
    void opened.ended.then(() => {
      // Only a stream that stayed open a while counts as recovered; one that keeps ending at once backs off too.
      if (Date.now() - openedAt >= MAX_REOPEN_DELAY_MS) delay = REOPEN_DELAY_MS;
      reopenLater();
    });
  };
  const reopenLater = () => {
    if (stopped) return;
    reopening = setTimeout(() => void follow(), delay).unref();
    delay = Math.min(delay * 2, MAX_REOPEN_DELAY_MS);
  };
  await follow();
  return stop;
}

/**
 * Opens the stream once from `last.id`, if there is one, keeping it at the furthest id of the
 * events that have one, and handing `setClose` a function that closes it as soon as there is one.
 * Answers how it went: open, with a promise that settles when the stream ends; refused by the
 * API with a client error, so opening it again would be refused too; or failed otherwise (the API
 * answered with a server error, couldn't be reached, or wasn't ready in time).
 */
async function openStream(
  baseUrl: string,
  caller: Caller,
  path: string,
  last: { id?: string },
  onEvent: (event: LiveEvent) => void,
  setClose: (close: () => void) => void,
): Promise<{ ended: Promise<void> } | "refused" | "failed"> {
  // A connection of its own, closed with the stream.
  const headers = { accept: "text/event-stream", ...callerHeaders(caller), ...(last.id !== undefined && { "last-event-id": last.id }) };
  const req: ClientRequest = request(new URL(path, baseUrl), { agent: false, headers });
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
    const receive = (event: LiveEvent) => {
      // Work can be pushed out of the order it started waiting in, so resume from the furthest id, not the latest.
      if (event.id !== undefined && (last.id === undefined || furthest(last.id, event.id) === event.id)) last.id = event.id;
      if (event.event !== "ready") onEvent(event);
    };
    // What was missed while the stream was down comes first, then `ready`.
    let next = await events.next();
    for (; !next.done && next.value.event !== "ready"; next = await events.next()) receive(next.value);
    if (next.done) {
      close();
      return "failed";
    }
    receive(next.value);
    const ended = (async () => {
      for (let next = await events.next(); !next.done; next = await events.next()) receive(next.value);
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

/** The further of two event ids: positions written in decimal, or otherwise `b`, the later one. */
function furthest(a: string, b: string): string {
  return /^\d+$/.test(a) && /^\d+$/.test(b) && BigInt(a) > BigInt(b) ? a : b;
}

/** The events of a server-sent event stream, as the API writes them: an `event` line, an optional `id` line, a JSON `data` line, a blank line. */
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
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("id:")) id = line.slice(3).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) yield { event, data: JSON.parse(data.join("\n")), ...(id !== undefined && { id }) };
    }
  }
}
