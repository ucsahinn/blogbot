# ADR 0008: Repository-bound GitHub App device flow

- Status: Accepted; external GitHub App registration and live acceptance blocked
- Date: 2026-09-03
- Supersedes: the classic OAuth App `repo`-scope authentication path

## Context

The desktop publication broker used GitHub's device authorization endpoints but
requested the classic OAuth `repo` scope. That scope can cover repositories
unrelated to the selected publication target. A single DPAPI-protected bearer
token also had no expiry or refresh contract, and the local readiness state did
not prove that the credential was still bound to the connector's current
repository.

Blogbot is a local Windows desktop application. It must not ship a GitHub App
private key or client secret, expose credentials to the renderer, or add a
remote Blogbot broker. Publication still requires a separately approved,
immutable revision and explicit human action.

GitHub's GitHub App device flow supports a public client ID without a client
secret. The resulting user access token is constrained by the intersection of
the app installation, app permissions and the authorizing user's access.
GitHub also permits a refresh request without a client secret when the user
access token originated from device flow.

## Decision

- Replace the classic OAuth App contract with a GitHub App user access token
  obtained through the device flow.
- The renderer accepts and transmits only the public GitHub App client ID,
  owner and repository name. It never accepts or receives an access token,
  refresh token, client secret, private key or device code.
- Device authorization requests contain no classic OAuth scope. Token responses
  must be bearer grants with an empty scope plus access-token and refresh-token
  expiry fields. Non-expiring or classic-scope grants are rejected.
- The GitHub App must be installed with repository selection set to
  `selected`, on exactly one repository, and that repository must exactly
  match the configured `owner/repository`.
- The installation permission map must exactly equal:
  - Actions: write
  - Administration: read
  - Checks: read
  - Contents: write
  - Metadata: read
  - Pull requests: write
- Extra permissions, missing permissions, multiple selected repositories or a
  different repository fail closed.
- Rust validates the target repository, installation, selected repository list
  and exact permission map before marking authorization ready.
- The versioned credential bundle stores the public client ID, normalized
  repository, access token, refresh token and both absolute expiries. The whole
  bundle is protected with Windows DPAPI and atomically replaced on disk.
- Legacy single-token records are not reinterpreted. They require a new device
  authorization.
- Before token use, the broker serializes credential access. A token near expiry
  is refreshed with the public client ID and refresh token, the repository and
  permissions are revalidated, and the rotated bundle is atomically persisted.
- An expired refresh token, terminal refresh error, revocation response or
  failed repository/permission revalidation latches
  `GITHUB_REAUTHORIZATION_REQUIRED` and blocks publication.
- UI and prerequisite projections report readiness only for the connector's
  current repository. Changing the target invalidates apparent readiness even
  if another valid credential remains in DPAPI storage.
- GitHub-side App registration, installation, branch protection and live
  publication are external changes and remain separately approval-gated.

## Rejected alternatives

### Keep the classic OAuth App `repo` scope

Rejected because it cannot express Blogbot's single selected-repository
boundary and unnecessarily increases the effect of a stolen token.

### Use an installation access token

Rejected for the desktop because minting installation tokens requires the app
to authenticate as itself with a private key and JWT. Shipping that private key
would collapse the trust boundary.

### Use a personal access token

Rejected because it would ask the user to create and paste a credential into
the desktop and would make rotation, installation identity and least-privilege
validation less reliable.

### Add a remote Blogbot credential broker

Rejected because it conflicts with the local-only product invariant and would
introduce a new remote control plane and credential custodian.

## Consequences

- A copied credential remains sensitive, but GitHub limits it to the installed
  app, selected repository, exact app permissions and the authorizing user's
  own access.
- Token rotation is automatic while the refresh token remains valid. Rotation
  failure cannot silently fall back to a stale or classic token.
- DPAPI protects credentials at rest for the current Windows profile; it is not
  a defense against malware already running as that user.
- Repository or permission policy changes require reauthorization and
  revalidation.
- The exact permission list is intentionally strict. Adding a new GitHub
  endpoint requires a reviewed permission change, tests and an ADR update.
- Local tests cannot prove GitHub account configuration, organization policy,
  SAML behavior, revocation timing, required checks or publication effects.

## Verification

Repository-controlled verification covers:

- request bodies omit classic scopes and reject classic or non-expiring grants;
- exact one-repository installation and exact permission matching;
- DPAPI-protected credential bundle round-trip and rejection of the legacy
  single-token record;
- access-token refresh, rotated persistence and repository/permission
  revalidation;
- refresh expiry and terminal authorization failures latching reauthorization;
- repository-bound publication readiness in Rust, TypeScript and the desktop
  UI contract;
- dry-run plans naming GitHub App permission validation without performing a
  GitHub write.

External acceptance still requires an approved owner to register the GitHub
App, enable device flow and expiring user access tokens, install it only on an
approved test repository, then exercise authorization, refresh, revocation,
required checks and the immutable-revision publication flow. None of those
GitHub-side actions are authorized by this ADR.

## References

- [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [Reviewing and modifying installed GitHub Apps](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps)
- [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [OAuth App scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
