# Site migration dry-run (read-only)

This document records the result of a local, read-only inspection of the site
folder selected during setup. It is not a migration and it does not authorize
Git, GitHub, hosting, or production writes.

## Detected profile

- Site format: Astro 7 project.
- Local source: the project folder selected in the user-facing setup flow.
- Local Git remote: detected from `.git/config` and shown only as a repository suggestion.
- Current content model: TypeScript editorial data under `lib/editorial-content`, not an Astro `src/content` collection.
- Current route model: dynamic `[section]/[slug]` pages plus an English route tree.
- Current metadata: JSON-LD is assembled in Astro page/layout code.
- Current feeds: Turkish/English RSS and news sitemap page modules are present.

## Consequence

The selected site is not yet eligible for an automatic content-collection
migration. A future migration adapter must first transform the existing
TypeScript article records into the adapter's declared collection/schema and
produce a complete dry-run file manifest. Until that dry-run is approved, the
publisher must keep the site target in `ATTENTION` and must not create a PR.

This is intentionally site-specific migration information. Blogbot's runtime
contract remains site-neutral; another user can select a different Astro or
adapter-supported site without seeing this profile.

## Required next gate

1. Generate a revision-free migration manifest from the selected site's current
   article records.
2. Validate every generated document, route, canonical, hreflang, JSON-LD,
   image, RSS, sitemap, and redirect entry.
3. Show the complete diff in Blogbot and require explicit migration approval.
4. Only then create a GitHub branch/PR through the separately authorized
   publisher connector.
