#!/bin/sh
# A stand-in for `docker` in the launcher's tests (test/deploy/launcher.test.ts): no daemon, no containers. Each call
# is one line in $FAKE_LOG (its arguments, separated by spaces); whatever a call reads on its standard input goes to
# $FAKE_STDIN after a line naming the call. $FAKE_STATE is a folder that remembers what is "up". What it answers is
# set by FAKE_* variables (see each case).
log() { printf '%s\n' "$*" >>"$FAKE_LOG"; }
log "$*"
args=" $* "
state=${FAKE_STATE:?}
# A value of the installation's that reached docker compose from the caller's environment instead of its .env file
# (`docker compose version` reads no project).
if [ "$1" = compose ] && [ "${2:-}" != version ]; then
  env | grep -E '^(RSC_BRAIN_|POSTGRES_|COMPOSE_)' | grep -vE '^RSC_BRAIN_(TTY|REPO)=' | sed 's/^/LEAK /' >>"$FAKE_LOG"
fi
# The env file a compose call reads (for the logs below).
env_file='' project_dir=''
prev=''
for a in "$@"; do
  [ "$prev" = --env-file ] && env_file=$a
  [ "$prev" = --project-directory ] && project_dir=$a
  prev=$a
done

# Updates: the image a compose call reads in the env file; what the last `up` started; the version each image says
# (FAKE_IMAGE_VERSIONS="image=version ...", default 0.1.0). $FAKE_STATE/images.log says which image each run/up used.
env_image() { sed -n "s/^RSC_BRAIN_IMAGE='\\(.*\\)'$/\\1/p" "$env_file" 2>/dev/null; }
up_image() { cat "$state/up-image" 2>/dev/null || env_image; }
version_of() {
  for pair in ${FAKE_IMAGE_VERSIONS:-}; do
    [ "${pair%%=*}" = "$1" ] && echo "${pair#*=}" && return
  done
  echo '0.1.0'
}
in_list() { case " $2 " in *" $1 "*) return 0 ;; esac; return 1; }
# A wait as long as docker compose's for its container: compose takes SIGINT back even when it started with it
# ignored (Go does), forwards it to the container and exits 130 without waiting for it (seen with Docker 29.1 and
# Compose 5.0). The shell cannot take back a signal it inherited ignored; perl can. It says it started (the marker
# $1) only once it listens, so a test that stops it then is never early.
compose_wait() {
  perl -e '$SIG{INT} = sub { exit 130 }; open(my $f, ">", shift) or die; close $f; sleep shift' "$state/$1" "$2" ||
    exit 130
}
if [ "$1" = compose ]; then
  case "$args" in
  *" run "*) echo "run $(env_image)" >>"$state/images.log" ;;
  *" up "*" door "*) ;;
  *" up "*) echo "up $(env_image)" >>"$state/images.log" ;;
  esac
fi

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
  [ -n "${FAKE_PROVISION_SLEEP:-}" ] && echo provisioning >>"$FAKE_STATE/provision-started" && sleep "$FAKE_PROVISION_SLEEP"
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
  if [ -n "${FAKE_KEY_ID_BY_KEY:-}" ]; then
    # An id that follows the key (rotation): its checksum.
    key=$(cat)
    printf '<<< key id\n%s\n' "$key" >>"$FAKE_STDIN"
    echo "id$(printf '%s' "$key" | cksum | cut -d' ' -f1)"
    exit 0
  fi
  take_stdin key id
  echo 'k3yid0123456'
  exit 0
  ;;
