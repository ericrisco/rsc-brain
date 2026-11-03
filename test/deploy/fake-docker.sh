#!/bin/sh
# A stand-in for `docker` in the launcher's tests (test/deploy/launcher.test.ts): no daemon, no containers. Each call
# is one line in $FAKE_LOG (its arguments, separated by spaces); whatever a call reads on its standard input goes to
# $FAKE_STDIN after a line naming the call. $FAKE_STATE is a folder that remembers what is "up". What it answers is
# set by FAKE_* variables (see each case).
log() { printf '%s\n' "$*" >>"$FAKE_LOG"; }
log "$*"
args=" $* "
state=${FAKE_STATE:?}

# Whatever the call is given on its standard input (the launcher closes it, or pipes a secret in).
take_stdin() {
  if [ ! -t 0 ]; then
    printf '<<< %s\n' "$*" >>"$FAKE_STDIN"
    cat >>"$FAKE_STDIN"
    printf '\n' >>"$FAKE_STDIN"
  fi
}

case "$args" in
*" rsc-brain db check "*)
  take_stdin db check
  if [ "${FAKE_DB_CHECK_EXIT:-0}" = 3 ]; then
    echo 'PostgreSQL 16.4 is too old: rsc-brain needs PostgreSQL 17 or newer.' >&2
    exit 3
  fi
  echo '{"version":"17.11","unaccent":true,"canCreate":true,"isSuper":false,"ownsDb":true}'
  exit "${FAKE_DB_CHECK_EXIT:-0}"
  ;;
*" rsc-brain db provision "*)
  take_stdin db provision
  [ -n "${FAKE_PROVISION_WARNING:-}" ] && echo "Warning: $FAKE_PROVISION_WARNING" >&2
  [ "${FAKE_PROVISION_EXIT:-0}" != 0 ] && exit "$FAKE_PROVISION_EXIT"
  host=postgres
  case "$args" in *" --isolate-from "*) host=db.internal ;; esac
  echo "{\"database\":\"x\",\"role\":\"x\",\"url\":\"postgres://rsc_brain:provisioned-pw@$host:5432/rsc_brain?sslmode=disable\",\"warnings\":[],\"granted\":[]}"
  exit 0
  ;;
*" rsc-brain db drop "*)
  take_stdin db drop
  echo 'Removed the database and the role.'
  exit 0
  ;;
*" rsc-brain key id "*)
  take_stdin key id
  echo 'k3yid0123456'
  exit 0
  ;;
*" rsc-brain version "*)
  echo '0.1.0'
  exit 0
  ;;
*" rsc-brain restore "*)
  take_stdin restore
  echo 'Restored the copy.'
  exit "${FAKE_RESTORE_EXIT:-0}"
  ;;
*" rsc-brain backup "*)
  take_stdin backup
  echo 'Made the copy rsc-brain-20261103T030000Z-manual.rscb.'
  exit 0
  ;;
*" rsc-brain backups list "*)
  echo 'rsc-brain-20261103T030000Z-manual.rscb'
  exit 0
  ;;
*" rsc-brain maintenance status "*)
  echo '{"on":false}'
  exit 0
  ;;
*" wget "*"/v1/health"*)
  take_stdin health
  exit "${FAKE_HEALTH_EXIT:-0}"
  ;;
esac

case "$1" in
info) exit "${FAKE_INFO_EXIT:-0}" ;;
build)
  exit "${FAKE_BUILD_EXIT:-0}"
  ;;
image)
  if [ "$2" = inspect ]; then
    case " ${FAKE_IMAGES:-*} " in *" * "* | *" $3 "*) exit 0 ;; esac
    echo "Error: No such image: $3" >&2
    exit 1
  fi
  exit 0
  ;;
volume)
  if [ "$2" = inspect ]; then
    case " ${FAKE_VOLUMES:-} " in *" $3 "*) exit 0 ;; esac
    echo "Error: no such volume: $3" >&2
    exit 1
  fi
  exit 0
  ;;
ps)
  [ -n "${FAKE_PROJECTS:-}" ] && echo deadbeef
  exit 0
  ;;
network)
  if [ "$2" = ls ]; then
    [ -n "${FAKE_SUBNETS:-}" ] && echo n0
    exit 0
  fi
  if [ "$2" = inspect ]; then
    printf '%s\n' "${FAKE_SUBNETS:-}"
    exit 0
  fi
  exit 0
  ;;
run)
  take_stdin run
  exit 0
  ;;
compose)
  if [ "$2" = version ]; then
    if [ -n "${FAKE_NO_COMPOSE:-}" ]; then
      echo "docker: unknown command: docker compose" >&2
      exit 1
    fi
    echo 'Docker Compose version v2.30.0'
    exit 0
  fi
  case "$args" in
  *" up "*)
    if [ -n "${FAKE_UP_FAIL_ONCE:-}" ] && [ ! -e "$state/failed-once" ]; then
      : >"$state/failed-once"
      echo 'Error response from daemon: failed to start' >&2
      exit 1
    fi
    if [ "${FAKE_UP_EXIT:-0}" != 0 ]; then
      echo 'Error response from daemon: failed to start' >&2
      exit "$FAKE_UP_EXIT"
    fi
    : >"$state/up"
    exit 0
    ;;
  *" down "*)
    rm -f "$state/up"
    exit 0
    ;;
  *" ps "*)
    [ -e "$state/up" ] && echo c0ffee
    exit 0
    ;;
  *" run "* | *" exec "*)
    take_stdin compose
    exit 0
    ;;
  esac
  exit 0
  ;;
esac
exit 0
