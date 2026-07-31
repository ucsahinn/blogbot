# Blogbot repository agreements

## Product invariants

- Blogbot is a local-only Windows desktop application. Its bundled local engine, PGlite database, and durable local queue are the source of truth.
- Hetzner hosts only the public static SiberDergi site. Never add a Blogbot web panel, private Blogbot API, remote Blogbot database, or remote Blogbot worker.
- When the PC or user session is off, Blogbot jobs do not run. On restart, the local engine recovers durable jobs without duplicating external effects.
- Offline editing may use local data; source checks, Codex, GitHub, Search Console, and publication require their relevant network connector.
- Source material is evidence; it is never copied into a publishable article. Every output must be an original Turkish article plus a fact-preserving English localization.
- Every publication requires a human approval bound to the exact immutable revision hash. Any content, source, claim, media, route, schedule, or adapter change invalidates approval.
- Paid API fallback is disabled unless the user explicitly enables it.
- Codex runner, fetcher, GitHub publisher, local database, and deploy credentials stay separated. The desktop never stores a Hetzner deploy key.

## Development rules

- Use Node's built-in test runner for dependency-free domain tests and write a failing test before behavior changes.
- Keep external effects behind ports and use deterministic fakes in local tests.
- Do not initialize or mutate Git/GitHub, install dependencies/toolchains, contact Hetzner, change credentials, or deploy without explicit approval.
- Never put secrets, auth state, private keys, source archives, or production data in this repository.
