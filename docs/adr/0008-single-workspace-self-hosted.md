# One self-hosted installation serves one Workspace

Cronk is self-hosted, and each installation serves exactly one Workspace: one organization with many Projects, a handful of Users and any number of Agents. We chose this over a multi-organization instance or a hosted service so that effort goes into how humans and Agents work together rather than tenancy, billing and isolation. Data is still scoped to the Workspace throughout, so supporting several Workspaces per installation later is an extension, not a rewrite.

## Considered Options

- **Several Workspaces per installation**: deferred; the data model keeps the door open.
- **Hosted service (SaaS) from the start**: rejected; billing and tenancy would dominate the early work.
