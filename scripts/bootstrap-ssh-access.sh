#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"

usage() {
  printf 'Usage:\n'
  printf '  bash %q [--port PORT] user@host\n' "$SCRIPT_PATH"
  printf '  bash %q --check [--port PORT] user@host\n' "$SCRIPT_PATH"
  cat <<'EOF'

Run the first form in a real local Terminal. SSH asks for the current server
password itself and does not expose it to Claude or the command history.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

MODE=install
PORT=22
TARGET=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      MODE=check
      ;;
    --port)
      shift
      [ "$#" -gt 0 ] || die "--port needs a value"
      PORT="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      [ -z "$TARGET" ] || die "provide exactly one user@host target"
      TARGET="$1"
      ;;
  esac
  shift
done

[ -n "$TARGET" ] || { usage >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]+$ ]] || die "port must be a number"
(( PORT >= 1 && PORT <= 65535 )) || die "port must be between 1 and 65535"
[[ "$TARGET" =~ ^[A-Za-z_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$ ]] \
  || die "target must look like root@203.0.113.10"

HOST="${TARGET#*@}"
SLUG="$(printf '%s-%s-%s' "${TARGET%@*}" "$HOST" "$PORT" | tr -c 'A-Za-z0-9._-' '-')"
SSH_DIR="${HOME:?HOME is not set}/.ssh"
KEY_FILE="${CLAUDE_PREMIUM_SSH_KEY:-$SSH_DIR/claude-premium-$SLUG}"

command -v ssh >/dev/null || die "OpenSSH client is not installed"
command -v ssh-keygen >/dev/null || die "ssh-keygen is not installed"

install -d -m 700 "$SSH_DIR"

if [ ! -f "$KEY_FILE" ]; then
  if [ -e "$KEY_FILE.pub" ]; then
    mv "$KEY_FILE.pub" "$KEY_FILE.pub.orphan.$(date +%s)"
  fi
  ssh-keygen -q -t ed25519 -N "" \
    -C "claude-premium-deploy@$HOST" -f "$KEY_FILE"
fi

if [ ! -f "$KEY_FILE.pub" ]; then
  ssh-keygen -y -f "$KEY_FILE" > "$KEY_FILE.pub"
  chmod 600 "$KEY_FILE.pub"
fi

SSH_ARGS=(
  -i "$KEY_FILE"
  -p "$PORT"
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=10
)

check_access() {
  ssh "${SSH_ARGS[@]}" -o BatchMode=yes "$TARGET" \
    'printf "SSH_KEY_READY\\n"' 2>/dev/null
}

print_ready() {
  printf '\nREADY: key-only SSH works.\n'
  printf 'Target: %s\n' "$TARGET"
  printf 'Identity file: %s\n' "$KEY_FILE"
  printf 'SSH command: ssh -i %q -p %q %q\n' "$KEY_FILE" "$PORT" "$TARGET"
}

if check_access; then
  print_ready
  exit 0
fi

if [ "$MODE" = check ]; then
  die "key-only SSH is not ready; run this script without --check in a local Terminal"
fi

[ -t 0 ] || die "run this command in a real local Terminal so you can type the server password privately"

printf 'One private password prompt follows. Type the VPS root password there; input is hidden.\n'

if command -v ssh-copy-id >/dev/null; then
  ssh-copy-id -i "$KEY_FILE.pub" -p "$PORT" \
    -o StrictHostKeyChecking=accept-new "$TARGET"
else
  ssh "${SSH_ARGS[@]}" "$TARGET" \
    'umask 077; mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; chmod 700 "$HOME/.ssh"; chmod 600 "$HOME/.ssh/authorized_keys"; IFS= read -r key; grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf "%s\\n" "$key" >> "$HOME/.ssh/authorized_keys"' \
    < "$KEY_FILE.pub"
fi

check_access || die "the key was not accepted; confirm the server address and password, then retry"
print_ready
