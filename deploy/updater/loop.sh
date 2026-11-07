#!/bin/sh
# rsc-brain's updater: the loop that runs in its own container (compose.updater.yaml, started by
# `rsc-brain.sh web-updates enable`) and starts `rsc-brain.sh update` when the web leaves a request mark.
#
# What it trusts: the marks are only looked at, never opened. <install>/update/request/request and .../retry count when
# they are regular files (lstat: a link is not followed, a FIFO is not opened, a folder is left alone); what is in them,
# their size and their name beyond the two are never read. The update that starts is always the same command, for the
# newest version the loop itself found: `update --yes --json --dir D --version V`. A web that is not to be trusted can
# at most ask for that, again, and the cap below bounds it: a version that failed is tried once more only on a retry
# mark, at most 3 times, 15 minutes apart; after that only the terminal can try it.
#
# Every 5 seconds it says it is alive (update/report/updater.json); every 6 hours (15 minutes after a failure) it asks
# for the newest version and writes update/report/check.json, which the service reads instead of asking the repository
# itself. It starts by asking the launcher for its status, which takes back an update that was cut halfway.
# After an update that went well it ends, and the container's restart policy starts it again from the new files.
#
# Secrets: the credential is a file made for this container; the launcher gets only the name of a helper that reads it
# (GIT_ASKPASS) or of an ssh key file, never a value. What a failure says passes through redact before it is kept.
#
# For tests: RSC_BRAIN_UPDATER_ONCE=1 does one round and ends; RSC_BRAIN_UPDATER_NOW is the time (epoch seconds);
# RSC_BRAIN_UPDATER_LAUNCHER is the launcher to call; RSC_BRAIN_UPDATER_BEAT is the seconds between beats (default 5). `loop.sh --access` only proves the repository answers with the
# credentials given (what `web-updates enable` asks before it starts anything).

set -u
umask 022

