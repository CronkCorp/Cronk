import type { FastifyReply } from "fastify";

/** One change pushed to watchers: an event name and its JSON data. */
export interface LiveEvent {
  /** The event's name, such as `activity`. */
  event: string;
  /** Its JSON data. */
  data: object;
}

type Listener = (event: LiveEvent) => void;

/** How often an open stream re-checks access and sends a comment, so proxies and browsers keep it open. */
const HEARTBEAT_MS = 25_000;

/**
 * Server-pushed live updates (ADR 0012): routes publish change events on a topic (such as a
 * Ticket), and the UI watches a topic over server-sent events (see `stream`).
 *
 * Events are passed in-process, so they reach the watchers connected to this server; Cronk
 * runs as one server process (ADR 0006, ADR 0008). Publish only once the change is committed.
 */
export class LiveUpdates {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly streams = new Set<() => void>();

  /** Tells everyone watching `topic` about `event`. */
  publish(topic: string, event: LiveEvent): void {
    for (const listener of this.listeners.get(topic) ?? []) listener(event);
  }

  /** Calls `listener` for every event published on `topic` until the returned function is called. */
  subscribe(topic: string, listener: Listener): () => void {
    const set = this.listeners.get(topic) ?? new Set();
    this.listeners.set(topic, set);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(topic);
    };
  }

  /**
   * Answers the request with a server-sent event stream of the events on `topic`. It opens
   * with a `ready` event once it is watching. Before each event, and on each heartbeat, it
   * calls `canSee`, which re-checks that the caller may still see the topic; the stream ends
   * once it says no (or throws), so a caller who loses access stops hearing about it. Check
   * access before calling this, so a caller who can't see the topic gets an ordinary error
   * answer instead.
   */
  stream(reply: FastifyReply, topic: string, canSee: () => Promise<boolean>): void {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const write = ({ event, data }: LiveEvent) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // Events are sent one at a time, in order, each after its access check.
    let queue = Promise.resolve();
    let open = true;
    const end = () => {
      if (!open) return;
      open = false;
      unsubscribe();
      clearInterval(heartbeat);
      this.streams.delete(end);
      res.end();
    };
    // Runs `send` after the access check, or ends the stream if the caller may no longer see the topic.
    const checked = (send: () => void) => {
      queue = queue.then(async () => {
        if (!open) return;
        const allowed = await canSee().catch(() => false);
        if (!open) return;
        if (allowed) send();
        else end();
      });
    };
    const unsubscribe = this.subscribe(topic, (event) => checked(() => write(event)));
    const heartbeat = setInterval(() => checked(() => res.write(": keep-alive\n\n")), HEARTBEAT_MS).unref();
    this.streams.add(end);
    res.on("close", end);
    write({ event: "ready", data: {} });
  }

  /** Ends every open stream, as when the server stops. */
  close(): void {
    for (const end of [...this.streams]) end();
  }
}
