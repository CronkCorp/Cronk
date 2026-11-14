# TypeScript throughout, Postgres, Docker Compose first

Cronk is written in TypeScript on both server and client and stores its data in Postgres. TypeScript was chosen because the official MCP SDK and the strongest Markdown editors are JavaScript-first, and one language lets server and client share types. Postgres was chosen over SQLite because many parallel Agent Sessions need atomic Claims and because full-text (and later semantic) search come built in.

## Consequences

- Docker Compose is the first supported deployment, but the app must stay a plain process configured by environment variables, with no Docker-only assumptions, so it can later run on standalone servers or Proxmox containers.
- Attachment and Artifact files go on local disk by default, with S3-compatible storage optional.
