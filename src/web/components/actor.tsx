// Who did something: a User or an Agent, and the Agent Session an Agent acted in (docs/ui.md § Component conventions).

const ADJECTIVES = [
  "amber", "bold", "brave", "brisk", "calm", "clever", "cosy", "crisp", "curly", "dapper", "deft", "eager", "early", "fair", "fancy", "fleet",
  "fond", "frank", "fresh", "gentle", "giddy", "glad", "golden", "grand", "happy", "hardy", "hazel", "honest", "humble", "jolly", "keen", "kind",
  "lively", "lucky", "merry", "mellow", "mighty", "misty", "modest", "noble", "nimble", "olive", "patient", "plucky", "polite", "proud", "quick", "quiet",
  "rapid", "ready", "rosy", "rustic", "sandy", "sharp", "shiny", "silent", "silver", "sleek", "smart", "snowy", "sober", "spry", "steady", "sunny",
  "swift", "tidy", "tranquil", "trusty", "upbeat", "vivid", "warm", "wary", "wise", "witty", "young", "zesty", "agile", "bright", "cheery", "dusky",
];
const ANIMALS = [
  "badger", "bat", "bear", "beaver", "bison", "crane", "crow", "deer", "dingo", "dove", "eagle", "eel", "elk", "falcon", "ferret", "finch",
  "fox", "gecko", "goat", "goose", "hare", "hawk", "heron", "ibex", "ibis", "jackal", "jay", "koala", "lark", "lemur", "lion", "llama",
  "lynx", "magpie", "marten", "mink", "mole", "moose", "moth", "newt", "otter", "owl", "panda", "parrot", "pelican", "pike", "puffin", "quail",
  "rabbit", "raven", "robin", "salmon", "seal", "shrew", "skunk", "sparrow", "stoat", "swan", "tapir", "tern", "tiger", "toad", "trout", "turtle",
  "vole", "walrus", "weasel", "whale", "wolf", "wombat", "wren", "yak", "zebra", "orca", "osprey", "plover", "kestrel", "marmot", "bobcat", "gull",
];

/** FNV-1a: a stable 32-bit hash of the id, so the same Agent Session gets the same name everywhere. */
function hash(text: string, seed: number): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** How the UI names an Agent Session: a readable word pair derived from its id, such as "brisk-otter". */
export const sessionName = (id: string) => `${ADJECTIVES[hash(id, 0) % ADJECTIVES.length]}-${ANIMALS[hash(id, 1) % ANIMALS.length]}`;

/** An Agent Session's readable name in the mono face, with its full id in the tooltip. */
export function SessionName(props: { id: string }) {
  return (
    <span className="session-name" title={props.id}>
      {sessionName(props.id)}
    </span>
  );
}

/** Anyone who can act: a User, or an Agent with the Owner it acts for and the Agent Session it acted in, where known. */
export type ActorLike =
  | { kind: "user"; name: string }
  | { kind: "agent"; name: string; owner?: { name: string }; session?: { id: string } | null };

/** A User, by name, made into an Actor. */
export const userActor = (name: string): ActorLike => ({ kind: "user", name });

/** An Agent as Activities, Reports and Claims carry it, made into an Actor. */
export const agentActor = (agent: { name: string; owner?: { name: string } }, session?: { id: string } | null): ActorLike => ({
  kind: "agent",
  name: agent.name,
  ...(agent.owner ? { owner: agent.owner } : {}),
  session: session ?? null,
});

/**
 * An avatar and a name. A User is round and neutral; an Agent is square and violet, followed by its
 * Agent Session and "for <Owner>". Pass `owner={false}` where the Owner is obvious.
 */
export function Actor(props: { actor: ActorLike; owner?: boolean }) {
  const { actor } = props;
  return (
    <span className={`actor ${actor.kind}`}>
      <Avatar actor={actor} />
      <span className="actor-name">{actor.name}</span>
      {actor.kind === "agent" && actor.session && (
        <>
          {" "}
          <SessionName id={actor.session.id} />
        </>
      )}
      {actor.kind === "agent" && actor.owner && props.owner !== false && <span className="muted"> for {actor.owner.name}</span>}
    </span>
  );
}

/** Just an Actor's avatar: round for a User, square and violet for an Agent. Pass `large` for a card's head. */
export function Avatar(props: { actor: Pick<ActorLike, "kind" | "name">; large?: boolean }) {
  const initial = props.actor.name.trim().charAt(0).toUpperCase();
  return <span className={`avatar ${props.actor.kind}${props.large ? " large" : ""}`} data-initial={initial} aria-hidden="true" />;
}