*" rsc-brain key reseal"*)
  # The key the data is sealed with is kept in $FAKE_STATE/sealed (at first, the installation's own). The reseal goes
  # from the key in the env file (the container's RSC_BRAIN_SECRET) to the key on the standard input, as the real one
  # does: already sealed with the new key, nothing to do; sealed with neither, refused. FAKE_RESEAL_EXIT fails it
  # before anything is written; FAKE_RESEAL_FAIL_AFTER_COMMIT (once) writes, then reports a failure.
  to=$(cat)
  printf '<<< key reseal\n%s\n' "$to" >>"$FAKE_STDIN"
  secret_of() { sed -n "s/^RSC_BRAIN_SECRET='\\(.*\\)'$/\\1/p" "$1" 2>/dev/null; }
  from=$(secret_of "$env_file")
  sealed=$(cat "$state/sealed" 2>/dev/null)
  [ -n "$sealed" ] || sealed=$(secret_of "$project_dir/.env")
  if [ "$sealed" = "$to" ]; then
    echo 'Resealed 0 values; 3 were sealed with the new key already.'
    exit 0
  fi
  if [ "$sealed" != "$from" ] || [ "${FAKE_RESEAL_EXIT:-0}" != 0 ]; then
    echo 'None of the 3 sealed values opens with key id x: it is not the key in use. Nothing was changed.' >&2
    code=${FAKE_RESEAL_EXIT:-1}
    [ "$code" = 0 ] && code=1
    exit "$code"
  fi
  printf '%s\n' "$to" >"$state/sealed"
  # FAKE_RESEAL_SLEEP: the reseal has written, and the launcher has not heard yet (a test kills it then).
  if [ -n "${FAKE_RESEAL_SLEEP:-}" ]; then
    compose_wait reseal-committed "$FAKE_RESEAL_SLEEP"
  fi
  if [ -n "${FAKE_RESEAL_FAIL_AFTER_COMMIT:-}" ] && [ ! -e "$state/failed-after-commit" ]; then
    : >"$state/failed-after-commit"
    echo 'Connection lost after the commit.' >&2
    exit 1
  fi
  echo 'Resealed 3 values.'
  exit 0
  ;;
*" rsc-brain version "*)
  if [ "$1" = run ]; then
    # docker run --rm IMAGE rsc-brain version
    img=''
    prev=''
    for a in "$@"; do
      [ "$a" = rsc-brain ] && img=$prev && break
      prev=$a
    done
    version_of "$img"
  else
    # FAKE_UP_VERSION="image=version": what that image says once started (a wrong tag).
    up=$(up_image)
    if [ -n "${FAKE_UP_VERSION:-}" ] && [ "${FAKE_UP_VERSION%%=*}" = "$up" ]; then
      echo "${FAKE_UP_VERSION#*=}"
    else
      version_of "$up"
    fi
  fi
  exit 0
  ;;
*" rsc-brain migrate "*)
  [ -f "$project_dir/.rsc-brain/door/step.txt" ] && echo "migrate: $(cat "$project_dir/.rsc-brain/door/step.txt")" >>"$state/door-steps.log"
  # FAKE_MIGRATE_SLEEP: a long migration (it says when it started, so a test can stop the launcher then).
  if [ -n "${FAKE_MIGRATE_SLEEP:-}" ]; then
    : >"$state/migrate-started"
    sleep "$FAKE_MIGRATE_SLEEP"
  fi
  if in_list "$(env_image)" "${FAKE_MIGRATE_FAIL:-}"; then
    echo 'Migration 0024_broken.sql failed: division by zero. Nothing of it was applied.' >&2
    exit 1
  fi
  echo 'Applied: 0024_next'
  exit 0
  ;;
*" rsc-brain maintenance on "*)
  exit "${FAKE_MAINTENANCE_EXIT:-0}"
  ;;
*" rsc-brain maintenance off"*)
  exit 0
  ;;
*" rsc-brain update record "*)
  take_stdin update record
  exit 0
  ;;
*" rsc-brain restore --check "*)
  take_stdin restore check
  [ "${FAKE_RESTORE_CHECK_EXIT:-0}" = 2 ] && echo 'The name given to confirm does not match this installation.' >&2
  exit "${FAKE_RESTORE_CHECK_EXIT:-0}"
  ;;
*" rsc-brain restore "*)
  take_stdin restore
  [ -f "$project_dir/.rsc-brain/door/step.txt" ] && echo "restore: $(cat "$project_dir/.rsc-brain/door/step.txt")" >>"$state/door-steps.log"
  # FAKE_RESTORE_SLEEP: a long restore of the copy made before an update (the rollback's).
  case "$args" in *" --keep-keys "*)
    if [ -n "${FAKE_RESTORE_SLEEP:-}" ]; then
      compose_wait restore-started "$FAKE_RESTORE_SLEEP"
    fi
    ;;
  esac
  echo 'Restored the copy.'
  exit "${FAKE_RESTORE_EXIT:-0}"
  ;;
