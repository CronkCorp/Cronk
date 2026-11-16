# Artifacts are served from a separate hostname

Artifacts contain arbitrary code written by Agents, which may be buggy or steered by hostile content the Agent read. Served on Cronk's own hostname, that code could act with the viewing User's session. Artifacts are therefore served from a second hostname (for example `artifacts.cronk.example`) and shown in sandboxed frames, so browser origin isolation keeps them away from Cronk's session; by default they may load scripts only from a short allow-list of CDNs. Installations that cannot add a second hostname may fall back to a strict sandbox on the same hostname, at reduced safety and functionality.

## Consequences

- Every installation needs an extra hostname and certificate; setup docs and the Compose file add it with Artifacts in Phase 2 (Phase 1 ships neither).
- A subdomain of Cronk's own domain is same-site with it, so cookies marked `SameSite=Lax` still reach it. Phase 2 settled this with an Origin check rather than a separate registrable domain: Cronk refuses signed-in writes whose `Origin` (or `Referer`) isn't its own, and marks the sign-in cookie `SameSite=Strict`, so a subdomain is enough.