DIR=${RSC_BRAIN_UPDATER_DIR:-}
case $DIR in
/*) ;;
*)
  echo 'loop.sh: RSC_BRAIN_UPDATER_DIR must be the absolute path of the installation.' >&2
  exit 2
  ;;
esac
REQ=$DIR/update/request REPORT=$DIR/update/report STATE=$DIR/update/state CRED=$DIR/updater/credentials
LAUNCHER=${RSC_BRAIN_UPDATER_LAUNCHER:-$DIR/updater/rsc-brain.sh}
ONCE=${RSC_BRAIN_UPDATER_ONCE:-0}
BEAT=${RSC_BRAIN_UPDATER_BEAT:-5} CHECK_EVERY=21600 RETRY_AFTER=900 MAX_RETRIES=3
DEFAULT_REPO=https://github.com/ericrisco/rsc-brain

# A stop may come while the output goes to a file: what is said then goes where it was going when this started.
if (exec 4>&2); then exec 4>&2; else exec 4>/dev/null; fi
if (exec 5>&1) 2>/dev/null; then exec 5>&1; else exec 5>/dev/null; fi
# shellcheck disable=SC2329
to_terminal() { exec 2>&4 1>&5; }
say() { printf '%s\n' "$*" >&2; }

now() { if [ -n "${RSC_BRAIN_UPDATER_NOW:-}" ]; then echo "$RSC_BRAIN_UPDATER_NOW"; else date +%s; fi; }
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }
# put FILE <IN: the file whole, beside and moved into place.
put() { cat >"$1.new" && chmod 644 "$1.new" && mv -f "$1.new" "$1"; }
# jstr TEXT: a JSON string of one line of text.
jstr() {
  printf '"%s"' "$(printf '%s' "$1" | LC_ALL=C tr -d '\000-\037\177' | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}
file_value() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n 1; }
env_value() { sed -n "s/^$1='\\(.*\\)'\$/\\1/p" "$DIR/.env" 2>/dev/null | head -n 1; }

# The host of the repository, as git names it in a question for a password (with its port, if it has one).
repo_url() {
  u=$(env_value RSC_BRAIN_REPO_URL)
  [ -n "$u" ] || u=$DEFAULT_REPO
  printf '%s' "$u"
}
repo_host() {
  h=$(repo_url)
  case $h in https://*) ;; *) return 0 ;; esac
  h=${h#https://}
  h=${h%%/*}
  printf '%s' "${h##*@}"
}

# What git is given to reach the repository: the name of a helper that reads the token file, or an ssh key file; never a
# value. Called in a subshell.
credentials_env() {
  GIT_TERMINAL_PROMPT=0
  export GIT_TERMINAL_PROMPT RSC_BRAIN_UPDATER_DIR
  if [ -f "$CRED/token" ] && [ ! -L "$CRED/token" ]; then
    GIT_ASKPASS=$DIR/updater/credentials.sh RSC_BRAIN_UPDATER_REPO_HOST=$(repo_host)
    export GIT_ASKPASS RSC_BRAIN_UPDATER_REPO_HOST
  fi
  if [ -f "$CRED/key" ] && [ ! -L "$CRED/key" ]; then
    # git runs this through a shell, so the quotes around the paths are meant.
    # shellcheck disable=SC2089,SC2090
    GIT_SSH_COMMAND="ssh -i '$CRED/key' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='$CRED/known_hosts' -o ConnectTimeout=15"
    # shellcheck disable=SC2090
    export GIT_SSH_COMMAND
  fi
}
# Runs the launcher with those, and nothing on its standard input.
run_launcher() { (credentials_env && exec sh "$LAUNCHER" "$@"); }

if [ "${1:-}" = --access ]; then
  (credentials_env && exec git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 ls-remote --tags --refs -- "$(repo_url)" 'v*' \
    >/dev/null 2>&1 </dev/null)
  exit $?
fi

mkdir -p "$STATE/attempts" 2>/dev/null && chmod 700 "$STATE" 2>/dev/null

# --------------------------------------------------------------------------------------------------------- reports
ACCEPTED=''
# updater.json: alive, when the last request was taken, what is running, and what failed with when it may be tried again.
write_updater() { # [running-version running-since]
  wu_now=$(now)
  {
    if [ -f "$DIR/updater/disabling" ]; then
      printf '{"enabled":false,"disabling":true,"beatAt":"%s"' "$(iso "$wu_now")"
    else
      printf '{"enabled":true,"beatAt":"%s"' "$(iso "$wu_now")"
    fi
    if [ -n "$ACCEPTED" ]; then printf ',"requestAcceptedAt":"%s"' "$(iso "$ACCEPTED")"; fi
    if [ -n "${1:-}" ]; then printf ',"running":{"to":%s,"startedAt":"%s"}' "$(jstr "$1")" "$(iso "$2")"; fi
    # A request the launcher refused (nothing was stopped): the web shows why, until the next request or a good update.
    if [ -f "$STATE/refused" ]; then
      rf_to=$(file_value "$STATE/refused" TO) rf_at=$(file_value "$STATE/refused" AT)
      case $rf_to$rf_at in
      *[!0-9a-zA-Z.]*) ;;
      *)
        if [ -n "$rf_to" ] && [ -n "$rf_at" ]; then
          printf ',"refused":{"to":%s,"at":"%s","reason":%s}' "$(jstr "$rf_to")" "$(iso "$rf_at")" \
            "$(jstr "$(cat "$STATE/refused.reason" 2>/dev/null)")"
        fi
        ;;
      esac
    fi
    printf ',"attempts":{'
    sep=''
    for f in "$STATE"/attempts/v*; do
      [ -f "$f" ] || continue
      case $f in *.reason) continue ;; esac
      v=${f##*/}
      failed=$(file_value "$f" FAILED_AT) retries=$(file_value "$f" RETRIES) last=$(file_value "$f" LAST_RETRY_AT)
      case $failed$retries$last in *[!0-9]*) continue ;; esac
      [ -n "$failed" ] || continue
      : "${retries:=0}"
      [ -n "$last" ] || last=$failed
      if [ "$retries" -ge "$MAX_RETRIES" ]; then from=null; else from="\"$(iso $((last + RETRY_AFTER)))\""; fi
      printf '%s%s:{"failedAt":"%s","reason":%s,"retries":%s,"retryFrom":%s}' "$sep" "$(jstr "$v")" "$(iso "$failed")" \
        "$(jstr "$(cat "$f.reason" 2>/dev/null)")" "$retries" "$from"
      sep=,
    done
    printf '}}\n'
  } | put "$REPORT/updater.json"
}