*" rsc-brain backup "*)
  take_stdin backup
  [ "${FAKE_BACKUP_EXIT:-0}" != 0 ] && echo 'The copy failed: writes_in_progress.' >&2 && exit "$FAKE_BACKUP_EXIT"
  case "$args" in
  *" --reason pre-update "*)
    echo '{"id":"rsc-brain-20261103T120000Z-pre-update","file":"rsc-brain-20261103T120000Z-pre-update.rscb","bytes":4096,"keyId":"k3yid0123456","createdAt":"2026-11-03T12:00:00.000Z"}'
    ;;
  *) echo 'Made the copy rsc-brain-20261103T030000Z-manual.rscb.' ;;
  esac
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
  # FAKE_HEALTH_SLEEP="image=seconds": that image takes a while to answer (it says when it started).
  if [ -n "${FAKE_HEALTH_SLEEP:-}" ] && [ "${FAKE_HEALTH_SLEEP%%=*}" = "$(up_image)" ]; then
    : >"$state/health-started"
    sleep "${FAKE_HEALTH_SLEEP#*=}"
  fi
  in_list "$(up_image)" "${FAKE_HEALTH_FAIL:-}" && exit 1
  exit "${FAKE_HEALTH_EXIT:-0}"
  ;;
esac

case "$1" in
version)
  # docker version --format '{{.Server.Version}}'
  echo "${FAKE_ENGINE_VERSION:-29.1.5}"
  exit 0
  ;;
info)
  if [ -n "${FAKE_INFO_DENIED:-}" ]; then
    echo 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock' >&2
    exit 1
  fi
  exit "${FAKE_INFO_EXIT:-0}"
  ;;
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
pull)
  exit "${FAKE_PULL_EXIT:-0}"
  ;;
rm)
  rm -f "$state/door"
  exit 0
  ;;
ps)
  # The stand-in door, asked for by its labels.
  case "$args" in *service=door*)
    [ -e "$state/door" ] && echo d00r
    exit 0
    ;;
  esac
  [ -n "${FAKE_PROJECTS:-}" ] && echo deadbeef
  exit 0
  ;;
network)
  if [ "$2" = ls ]; then
    [ -n "${FAKE_SUBNETS:-}" ] && echo n0
    exit 0
  fi
  if [ "$2" = inspect ]; then
    # A network asked for by name (companion mode): FAKE_NETWORKS="name=subnet|gateway[,more] ...", or not found.
    case "$args" in
    *'|{{.Gateway}}'*)
      for a in "$@"; do last=$a; done
      for pair in ${FAKE_NETWORKS:-}; do
        # Several entries of one network are written with commas between them.
        [ "${pair%%=*}" = "$last" ] && printf '%s \n' "${pair#*=}" | tr ',' ' ' && exit 0
      done
      echo "Error response from daemon: network $last not found" >&2
      exit 1
      ;;
    esac
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
    echo "Docker Compose version ${FAKE_COMPOSE_VERSION:-v2.38.2}"
    exit 0
  fi
  case "$args" in
  *" up "*" door "*)
    # The stand-in door takes the port of the service; it has a marker of its own, and is not the service.
    [ "${FAKE_DOOR_UP_EXIT:-0}" = 0 ] || exit "$FAKE_DOOR_UP_EXIT"
    : >"$state/door"
    exit 0
    ;;
  *" rm "*" door "*)
    rm -f "$state/door"
    exit 0
    ;;
  *" up "*)
    # The port is taken while the door is up, as it would be.
    if [ -e "$state/door" ]; then
      echo 'Error response from daemon: Bind for 127.0.0.1 failed: port is already allocated' >&2
      exit 1
    fi
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
    env_image >"$state/up-image"
    exit 0
    ;;
  *" logs "*)
    # A service that prints its own key at start (it never should): the launcher must not keep it.
    secret=$(sed -n "s/^RSC_BRAIN_SECRET='\\(.*\\)'$/\\1/p" "$env_file" 2>/dev/null)
    echo "app-1  | boot failed: database refused (key $secret; again: $secret)"
    exit 0
    ;;
  *" down "* | *" stop "*)
    # FAKE_STOP_SLEEP: a slow stop (it says when it started).
    if [ -n "${FAKE_STOP_SLEEP:-}" ]; then
      : >"$state/stop-started"
      sleep "$FAKE_STOP_SLEEP"
    fi
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
