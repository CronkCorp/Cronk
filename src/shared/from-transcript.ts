/**
 * The kinds of item that list the Transcripts they came from ("From Transcript"), each with its collection under `/api`
 * and whether it is addressed there by its key or its id: `/api/{collection}/{key or id}/transcripts`. The server's
 * routes, the web client and the MCP transcripts tool all derive their lists of these kinds from here, so adding a
 * kind starts here; the type checker then asks for its entry in the server's LINKED route table. Not derived from
 * here: the `{kind}_id` column each kind needs in the RECORDS query of src/server/transcripts/transcripts.ts, and the
 * descriptions that name the kinds in prose. Plain data only: this ends up in the web bundle.
 */
export const LINKED_KINDS = {
  ticket: { collection: "tickets", by: "key" },
  document: { collection: "documents", by: "id" },
  term: { collection: "terms", by: "id" },
  decision: { collection: "decisions", by: "key" },
  artifact: { collection: "artifacts", by: "id" },
} as const satisfies Record<string, { collection: string; by: "key" | "id" }>;

/** A kind of item that lists the Transcripts it came from. */
export type LinkedKind = keyof typeof LINKED_KINDS;

/** The LinkedKinds, in LINKED_KINDS' order. */
export const LINKED_KIND_NAMES = Object.keys(LINKED_KINDS) as [LinkedKind, ...LinkedKind[]];

/** The collection under `/api` that items of a LinkedKind are listed in. */
export type LinkedCollection = (typeof LINKED_KINDS)[LinkedKind]["collection"];
