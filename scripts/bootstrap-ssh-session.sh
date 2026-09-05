#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"

usage() {
  printf 'Usage:\n'
  printf '  bash %q [--port PORT] user@host\n' "$SCRIPT_PATH"
  printf '  bash %q --password-stdin [--port PORT] user@host\n' "$SCRIPT_PATH"
  printf '  bash %q --password-file FILE [--port PORT] user@host\n' "$SCRIPT_PATH"
  printf '  bash %q --probe-fresh --password-file FILE [--port PORT] user@host\n' "$SCRIPT_PATH"
  printf '  bash %q --check [--port PORT] user@host\n' "$SCRIPT_PATH"
  printf '  bash %q --close [--port PORT] user@host\n' "$SCRIPT_PATH"
  cat <<'EOF'

Interactive mode lets OpenSSH ask for the password in a local Terminal.
Installer agents use --password-stdin when their command runner has a separate
stdin channel. Otherwise they create a mode-600 temporary file and use
--password-file; the helper consumes and removes it before invoking OpenSSH.
The password is excluded from process arguments, environment variables, and
command output. --probe-fresh proves a new authenticated TCP/SSH connection
without reusing the ControlMaster socket.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

MODE=open
PASSWORD_STDIN=0
PASSWORD_FILE=""
PORT=22
TARGET=""

# Parse everything before creating a directory or starting a process.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      [ "$MODE" = open ] || die "choose only one of --check or --close"
      MODE=check
      ;;
    --close)
      [ "$MODE" = open ] || die "choose only one operation mode"
      MODE=close
      ;;
    --probe-fresh)
      [ "$MODE" = open ] || die "choose only one operation mode"
      MODE=probe-fresh
      ;;
    --password-stdin)
      [ "$PASSWORD_STDIN" -eq 0 ] || die "provide --password-stdin only once"
      PASSWORD_STDIN=1
      ;;
    --password-file)
      shift
      [ "$#" -gt 0 ] || die "--password-file needs a path"
      [ -z "$PASSWORD_FILE" ] || die "provide --password-file only once"
      PASSWORD_FILE="$1"
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

if [ "$PASSWORD_STDIN" -eq 1 ] && [ -n "$PASSWORD_FILE" ]; then
  die "choose only one password source"
fi
if [ "$MODE" = check ] || [ "$MODE" = close ]; then
  [ "$PASSWORD_STDIN" -eq 0 ] && [ -z "$PASSWORD_FILE" ] \
    || die "password input is not valid with --$MODE"
fi
if [ "$MODE" = probe-fresh ] && [ "$PASSWORD_STDIN" -eq 0 ] && [ -z "$PASSWORD_FILE" ]; then
  die "--probe-fresh needs --password-stdin or --password-file"
fi
[ -n "$TARGET" ] || { usage >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]+$ ]] || die "port must be a number"
(( PORT >= 1 && PORT <= 65535 )) || die "port must be between 1 and 65535"
USER_PART="${TARGET%%@*}"
HOST_PART="${TARGET#*@}"
[[ "$USER_PART" =~ ^[A-Za-z_][A-Za-z0-9._-]*$ ]] \
  && [[ "$HOST_PART" =~ ^(\[[A-Fa-f0-9:]+\]|[A-Za-z0-9][A-Za-z0-9.:-]*)$ ]] \
  || die "target must look like root@203.0.113.10"

command -v ssh >/dev/null || die "OpenSSH client is not installed"
command -v cksum >/dev/null || die "cksum is not installed"

LOCAL_UID="${UID:-$(id -u)}"
SOCKET_ID="$(printf '%s' "$TARGET:$PORT" | cksum | awk '{print $1}')"
BASE_ROOT="${TMPDIR:-/tmp}"
BASE_DIR="${BASE_ROOT%/}/claude-premium-ssh-$LOCAL_UID"
SOCKET="$BASE_DIR/cp-$SOCKET_ID.sock"

