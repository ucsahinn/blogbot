# Local backup helpers

Blogbot is a local Windows desktop application. This folder contains only
offline backup and restore helpers; it has no hosting, deployment, or remote
publication authority.

- `backup/backup-plan.example.json` defines the artifacts to stage. Run
  `scripts/backup.ps1` only against that offline staging directory.
  `scripts/restore.ps1` verifies the expected SHA-256 and defaults to preview;
  `-Apply` refuses to overwrite a non-empty target.

The templates intentionally perform no install, credential creation, network
call, publication, or deployment. Any configured external publisher remains a
separate approval-gated operation.
