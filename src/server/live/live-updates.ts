import type { FastifyReply } from "fastify";

/** One change pushed to watchers: an event name and its JSON data. */
export interface LiveEvent {
  /** The event's name, such as `activity`. */
  event: string;
  /** Its JSON data. */
  data: object;
  /** Its id, if it has one: where a stream reopened from it (with `Last-Event-ID`) picks up. */
  id?: string;
}

/** What a stream reopened from an event's id missed, and the id its `ready` carries, to reopen from if nothing else arrives. */
export interface CatchUp {
  /** The events the stream missed, in the order to send them. */
  missed: LiveEvent[];
  /** The id `ready` carries: where the stream stands once it has sent them. */
  readyId: string;
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
   *
   * With `catchUp`, the stream first sends the events it answers as missed, then the events
   * published while it ran, each behind the same access check, and then a `ready`. It is called
   * once the stream is watching, so nothing published meanwhile is lost; an event with the id
   * of one already sent isn't sent again. The stream ends if it fails. Ids on such a stream are
   * positions, decimal integers: `ready` carries the furthest of the id `catchUp` answers and
   * every id sent, so every event published before `ready` is sent before it, and a stream
   * reopened from `ready`'s id misses nothing published later that has a further position.
   */
  stream(reply: FastifyReply, topic: string, canSee: () => Promise<boolean>, catchUp?: () => Promise<CatchUp>): void {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const write = ({ event, data, id }: LiveEvent) => res.write(`event: ${event}\n${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`);

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
    // Whether the stream is still open and the caller may still see the topic; it may have closed during the check.
    const allowed = async () => open && (await canSee().catch(() => false)) && open;
    // Runs `send` after the access check, or ends the stream if the caller may no longer see the topic.
    const checked = (send: () => void) => {
      queue = queue.then(async () => {
        if (!open) return;
        if (await allowed()) send();
        else end();
      });
    };
    // Ids already sent, so an event both replayed and published is sent once.
    const sent = new Set<string>();
    const fresh = (event: LiveEvent) => event.id === undefined || !sent.has(event.id);
    // While catching up, live events wait here instead, to be sent before `ready`.
    let held: LiveEvent[] | null = catchUp ? [] : null;
    const unsubscribe = this.subscribe(topic, (event) => (held ? held.push(event) : checked(() => fresh(event) && write(event))));
    const heartbeat = setInterval(() => checked(() => res.write(": keep-alive\n\n")), HEARTBEAT_MS).unref();
    this.streams.add(end);
    res.on("close", end);
    if (!catchUp) {
      write({ event: "ready", data: {} });
      return;
    }
    queue = (async () => {
      try {
        const { missed, readyId } = await catchUp();
        let furthest = BigInt(readyId);
        // Sends `event` unless it was sent already; false once the stream has ended.
        const send = async (event: LiveEvent) => {
          if (!fresh(event)) return true;
          if (!(await allowed())) return false;
          if (event.id !== undefined) {
            sent.add(event.id);
            if (BigInt(event.id) > furthest) furthest = BigInt(event.id);
          }
          write(event);
          return true;
        };
        for (const event of missed) if (!(await send(event))) return end();
        // Then what was published meanwhile, including while these are being sent.
        for (let event = held!.shift(); event; event = held!.shift()) if (!(await send(event))) return end();
        held = null;
        if (open) write({ event: "ready", id: String(furthest), data: {} });
      } catch {
        end();
      }
    })();
  }

  /** Ends every open stream, as when the server stops. */
  close(): void {
    for (const end of [...this.streams]) end();
  }
}
