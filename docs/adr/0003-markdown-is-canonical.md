# Markdown is the canonical format; all data is exportable

Documents are stored as Markdown, with a small set of defined extensions for embeds (Ticket references, Artifacts, glossary terms, media), rather than as a block-structured JSON model like Notion or Confluence. Agents read and write exactly what is stored with no lossy conversion, diffs and Versions stay readable, and users are never locked in: everything they put into Cronk must be exportable in open formats. The cost is that layouts richer than Markdown plus our extensions are not possible.
