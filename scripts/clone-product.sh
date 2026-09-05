#!/usr/bin/env bash
# Clone the private product repository without exposing its token.
set -euo pipefail

REPOSITORY=https://github.com/kgnvsk/claude-tg-starter.git
TARGET=/opt/claude-tg-starter
TOKEN_FILE=
MIGRATE_FROM_PREMIUM=0
PREMIUM_REPOSITORY=https://github.com/kgnvsk/claude-premium.git

usage() {
  cat <<'EOF'
Usage: clone-product.sh --token-file FILE [--target DIRECTORY] [--migrate-from-premium]

FILE must be a root-owned regular file with mode 600. It is deleted as soon as
the token is moved into the root-only Git credential store.

--migrate-from-premium replaces a clean, root-owned Premium checkout at TARGET
with this repository and preserves the old checkout as TARGET.premium-backup.*
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --token-file) TOKEN_FILE="${2:-}"; shift 2 ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    --migrate-from-premium) MIGRATE_FROM_PREMIUM=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "FATAL: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "FATAL: run as root" >&2; exit 1; }
[ -n "$TOKEN_FILE" ] || { echo "FATAL: --token-file is required" >&2; exit 2; }
[ -f "$TOKEN_FILE" ] && [ ! -L "$TOKEN_FILE" ] || {
  echo "FATAL: token file must be a regular non-symlink file" >&2
  exit 2
}
[ "$(stat -c %u "$TOKEN_FILE")" -eq 0 ] && [ "$(stat -c %a "$TOKEN_FILE")" = 600 ] || {
  echo "FATAL: token file must be owned by root with mode 600" >&2
  exit 2
}
[ "$(stat -c %h "$TOKEN_FILE")" -eq 1 ] || {
  echo "FATAL: token file must have exactly one hard link" >&2
  exit 2
}

validate_premium_checkout() {
  local foreign_owner origin status
  [ -d "$TARGET" ] && [ ! -L "$TARGET" ] || {
    echo "FATAL: Premium migration target must be a directory: $TARGET" >&2
    return 1
  }
  [ "$(stat -c %U "$TARGET")" = root ] || {
    echo "FATAL: Premium migration target is not owned by root: $TARGET" >&2
    return 1
  }
  foreign_owner="$(find "$TARGET" -xdev ! -user root -print -quit)"
  [ -z "$foreign_owner" ] || {
    echo "FATAL: Premium checkout contains a non-root path: $foreign_owner" >&2
    return 1
  }
  git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
    echo "FATAL: Premium migration target is not a git checkout" >&2
    return 1
  }
  origin="$(git -C "$TARGET" remote get-url origin 2>/dev/null || true)"
  case "$origin" in
    "$PREMIUM_REPOSITORY"|git@github.com:kgnvsk/claude-premium.git|ssh://git@github.com/kgnvsk/claude-premium.git) ;;
    *) echo "FATAL: migration source is not the Premium repository: ${origin:-missing}" >&2; return 1 ;;
  esac
  status="$(git -C "$TARGET" status --porcelain --untracked-files=all)"
  [ -z "$status" ] || {
    echo "FATAL: Premium checkout has local changes; migration stopped" >&2
    return 1
  }
}

if [ "$MIGRATE_FROM_PREMIUM" -eq 1 ]; then
  [ -e "$TARGET" ] || {
    echo "FATAL: Premium migration target does not exist: $TARGET" >&2
    exit 2
  }
  validate_premium_checkout
else
  [ ! -e "$TARGET" ] || {
    echo "FATAL: target already exists: $TARGET" >&2
    exit 2
  }
fi

trap 'rm -f -- "$TOKEN_FILE"' EXIT
token="$(cat -- "$TOKEN_FILE")"
rm -f -- "$TOKEN_FILE"
trap - EXIT
[[ "$token" =~ ^[A-Za-z0-9_]+$ ]] || {
  echo "FATAL: token format is not recognized" >&2
  exit 2
}

credential_dir=/root/.config/claude-product
credential_file="$credential_dir/git-credentials"
install -d -m 700 "$credential_dir"
old_umask="$(umask)"
umask 077
temporary="$(mktemp "$credential_dir/git-credentials.XXXXXX")"
trap 'rm -f -- "$temporary"' EXIT
printf 'https://x-access-token:%s@github.com\n' "$token" > "$temporary"
unset token
chmod 600 "$temporary"
mv -f -- "$temporary" "$credential_file"
trap - EXIT

umask "$old_umask"
clone_target="$TARGET"
backup=
if [ "$MIGRATE_FROM_PREMIUM" -eq 1 ]; then
  target_parent="$(dirname "$TARGET")"
  target_name="$(basename "$TARGET")"
  clone_target="$(mktemp -d "$target_parent/.${target_name}.product.XXXXXX")"
  rmdir "$clone_target"
  trap 'rm -rf -- "$clone_target"' EXIT
fi

git -c "credential.helper=store --file=$credential_file" clone "$REPOSITORY" "$clone_target"
git -C "$clone_target" config --local credential.helper "store --file=$credential_file"
chown -R root:root "$clone_target"
# Root owns executable install code, while the unprivileged agent may read it.
chmod -R a+rX "$clone_target"
chmod -R go-w "$clone_target"
chmod +x "$clone_target/update.sh"

if [ "$MIGRATE_FROM_PREMIUM" -eq 1 ]; then
  backup="$TARGET.premium-backup.$(date -u +%Y%m%dT%H%M%SZ)"
  [ ! -e "$backup" ] || {
    echo "FATAL: migration backup already exists: $backup" >&2
    exit 1
  }
  mv -- "$TARGET" "$backup"
  if ! mv -- "$clone_target" "$TARGET"; then
    mv -- "$backup" "$TARGET"
    echo "FATAL: product checkout activation failed; Premium restored" >&2
    exit 1
  fi
  clone_target="$TARGET"
  trap - EXIT
  echo "Premium checkout preserved at: $backup"
fi

chown -R root:root "$TARGET"
chmod -R a+rX "$TARGET"
chmod -R go-w "$TARGET"
chmod +x "$TARGET/update.sh"

echo "Product kit cloned: $(git -C "$TARGET" rev-parse --short HEAD)"
