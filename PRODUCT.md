# Blogbot Product Register

This register defines the approved V1 product target. It is not an assertion
that every target capability is already wired through the packaged desktop.
The live implementation boundary is tracked in `README.md` and
`docs/architecture/system.md`.

## Product

Blogbot is a private, local-first Windows editorial workstation for a site
chosen by the user. One editor uses it to discover stories from URL, RSS, Atom, sitemap
and OPML sources; create one-off briefs; review Turkish and English content
with its evidence package; approve immutable revisions; and supervise
publishing.

At the completed V1 boundary, the bundled local engine owns scanning, drafting,
scheduling, revision state and the publication outbox while the Windows
application is running. There is
no remote Blogbot control plane. A selected project's public artifact may be
sent through its own GitHub/hosting workflow, but that is optional and
configured per project. Blogbot has no built-in provider, domain, repository,
or public site.

## Users

- Primary user: the owner-editor of a selected content site or local project on one Windows 10/11 x64 device.
- Future user: another trusted editor using a separately provisioned device.
- Daily editorial work must not require a terminal, a browser admin panel or
  knowledge of a particular hosting provider.

## Jobs to be done

- Understand what needs attention today within seconds.
- Add, test, import, organize, pause and search a large source catalog.
- Create a draft immediately from selected sources, direct URLs, intent,
  section, article type and urgency.
- Route discovered candidates into research or dismiss them with duplicate and
  source evidence visible.
- Compare Turkish and English versions; verify claims, sources, visuals, SEO,
  safety gates, schedule and generated file diff before approval.
- Manage weekly slots, scheduled work, history, failures, retries, Codex
  capacity, connector readiness and preferences.
- Diagnose missing prerequisites through a reusable Doctor surface without
  blocking access to the rest of the application.

## Personality

Calm, credible, editorial, direct and operationally transparent. Blogbot should
feel like a well-made Windows newsroom tool rather than a generic SaaS dashboard
or an AI toy.

## Product invariants

- Human approval is mandatory for every publishable revision.
- Missing or unexecuted checks never count as passed.
- Any approved package change invalidates approval.
- Offline work may view and edit local content, but source fetch, Codex,
  GitHub, Search Console and publication actions fail closed.
- Scanning, drafting and scheduled execution require the local engine and
  therefore the Windows computer and user session to be running.
- The application never exposes a public or private remote Blogbot API.
- Live GitHub, hosting, credential, install, DNS and deployment changes remain
  separately approval-gated.
- External source content is untrusted data, never executable instruction.
- Paid API fallback is disabled until explicitly enabled by the user.

## Visual and interaction direction

- Dense but calm desktop workspace optimized for a 1366px-or-wider Windows
  display, while remaining usable at 960×680.
- Persistent local-engine and connector readiness plus a prominent next
  editorial action.
- Five stable primary work areas: General Overview, Content Flow, Editorial
  Desk, Calendar & Publishing, and Operations.
- Setup and Settings are secondary destinations and remain reachable.
- Native Segoe UI typography, restrained color, no decorative gradients, glass
  effects, excessive rounded cards or playful AI visuals.
- Complete keyboard navigation, visible focus, readable status labels,
  reduced-motion support, live-region feedback and color-independent state
  communication.

## Anti-references

- Generic admin templates with a dozen equal-weight sidebar destinations.
- Blocking first-run onboarding that prevents opening the product.
- Empty dashboards that present placeholder success.
- Neon, glassmorphism, decorative gradients, floating blobs and oversized
  marketing typography.
- Technical worker terminology as the primary information architecture.