# macOS sun_path holds 104 bytes including NUL. OpenSSH muxserver_listen adds
# a dot and 16 random characters before binding: 104 - 1 - 17 = 86 bytes.
# Count bytes, not characters, so a Unicode TMPDIR also gets the short fallback.
if [ "$(printf '%s' "$SOCKET" | wc -c)" -gt 86 ]; then
  BASE_DIR="/tmp/claude-premium-ssh-$LOCAL_UID"
  SOCKET="$BASE_DIR/cp-$SOCKET_ID.sock"
fi

read_password() {
  PASSWORD_VALUE=""
  if [ -n "$PASSWORD_FILE" ]; then
    [ ! -L "$PASSWORD_FILE" ] && [ -f "$PASSWORD_FILE" ] \
      || die "password file must be a regular file, not a symlink"
    [ -O "$PASSWORD_FILE" ] || die "password file must belong to the current user"
    if stat -f '%Lp' "$PASSWORD_FILE" >/dev/null 2>&1; then
      FILE_MODE="$(stat -f '%Lp' "$PASSWORD_FILE")"
    else
      FILE_MODE="$(stat -c '%a' "$PASSWORD_FILE")"
    fi
    (( (8#$FILE_MODE & 077) == 0 )) \
      || die "password file must not be readable by group or others (use mode 600)"
    IFS= read -r PASSWORD_VALUE < "$PASSWORD_FILE" || [ -n "$PASSWORD_VALUE" ] \
      || die "could not read password file"
    rm -f "$PASSWORD_FILE"
    PASSWORD_FILE=""
  else
    IFS= read -r PASSWORD_VALUE || [ -n "$PASSWORD_VALUE" ] \
      || die "could not read a password from standard input"
  fi
  [ -n "$PASSWORD_VALUE" ] || die "password input is empty"
}

run_control() {
  ssh -S "$SOCKET" -p "$PORT" \
    -o BatchMode=yes -o PreferredAuthentications=none \
    "$@" "$TARGET"
}

check_master() {
  run_control "-O" "check" >/dev/null 2>&1
}

print_ready() {
  printf '\nSESSION_READY: temporary SSH session is active.\n'
  printf 'Target: %s\n' "$TARGET"
  printf 'Control socket: %s\n' "$SOCKET"
  printf 'SSH command: ssh -S %q -p %q -o BatchMode=yes -o PreferredAuthentications=none %q\n' \
    "$SOCKET" "$PORT" "$TARGET"
  printf 'Check command: bash %q --check --port %q %q\n' "$SCRIPT_PATH" "$PORT" "$TARGET"
  printf 'Close command: bash %q --close --port %q %q\n' "$SCRIPT_PATH" "$PORT" "$TARGET"
  printf 'The connection expires automatically after at most eight idle hours.\n'
}

if [ "$MODE" = check ]; then
  [ -e "$SOCKET" ] || die "temporary SSH session is not active; run this script without --check"
  check_master || die "temporary SSH session is not healthy; open a new session"
  print_ready
  exit 0
fi

if [ "$MODE" = close ]; then
  if [ ! -e "$SOCKET" ]; then
    printf 'SESSION_CLOSED: temporary SSH session is already absent.\n'
    exit 0
  fi
  if check_master; then
    run_control "-O" "exit" >/dev/null 2>&1 || die "could not close the temporary SSH session"
  fi
  rm -f "$SOCKET"
  rmdir "$BASE_DIR" 2>/dev/null || true
  printf 'SESSION_CLOSED: temporary SSH session was closed.\n'
  exit 0
fi

if [ "$MODE" = open ] && check_master; then
  if [ "$PASSWORD_STDIN" -eq 1 ] || [ -n "$PASSWORD_FILE" ]; then
    read_password
    unset PASSWORD_VALUE
  fi
  print_ready
  exit 0
fi

if [ "$MODE" = open ] && [ "$PASSWORD_STDIN" -eq 0 ] && [ -z "$PASSWORD_FILE" ]; then
  [ -t 0 ] || die "use --password-stdin or run this command in a real local Terminal"
fi
if [ -L "$BASE_DIR" ]; then
  die "refusing a symlinked SSH session directory: $BASE_DIR"
fi
mkdir -p "$BASE_DIR"
OWNER_UID="$(ls -dn "$BASE_DIR" | awk '{print $3}')"
[ "$OWNER_UID" = "$LOCAL_UID" ] || die "SSH session directory belongs to another user: $BASE_DIR"
chmod 700 "$BASE_DIR"
if [ "$MODE" = open ] && { [ -e "$SOCKET" ] || [ -L "$SOCKET" ]; }; then
  rm -f "$SOCKET"
fi

open_master() {
  ssh -S "$SOCKET" -p "$PORT" -fN \
    -o ControlMaster=yes \
    -o ControlPersist=28800 \
    -o PubkeyAuthentication=no \
    -o PreferredAuthentications=password,keyboard-interactive \
    -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    "$TARGET"
}

probe_fresh() {
  ssh -p "$PORT" \
    -o ControlMaster=no \
    -o ControlPath=none \
    -o PubkeyAuthentication=no \
    -o PreferredAuthentications=password,keyboard-interactive \
    -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=10 \
    "$TARGET" true
}

ASKPASS_HELPER=""
ASKPASS_DIR=""
ASKPASS_WRITER_PID=""
cleanup() {
  if [ -n "$ASKPASS_WRITER_PID" ]; then
    kill "$ASKPASS_WRITER_PID" 2>/dev/null || true
    wait "$ASKPASS_WRITER_PID" 2>/dev/null || true
    ASKPASS_WRITER_PID=""
  fi
  if [ -n "$ASKPASS_DIR" ]; then
    rm -f "$ASKPASS_HELPER" "$ASKPASS_DIR/password"
    rmdir "$ASKPASS_DIR"
    ASKPASS_DIR=""
  fi
}
trap cleanup EXIT

configure_askpass() {
  umask 077
  ASKPASS_DIR="$(mktemp -d "$BASE_DIR/askpass.XXXXXX")"
  ASKPASS_HELPER="$ASKPASS_DIR/helper"
  mkfifo "$ASKPASS_DIR/password"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'pipe="${0%/*}/password"' \
    '[ -p "$pipe" ] || exit 1' \
    'exec 3<> "$pipe" || exit 1' \
    'IFS= read -r -t 10 answer <&3 || exit 1' \
    'rm -f "$pipe"' \
    'printf "%s\n" "$answer"' \
    'unset answer' > "$ASKPASS_HELPER"
  chmod 700 "$ASKPASS_HELPER"

  # OpenSSH closes inherited fds above stderr. Let askpass open a private,
  # one-use FIFO itself; the password stays in memory, never in a regular file.
  (printf '%s\n' "$PASSWORD_VALUE" > "$ASKPASS_DIR/password") &
  ASKPASS_WRITER_PID=$!
  unset PASSWORD_VALUE
  export SSH_ASKPASS="$ASKPASS_HELPER"
  export SSH_ASKPASS_REQUIRE=force
  export DISPLAY=claude-premium:0
}

if [ "$PASSWORD_STDIN" -eq 1 ] || [ -n "$PASSWORD_FILE" ]; then
  read_password
  configure_askpass
  if [ "$MODE" = probe-fresh ]; then
    probe_fresh </dev/null
  else
    open_master </dev/null
  fi
  cleanup
  unset SSH_ASKPASS SSH_ASKPASS_REQUIRE DISPLAY
  if [ "$MODE" = probe-fresh ]; then
    printf 'FRESH_CONNECTION_OK: new authenticated SSH connection succeeded without ControlMaster reuse.\n'
    exit 0
  fi
else
  printf 'One private OpenSSH password prompt follows. Input is hidden.\n'
  open_master
fi

check_master || die "the SSH master did not become ready; confirm the server address and password, then retry"
print_ready
