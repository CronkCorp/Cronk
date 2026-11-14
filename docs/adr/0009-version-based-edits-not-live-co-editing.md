# Edits name their base Version; no real-time co-editing

Every write to a Document (and every Artifact publish) names the Version it is based on and is refused if that Version is no longer current; the refusal returns the current Version. Agents edit section by section and simply retry; the editor shows Users the other edit and merges automatically when the edits touch different sections. We chose this over real-time collaborative editing (a CRDT such as Yjs) because a CRDT document would become the real source of truth with Markdown derived from it, contradicting ADR 0003, and over edit locks because a forgotten browser tab would block Agents for hours.

## Consequences

- Two Users editing the same section at once get a merge step rather than seeing each other type. Real-time co-editing between Users can be added later only if it keeps Markdown canonical.
