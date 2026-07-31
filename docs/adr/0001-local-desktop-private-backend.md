# SUPERSEDED HISTORICAL ADR

The remote backend/WireGuard design below is retained only for decision
history. It is not an active setup requirement. The current product is local
only; see ADR 0004 and `architecture/site-neutral-product.md`.

# ADR 0001: Local Windows client and private backend

- Status: Superseded by ADR 0004
- Date: 2026-07-29

## Decision

Blogbot consists of a Tauri 2 + React Windows application and a continuously running private Hetzner backend. The desktop frontend does not call the network directly. Rust commands expose a narrow, typed API over a WireGuard-only, mutually authenticated connection.

There is no public Blogbot administration panel. The public Caddy serving SiberDergi and the private API listener use separate listeners and networks.

## Consequences

- Closing the desktop application does not stop source ingestion or server jobs.
- New approvals and configuration changes require the paired Windows device to be online.
- Offline cache is encrypted and strictly read-only.
- Installation, pairing, firewall, credentials, GitHub, DNS, deployment, and release remain explicit operational gates.

## Historical note

This topology is retained only to explain the original design. ADR 0004 moved
the engine, scheduler, data and workers to the Windows application. WireGuard,
the private API and the remote database are not V1 runtime prerequisites.
# SUPERSEDED

This historical ADR describes the retired remote-backend/WireGuard design. The
current product is local-only; see `0004-local-first-runtime.md` and
`architecture/site-neutral-product.md` for the active decision.