CHECKED=0 CHECK_OK=0 CHECK_LATEST='' CHECK_NEWER=false
# One asking of the newest version, through the launcher, with this machine's access. check.json says what came of it;
# when it could not say, what was known before stays in it and the reason is said.
run_check() {
  CHECKED=1 CHECK_OK=0 CHECK_LATEST='' CHECK_NEWER=false
  rc_now=$(now)
  code=0
  out=$(run_launcher update --check --json --dir "$DIR" </dev/null 2>/dev/null) || code=$?
  latest=$(printf '%s\n' "$out" | sed -nE 's/^\{"installed":("([^"\\]|\\.)*"|null),"latest":"(v[0-9]+\.[0-9]+\.[0-9]+)","newer":(true|false),"notes":("([^"\\]|\\.)*").*$/\3/p')
  newer=$(printf '%s\n' "$out" | sed -nE 's/^\{"installed":("([^"\\]|\\.)*"|null),"latest":"(v[0-9]+\.[0-9]+\.[0-9]+)","newer":(true|false),"notes":("([^"\\]|\\.)*").*$/\4/p')
  notes=$(printf '%s\n' "$out" | sed -nE 's/^\{"installed":("([^"\\]|\\.)*"|null),"latest":"(v[0-9]+\.[0-9]+\.[0-9]+)","newer":(true|false),"notes":("([^"\\]|\\.)*").*$/\5/p')
  if [ "$code" = 0 ] && [ -n "$latest" ] && [ -n "$newer" ] && [ -n "$notes" ]; then
    CHECK_OK=1 CHECK_LATEST=$latest CHECK_NEWER=$newer
    printf '{"checkedAt":"%s","ok":true,"reason":null,"products":{"brain":{"latest":"%s","notes":%s}}}\n' "$(iso "$rc_now")" "$latest" "$notes" |
      put "$REPORT/check.json"
    printf '%s ok\n' "$rc_now" >"$STATE/last-check"
    return 0
  fi
  reason=$(printf '%s\n' "$out" | sed -nE 's/.*,"error":"([a-z_]+)"\}$/\1/p' | head -n 1)
  # The three the web understands; anything else the launcher said (rsc-brain is stopped, an update is running) is a
  # check that did not get an answer.
  case $reason in no_access | none) ;; *) reason=network ;; esac
  known=$(sed -nE 's/^\{"checkedAt":"[^"]*","ok":(true|false),"reason":("[a-z_]*"|null),"products":(.*)\}$/\3/p' "$REPORT/check.json" 2>/dev/null)
  [ -n "$known" ] || known='{}'
  printf '{"checkedAt":"%s","ok":false,"reason":"%s","products":%s}\n' "$(iso "$rc_now")" "$reason" "$known" | put "$REPORT/check.json"
  printf '%s failed\n' "$rc_now" >"$STATE/last-check"
  return 0
}
check_due() {
  # shellcheck disable=SC2046
  set -- $(cat "$STATE/last-check" 2>/dev/null)
  [ -n "${1:-}" ] || return 0
  case $1 in *[!0-9]*) return 0 ;; esac
  wait_for=$CHECK_EVERY
  [ "${2:-}" = ok ] || wait_for=$RETRY_AFTER
  [ $(($(now) - $1)) -ge "$wait_for" ]
}

# redact SECRET... <IN >OUT: every secret given replaced by [redacted], with no other program seeing them.
redact() {
  while IFS= read -r line || [ -n "$line" ]; do
    for s in "$@"; do
      [ -n "$s" ] || continue
      kept=''
      while :; do
        case $line in
        *"$s"*)
          kept="$kept${line%%"$s"*}[redacted]"
          line=${line#*"$s"}
          ;;
        *) break ;;
        esac
      done
      line=$kept$line
    done
    printf '%s\n' "$line"
  done
}

# -------------------------------------------------------------------------------------------------------- the marks
# 0 when NAME is a regular file; anything else is not a request (a link, a FIFO, a socket are taken away without being
# opened; a folder stays, since rm -f cannot remove it).
is_mark() {
  if [ -L "$1" ]; then
    rm -f -- "$1"
    return 1
  fi
  [ -e "$1" ] || return 1
  [ -f "$1" ] && return 0
  # rm -f does not remove a folder: one is left where it is.
  rm -f -- "$1" 2>/dev/null
  return 1
}

CHILD='' STOPPING=0
# shellcheck disable=SC2329
on_stop() {
  to_terminal
  STOPPING=1
  [ -z "$CHILD" ] || kill -TERM "$CHILD" 2>/dev/null
  return 0
}

