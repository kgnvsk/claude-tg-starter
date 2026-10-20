# The browser's network deny and resource limits as drop-ins beside claude-browser.service. install-browser.sh and
# every install-core run write them from the same kit file, so an installed agent's browser gets them in its next
# update (Codex, 19.10). Sourced with KIT set.

# The kit's own drop-ins; anything else in the directory is the operator's and is never touched.
BROWSER_KIT_DROPINS="30-hardening.conf 40-dns.conf 50-allow-private-network.conf"

# write_browser_dropins DIR [RESOLV_CONF]
write_browser_dropins() {
  local dir="$1" resolv="${2:-/etc/resolv.conf}" nameservers
  install -d -m 755 "$dir" || return 1
  if [ -e "$dir/30-hardening.conf" ] && ! cmp -s "$KIT/assets/systemd/claude-browser-hardening.conf" "$dir/30-hardening.conf"; then
    echo "WARN: $dir/30-hardening.conf змінено вручну — залишаю як є" >&2
  else
    install -m 644 "$KIT/assets/systemd/claude-browser-hardening.conf" "$dir/30-hardening.conf" || return 1
  fi
  # A resolver listed directly in resolv.conf (no 127.0.0.53 stub) stays reachable, since an allow wins over the deny.
  nameservers="$(awk '$1 == "nameserver" && $2 !~ /^(127\.|::1$)/ {ns = $2; sub(/%.*/, "", ns); printf "%s ", ns}' "$resolv" 2>/dev/null || true)"
  if [ -n "$nameservers" ]; then
    printf '[Service]\nIPAddressAllow=%s\n' "$nameservers" > "$dir/40-dns.conf" || return 1
  else
    rm -f "$dir/40-dns.conf" || return 1
  fi
  # The operator's opt-out for a browser that must reach the LAN or a tailnet: 1 sets it, 0 removes it, unset keeps it.
  case "${CLAUDE_BROWSER_ALLOW_PRIVATE_NETWORK:-}" in
    1) printf '[Service]\nIPAddressDeny=\n' > "$dir/50-allow-private-network.conf" || return 1 ;;
    0) rm -f "$dir/50-allow-private-network.conf" || return 1 ;;
  esac
}

# browser_answers OLD_PID: a new process, not OLD_PID, answers on the MCP endpoint the way claude-browser-recover checks
# it (curl succeeds, 200/400/405), and is still the unit's process after the answer; playwright-mcp binds its port some
# seconds after systemd reports the unit active.
browser_answers() {
  local old="$1" pid code _
  for _ in $(seq 1 "${BROWSER_START_WAIT:-30}"); do
    pid="$(systemctl show -p MainPID --value claude-browser.service 2>/dev/null || true)"
    if [ -n "$pid" ] && [ "$pid" != 0 ] && [ "$pid" != "$old" ] &&
       code="$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:8931/mcp 2>/dev/null)" &&
       case "$code" in 200|400|405) true ;; *) false ;; esac &&
       [ "$(systemctl show -p MainPID --value claude-browser.service 2>/dev/null || true)" = "$pid" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# refresh_browser_dropins MAINTENANCE [DIR] [RESOLV_CONF]
# Rewrites the kit drop-ins of an installed browser. In an update window (the agent is stopped) an active browser
# restarts into them and must come back as a new, answering process; otherwise the previous kit drop-ins return. It
# checks every step itself and returns non-zero on a failure, so call it as `refresh_browser_dropins … || true`: a
# browser problem is reported, never the end of an install (the healthcheck's recovery takes it from there).
refresh_browser_dropins() {
  local maintenance="$1" dir="${2:-/etc/systemd/system/claude-browser.service.d}" resolv="${3:-/etc/resolv.conf}"
  local saved name old restart=0 restored
  saved="$(mktemp -d)" || return 1
  for name in $BROWSER_KIT_DROPINS; do
    if [ -e "$dir/$name" ]; then cp -p "$dir/$name" "$saved/$name" || { rm -rf "$saved"; return 1; }; fi
  done
  old="$(systemctl show -p MainPID --value claude-browser.service 2>/dev/null || true)"
  [ "$maintenance" != 1 ] || ! systemctl is-active --quiet claude-browser.service || restart=1
  if write_browser_dropins "$dir" "$resolv" && systemctl daemon-reload &&
     { [ "$restart" = 0 ] || { systemctl restart claude-browser.service && browser_answers "$old"; }; }; then
    rm -rf "$saved"
    return 0
  fi
  echo "WARN: браузер не прийняв нові обмеження мережі — повертаю попередні drop-ins кита" >&2
  restored=1
  for name in $BROWSER_KIT_DROPINS; do
    if [ -e "$saved/$name" ]; then cp -p "$saved/$name" "$dir/$name" || restored=0; else rm -f "$dir/$name" || restored=0; fi
  done
  if [ "$restored" != 1 ] || ! systemctl daemon-reload; then
    echo "WARN: попередні drop-ins кита не повернуто — їхня копія в $saved; браузер не перезапускаю" >&2
    return 1
  fi
  rm -rf "$saved"
  if [ "$restart" = 1 ]; then
    old="$(systemctl show -p MainPID --value claude-browser.service 2>/dev/null || true)"
    { systemctl restart claude-browser.service && browser_answers "$old"; } ||
      echo "WARN: браузер не відповідає й із попередніми drop-ins — перевір claude-browser.service" >&2
  fi
  return 1
}
