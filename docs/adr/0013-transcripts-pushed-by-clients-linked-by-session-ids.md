# Transcripts are pushed by clients and linked by scanning for Agent Session ids

Cronk only sees an Agent's tool calls, never the chat that led to them, and it never runs agents (ADR 0005). So a Transcript reaches Cronk only when something on the client side, such as a Claude Code hook, uploads it with the Agent's token, as Markdown following a documented turn convention. Cronk does not parse client formats like Claude Code's `.jsonl`; a reference hook in the repository converts them. To link a Transcript to what it led to, Cronk scans its text for the ids of the uploading Agent's own Agent Sessions, which every welcome and tool result already carries, and links those Sessions and so everything they changed. Uploads whose linked Sessions changed nothing are refused. The same scan finds the turn where each changed item's key or id first appears, so items link to that turn. This keeps the upload a single call that works for any client able to export its chat, with no ids for the client to track. The alternatives were to have the uploader declare the Sessions or items, which pushes bookkeeping onto every client integration, or to have Cronk parse each client's format, which ties Cronk to formats that change often.

## Consequences

- Agent Session ids must keep appearing in the welcome and in every MCP tool result, errors included, or linking breaks.
- The client's conversion to Markdown must be deterministic. Re-uploads are matched by (Agent, client chat id) and replace the stored text only when the new text continues it; otherwise the old text is kept as well.
- Clients that cannot export a chat, such as claude.ai, produce no Transcripts.
- Known secret patterns are scrubbed on upload, and the originals are never stored. This is best-effort.
- A Transcript's Owner may redact passages by hand. Cronk keeps only each passage's length and digests, never the passage, and finds it again in every later upload, so redactions survive re-uploads and travel in exports. A passage spanning the end of an earlier upload can make the next one look like a rewrite.