EXIT_AFTER=0
requests() {
  req=0 retry=0
  is_mark "$REQ/request" && req=1
  is_mark "$REQ/retry" && retry=1
  [ "$req$retry" != 00 ] || return 0
  if [ -f "$DIR/updater/disabling" ]; then
    # `web-updates disable` has removed the credential and is waiting for the lock to take the updater away: the marks
    # are taken, and nothing starts.
    say 'The updater is being turned off: the request was not started.'
    rm -f -- "$REQ/request" "$REQ/retry"
    return 0
  fi
  [ "$CHECKED" = 1 ] || run_check
  target=$CHECK_LATEST
  if [ "$CHECK_OK" = 0 ] || [ "$CHECK_NEWER" != true ] || [ -z "$target" ]; then
    rm -f -- "$REQ/request" "$REQ/retry"
    return 0
  fi
  att=$STATE/attempts/$target
  retries=0
  t=$(now)
  if [ -f "$att" ]; then
    retries=$(file_value "$att" RETRIES)
    last=$(file_value "$att" LAST_RETRY_AT)
    [ -n "$last" ] || last=$(file_value "$att" FAILED_AT)
    case $retries$last in *[!0-9]*) retries=$MAX_RETRIES last=$t ;; esac
    : "${retries:=0}" "${last:=$t}"
    if [ "$retry" = 0 ] || [ "$retries" -ge "$MAX_RETRIES" ] || [ $((t - last)) -lt "$RETRY_AFTER" ]; then
      rm -f -- "$REQ/request" "$REQ/retry"
      return 0
    fi
    retries=$((retries + 1))
    retrying=1
  else
    retrying=0
  fi
  # The status says running first, and only then is the mark taken: a request is never lost between the two.
  ACCEPTED=$t
  rm -f -- "$STATE/refused" "$STATE/refused.reason"
  write_updater "$target" "$t"
  rm -f -- "$REQ/request" "$REQ/retry"
  if [ -e "$REQ/request" ] || [ -L "$REQ/request" ] || [ -e "$REQ/retry" ] || [ -L "$REQ/retry" ]; then
    say 'The request mark could not be removed: nothing was started.'
    write_updater
    return 0
  fi
  log=$STATE/update.out
  : >"$log"
  chmod 600 "$log"
  trap on_stop HUP INT TERM
  # The subshell becomes the launcher (exec): the pid kept is the launcher's, and a stop reaches it.
  (credentials_env && exec sh "$LAUNCHER" update --yes --json --dir "$DIR" --version "$target") </dev/null >"$log" 2>&1 &
  CHILD=$!
  # While the launcher runs (an image pull can take many minutes) the loop keeps saying it is alive: every second it looks
  # at the child, and every BEAT seconds it writes updater.json again with the update still running. Only this shell writes
  # that file, one write at a time, so no write can land after the last one; the beat stops when this shell does, which is
  # what the service must see if the updater dies. A stop (a trapped signal) ends the sleep, reaches the child through
  # on_stop, and the loop goes on until the child has ended: its own exit code is read by the last wait.
  beat_n=0
  while kill -0 "$CHILD" 2>/dev/null; do
    sleep 1 >/dev/null 2>&1 4>&- 5>&- &
    nap=$!
    wait "$nap"
    beat_n=$((beat_n + 1))
    if [ "$beat_n" -ge "$BEAT" ]; then
      beat_n=0
      write_updater "$target" "$t"
    fi
  done
  wait "$CHILD"
  code=$?
  CHILD=''
  trap on_stop HUP INT TERM
  token=''
  [ -f "$CRED/token" ] && [ ! -L "$CRED/token" ] && IFS= read -r token <"$CRED/token"
  reason=$(tail -n 20 "$log" | redact "$token" | tr '\n' ' ' | sed -e 's/^ *//' -e 's/ *$//' | cut -c1-4000)
  rm -f -- "$log"
  # A failure is dated when it ended: the 15 minutes before a retry run from there.
  ended=$(now)
  if [ "$STOPPING" = 1 ]; then
    write_updater
    return 0
  fi
  case $code in
  0)
    rm -f -- "$att" "$att.reason"
    write_updater
    EXIT_AFTER=1
    ;;
  2 | 3)
    # Refused, or something missing or running: nothing was stopped, and no attempt is spent. The web is told why.
    [ -n "$reason" ] || reason="The launcher refused the update to $target (exit $code)."
    printf '%s\n' "$reason" >"$STATE/refused.reason"
    printf 'TO=%s\nAT=%s\n' "$target" "$ended" >"$STATE/refused"
    write_updater
    ;;
  *)
    [ -n "$reason" ] || reason="The update to $target failed (exit $code)."
    first=$ended
    [ "$retrying" = 0 ] || first=$(file_value "$att" FAILED_AT)
    printf 'FAILED_AT=%s\nRETRIES=%s\nLAST_RETRY_AT=%s\n' "$first" "$retries" "$ended" >"$att.new" && mv -f "$att.new" "$att"
    printf '%s\n' "$reason" >"$att.reason"
    write_updater
    ;;
  esac
  return 0
}

tick() {
  CHECKED=0
  write_updater
  if check_due; then run_check; fi
  requests
}

# ------------------------------------------------------------------------------------------------------------ run
trap on_stop HUP INT TERM
# Taking back an update that was cut halfway is the launcher's first job.
run_launcher status --dir "$DIR" </dev/null >/dev/null 2>&1 || :
while :; do
  tick
  [ "$ONCE" = 1 ] && break
  [ "$EXIT_AFTER" = 1 ] && break
  [ "$STOPPING" = 1 ] && break
  sleep "$BEAT" &
  wait $!
  [ "$STOPPING" = 1 ] && break
done
exit 0
