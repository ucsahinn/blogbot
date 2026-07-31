# SiberDergi public hosting infrastructure

Blogbot has no server runtime. These files only describe the optional public
static hosting edge for SiberDergi and are not deployment authority. They
contain no credentials and are not connected to a production host.

- `compose/public.compose.yml` runs only the public Caddy edge. Copy
  `.env.example` outside the repository and replace the image placeholder with
  a digest-pinned, reviewed Caddy image.
- `caddy/public.Caddyfile` serves only the current static SiberDergi release.
- `scripts/deploy-release.sh` verifies and stages a hash-addressed static
  release, then changes the `current` symlink atomically.
- `backup/backup-plan.example.json` defines the artifacts to stage. Run
  `scripts/backup.ps1` only against that offline staging directory.
  `scripts/restore.ps1` verifies the expected SHA-256 and defaults to preview;
  `-Apply` refuses to overwrite a non-empty target.

The templates intentionally perform no install, credential creation, network
call, publication, or deployment. GitHub and Hetzner changes remain separate
approval-gated operations.
