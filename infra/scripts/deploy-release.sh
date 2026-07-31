#!/usr/bin/env bash
set -euo pipefail
artifact=""; checksum=""; release_id=""; root=""; apply=false; rollback=false
display_path() {
  case "$1" in
    /mnt/[a-zA-Z]/*)
      drive="${1:5:1}"
      rest="${1:7}"
      raw="${drive^^}:\\${rest//\//\\}"
      printf '%s' "${raw//\\/\\\\}"
      ;;
    /[a-zA-Z]/*)
      drive="${1:1:1}"
      rest="${1:3}"
      raw="${drive^^}:\\${rest//\//\\}"
      printf '%s' "${raw//\\/\\\\}"
      ;;
    *) printf '%s' "$1" ;;
  esac
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact) artifact="$2"; shift 2 ;;
    --sha256) checksum="$2"; shift 2 ;;
    --release-id) release_id="$2"; shift 2 ;;
    --root) root="$2"; shift 2 ;;
    --apply) apply=true; shift ;;
    --rollback) rollback=true; shift ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
done
[ "$rollback" = true ] || { [ -f "$artifact" ] && [[ "$checksum" =~ ^[a-f0-9]{64}$ ]] && [[ "$release_id" =~ ^[a-f0-9]{16,64}$ ]]; } || { echo "invalid release input" >&2; exit 64; }
[ -n "$root" ] || { echo "invalid release root" >&2; exit 64; }
if $rollback; then
  $apply || { printf '{"mode":"rollback-preview","root":"%s"}\n' "$(display_path "$root")"; exit 0; }
  [ -L "$root/previous" ] || { echo "previous release link is missing" >&2; exit 68; }
  rollback_tmp="$root/.blogbot-rollback-$$"
  ln -s -- "$(readlink "$root/previous")" "$rollback_tmp"
  mv -Tf -- "$rollback_tmp" "$root/current"
  printf '{"mode":"rolled-back","root":"%s"}\n' "$(display_path "$root")"
  exit 0
fi
actual="$(sha256sum "$artifact" | awk '{print $1}')"
[ "$actual" = "$checksum" ] || { echo "artifact checksum mismatch" >&2; exit 65; }
release_directory="$root/releases/$release_id"
if ! $apply; then
  printf '{"mode":"preview","releaseId":"%s","releaseDirectory":"%s","currentLink":"%s","previousLink":"%s","sha256":"%s"}\n' "$release_id" "$(display_path "$release_directory")" "$(display_path "$root/current")" "$(display_path "$root/previous")" "$checksum"
  exit 0
fi
[ ! -e "$release_directory" ] || { echo "release already exists" >&2; exit 66; }
mkdir -p "$root/releases"

# Validate the archive before extraction.  In particular, reject absolute,
# traversal, symlink, and hard-link entries so an attacker cannot escape the
# release directory during tar extraction.
while IFS= read -r entry; do
  case "$entry" in
    ""|/*|../*|*/../*|*/..|*\\*)
      echo "unsafe archive entry: $entry" >&2
      exit 67
      ;;
  esac
done < <(tar -tzf "$artifact")
if tar -tvzf "$artifact" | awk 'substr($1, 1, 1) ~ /^[lhcbpf]$/ { found=1 } END { exit found ? 1 : 0 }'; then
  :
else
  echo "archive links are not allowed" >&2
  exit 67
fi

staging_directory="$root/.blogbot-release-$release_id-$$"
cleanup() { rm -rf -- "$staging_directory"; }
trap cleanup EXIT INT TERM
mkdir -p "$staging_directory"
tar -xzf "$artifact" --no-same-owner --no-same-permissions -C "$staging_directory"
mv -- "$staging_directory" "$release_directory"

# Keep the previous release and switch current with a same-filesystem rename.
if [ -L "$root/current" ]; then
  previous_target="$(readlink "$root/current")"
  previous_tmp="$root/.blogbot-previous-$release_id-$$"
  ln -s -- "$previous_target" "$previous_tmp"
  mv -Tf -- "$previous_tmp" "$root/previous"
fi
current_tmp="$root/.blogbot-current-$release_id-$$"
ln -s -- "$release_directory" "$current_tmp"
mv -Tf -- "$current_tmp" "$root/current"
printf '{"mode":"applied","releaseId":"%s","sha256":"%s"}\n' "$release_id" "$checksum"
