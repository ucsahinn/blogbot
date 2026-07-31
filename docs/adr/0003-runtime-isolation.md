# ADR 0003: Runtime isolation

- Status: Superseded in topology by ADR 0004
- Date: 2026-07-29

## Decision

Fetcher, Codex runner, publisher, API/worker, PostgreSQL, and public site are separate privilege boundaries. `pg-boss` is a library and PostgreSQL schema owned by the worker, not an independent service.

The Codex runner receives only a schema-bound task payload and a minimal dedicated `CODEX_HOME`. It receives no MCP configuration, user memories, site repository, database connection, GitHub credential, deploy key, or publication command.

## Consequences

- Fetcher can reach approved public HTTP(S) targets but not private networks or internal services.
- Publisher can create content-only changes for one repository but cannot access Codex authentication or the database directly.
- Deployment credentials are not held by the publisher.
- Chef, Brain, Control, agents, skills, and MCPs remain development surfaces, not Blogbot's production control plane.

## Historical note

ADR 0004 supersedes the remote service topology described here. The
least-privilege intent remains active: local fetcher, Codex and publisher child
processes receive only their task-specific inputs and credentials. `apps/api`,
`apps/worker`, remote PostgreSQL and private infrastructure are not active V1
runtime boundaries.
