# Git host tokens are encrypted with a key from the server environment

Cronk stores only a hash of the secrets it checks (Agent tokens, sign-in cookies, Invitations), but it must use a Repository's Git host token and webhook secret, so it has to keep them in a form it can read back. They are encrypted at rest with a key set once in the server environment (`CRONK_SECRET_KEY`), so a leaked database dump or backup alone doesn't hand out access to the Workspace's code. The alternatives were plain text guarded only by database access, which makes every backup a credential store, or an external secret manager, which Cronk must never require (ADR 0006).

## Consequences

- The key must be set before a Repository can be listed, and kept: losing or changing it means re-entering every Repository's token and secret. Setup docs say so, and exports never carry these secrets.
- Rotating the key needs a server command that re-encrypts the stored secrets.
- Later secrets Cronk must use, such as SMTP credentials stored in the database or OIDC client secrets, follow the same rule.
