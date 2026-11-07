#!/bin/sh
# rsc-brain.sh: install and run rsc-brain with containers, on this machine or on a server with a domain.
# Needs Docker with Compose v2 (and git to build from the source). Run `sh rsc-brain.sh help` for the commands.
#
# It only arranges containers and files: everything that touches data (copies, restoring, creating the database)
# is the rsc-brain command inside the image. Secrets never go on a command line: the installation key and database
# passwords live in <dir>/.env (only its owner reads it) and reach containers through it or their standard input.
#
# Exit codes: 0 done, 2 wrong usage, 3 a requirement is missing (nothing was changed), 4 failed and put back what was
# there, 1 anything else.
#
# For tests: RSC_BRAIN_TTY is the terminal questions are asked on (default /dev/tty); RSC_BRAIN_REPO is where the
# source is cloned from; RSC_BRAIN_TEST_STOP_AT=<step> makes a first install (or an update, at update-journal) stop
# itself right after that step, with RSC_BRAIN_TEST_STOP_SIGNAL (default KILL); RSC_BRAIN_TEST_WAIT is how many seconds the service gets to answer (default 120); RSC_BRAIN_TEST_TAIL_WAIT how many seconds each call at the end of an update gets (default 60).

set -u
umask 077

PROG=rsc-brain.sh
REPO=${RSC_BRAIN_REPO:-https://github.com/ericrisco/rsc-brain.git}
# Whether this run was told where the repository is; if not, the installation's own address counts (RSC_BRAIN_REPO_URL).
REPO_GIVEN=0
[ -n "${RSC_BRAIN_REPO:-}" ] && REPO_GIVEN=1
TTY=${RSC_BRAIN_TTY:-/dev/tty}
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
NL='
'
CR=$(printf '\r')
TAB=$(printf '\t')
# The whitespace of the definition of a published version; a no-break space is text.
BLANK=" $TAB$NL"
C1_CONTROLS=$(printf '\302[\200-\237]')
MIN_FREE_KB=2097152
WAIT_SECONDS=${RSC_BRAIN_TEST_WAIT:-120}
# How long each call of the end of an update (maintenance off, the record) may take before it is ended (60 seconds).
TAIL_WAIT=${RSC_BRAIN_TEST_TAIL_WAIT:-60}

USAGE="Usage: sh $PROG <command> [options]

Commands:
  install           install rsc-brain, or apply new settings to an installation (its key and data are kept)
  update [--version vX.Y.Z | --image I]
                    move to a newer version (default: the latest published): writes wait, a copy is made, the
                    data is migrated and the new version started; if anything fails, the copy is restored and
                    the version before comes back (exit 4). Sessions and keys keep working either way. An
                    update stopped halfway is taken back by the next command (status, or any that changes something)
  update --check [--json] [--repo URL]
                    only look: the version running, the newest published and what it changes, with this machine's
                    access to the repository. Nothing is stopped or written. Exit 3 when it cannot say
  status [--json]   whether rsc-brain runs and answers
  backup [--json]   make an encrypted copy of everything now
  backups [--json]  list the copies
  restore --file F --confirm NAME [--key-file K]
                    replace everything with the copy F (a copy of what is there is made first). NAME is the
                    installation's name as the web shows it; K holds the key the copy was made with (default: this
                    installation's). Everyone signs in again afterwards
  web-updates enable [--repo-key F | --repo-token-file F]
                    let an administrator update rsc-brain from its web: a container of its own runs update when
                    asked. It has full control of Docker on this machine, so whoever controls it controls this
                    server; it is off until you turn it on. F holds the read access to a private repository
                    (an SSH private key, or a token); it is copied for the updater alone. Not for an
                    installation made by rsc-factory (exit 2): update it from there
  web-updates disable
                    stop it and remove its container and the credential; the web shows the command again
  web-updates status
                    whether updates from the web are on
  key show          print the installation key (it opens the copies; keep it safe)
  key rotate        make a new installation key and seal everything with it (rsc-brain stops for a moment).
                    Copies made before need the previous key: it is kept in installation-key-<id>.txt.
                    A rotation stopped halfway is finished by running key rotate again
  uninstall         stop rsc-brain and remove its containers; the data, the copies and the key are kept
    --delete-data --confirm NAME [--db-admin-url-file F]
                    also remove the database and the copies (NAME: the name given at install, default rsc-brain)

Install options:
  --local | --domain D      this machine only (http://localhost:PORT), or a server with HTTPS for the domain D
  --db bundled|existing|shared
                            the PostgreSQL: rsc-brain's own (default), an existing one, or the one rsc-factory uses
  --db-url-file F           existing: the URL of a database for rsc-brain alone (F, or - for the standard input)
  --db-admin-url-file F     existing or shared: an administration login, used once to make rsc-brain's database
                            and role; never kept
  --factory-db NAME         shared: the other program's database; neither can connect to the other's
  --port N                  the port of the web on this machine (default 8090; published on 127.0.0.1 only)
  --http-port N, --https-port N
                            server: the ports Caddy publishes (default 80 and 443)
  --dir D                   where the installation lives (default ~/rsc-brain, or /opt/rsc-brain for a server)
  --name N                  the installation's name on this machine (default rsc-brain)
  --version vX.Y.Z | --image I
                            build that version from the source (default: the latest), or use an image already built
  --repo URL                where the source is fetched from (default the public repository); while it is
                            private, an address git can read with your access (SSH, or git's credential helper)
  --companion               installed by rsc-factory (needs --attach-network and --factory-url): no Caddy of its
                            own, and the first-time setup is rsc-factory's, with a one-time key (companionToken)
  --attach-network NAME     companion: the Docker network shared with rsc-factory; rsc-brain joins it as rsc-brain
  --factory-url URL         companion: the address of rsc-factory (https, or http://localhost on this machine)
  --trusted-proxy IP        companion with --domain: the fixed address of rsc-factory's Caddy on that network
  --yes                     ask nothing; whatever is missing is an error that names the option giving it
  --json                    print only a JSON summary on standard output; everything else goes to the error stream

Exit codes: 0 done, 2 wrong usage, 3 a requirement is missing (nothing was changed), 4 failed and put back, 1 other."

# ---------------------------------------------------------------------------------------------------------- output
# Progress, questions and errors go to the error stream; results to standard output (never with --json).
JSON=0
say() { printf '%s\n' "$*" >&2; }
step() { printf '==> %s\n' "$*" >&2; }
out() { [ "$JSON" = 1 ] || printf '%s\n' "$*"; }
usage() {
  say "$1"
  say "Run 'sh $PROG help' for the commands and options."
  exit 2
}
# A stop may come while a command's output goes to a log or to /dev/null: what the launcher says then goes to the
# error stream and the standard output it started with, kept in 4 and 5 (3 is the terminal questions are read from).
to_terminal() { exec 2>&4 1>&5; }
json_str() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

# ----------------------------------------------------------------------------------------------------------- input
# Questions are asked on the terminal, never on the standard input (which may carry a secret, or be closed).
ASKING=0
YES=0
can_ask() {
  [ "$YES" = 0 ] || return 1
  [ "$ASKING" = 1 ] && return 0
  if (: <"$TTY") 2>/dev/null; then
    exec 3<"$TTY"
    ASKING=1
    return 0
  fi
  return 1
}
ask() {
  printf '%s' "$1" >&2
  if ! IFS= read -r ANSWER <&3; then
    say ''
    say 'No answer. Nothing was changed.'
    exit 2
  fi
  ANSWER=$(printf '%s' "$ANSWER" | tr -d '\r')
}
# yes_no QUESTION DEFAULT(y|n): true for yes.
yes_no() {
  if [ "$2" = y ]; then ask "$1 [Y/n] "; else ask "$1 [y/N] "; fi
  case $ANSWER in
  '') [ "$2" = y ] ;;
  [yY] | [yY][eE][sS]) return 0 ;;
  *) return 1 ;;
  esac
}

# ------------------------------------------------------------------------------------------------------ the options
CMD=${1:-}
[ $# -gt 0 ] && shift
case $CMD in
'') usage "$USAGE" ;;
help | -h | --help)
  printf '%s\n' "$USAGE"
  exit 0
  ;;
install | update | status | backup | backups | restore | uninstall) ;;
web-updates)
  case ${1:-} in
  enable) CMD='web-updates enable' ;;
  disable) CMD='web-updates disable' ;;
  status) CMD='web-updates status' ;;
  *) usage 'Say web-updates enable, web-updates disable or web-updates status.' ;;
  esac
  shift
  ;;
key)
  case ${1:-} in
  show) CMD='key show' ;;
  rotate) CMD='key rotate' ;;
  *) usage 'Say key show or key rotate.' ;;
  esac
  shift
  ;;
*) usage "Unknown command. $USAGE" ;;
esac

MODE='' DOMAIN='' DB='' DB_URL_FILE='' ADMIN_URL_FILE='' FACTORY_DB='' PORT='' HTTP_PORT='' HTTPS_PORT=''
DIR='' DIR_GIVEN=0 NAME='' VERSION='' IMAGE='' COPY_FILE='' KEY_FILE='' CONFIRM='' CONFIRM_SET=0 DELETE_DATA=0
COMPANION=0 SHARED_NET='' FACTORY_URL='' TRUSTED_PROXY='' CHECK=0 REPO_KEY='' REPO_TOKEN=''
OPT=''
# The option goes with these commands only.
only() {
  case " $* " in
  *" $(printf '%s' "$CMD" | tr ' ' -) "*) ;;
  *) usage "$OPT does not go with $CMD." ;;
  esac
}
value() {
  [ $# -ge 2 ] || usage "$1 needs a value."
  case $2 in --*) usage "$1 needs a value." ;; esac
}
while [ $# -gt 0 ]; do
  OPT=${1%%=*}
  case $1 in
  --local) only install && MODE=local ;;
  --domain) only install && value "$@" && DOMAIN=$2 && shift ;;
  --db) only install && value "$@" && DB=$2 && shift ;;
  --db-url-file) only install && value "$@" && DB_URL_FILE=$2 && shift ;;
  --db-admin-url-file) only install uninstall && value "$@" && ADMIN_URL_FILE=$2 && shift ;;
  --factory-db) only install && value "$@" && FACTORY_DB=$2 && shift ;;
  --port) only install && value "$@" && PORT=$2 && shift ;;
  --http-port) only install && value "$@" && HTTP_PORT=$2 && shift ;;
  --https-port) only install && value "$@" && HTTPS_PORT=$2 && shift ;;
  --name) only install && value "$@" && NAME=$2 && shift ;;
  --companion) only install && COMPANION=1 ;;
  --attach-network) only install && value "$@" && SHARED_NET=$2 && shift ;;
  --factory-url) only install && value "$@" && FACTORY_URL=$2 && shift ;;
  --trusted-proxy) only install && value "$@" && TRUSTED_PROXY=$2 && shift ;;
  --version) only install update && value "$@" && VERSION=$2 && shift ;;
  --image) only install update && value "$@" && IMAGE=$2 && shift ;;
  --repo) only install update && value "$@" && REPO=$2 && REPO_GIVEN=1 && shift ;;
  --check) only update && CHECK=1 ;;
  --repo-key) only web-updates-enable && value "$@" && REPO_KEY=$2 && shift ;;
  --repo-token-file) only web-updates-enable && value "$@" && REPO_TOKEN=$2 && shift ;;
  --file) only restore && value "$@" && COPY_FILE=$2 && shift ;;
  --key-file) only restore && value "$@" && KEY_FILE=$2 && shift ;;
  --confirm) only restore uninstall && value "$@" && CONFIRM=$2 && CONFIRM_SET=1 && shift ;;
  --delete-data) only uninstall && DELETE_DATA=1 ;;
  --dir) value "$@" && DIR=$2 && DIR_GIVEN=1 && shift ;;
  --yes) YES=1 ;;
  --json) only install update status backup backups restore key-rotate && JSON=1 ;;
  --*=*) usage "Write $OPT and its value apart: $OPT VALUE." ;;
  --*) usage "Unknown option $OPT." ;;
  *) usage 'Unexpected argument (not repeated here: it could be a secret). Secrets are read from files: --db-url-file, --db-admin-url-file, --key-file.' ;;
  esac
  shift
done

is_port() {
  case $1 in '' | 0* | *[!0-9]*) return 1 ;; esac
  [ ${#1} -le 5 ] && [ "$1" -le 65535 ]
}
matches() { printf '%s\n' "$1" | grep -Eq "$2"; }
is_ipv4() {
  matches "$1" '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' || return 1
  oldifs=$IFS
  IFS=.
  # shellcheck disable=SC2086
  set -- $1
  IFS=$oldifs
  for o in "$@"; do [ "$o" -le 255 ] || return 1; done
}

if [ "$CMD" = install ] || [ "$CMD" = update ]; then
  [ -n "$VERSION" ] && [ -n "$IMAGE" ] && usage 'Pass --version or --image, not both.'
  [ "$CHECK" = 1 ] && [ -n "$VERSION$IMAGE" ] && usage '--check only looks: it does not go with --version or --image.'
  case $REPO in *"'"* | *"$NL"*) usage '--repo cannot hold a quote or a line break.' ;; esac
  [ -z "$VERSION" ] || matches "$VERSION" '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$' ||
    usage '--version takes a published version such as v1.2.0.'
  [ -z "$IMAGE" ] || matches "$IMAGE" '^[A-Za-z0-9][A-Za-z0-9._/:@-]*$' || usage '--image takes an image name such as rsc-brain:v1.2.0.'
fi
if [ "$CMD" = install ]; then
  [ -n "$MODE" ] && [ -n "$DOMAIN" ] && usage 'Pass --local or --domain D, not both.'
  if [ -n "$DOMAIN" ]; then
    DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
    if [ ${#DOMAIN} -gt 253 ] || ! matches "$DOMAIN" '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$'; then
      usage '--domain takes a domain name such as brain.example.com (no http://, no port, no path).'
    fi
    MODE=server
  fi
  case $DB in '' | bundled | existing | shared) ;; *) usage '--db is bundled, existing or shared.' ;; esac
  for p in "$PORT" "$HTTP_PORT" "$HTTPS_PORT"; do
    [ -z "$p" ] || is_port "$p" || usage '--port, --http-port and --https-port take a port number from 1 to 65535.'
  done
  [ -z "$NAME" ] || matches "$NAME" '^[a-z0-9][a-z0-9_-]{0,39}$' ||
    usage '--name takes lower-case letters, digits, - and _ (up to 40), starting with a letter or a digit.'
  [ -z "$FACTORY_DB" ] || matches "$FACTORY_DB" '^[a-z_][a-z0-9_]{0,62}$' || usage '--factory-db takes a database name such as rsc_factory.'
  if [ "$DB" = existing ] && [ -z "$DB_URL_FILE" ] && [ -z "$ADMIN_URL_FILE" ] && [ "$YES" = 1 ]; then
    usage '--db existing needs --db-url-file F (a database for rsc-brain alone) or --db-admin-url-file F (a login that can make one).'
  fi
  [ -n "$DB_URL_FILE" ] && [ -n "$ADMIN_URL_FILE" ] && usage 'Pass --db-url-file or --db-admin-url-file, not both.'
  if [ "$DB" = shared ] && { [ -z "$FACTORY_DB" ] || [ -z "$ADMIN_URL_FILE" ]; } && [ "$YES" = 1 ]; then
    usage '--db shared needs --db-admin-url-file F (an administration login of that PostgreSQL) and --factory-db NAME (the other program'"'"'s database).'
  fi
  [ "$DB" = shared ] && [ -n "$DB_URL_FILE" ] && usage '--db shared makes its own database: pass --db-admin-url-file, not --db-url-file.'
  [ -n "$FACTORY_DB" ] && [ "$DB" != shared ] && usage '--factory-db goes with --db shared.'
  [ "$DB" = bundled ] && { [ -n "$DB_URL_FILE" ] || [ -n "$ADMIN_URL_FILE" ]; } && usage '--db bundled takes no URL file.'
  [ -z "$DB" ] && { [ -n "$DB_URL_FILE" ] || [ -n "$ADMIN_URL_FILE" ]; } && DB=existing
  # Companion mode (installed by rsc-factory): its options go with --companion, and are checked before anything runs.
  if [ "$COMPANION" = 0 ]; then
    for o in "--attach-network:$SHARED_NET" "--factory-url:$FACTORY_URL" "--trusted-proxy:$TRUSTED_PROXY"; do
      [ -z "${o#*:}" ] || usage "${o%%:*} goes with --companion (rsc-brain installed by rsc-factory)."
    done
  else
    [ -z "$SHARED_NET" ] || matches "$SHARED_NET" '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$' ||
      usage '--attach-network takes the name of a Docker network, such as rsc-shared.'
    if [ -n "$FACTORY_URL" ]; then
      FACTORY_URL=${FACTORY_URL%/}
      # As the service checks it (factoryUrlOf): https, or http on this machine; no credentials, query or fragment;
      # only characters a shell reads as text; a real port; at most 300 characters.
      fu_rest=${FACTORY_URL#*://} fu_port=''
      fu_host=${fu_rest%%/*}
      case $fu_host in *:*) fu_port=${fu_host##*:} ;; esac
      { [ ${#FACTORY_URL} -le 300 ] && { [ -z "$fu_port" ] || is_port "$fu_port"; } &&
        matches "$FACTORY_URL" '^(https://[a-z0-9.-]+|http://(localhost|127\.0\.0\.1))(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'; } ||
        usage '--factory-url takes the address of rsc-factory: https://factory.example.com, or http://localhost:PORT on this machine (lower-case, no query).'
    fi
    [ -z "$TRUSTED_PROXY" ] || is_ipv4 "$TRUSTED_PROXY" || usage '--trusted-proxy takes an IPv4 address, such as 192.168.210.2.'
    [ "$DB" = bundled ] &&
      usage '--companion uses the PostgreSQL of rsc-factory (--db shared) or an existing one (--db existing), not --db bundled.'
    [ -n "$HTTP_PORT$HTTPS_PORT" ] &&
      usage "--http-port and --https-port do not go with --companion: rsc-factory's Caddy serves rsc-brain."
  fi
fi
if [ "$CMD" = 'web-updates enable' ]; then
  [ -n "$REPO_KEY" ] && [ -n "$REPO_TOKEN" ] && usage 'Pass --repo-key or --repo-token-file, not both.'
fi
if [ "$CMD" = restore ]; then
  [ -n "$COPY_FILE" ] || usage 'Pass --file with the copy to restore.'
fi
[ "$CMD" = uninstall ] && [ "$DELETE_DATA" = 0 ] && [ "$CONFIRM_SET" = 1 ] && usage '--confirm goes with --delete-data.'
[ "$CMD" = uninstall ] && [ "$DELETE_DATA" = 0 ] && [ -n "$ADMIN_URL_FILE" ] && usage '--db-admin-url-file goes with --delete-data.'

if [ -n "$DIR" ]; then
  case $DIR in /*) ;; *) DIR=$(pwd)/$DIR ;; esac
  case $DIR in *"$NL"* | *"'"*) usage '--dir cannot hold a quote or a line break.' ;; esac
  DIR=${DIR%/}
fi

# ----------------------------------------------------------------------------------------------- the installation
# Everything the launcher keeps for itself lives in <dir>/.rsc-brain (the source it builds from, an install still in
# progress, the settings before a change). An installation is a folder whose .env the launcher wrote (it carries
# RSC_BRAIN_LAUNCHER='1'); .env is written only once an install has completed.
STATE=.rsc-brain
ENV_FILE='' PROFILES=''
# file_get FILE NAME: a value of a settings file (.env, or a journal) as say_env wrote it.
file_get() { sed -n "s/^$2='\\(.*\\)'\$/\\1/p" "$1" 2>/dev/null | head -n 1; }
env_get() { file_get "$ENV_FILE" "$1"; }
# env_with NAME VALUE <IN >OUT: the settings with NAME set to VALUE. The value never goes on a command line (it can be
# the installation key, and a command line is readable by anyone on the machine).
env_with() {
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
    "$1="*) printf "%s='%s'\n" "$1" "$2" ;;
    *) printf '%s\n' "$line" ;;
    esac
  done
}
# redact SECRET... <IN >OUT: every secret given replaced by [redacted], with no other program seeing them.
redact() {
  while IFS= read -r line || [ -n "$line" ]; do
    for s in "$@"; do
      [ -n "$s" ] || continue
      done_part=''
      while :; do
        case $line in
        *"$s"*)
          done_part="$done_part${line%%"$s"*}[redacted]"
          line=${line#*"$s"}
          ;;
        *) break ;;
        esac
      done
      line=$done_part$line
    done
    printf '%s\n' "$line"
  done
}
is_installation() { [ -f "$1/.env" ] && grep -q "^RSC_BRAIN_LAUNCHER='1'\$" "$1/.env"; }

# Where an installation is when --dir is not given: the one for this machine, or the one for a server.
find_dir() {
  [ -n "$DIR" ] && return
  for d in "${HOME:-/nonexistent}/rsc-brain" /opt/rsc-brain; do
    if is_installation "$d"; then
      DIR=$d
      return
    fi
  done
  DIR=${HOME:-/nonexistent}/rsc-brain
}
need_installation() {
  find_dir
  if ! is_installation "$DIR"; then
    [ "$CHECK" = 1 ] && [ "$JSON" = 1 ] && check_answer '' false '' missing
    say "No rsc-brain installation in \"$DIR\". Pass --dir with the folder it was installed in. Nothing was changed."
    exit 3
  fi
  ENV_FILE=$DIR/.env
  NAME=$(env_get RSC_BRAIN_NAME)
  PROFILES=$(env_get COMPOSE_PROFILES)
}

# One launcher at a time per folder: <dir>/.rsc-brain/lock, made atomically, names the process and the machine. A lock
# whose process is gone (on this machine) is taken over; the journal of an interrupted install is then taken back.
LOCKED=0 LOCK_MADE_DIR=0 LOCK_MADE_STATE=0
host_name() { uname -n 2>/dev/null; }
# The lock is not free. Usually nothing was changed; a `web-updates disable` has already removed the credential, and says so.
LOCK_AFTER_DISABLE_STEP=0
lock_refused() {
  if [ "$LOCK_AFTER_DISABLE_STEP" = 1 ]; then
    say "$1"
    say 'The credential is removed, but the updater was not stopped: it is still running, without its credential, and it'
    say "starts nothing. Run: sh $PROG web-updates disable --dir \"$DIR\" again when the other launcher has finished."
    exit 3
  fi
  missing "$1"
}
take_lock() {
  lock=$DIR/$STATE/lock
  if [ ! -d "$DIR" ]; then
    mkdir -p "$DIR" 2>/dev/null || missing "Cannot create \"$DIR\". Pass --dir with a folder you may write in (or run as root for /opt)."
    chmod 700 "$DIR"
    LOCK_MADE_DIR=1
  fi
  [ -d "$DIR/$STATE" ] || { mkdir "$DIR/$STATE" 2>/dev/null && LOCK_MADE_STATE=1; }
  # From the moment the lock may exist, whatever ends this run lets it go (and what was made only to hold it).
  trap release_lock EXIT
  tries=0
  until mkdir "$lock" 2>/dev/null; do
    owner=$(cat "$lock/owner" 2>/dev/null)
    if [ -z "$owner" ]; then
      # Just made by another launcher, which has not written its name yet.
      tries=$((tries + 1))
      [ "$tries" -gt 5 ] && lock_refused "Another rsc-brain launcher is working on \"$DIR\". Wait for it to finish."
      sleep 1
      continue
    fi
    pid=${owner%% *} who=${owner#* }
    [ "$who" = "$(host_name)" ] ||
      lock_refused "Another rsc-brain launcher, on $who, is working on \"$DIR\" (process $pid). Wait for it to finish; if it is not running any more, remove \"$lock\"."
    kill -0 "$pid" 2>/dev/null &&
      lock_refused "Another rsc-brain launcher is working on \"$DIR\" (process $pid). Wait for it to finish."
    say "Taking over from a launcher that stopped (process $pid)."
    rm -rf "${lock:?}"
  done
  printf '%s %s\n' "$$" "$(host_name)" >"$lock/owner"
  LOCKED=1
}
release_lock() {
  [ "$LOCKED" = 1 ] && rm -rf "${DIR:?}/${STATE:?}/lock"
  LOCKED=0
  # What was made only to hold the lock goes if it is still empty.
  [ "$LOCK_MADE_STATE" = 1 ] && rmdir "$DIR/$STATE" 2>/dev/null
  [ "$LOCK_MADE_DIR" = 1 ] && rmdir "$DIR" 2>/dev/null
  return 0
}
# A test hook: stop dead right after a step, as a power cut would (or with another signal, as a Ctrl-C would).
checkpoint() {
  [ "${RSC_BRAIN_TEST_STOP_AT:-}" = "$1" ] && kill -"${RSC_BRAIN_TEST_STOP_SIGNAL:-KILL}" $$
  return 0
}

# What docker compose would take from this shell instead of the installation's file: the variables compose.yaml
# names, and Compose's own. They are removed for every compose call.
FIXED_VARS='COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PATH_SEPARATOR
POSTGRES_PASSWORD RSC_BRAIN_SECRET RSC_BRAIN_DATABASE_URL RSC_BRAIN_PUBLISH RSC_BRAIN_IMAGE RSC_BRAIN_DOMAIN
RSC_BRAIN_ACME_CA RSC_BRAIN_SHARED_NETWORK'
compose_vars() {
  {
    # shellcheck disable=SC2086
    printf '%s\n' $FIXED_VARS
    for f in "$@"; do
      # shellcheck disable=SC2016
      [ -f "$f" ] && grep -o '\${[A-Z_][A-Z0-9_]*' "$f" | sed 's/^\${//'
    done
  } | sort -u
}
warn_shell_vars() {
  set_here=''
  for v in $(compose_vars "$HERE/compose.yaml" "${DIR:-/nonexistent}/compose.yaml" "${DIR:-/nonexistent}/compose.companion.yaml"); do
    eval "isset=\${$v+x}"
    [ -n "$isset" ] && set_here="$set_here $v"
  done
  [ -n "$set_here" ] && say "Ignored, set in this shell:$set_here. rsc-brain takes its settings from its own .env only."
  return 0
}

# docker compose, always for this installation's project and files (and never anything else's), with none of the
# installation's values taken from this shell.
# With SHIELD=1 (what must not stop halfway: the way back of an update, a key reseal) it runs out of the terminal's
# process group. Ignoring SIGINT here is not enough: docker compose takes a Ctrl-C back even when it started with it
# ignored, passes it to the container and stops waiting for it (Docker 29.1, Compose 5.0: `run --rm` exits 130 and
# the container goes on, or stops). In a session of its own a Ctrl-C at the terminal does not reach it: setsid
# (util-linux, busybox), or perl's (macOS has perl, not setsid). A session has no terminal, so `stty tostop` cannot stop
# it either; job control (set -m) was no way: dash has none in a subshell, and tostop stops a background job that
# writes. With neither, it runs as any other call (the known limit, said in the README).
SHIELD=0
DC_BOUND=0 DC_GROUP=0
dc() {
  [ -f "$DIR/compose.override.yaml" ] && set -- -f "$DIR/compose.override.yaml" "$@"
  # Companion mode: the app also joins the network shared with rsc-factory (written by install).
  [ -f "$DIR/compose.companion.yaml" ] && set -- -f "$DIR/compose.companion.yaml" "$@"
  set -- -f "$DIR/compose.yaml" "$@"
  for p in $(printf '%s' "$PROFILES" | tr ',' ' '); do
    set -- --profile "$p" "$@"
  done
  if [ "${DC_BOUND:-0}" -gt 0 ]; then
    # Bounded: the call is this shell's own job (it is docker itself: nothing in between to leave behind), ended at
    # the bound. No timeout(1) on a Mac, so it is looked at until it ends or the time is up.
    dc_child "$@" &
    dcb_pid=$!
    dcb_end=$(($(date +%s) + DC_BOUND))
    while kill -0 "$dcb_pid" 2>/dev/null; do
      if [ "$(date +%s)" -ge "$dcb_end" ]; then
        # KILL: what is ignored here (the tail ignores TERM) is ignored by docker too, and a hung call has no use for a
        # goodbye. The whole group: docker compose runs its plugin as a child, and a KILL on docker is not passed on.
        # The group is the call's own only when it leads one (dc_bounded makes sure it does); the launcher's never.
        if [ "$DC_GROUP" = 1 ]; then kill -s KILL -- "-$dcb_pid" 2>/dev/null; else kill -s KILL "$dcb_pid" 2>/dev/null; fi
        wait "$dcb_pid" 2>/dev/null
        return 124
      fi
      sleep 0.1 2>/dev/null || sleep 1
    done
    wait "$dcb_pid"
    return $?
  fi
  ( dc_child "$@" )
}
# The docker call of dc. Run as a subshell of its own it becomes docker (exec), so the process id is docker's.
dc_child() {
  for v in $(compose_vars "$DIR/compose.yaml" "$DIR/compose.companion.yaml" "$DIR/compose.override.yaml"); do unset "$v"; done
  set -- compose --project-directory "$DIR" -p "$NAME" --env-file "$ENV_FILE" "$@"
  [ "$SHIELD" = 1 ] || exec docker "$@"
  command -v setsid >/dev/null 2>&1 && exec setsid docker "$@"
  # This subshell is not a process group leader (no job control here), so setsid() does not fail.
  command -v perl >/dev/null 2>&1 &&
    exec perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!\n"; exec @ARGV or die "$ARGV[0]: $!\n"' docker "$@"
  exec docker "$@"
}
# A call of dc that is ended after TAIL_WAIT seconds (exit 124), with everything it started: it always runs shielded,
# so it leads a session (and group) of its own that can be ended whole. With neither setsid nor perl there is no such
# group: then only the call's own process is ended, never the launcher's group. (What the call already asked of the
# container, an exec in it, cannot be reached from here and may still land late.)
dc_bounded() {
  dcb_shield=$SHIELD
  SHIELD=1
  DC_BOUND=$TAIL_WAIT
  DC_GROUP=0
  if command -v setsid >/dev/null 2>&1 || command -v perl >/dev/null 2>&1; then DC_GROUP=1; fi
  dc "$@"
  dcb_code=$?
  DC_BOUND=0
  DC_GROUP=0
  SHIELD=$dcb_shield
  return "$dcb_code"
}

running() { [ -n "$(dc ps -q app 2>/dev/null </dev/null)" ]; }
healthy() { dc exec -T app wget -q -O /dev/null http://127.0.0.1:8090/v1/health >/dev/null 2>&1 </dev/null; }
wait_healthy() {
  i=0
  while [ "$i" -lt "$WAIT_SECONDS" ]; do
    healthy && return 0
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------------------------------------- requirements (CA4)
missing() {
  [ "$CHECK" = 1 ] && [ "$JSON" = 1 ] && check_answer '' false '' missing
  say "$1"
  say 'Nothing was changed.'
  exit 3
}
need_docker() {
  command -v docker >/dev/null 2>&1 ||
    missing 'Docker is not installed. Install Docker Desktop (macOS) or Docker Engine (Linux): https://docs.docker.com/get-docker/ and run this again.'
  if ! info=$(docker info 2>&1 </dev/null); then
    case $info in
    *[Pp]ermission\ denied*)
      # shellcheck disable=SC2016
      missing 'Your user cannot use Docker. Add it to the docker group (sudo usermod -aG docker $USER, then log in again) or run with sudo.'
      ;;
    esac
    missing 'Docker is not running. Start Docker Desktop (or the docker service: sudo systemctl start docker) and run this again.'
  fi
  docker compose version >/dev/null 2>&1 </dev/null ||
    missing 'Docker Compose v2 is missing (the "docker compose" command). Install it: https://docs.docker.com/compose/install/'
}

# 0: something listens on the port; 1: free; 2: no tool here can tell.
port_busy() {
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 2 127.0.0.1 "$1" >/dev/null 2>&1 </dev/null && return 0
    return 1
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    return 1
  fi
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ] && return 0
    return 1
  fi
  if command -v bash >/dev/null 2>&1; then
    bash -c "exec 3<>/dev/tcp/127.0.0.1/$1" >/dev/null 2>&1 </dev/null && return 0
    return 1
  fi
  return 2
}
next_free() {
  q=$(($1 + 1))
  while [ "$q" -le 65535 ] && [ "$q" -le $(($1 + 100)) ]; do
    port_busy "$q" || {
      echo "$q"
      return
    }
    q=$((q + 1))
  done
  echo ''
}
# free_port VARIABLE OPTION: the port in VARIABLE is free, or another one is chosen with the person, or exit 3.
free_port() {
  fp=''
  eval "fp=\$$1"
  port_busy "$fp"
  case $? in
  1) return 0 ;;
  2)
    say "This machine has no nc, lsof, ss or bash: cannot check whether port $fp is free. Going on."
    return 0
    ;;
  esac
  alt=$(next_free "$fp")
  if can_ask && [ -n "$alt" ]; then
    if yes_no "Port $fp is in use on this machine. Use $alt instead?" y; then
      eval "$1=\$alt"
      return 0
    fi
  fi
  missing "Port $fp is in use on this machine. Pass a free one with $2 N${alt:+ ($alt is free)}."
}

# The URL in a file (or - for the standard input), whole, checked for what .env could not keep as written.
read_url() {
  if [ "$1" = - ]; then RU=$(cat); else
    [ -r "$1" ] || usage "The file \"$1\" cannot be read."
    RU=$(cat -- "$1")
  fi
  case $RU in
  *"$NL"* | *"$CR"* | *"'"*) usage "The URL in \"$1\" holds a line break or a quote; percent-encode a quote as %27." ;;
  postgres://?* | postgresql://?*) ;;
  *) usage "The file \"$1\" does not hold a PostgreSQL URL (postgres://...)." ;;
  esac
}

# A private subnet no Docker network on this machine uses, for this installation's own network.
ip_int() {
  oldifs=$IFS
  IFS=.
  # shellcheck disable=SC2086
  set -- $1
  IFS=$oldifs
  echo $((($1 << 24) + ($2 << 16) + ($3 << 8) + $4))
}
pick_subnet() {
  ids=$(docker network ls -q 2>/dev/null </dev/null)
  used=''
  # shellcheck disable=SC2086
  [ -n "$ids" ] && used=$(docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' $ids 2>/dev/null </dev/null)
  c=200
  while [ "$c" -le 254 ]; do
    cand=$(ip_int "192.168.$c.0")
    clash=0
    for s in $used; do
      case $s in *.*.*.*/*) ;; *) continue ;; esac
      len=${s#*/}
      net=$(ip_int "${s%/*}")
      [ "$len" -gt 24 ] && len=24
      [ $((cand >> (32 - len))) -eq $((net >> (32 - len))) ] && clash=1 && break
    done
    if [ "$clash" = 0 ]; then
      SUBNET=192.168.$c.0/24 PROXY_IP=192.168.$c.2 IP_RANGE=192.168.$c.128/25
      return 0
    fi
    c=$((c + 1))
  done
  missing 'No free 192.168.200-254.0/24 network for rsc-brain: remove unused Docker networks (docker network prune) and run this again.'
}

# Companion mode: Docker new enough to keep the default route on the installation's own network (gw_priority), and the
# network shared with rsc-factory, which rsc-factory's installer makes: its IPv4 subnet and gateway go to the service
# (the handshake answers only from that subnet, never from its gateway).
int_ip() { echo "$(($1 >> 24 & 255)).$(($1 >> 16 & 255)).$(($1 >> 8 & 255)).$(($1 & 255))"; }
# version_at_least VERSION MAJOR MINOR: VERSION (such as v2.38.2 or 29.1.5) is MAJOR.MINOR or newer.
version_at_least() {
  v=$(printf '%s' "$1" | sed -n 's/^[^0-9]*\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p')
  [ -n "$v" ] || return 1
  # shellcheck disable=SC2086
  set -- $v "$2" "$3"
  [ "$1" -gt "$3" ] || { [ "$1" -eq "$3" ] && [ "$2" -ge "$4" ]; }
}
SHARED_CIDR='' SHARED_GW='' COMPANION_TOKEN=''
companion_requirements() {
  # On this machine only (--local), «this machine only» trusts the gateway of the installation's own network, and a
  # request through the published port arrives from the network that holds the default route: gw_priority keeps it
  # on the own network (measured with Docker 29.1: without it, the order of the names decides). A server needs neither.
  if [ "$MODE" = local ]; then
    version_at_least "$(docker compose version 2>/dev/null </dev/null)" 2 33 ||
      missing 'Companion mode on this machine needs Docker Compose 2.33 or newer (and Docker Engine 28 or newer). Update Docker and run this again.'
    version_at_least "$(docker version --format '{{.Server.Version}}' 2>/dev/null </dev/null)" 28 0 ||
      missing 'Companion mode on this machine needs Docker Engine 28 or newer (and Docker Compose 2.33 or newer). Update Docker and run this again.'
  fi
  info=$(docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}}|{{.Gateway}} {{end}}{{if .EnableIPv6}}ipv6{{end}}' "$SHARED_NET" 2>/dev/null </dev/null) ||
    missing "There is no Docker network $SHARED_NET. rsc-factory's installer makes it before it installs rsc-brain; pass --attach-network with the network rsc-factory uses."
  # IPv4 only: the handshake answers by the IPv4 subnet, and over IPv6 rsc-factory could reach rsc-brain from an address
  # it does not know.
  for e in $info; do
    case $e in ipv6 | *:*)
      usage "The Docker network $SHARED_NET has IPv6 on. Companion mode works over IPv4 only: make the network without --ipv6 (docker network create --subnet <IPv4/24> $SHARED_NET)."
      ;;
    esac
  done
  SHARED_CIDR='' SHARED_GW=''
  for e in $info; do
    case ${e%%|*} in
    *.*.*.*/*)
      SHARED_CIDR=${e%%|*} SHARED_GW=${e#*|}
      break
      ;;
    esac
  done
  len=${SHARED_CIDR#*/}
  case $len in '' | *[!0-9]*) len=0 ;; esac
  { [ "$len" -ge 8 ] && [ "$len" -le 30 ]; } ||
    missing "The Docker network $SHARED_NET has no IPv4 subnet from /8 to /30. rsc-factory's installer makes it with one (docker network create --subnet)."
  net=$(($(ip_int "${SHARED_CIDR%/*}") >> (32 - len)))
  [ -n "$SHARED_GW" ] || SHARED_GW=$(int_ip $(((net << (32 - len)) + 1)))
  if [ -n "$TRUSTED_PROXY" ]; then
    if [ $(($(ip_int "$TRUSTED_PROXY") >> (32 - len))) -ne "$net" ] || [ "$TRUSTED_PROXY" = "$SHARED_GW" ]; then
      usage "--trusted-proxy $TRUSTED_PROXY is not an address of $SHARED_NET ($SHARED_CIDR) other than its gateway: give the fixed address of rsc-factory's Caddy on that network."
    fi
  fi
}
# The app joins the shared network as rsc-brain; its own network keeps the default route (RSC_BRAIN_LOCAL_ONLY trusts
# that gateway as this machine).
write_companion_compose() {
  {
    echo '# Companion mode, written by rsc-brain.sh install --companion (do not edit: install writes it again). The app'
    echo "# joins the Docker network it shares with rsc-factory, which reaches it there as http://rsc-brain:8090; rsc-factory's"
    echo '# Caddy serves its web address. Its own network keeps the default route.'
    echo 'services:'
    echo '  app:'
    echo '    networks:'
    if [ "$MODE" = local ]; then
      echo '      default:'
      echo '        gw_priority: 1'
    else
      echo '      default: {}'
    fi
    echo '      shared:'
    echo '        aliases:'
    echo '          - rsc-brain'
    # The stand-in door answers there under the same name; only where the compose file has one (a service without an
    # image would stop every compose call).
    if grep -q '^  door:$' "$DIR/compose.yaml" 2>/dev/null; then
      echo '  door:'
      echo '    networks:'
      if [ "$MODE" = local ]; then
        echo '      default:'
        echo '        gw_priority: 1'
        echo '        aliases:'
        echo '          - app'
      else
        echo '      default:'
        echo '        aliases:'
        echo '          - app'
      fi
      echo '      shared:'
      echo '        aliases:'
      echo '          - rsc-brain'
    fi
    echo 'networks:'
    echo '  shared:'
    # shellcheck disable=SC2016
    echo '    name: ${RSC_BRAIN_SHARED_NETWORK:?run rsc-brain.sh install}'
    echo '    external: true'
  } >"$DIR/compose.companion.yaml.new" && chmod 644 "$DIR/compose.companion.yaml.new" &&
    mv -f "$DIR/compose.companion.yaml.new" "$DIR/compose.companion.yaml"
}

# ---------------------------------------------------------------------------------------------------------- install
# What this run made, so a failure (or a stop) takes back exactly that. During a first install the same is kept in
# <dir>/.rsc-brain/install.pending, so a run that was killed can be taken back by the next one.
MADE_DIR=0 MADE_IMAGE=0 MADE_FILES='' PROVISIONED=0 STARTED=0 REINSTALL=0 RESUME=0 FAILURE_LOG=''

take_back() {
  if [ "$REINSTALL" = 1 ]; then
    if [ -f "${DIR:?}/${STATE:?}/env.previous" ]; then
      mv -f "${DIR:?}/${STATE:?}/env.previous" "$DIR/.env"
      ENV_FILE=$DIR/.env
      PROFILES=$(env_get COMPOSE_PROFILES)
      step 'Starting the previous settings again'
      dc up -d --remove-orphans >&2 </dev/null || say "The previous installation did not start either: see docker compose logs in \"$DIR\"."
    fi
    return 0
  fi
  if [ "$PROVISIONED" = 1 ] && [ "$DB" != bundled ]; then
    step "Removing the database $DB_NAME it made"
    printf '%s\n' "$ADMIN_URL" | dc run --rm -T --no-deps app rsc-brain db drop --database "$DB_NAME" --role "$DB_NAME" \
      --confirm "$DB_NAME" >&2 || say "Could not remove the database $DB_NAME and the role $DB_NAME: remove them by hand."
  fi
  if [ "$STARTED" = 1 ]; then
    step 'Removing the containers, network and volumes it made'
    dc down -v --remove-orphans >&2 </dev/null
  fi
  [ "$MADE_IMAGE" = 1 ] && docker image rm "$IMAGE" >/dev/null 2>&1 </dev/null
  for f in $MADE_FILES; do rm -rf "${DIR:?}/${f:?}"; done
  [ "$MADE_DIR" = 1 ] && rmdir "$DIR" 2>/dev/null
  return 0
}

# The service's last lines, kept before the containers go, with the key and the passwords taken out.
url_password() { printf '%s' "$1" | sed -n 's|^[a-z]*://[^:/@]*:\([^@]*\)@.*|\1|p'; }
keep_failure_log() {
  [ "$STARTED" = 1 ] || return 0
  dc logs --no-color --tail 200 app </dev/null 2>&1 |
    redact "$SECRET" "$PG_PASSWORD" "$(url_password "$DATABASE_URL")" "$(url_password "$ADMIN_URL")" >"$DIR/last-failure.log.new" &&
    chmod 600 "$DIR/last-failure.log.new" && mv -f "$DIR/last-failure.log.new" "$DIR/last-failure.log" &&
    FAILURE_LOG=$DIR/last-failure.log
  return 0
}

# failed CODE MESSAGE: take back what this run made, then exit with CODE (4: failed and put back; 3: a requirement).
failed() {
  trap - HUP INT TERM
  say "$2"
  [ "$1" = 4 ] && keep_failure_log
  take_back
  if [ "$1" = 3 ]; then say 'Nothing was changed.'; else
    if [ "$REINSTALL" = 1 ]; then say 'The previous settings were put back.'; else say 'Everything it made was removed.'; fi
  fi
  [ -n "$FAILURE_LOG" ] && say "The last lines of the service are in \"$FAILURE_LOG\"."
  exit "$1"
}
interrupted() {
  trap - HUP INT TERM
  to_terminal
  say ''
  say 'Interrupted: taking back what this run made.'
  take_back
  exit 4
}

say_env() { printf "%s='%s'\n" "$1" "$2"; }
# write_env FILE [pending]: the settings, whole, written beside and moved into place.
write_env() {
  {
    echo '# rsc-brain settings, written by rsc-brain.sh. Only its owner may read this file: it holds the'
    echo '# installation key, which opens every copy. Change settings by running rsc-brain.sh install again.'
    say_env RSC_BRAIN_LAUNCHER 1
    say_env RSC_BRAIN_NAME "$NAME"
    say_env COMPOSE_PROJECT_NAME "$NAME"
    say_env COMPOSE_PROFILES "$PROFILES"
    say_env RSC_BRAIN_MODE "$MODE"
    say_env RSC_BRAIN_DB "$DB"
    say_env RSC_BRAIN_IMAGE "$IMAGE"
    say_env RSC_BRAIN_REPO_URL "$(repo_setting)"
    say_env RSC_BRAIN_SITE "$SITE"
    say_env RSC_BRAIN_SETUP_URL "$SITE"
    say_env RSC_BRAIN_DOMAIN "$DOMAIN"
    say_env RSC_BRAIN_PUBLISH "127.0.0.1:$PORT"
    say_env RSC_BRAIN_LOCAL_ONLY "$LOCAL_ONLY"
    say_env RSC_BRAIN_HTTP_PORT "$HTTP_PORT"
    say_env RSC_BRAIN_HTTPS_PORT "$HTTPS_PORT"
    say_env RSC_BRAIN_SUBNET "$SUBNET"
    say_env RSC_BRAIN_IP_RANGE "$IP_RANGE"
    say_env RSC_BRAIN_PROXY_IP "$PROXY_IP"
    say_env RSC_BRAIN_TRUSTED_PROXIES "$TRUSTED"
    say_env RSC_BRAIN_UID "$RUN_UID"
    say_env RSC_BRAIN_GID "$RUN_GID"
    say_env RSC_BRAIN_DB_NAME "$DB_NAME"
    say_env RSC_BRAIN_FACTORY_DB "$FACTORY_DB"
    say_env RSC_BRAIN_COMPANION "$COMPANION"
    say_env RSC_BRAIN_SHARED_NETWORK "$SHARED_NET"
    say_env RSC_BRAIN_COMPANION_NETWORK "$SHARED_CIDR"
    say_env RSC_BRAIN_COMPANION_GATEWAY "$SHARED_GW"
    say_env RSC_BRAIN_COMPANION_PROXY "$TRUSTED_PROXY"
    say_env RSC_BRAIN_FACTORY_URL "$FACTORY_URL"
    say_env RSC_BRAIN_COMPANION_TOKEN "$COMPANION_TOKEN"
    [ "$DB" = bundled ] && say_env POSTGRES_PASSWORD "$PG_PASSWORD"
    say_env RSC_BRAIN_DATABASE_URL "$DATABASE_URL"
    say_env RSC_BRAIN_SECRET "$SECRET"
    if [ "${2:-}" = pending ]; then
      say_env RSC_BRAIN_PENDING_MADE "$MADE_FILES"
      say_env RSC_BRAIN_PENDING_MADE_DIR "$MADE_DIR"
      say_env RSC_BRAIN_PENDING_MADE_IMAGE "$MADE_IMAGE"
      say_env RSC_BRAIN_PENDING_PROVISIONED "$PROVISIONED"
      say_env RSC_BRAIN_PENDING_STARTED "$STARTED"
    fi
  } >"$1.new" && chmod 600 "$1.new" && mv -f "$1.new" "$1"
}
# What a first install has made so far, for the next run if this one is killed.
save_state() {
  [ "$REINSTALL" = 1 ] && return 0
  write_env "$PENDING" pending || failed 4 "Could not write \"$PENDING\"."
}

random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
# What is published (rsc-updates §0): a tag vX.Y.Z of the repository, exactly, in numeric order; the same definition as
# the service's src/ops/releases.ts and rsc-factory's, pinned by test/fixtures/published-vectors.json.
# newest_of: from the lines of `git ls-remote`, the newest, or nothing.
newest_of() {
  v=$(LC_ALL=C sed -n 's|^[0-9a-f]\{1,\}[[:space:]]\{1,\}refs/tags/\(v[0-9]\{1,\}\.[0-9]\{1,\}\.[0-9]\{1,\}\)$|\1|p' |
    LC_ALL=C grep -Ev '(^v|\.)0[0-9]' | sed 's/^v//' | LC_ALL=C sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
  [ -n "$v" ] && echo "v$v"
  return 0
}
latest_version() { git ls-remote --tags --refs "$REPO" 'v*' 2>/dev/null </dev/null | newest_of; }
# An address as it may be kept and said: nothing that opens it. Over http(s), no user; elsewhere (ssh's git@), no password.
# Git and curl take the host after the last @ before the first /, and a password may hold an @.
repo_public() {
  printf '%s' "$1" | printable | LC_ALL=C sed -e 's|^\([hH][tT][tT][pP][sS]\{0,1\}://\)[^/]*@|\1|' \
    -e 's|^\([a-zA-Z0-9+.-]*://[^/:]*\):[^/]*@|\1@|' -e 's|^\([a-zA-Z0-9+.-]*://\)@|\1|'
}
# Text from outside (a CHANGELOG.md, an address) as it may reach a terminal: without what moves the cursor or clears
# lines. All control characters but tabs and line ends, DEL, and the C1 ones as UTF-8 (U+0080 to U+009F).
printable() {
  LC_ALL=C tr -d '\001-\010\013-\037\177' | LC_ALL=C sed "s/$C1_CONTROLS//g"
}
# RSC_BRAIN_REPO_URL, where the service asks for new versions: what this run was told or, on an installation that has
# one, what it has (empty: the service never asks).
repo_setting() {
  if [ "$REPO_GIVEN" = 0 ] && grep -q '^RSC_BRAIN_REPO_URL=' "$DIR/.env" 2>/dev/null; then
    file_get "$DIR/.env" RSC_BRAIN_REPO_URL
  else
    repo_public "$REPO"
  fi
}
# The launcher asks the repository of the installation, unless told another. Its being empty only silences the service.
installation_repo() {
  [ "$REPO_GIVEN" = 0 ] || return 0
  ir=$(env_get RSC_BRAIN_REPO_URL)
  [ -z "$ir" ] || REPO=$ir
}

# Only these may be in a folder before the first install: the person's own additions, the launcher itself, what an
# earlier installation left on purpose (the log of a failed one, its saved key), the launcher's own folder, and what
# file systems and desktops put everywhere.
foreign_files() {
  for f in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    case ${f##*/} in
    compose.override.yaml | last-failure.log | installation-key.txt | installation-key-*.txt | rsc-brain.sh | .rsc-brain | \
      .DS_Store | lost+found | ._* | Thumbs.db) ;;
    *)
      echo "${f##*/}"
      return
      ;;
    esac
  done
}

install() {
  # Where, and what is there already.
  if [ -z "$DIR" ]; then
    case $MODE in
    local) DIR=${HOME:-/nonexistent}/rsc-brain ;;
    server) DIR=/opt/rsc-brain ;;
    *) find_dir ;;
    esac
  fi
  PENDING=$DIR/$STATE/install.pending
  if is_installation "$DIR"; then
    REINSTALL=1
    ENV_FILE=$DIR/.env
    OLD_NAME=$(env_get RSC_BRAIN_NAME)
    OLD_DB=$(env_get RSC_BRAIN_DB)
    OLD_IMAGE=$(env_get RSC_BRAIN_IMAGE)
    [ -n "$NAME" ] && [ "$NAME" != "$OLD_NAME" ] && usage "The installation in \"$DIR\" is called $OLD_NAME; its name cannot change."
    NAME=$OLD_NAME
    [ -n "$DB" ] && [ "$DB" != "$OLD_DB" ] &&
      usage "The installation in \"$DIR\" uses the $OLD_DB database, and install keeps it. To move to another one: make a copy (backup), uninstall, install anew and restore the copy."
    DB=$OLD_DB
    if { [ -n "$IMAGE" ] && [ "$IMAGE" != "$OLD_IMAGE" ]; } || { [ -n "$VERSION" ] && [ "rsc-brain:$VERSION" != "$OLD_IMAGE" ]; }; then
      usage "The installation in \"$DIR\" runs $OLD_IMAGE. Changing the version is an update (a copy first, then the new version, and back if it fails); install keeps the version."
    fi
    IMAGE=$OLD_IMAGE VERSION=''
    if [ -z "$MODE" ]; then
      MODE=$(env_get RSC_BRAIN_MODE)
      DOMAIN=$(env_get RSC_BRAIN_DOMAIN)
    fi
    # Installed by rsc-factory or not: install keeps that (and the shared network and addresses it is not given).
    if [ "$(env_get RSC_BRAIN_COMPANION)" = 1 ]; then
      COMPANION=1
      [ -n "$SHARED_NET" ] || SHARED_NET=$(env_get RSC_BRAIN_SHARED_NETWORK)
      [ -n "$FACTORY_URL" ] || FACTORY_URL=$(env_get RSC_BRAIN_FACTORY_URL)
      [ -n "$TRUSTED_PROXY" ] || [ "$MODE" != server ] || TRUSTED_PROXY=$(env_get RSC_BRAIN_COMPANION_PROXY)
    elif [ "$COMPANION" = 1 ]; then
      usage "The installation in \"$DIR\" was not installed by rsc-factory, and install keeps that (--companion). To move it: make a copy (backup), uninstall, install anew with --companion and restore the copy."
    fi
    [ -n "$PORT" ] || PORT=$(env_get RSC_BRAIN_PUBLISH | sed 's/.*://')
    [ -n "$HTTP_PORT" ] || HTTP_PORT=$(env_get RSC_BRAIN_HTTP_PORT)
    [ -n "$HTTPS_PORT" ] || HTTPS_PORT=$(env_get RSC_BRAIN_HTTPS_PORT)
    [ -n "$DB_URL_FILE$ADMIN_URL_FILE" ] && say 'The installation keeps its database: the URL file is not used.'
    DB_URL_FILE='' ADMIN_URL_FILE='' FACTORY_DB=$(env_get RSC_BRAIN_FACTORY_DB)
  elif [ -f "$PENDING" ]; then
    # A first install that was killed: the next one takes it back, then installs as a first install.
    RESUME=1
  elif [ -n "$(foreign_files "$DIR")" ]; then
    usage "\"$DIR\" already holds files that are not an rsc-brain installation. Choose another folder with --dir."
  fi
  [ -n "$NAME" ] || NAME=rsc-brain

  # Questions, only for what the options did not say.
  if ! can_ask && [ "$YES" = 0 ]; then
    usage 'There is no terminal to ask on. Pass the answers as options and --yes (see help).'
  fi
  if [ -z "$MODE" ]; then
    can_ask || usage 'Say where rsc-brain runs: pass --local or --domain D (--local: this machine only; --domain: a server with HTTPS).'
    while [ -z "$MODE" ]; do
      ask 'Domain name for a server with HTTPS (leave empty to run on this machine only): '
      if [ -z "$ANSWER" ]; then MODE=local; else
        DOMAIN=$(printf '%s' "$ANSWER" | tr '[:upper:]' '[:lower:]')
        if matches "$DOMAIN" '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$'; then MODE=server; else
          say 'That is not a domain name (such as brain.example.com).'
        fi
      fi
    done
    if [ "$MODE" = server ] && [ "$DIR_GIVEN" = 0 ] && [ "$REINSTALL" = 0 ] && [ "$RESUME" = 0 ]; then
      DIR=/opt/rsc-brain
      PENDING=$DIR/$STATE/install.pending
      [ -n "$(foreign_files "$DIR")" ] &&
        usage "\"$DIR\" already holds files that are not an rsc-brain installation. Choose another folder with --dir."
    fi
  fi
  if [ "$COMPANION" = 1 ]; then
    [ -n "$SHARED_NET" ] || usage '--companion needs --attach-network NAME: the Docker network shared with rsc-factory (its installer makes it).'
    [ -n "$FACTORY_URL" ] || usage '--companion needs --factory-url URL: the address of rsc-factory.'
    if [ "$MODE" = server ]; then
      [ -n "$TRUSTED_PROXY" ] ||
        usage "--companion with --domain needs --trusted-proxy IP: the fixed address of rsc-factory's Caddy on $SHARED_NET."
    else
      [ -z "$TRUSTED_PROXY" ] || usage '--trusted-proxy goes with --domain: on this machine only, nothing stands in front of rsc-brain.'
    fi
    [ -n "$DB" ] || DB=shared
  fi
  if [ -z "$DB" ]; then
    if can_ask; then
      while [ -z "$DB" ]; do
        ask 'Database: 1) rsc-brain runs its own PostgreSQL  2) an existing PostgreSQL  3) the PostgreSQL rsc-factory uses [1]: '
        case $ANSWER in '' | 1) DB=bundled ;; 2) DB=existing ;; 3) DB=shared ;; *) say 'Answer 1, 2 or 3.' ;; esac
      done
    else DB=bundled; fi
  fi
  if [ "$REINSTALL" = 0 ] && [ "$DB" = existing ] && [ -z "$DB_URL_FILE$ADMIN_URL_FILE" ]; then
    can_ask || usage '--db existing needs --db-url-file F or --db-admin-url-file F.'
    ask 'File holding the URL of a database for rsc-brain alone (leave empty to give an administration login instead): '
    if [ -n "$ANSWER" ]; then DB_URL_FILE=$ANSWER; else
      ask 'File holding the URL of an administration login (used once, never kept): '
      ADMIN_URL_FILE=$ANSWER
    fi
  fi
  if [ "$REINSTALL" = 0 ] && [ "$DB" = shared ]; then
    if [ -z "$ADMIN_URL_FILE" ]; then
      can_ask || usage '--db shared needs --db-admin-url-file F and --factory-db NAME.'
      ask 'File holding the URL of an administration login of that PostgreSQL (used once, never kept): '
      ADMIN_URL_FILE=$ANSWER
    fi
    while [ -z "$FACTORY_DB" ]; do
      can_ask || usage '--db shared needs --factory-db NAME.'
      ask "The other program's database (rsc_factory for rsc-factory): "
      matches "$ANSWER" '^[a-z_][a-z0-9_]{0,62}$' && FACTORY_DB=$ANSWER
    done
  fi
  [ -n "$PORT" ] || PORT=8090
  [ -n "$HTTP_PORT" ] || HTTP_PORT=80
  [ -n "$HTTPS_PORT" ] || HTTPS_PORT=443
  DB_NAME=$(printf '%s' "$NAME" | tr '-' '_')
  case $DB_NAME in [0-9]*) DB_NAME=b_$DB_NAME ;; esac
  [ "$REINSTALL" = 1 ] && DB_NAME=$(env_get RSC_BRAIN_DB_NAME)
  DB_URL='' ADMIN_URL=''
  if [ -n "$DB_URL_FILE" ]; then
    read_url "$DB_URL_FILE"
    DB_URL=$RU
  fi
  if [ -n "$ADMIN_URL_FILE" ]; then
    read_url "$ADMIN_URL_FILE"
    ADMIN_URL=$RU
  fi
  # One launcher at a time: and what the folder was may have changed while this one asked.
  take_lock
  if { [ "$REINSTALL" = 1 ] && ! is_installation "$DIR"; } || { [ "$REINSTALL" = 0 ] && is_installation "$DIR"; } ||
    { [ "$RESUME" = 0 ] && [ "$REINSTALL" = 0 ] && [ -f "$PENDING" ]; }; then
    missing "\"$DIR\" changed while this launcher was getting ready. Run it again."
  fi
  if [ "$RESUME" = 1 ]; then
    ENV_FILE=$PENDING
    if [ "$(env_get RSC_BRAIN_PENDING_PROVISIONED)" = 1 ] && [ "$(env_get RSC_BRAIN_DB)" != bundled ] && [ -z "$ADMIN_URL" ]; then
      usage "An install in \"$DIR\" was interrupted while it made the database $(env_get RSC_BRAIN_DB_NAME). Pass --db-admin-url-file with the administration login, so that database is removed before installing again."
    fi
  fi

  # Requirements: nothing is changed until all of them are met.
  step 'Checking what rsc-brain needs'
  need_docker
  [ "$COMPANION" = 1 ] && companion_requirements
  [ "$REINSTALL" = 1 ] && interrupted_work
  if [ "$RESUME" = 1 ]; then
    # Take back the interrupted install with what it wrote down, then go on as a first install.
    step "Taking back an install in \"$DIR\" that was interrupted"
    saved="$NAME|$DB|$DB_NAME|$IMAGE|$PROFILES"
    NAME=$(env_get RSC_BRAIN_NAME) DB=$(env_get RSC_BRAIN_DB) DB_NAME=$(env_get RSC_BRAIN_DB_NAME)
    IMAGE=$(env_get RSC_BRAIN_IMAGE) PROFILES=$(env_get COMPOSE_PROFILES)
    MADE_FILES='' MADE_DIR=0
    # Its own folder holds this run's lock: it stays, and what the other run made there goes.
    for f in $(env_get RSC_BRAIN_PENDING_MADE); do [ "$f" = "$STATE" ] || MADE_FILES="$MADE_FILES $f"; done
    MADE_IMAGE=$(env_get RSC_BRAIN_PENDING_MADE_IMAGE) PROVISIONED=$(env_get RSC_BRAIN_PENDING_PROVISIONED)
    STARTED=$(env_get RSC_BRAIN_PENDING_STARTED)
    adopt_dir=$(env_get RSC_BRAIN_PENDING_MADE_DIR) adopt_state=0
    case " $(env_get RSC_BRAIN_PENDING_MADE) " in *" $STATE "*) adopt_state=1 ;; esac
    take_back
    rm -rf "${DIR:?}/${STATE:?}/src" "${PENDING:?}"
    oldifs=$IFS
    IFS='|'
    # shellcheck disable=SC2086
    set -- $saved
    IFS=$oldifs
    NAME=$1 DB=$2 DB_NAME=$3 IMAGE=${4:-} PROFILES=${5:-}
    MADE_FILES='' MADE_DIR=0 MADE_IMAGE=0 PROVISIONED=0 STARTED=0 RESUME=0
    # What the other run made of the folders is this run's to take back now.
    [ "$adopt_dir" = 1 ] && LOCK_MADE_DIR=1
    [ "$adopt_state" = 1 ] && LOCK_MADE_STATE=1
    [ -n "$(foreign_files "$DIR")" ] &&
      usage "\"$DIR\" still holds files that are not an rsc-brain installation. Choose another folder with --dir."
  fi
  BUILD=0
  if [ -z "$IMAGE" ]; then
    command -v git >/dev/null 2>&1 ||
      missing 'git is not installed (it fetches the source to build rsc-brain). Install it: https://git-scm.com/downloads, or pass --image with an image already built.'
    if [ -z "$VERSION" ]; then
      VERSION=$(latest_version)
      if [ -z "$VERSION" ]; then
        say "No published version of rsc-brain at $(repo_public "$REPO") yet: building its main branch."
        VERSION=main
      fi
    fi
    IMAGE=rsc-brain:$VERSION
    BUILD=1
  elif ! docker image inspect "$IMAGE" >/dev/null 2>&1 </dev/null; then
    missing "The image $IMAGE is not on this machine. Build or pull it first, or pass --version to build one from the source."
  fi
  probe=$DIR
  while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
  free_kb=$(df -Pk "$probe" 2>/dev/null | tail -n 1 | tr -s ' ' | cut -d' ' -f4)
  case $free_kb in '' | *[!0-9]*) free_kb=$MIN_FREE_KB ;; esac
  [ "$free_kb" -ge "$MIN_FREE_KB" ] ||
    missing "Only $((free_kb / 1024)) MB are free on the disk of \"$DIR\"; rsc-brain needs at least 2 GB (images, database and copies). Free some space, or pass --dir on another disk."
  # Its own running installation holds its ports: those are not «in use».
  OWN=0
  [ "$REINSTALL" = 1 ] && PROFILES=$(env_get COMPOSE_PROFILES) && running && OWN=1
  if [ "$OWN" = 0 ] || [ "127.0.0.1:$PORT" != "$(env_get RSC_BRAIN_PUBLISH)" ]; then free_port PORT --port; fi
  if [ "$MODE" = server ] && [ "$COMPANION" = 0 ]; then
    if [ "$OWN" = 0 ] || [ "$(env_get RSC_BRAIN_MODE)" != server ] || [ "$HTTP_PORT" != "$(env_get RSC_BRAIN_HTTP_PORT)" ]; then free_port HTTP_PORT --http-port; fi
    if [ "$OWN" = 0 ] || [ "$(env_get RSC_BRAIN_MODE)" != server ] || [ "$HTTPS_PORT" != "$(env_get RSC_BRAIN_HTTPS_PORT)" ]; then free_port HTTPS_PORT --https-port; fi
  fi

  # A new installation never takes the name of one Docker already holds (a failure would take its volumes down).
  if [ "$REINSTALL" = 0 ]; then
    if [ -n "$(docker ps -a -q --filter "label=com.docker.compose.project=$NAME" 2>/dev/null </dev/null)" ] ||
      docker volume inspect "${NAME}_pgdata" >/dev/null 2>&1 </dev/null; then
      missing "Docker already holds an installation called $NAME (its containers or its database volume ${NAME}_pgdata), and \"$DIR\" has no .env for it. Pass --dir with its folder, or --name with another name for a new one."
    fi
    pick_subnet
  fi
  if [ "$MODE" = server ]; then
    SITE=https://$DOMAIN
    # In companion mode rsc-factory's Caddy serves it, on 443.
    [ "$HTTPS_PORT" = 443 ] || [ "$COMPANION" = 1 ] || SITE=$SITE:$HTTPS_PORT
  else
    SITE=http://localhost:$PORT
  fi
  # The key an installation deleted here kept for its copies: used again (asked, or with --yes), so they stay
  # restorable; or a new one, and the saved file is left alone.
  REUSED=''
  if [ "$REINSTALL" = 0 ] && [ -f "$DIR/installation-key.txt" ]; then
    saved=$(cat -- "$DIR/installation-key.txt" 2>/dev/null)
    case $saved in *"$NL"* | *"$CR"* | *"'"* | *' '*) saved='' ;; esac
    [ ${#saved} -ge 32 ] ||
      usage "\"$DIR/installation-key.txt\" holds no usable installation key. Move it out of the folder (or choose another with --dir)."
    if ! can_ask || yes_no "Reuse the installation key saved in \"$DIR/installation-key.txt\"? Copies made with it stay restorable." y; then
      REUSED=$saved
      say "Using the installation key saved in \"$DIR/installation-key.txt\"."
    else
      say "A new installation key was made; \"$DIR/installation-key.txt\" is left as it was (copies made before need it)."
    fi
  fi
  if can_ask; then
    if [ "$REINSTALL" = 1 ]; then q="Apply these settings to rsc-brain in \"$DIR\" ($MODE, $SITE)? Its key and data are kept."; else
      q="Install rsc-brain in \"$DIR\" ($MODE, $SITE, $DB database)?"
    fi
    yes_no "$q" y || {
      say 'Nothing was changed.'
      exit 1
    }
  fi

  # The values: kept on a reinstall, new on a first install.
  if [ "$(id -u)" = 0 ]; then RUN_UID=1000 RUN_GID=1000; else RUN_UID=$(id -u) RUN_GID=$(id -g); fi
  if [ "$REINSTALL" = 1 ]; then
    SECRET=$(env_get RSC_BRAIN_SECRET)
    PG_PASSWORD=$(env_get POSTGRES_PASSWORD)
    DATABASE_URL=$(env_get RSC_BRAIN_DATABASE_URL)
    SUBNET=$(env_get RSC_BRAIN_SUBNET) IP_RANGE=$(env_get RSC_BRAIN_IP_RANGE) PROXY_IP=$(env_get RSC_BRAIN_PROXY_IP)
    COMPANION_TOKEN=$(env_get RSC_BRAIN_COMPANION_TOKEN)
  else
    SECRET=${REUSED:-$(random_hex 48)}
    PG_PASSWORD=$(random_hex 32)
    DATABASE_URL=$DB_URL
    # The one-time key of the companion setup: for rsc-factory, which sets rsc-brain up with it (POST
    # /v1/setup/companion); once set up it serves nothing.
    [ "$COMPANION" = 1 ] && COMPANION_TOKEN=$(random_hex 32)
  fi
  [ "$DB" = bundled ] || PG_PASSWORD=''
  PROFILES=''
  [ "$DB" = bundled ] && PROFILES=bundled
  [ "$MODE" = server ] && [ "$COMPANION" = 0 ] && PROFILES=${PROFILES:+$PROFILES,}server
  if [ "$MODE" = server ]; then LOCAL_ONLY=0 TRUSTED=$PROXY_IP; else LOCAL_ONLY=1 TRUSTED=''; fi
  # In companion mode, rsc-factory's Caddy is the only proxy believed.
  [ "$COMPANION" = 1 ] && [ "$MODE" = server ] && TRUSTED=$TRUSTED_PROXY

  # From here on, a failure or a stop takes back what this run made.
  trap interrupted HUP INT TERM
  # The folders the lock needed are this run's from now on (a failure takes them back with the rest).
  [ "$LOCK_MADE_DIR" = 1 ] && MADE_DIR=1
  [ "$LOCK_MADE_STATE" = 1 ] && MADE_FILES="$MADE_FILES $STATE"
  [ -d "$DIR/$STATE" ] || failed 4 "Cannot create \"$DIR/$STATE\"."
  if [ "$REINSTALL" = 1 ]; then
    # env.previous is an update's way back while its journal is there: never written over then.
    if [ -f "$DIR/$STATE/update.pending" ]; then
      say "An update in \"$DIR\" was interrupted: run sh $PROG update --dir \"$DIR\" to go back first. Nothing was changed."
      exit 1
    fi
    cp -p "$DIR/.env" "$DIR/$STATE/env.previous" || failed 4 "Cannot keep a copy of \"$DIR/.env\"."
  else
    ENV_FILE=$PENDING
    save_state
    checkpoint state
  fi
  if [ "$BUILD" = 1 ]; then
    docker image inspect "$IMAGE" >/dev/null 2>&1 </dev/null || MADE_IMAGE=1
    save_state
    step "Fetching the source of rsc-brain $VERSION"
    rm -rf "${DIR:?}/${STATE:?}/src"
    # The image is built from these files: they must be readable by all, whatever this shell's umask.
    (umask 022 && git clone --depth 1 --branch "$VERSION" "$REPO" "$DIR/$STATE/src") >&2 </dev/null ||
      failed 3 "Could not fetch $VERSION from $(repo_public "$REPO"). Check the version (git tags) and the network."
    step "Building the image $IMAGE (a few minutes the first time)"
    docker build -t "$IMAGE" "$DIR/$STATE/src" >&2 </dev/null || failed 4 "The image did not build: the lines above say why."
  fi
  # A database it is given is checked before anything is made in it.
  check_url=$DB_URL
  [ -n "$ADMIN_URL" ] && check_url=$ADMIN_URL
  if [ -n "$check_url" ]; then
    step 'Checking the PostgreSQL'
    # In companion mode the PostgreSQL is reached on the shared network, as the service will.
    set -- --rm -i --add-host host.docker.internal:host-gateway
    [ "$COMPANION" = 1 ] && set -- "$@" --network "$SHARED_NET"
    printf '%s\n' "$check_url" | docker run "$@" "$IMAGE" rsc-brain db check --url-stdin --json >/dev/null ||
      failed 3 'That PostgreSQL cannot hold rsc-brain (the line above says why).'
  fi

  # Each thing it makes is written in the journal first: a run killed in between leaves nothing unnamed.
  if [ ! -d "$DIR/backups" ]; then
    MADE_FILES="$MADE_FILES backups"
    save_state
    mkdir "$DIR/backups" || failed 4 "Cannot create \"$DIR/backups\"."
    checkpoint backups
  fi
  # The service writes the copies as the owner of the folder; as root, as the image's unprivileged user.
  [ "$(id -u)" = 0 ] && chown 1000:1000 "$DIR/backups"
  chmod 700 "$DIR/backups"
  # The folders for the web's marks and the updater's report (the service mounts the report, read only).
  if [ ! -d "$DIR/update" ]; then
    MADE_FILES="$MADE_FILES update"
    save_state
  fi
  ensure_update_dirs || failed 4 "Cannot create \"$DIR/update\"."
  # The compose file and the Caddyfiles of the version installed (a version from before has no door).
  src=$HERE
  [ "$BUILD" = 1 ] && src=$DIR/$STATE/src/deploy
  for f in compose.yaml Caddyfile door.Caddyfile; do
    [ "$f" != door.Caddyfile ] || [ -f "$src/$f" ] || continue
    if [ -f "$src/$f" ]; then
      if [ ! -f "$DIR/$f" ]; then
        MADE_FILES="$MADE_FILES $f"
        save_state
      fi
      if ! { cp "$src/$f" "$DIR/$f.new" && chmod 644 "$DIR/$f.new" && mv -f "$DIR/$f.new" "$DIR/$f"; }; then
        failed 4 "Could not write \"$DIR/$f\"."
      fi
      checkpoint "$f"
    elif [ ! -f "$DIR/$f" ]; then
      failed 3 "$f is not next to the launcher. Run it from a copy of the repository (deploy/), or with --version."
    fi
  done
  if [ "$COMPANION" = 1 ]; then
    if [ ! -f "$DIR/compose.companion.yaml" ]; then
      MADE_FILES="$MADE_FILES compose.companion.yaml"
      save_state
    fi
    write_companion_compose || failed 4 "Could not write \"$DIR/compose.companion.yaml\"."
  fi
  if [ "$REINSTALL" = 1 ]; then write_env "$DIR/.env" || failed 4 "Could not write \"$DIR/.env\"."; fi
  STARTED=1
  save_state

  if [ "$DB" = bundled ]; then
    step 'Starting PostgreSQL'
    dc up -d --wait postgres >&2 </dev/null || failed 4 'PostgreSQL did not start: the lines above say why.'
    [ -z "$DATABASE_URL" ] && ADMIN_URL="postgres://postgres:$PG_PASSWORD@postgres:5432/postgres"
  fi
  if [ -z "$DATABASE_URL" ]; then
    step "Making the database and the role $DB_NAME (no superuser)"
    # Written down before it starts: if this run is stopped meanwhile, what it was making is removed.
    PROVISIONED=1
    save_state
    set --
    [ "$DB" = shared ] && set -- --isolate-from "$FACTORY_DB"
    made=$(printf '%s\n' "$ADMIN_URL" | dc run --rm -T --no-deps app rsc-brain db provision --database "$DB_NAME" \
      --role "$DB_NAME" "$@" --json)
    code=$?
    case $code in
    0) ;;
    2 | 3) failed "$code" 'The database could not be made (the line above says why).' ;;
    *) failed 4 'The database could not be made (the lines above say why).' ;;
    esac
    DATABASE_URL=$(printf '%s\n' "$made" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
    case $DATABASE_URL in '' | *"'"*) failed 4 'The database was made, but its URL could not be read.' ;; esac
    save_state
  fi

  step 'Starting rsc-brain'
  dc up -d --remove-orphans >&2 </dev/null || failed 4 'rsc-brain did not start: the lines above say why.'
  step 'Waiting for rsc-brain to answer'
  wait_healthy || failed 4 'rsc-brain did not answer within 2 minutes.'
  version=$(dc exec -T app rsc-brain version </dev/null 2>/dev/null)
  key_id=$(printf '%s' "$SECRET" | dc exec -T app rsc-brain key id 2>/dev/null)
  # Done: only now is there an installation (.env), and nothing left to take back.
  if [ "$REINSTALL" = 0 ]; then
    write_env "$DIR/.env" || failed 4 "Could not write \"$DIR/.env\"."
    rm -f "${PENDING:?}"
    ENV_FILE=$DIR/.env
  fi
  rm -f "${DIR:?}/${STATE:?}/env.previous" "${DIR:?}/last-failure.log"
  trap - HUP INT TERM

  if [ "$JSON" = 1 ]; then
    companion_json=''
    [ "$COMPANION" = 1 ] &&
      companion_json=",\"companionToken\":$(json_str "$COMPANION_TOKEN"),\"internalUrl\":\"http://rsc-brain:8090\""
    printf '{"url":%s,"mode":%s,"db":%s,"installationKey":%s,"keyId":%s,"version":%s,"dir":%s%s}\n' \
      "$(json_str "$SITE")" "$(json_str "$MODE")" "$(json_str "$DB")" "$(json_str "$SECRET")" \
      "$(json_str "$key_id")" "$(json_str "$version")" "$(json_str "$DIR")" "$companion_json"
    return 0
  fi
  out ''
  out "rsc-brain $version is running at $SITE"
  if [ "$REINSTALL" = 1 ]; then
    out 'Its settings were applied; the installation key, the data and the copies are as they were.'
    return 0
  fi
  if [ "$COMPANION" = 1 ]; then
    out "It waits for rsc-factory ($FACTORY_URL): finish the first-time setup of rsc-factory, and rsc-brain is set up"
    out "with the same administration. rsc-factory reaches it as http://rsc-brain:8090 on the network $SHARED_NET."
  else
    out 'Open it to finish the first-time setup: there you make the administration account.'
  fi
  [ "$MODE" = server ] && [ "$COMPANION" = 0 ] && out "($DOMAIN must point at this server; the certificate arrives by itself on the first visit.)"
  out ''
  if [ -t 1 ]; then
    out "The installation key (id $key_id) opens your copies; without it they cannot be restored. Save it now in a"
    out 'password manager:'
    out ''
    out "  $SECRET"
    out ''
    out "Print it again with: sh $PROG key show --dir \"$DIR\""
  else
    out "The installation key (id $key_id) opens your copies; without it they cannot be restored. It is kept in"
    out "\"$DIR/.env\". Print it with: sh $PROG key show --dir \"$DIR\", and save it in a password manager."
  fi
  out "Copies are made every day at 03:00 (UTC) in \"$DIR/backups\"; list them with: sh $PROG backups --dir \"$DIR\""
  return 0
}

# --------------------------------------------------------------------------------------------- the other commands
status() {
  need_installation
  need_docker
  # An update killed halfway is taken back here too, unless a launcher is at work on it right now.
  if [ -f "$DIR/$STATE/update.pending" ] && ! lock_held; then
    take_lock
    interrupted_work update-only
  fi
  [ -f "$DIR/$STATE/env.rotated" ] &&
    say "A key rotation in \"$DIR\" was interrupted (or is running now). Finish it with: sh $PROG key rotate --dir \"$DIR\""
  rollback_failed_notice
  is_running=false is_healthy=false version=''
  if running; then
    is_running=true
    healthy && is_healthy=true
    version=$(dc exec -T app rsc-brain version </dev/null 2>/dev/null)
  fi
  site=$(env_get RSC_BRAIN_SITE) mode=$(env_get RSC_BRAIN_MODE) db=$(env_get RSC_BRAIN_DB) image=$(env_get RSC_BRAIN_IMAGE)
  if [ "$JSON" = 1 ]; then
    printf '{"url":%s,"mode":%s,"db":%s,"dir":%s,"image":%s,"version":%s,"running":%s,"healthy":%s}\n' \
      "$(json_str "$site")" "$(json_str "$mode")" "$(json_str "$db")" "$(json_str "$DIR")" "$(json_str "$image")" \
      "$(json_str "$version")" "$is_running" "$is_healthy"
  else
    out "rsc-brain in \"$DIR\": $site ($mode, $db database, $image)"
    if [ "$is_healthy" = true ]; then
      out "Running version $version and answering."
      dc exec -T app rsc-brain maintenance status </dev/null 2>/dev/null
    elif [ "$is_running" = true ]; then
      out "Running but not answering. See why with: docker compose --project-directory \"$DIR\" logs app"
    else
      out "Not running. Start it with: sh $PROG install --dir \"$DIR\""
    fi
  fi
  [ "$is_healthy" = true ] && [ "$ROLLBACK_FAILED" = 0 ]
}

need_running() {
  running || {
    say "rsc-brain is not running. Start it with: sh $PROG install --dir \"$DIR\""
    exit 1
  }
}

backup() {
  need_installation
  take_lock
  need_docker
  interrupted_work
  need_running
  set --
  [ "$JSON" = 1 ] && set -- --json
  dc exec -T app rsc-brain backup "$@" </dev/null
}

backups() {
  need_installation
  need_docker
  need_running
  set --
  [ "$JSON" = 1 ] && set -- --json
  dc exec -T app rsc-brain backups list "$@" </dev/null
}

restore() {
  [ -z "$KEY_FILE" ] || [ -r "$KEY_FILE" ] || usage "The key file \"$KEY_FILE\" cannot be read."
  need_installation
  # A name as `backups` prints it is a copy in <dir>/backups.
  case $COPY_FILE in */*) ;; *) [ -f "$DIR/backups/$COPY_FILE" ] && COPY_FILE=$DIR/backups/$COPY_FILE ;; esac
  [ -f "$COPY_FILE" ] && [ -r "$COPY_FILE" ] || usage "The copy \"$COPY_FILE\" cannot be read."
  if [ "$CONFIRM_SET" = 0 ]; then
    can_ask || usage "Pass --confirm with the installation's name (as the web shows it; on a new installation, the name in the copy)."
    ask "Restoring replaces everything in rsc-brain with the copy. Type the installation's name to go on: "
    CONFIRM=$ANSWER
  fi
  take_lock
  need_docker
  interrupted_work
  base=$(basename -- "$COPY_FILE" | tr -c 'A-Za-z0-9._\n-' '_')
  target=$DIR/backups/$base
  copy_dir=$(cd -- "$(dirname -- "$COPY_FILE")" && pwd)
  brought=0
  if [ "$copy_dir/$(basename -- "$COPY_FILE")" != "$target" ]; then
    [ -e "$target" ] && usage "A copy named $base is in \"$DIR/backups\" already: restore that one (--file $base) or rename yours."
    cp -- "$COPY_FILE" "$target" || exit 1
    brought=1
    [ "$(id -u)" = 0 ] && chown 1000:1000 "$target"
  fi
  # The name, the key and the version, checked by rsc-brain itself before anything stops.
  step "Checking $base"
  if running; then set -- exec -T app; else set -- run --rm -T --no-deps app; fi
  if [ -n "$KEY_FILE" ]; then
    dc "$@" rsc-brain restore --check --file "/backups/$base" --confirm "$CONFIRM" <"$KEY_FILE" >&2
  else
    dc "$@" rsc-brain restore --check --file "/backups/$base" --confirm "$CONFIRM" </dev/null >&2
  fi
  code=$?
  if [ "$code" != 0 ]; then
    [ "$brought" = 1 ] && rm -f "${target:?}"
    say 'Nothing was changed: rsc-brain kept running.'
    [ "$code" = 2 ] && exit 2
    exit 1
  fi
  step 'Stopping rsc-brain'
  dc stop app >&2 </dev/null
  step "Restoring $base"
  set --
  [ "$JSON" = 1 ] && set -- --json
  if [ -n "$KEY_FILE" ]; then
    dc run --rm -T --no-deps app rsc-brain restore --file "/backups/$base" --confirm "$CONFIRM" "$@" <"$KEY_FILE"
  else
    dc run --rm -T --no-deps app rsc-brain restore --file "/backups/$base" --confirm "$CONFIRM" "$@" </dev/null
  fi
  code=$?
  # A copy brought in only for a restore that did not happen is not left among the copies.
  [ "$code" != 0 ] && [ "$brought" = 1 ] && rm -f "${target:?}"
  step 'Starting rsc-brain again'
  if ! { dc up -d >&2 </dev/null && wait_healthy; }; then
    say "rsc-brain did not answer after the restore. See why with: docker compose --project-directory \"$DIR\" logs app"
  fi
  if [ "$code" = 0 ]; then
    rm -f "${DIR:?}/${STATE:?}/rollback.failed"
    say 'Restored. Every key, session and connection made before no longer works: everyone has to sign in again.'
    return 0
  fi
  [ "$code" = 2 ] && return 2
  return 1
}

# ----------------------------------------------------------------------------------------------------------- update
# Versions are X.Y.Z (or vX.Y.Z), maybe with a -preview part. rsc-brain only moves forward: migrations go one way.
version_ok() { matches "$1" '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; }
# number_after A B: the number A is larger, whatever its length.
number_after() {
  na=${1#"${1%%[!0]*}"} nb=${2#"${2%%[!0]*}"}
  [ ${#na} -ne ${#nb} ] && { [ ${#na} -gt ${#nb} ]; return; }
  [ "$na" != "$nb" ] && [ "$(printf '%s\n%s\n' "$na" "$nb" | LC_ALL=C sort | tail -n 1)" = "$na" ]
}
# newer A B: A comes after B.
newer() {
  version_ok "$1" && version_ok "$2" || return 1
  va=${1#v} vb=${2#v}
  ca=${va%%-*} cb=${vb%%-*}
  oldifs=$IFS
  IFS=.
  # shellcheck disable=SC2086
  set -- $ca $cb
  IFS=$oldifs
  number_after "$1" "$4" && return 0
  number_after "$4" "$1" && return 1
  number_after "$2" "$5" && return 0
  number_after "$5" "$2" && return 1
  number_after "$3" "$6" && return 0
  number_after "$6" "$3" && return 1
  # The same numbers: a release comes after its previews, and previews come in semver's order.
  if [ "$va" = "$ca" ]; then
    [ "$vb" != "$cb" ]
    return
  fi
  [ "$vb" = "$cb" ] && return 1
  preview_after "${va#*-}" "${vb#*-}"
}
# preview_after A B: the preview part A (such as rc.10) comes after B (rc.2), as semver orders them: the parts between
# dots one by one, numbers by their value and before words, words in ASCII order, and more parts after fewer.
preview_after() {
  pa=$1 pb=$2
  while :; do
    [ -z "$pa" ] && return 1
    [ -z "$pb" ] && return 0
    ia=${pa%%.*} ib=${pb%%.*}
    case $pa in *.*) pa=${pa#*.} ;; *) pa='' ;; esac
    case $pb in *.*) pb=${pb#*.} ;; *) pb='' ;; esac
    [ "$ia" = "$ib" ] && continue
    case $ia in '' | *[!0-9]*) na=0 ;; *) na=1 ;; esac
    case $ib in '' | *[!0-9]*) nb=0 ;; *) nb=1 ;; esac
    if [ "$na" = 1 ] && [ "$nb" = 1 ]; then
      # Numbers of any length: the longer one is larger; the same length, the first that differs.
      [ ${#ia} -ne ${#ib} ] && { [ ${#ia} -gt ${#ib} ]; return; }
    elif [ "$na" = 1 ]; then
      return 1
    elif [ "$nb" = 1 ]; then
      return 0
    fi
    [ "$(printf '%s\n%s\n' "$ia" "$ib" | LC_ALL=C sort | head -n 1)" = "$ib" ]
    return
  done
}
same_version() { [ "${1#v}" = "${2#v}" ]; }

# The size of the newest copy, in KB (0 without copies).
# Copies are named by their UTC date (rsc-brain-<yyyymmddThhmmssZ>-<reason>.rscb): the last name is the newest.
last_copy_kb() {
  newest=''
  for f in "$DIR"/backups/rsc-brain-*.rscb; do [ -f "$f" ] && newest=$f; done
  bytes=0
  [ -n "$newest" ] && bytes=$(wc -c <"$newest" 2>/dev/null | tr -d ' ')
  case $bytes in '' | *[!0-9]*) bytes=0 ;; esac
  echo $((bytes / 1024))
}

UPDATE_FROM='' UPDATE_TO='' PRE_COPY='' UPDATE_PHASE='' NEXT_SRC='' UPDATE_LOG=''
# The source fetched for a version that is not installed after all.
drop_next() { [ -n "$NEXT_SRC" ] && rm -rf "${NEXT_SRC:?}"; return 0; }
# Before anything was switched: maintenance off again (when it was on), and nothing else to take back. A journal this
# run wrote (a stop may come between writing it and the switch) goes too: it would make the next launcher take back
# an update that never switched.
update_abort() {
  trap '' HUP INT TERM
  say "$1"
  [ "$UPDATE_PHASE" = maintenance ] && dc exec -T app rsc-brain maintenance off </dev/null >&2
  rm -f "${DIR:?}/${STATE:?}/update.pending" "${DIR:?}/${STATE:?}/update.pending.new"
  drop_next
  say "Nothing was changed: rsc-brain $UPDATE_FROM keeps running."
  exit 1
}
# The new version's output and the service's last lines, without the key or a password, for the person and the web.
update_failure_log() {
  # The service's lines first, the new version's own output last: the end of the log says why (the web keeps the end).
  {
    dc logs --no-color --tail 200 app </dev/null 2>&1
    [ -f "$UPDATE_LOG" ] && cat "$UPDATE_LOG"
  } | redact "$(env_get RSC_BRAIN_SECRET)" "$(env_get POSTGRES_PASSWORD)" \
    "$(url_password "$(env_get RSC_BRAIN_DATABASE_URL)")" >"$DIR/last-failure.log.new" &&
    chmod 600 "$DIR/last-failure.log.new" && mv -f "$DIR/last-failure.log.new" "$DIR/last-failure.log" &&
    FAILURE_LOG=$DIR/last-failure.log
  return 0
}
# The stand-in door (compose profile door): while the service is stopped something answers on its port, 503 with
# Retry-After. It never decides an update: not starting is said, and the update goes on as it did without one.
has_door() { grep -q '^  door:$' "$DIR/compose.yaml" 2>/dev/null && [ -f "$DIR/door.Caddyfile" ]; }
# The image of the door named by a compose file; nothing when that file has no door.
door_image() {
  sed -n -e '/^  door:$/,/^  [a-z]/{' -e 's/^    image: *//p' -e '}' "$1" 2>/dev/null | head -n 1
}
# Companion mode: the file follows the compose file it goes with.
door_companion() {
  [ -f "$DIR/compose.companion.yaml" ] || return 0
  MODE=$(env_get RSC_BRAIN_MODE)
  write_companion_compose || say "Could not write \"$DIR/compose.companion.yaml\"."
  return 0
}
# The page is anonymous, so what is written here never names a version: only a valid key learns it.
door_step() {
  [ -d "$DIR/$STATE/door" ] || return 0
  printf '%s\n' "$1" >"$DIR/$STATE/door/step.txt.new" && chmod 644 "$DIR/$STATE/door/step.txt.new" &&
    mv -f "$DIR/$STATE/door/step.txt.new" "$DIR/$STATE/door/step.txt"
  return 0
}
door_up() {
  door_companion
  has_door || return 0
  mkdir -p "$DIR/$STATE/door" && chmod 755 "$DIR/$STATE/door"
  door_step "$1"
  dc --profile door up -d --no-deps door >&2 </dev/null ||
    say 'The stand-in for the service did not start: until rsc-brain is back, its address does not answer.'
  checkpoint door-up
  return 0
}
# By compose while the file knows it, and by its labels otherwise (an update going back to a version without a door).
door_down() {
  has_door && dc --profile door rm -fsv door >&2 </dev/null
  dd_left=$(docker ps -aq --filter "label=com.docker.compose.project=$NAME" --filter 'label=com.docker.compose.service=door' 2>/dev/null </dev/null)
  # shellcheck disable=SC2086
  [ -z "$dd_left" ] || docker rm -fv $dd_left >/dev/null 2>&1 </dev/null
  return 0
}
# After the switch: back to the version before, with the copy made before the update and its keys kept (exit 4); or,
# when even that fails, what to do by hand (exit 1).
rollback() {
  # Nothing stops the way back halfway: a second Ctrl-C is ignored here, and does not reach what it runs.
  trap '' HUP INT TERM
  SHIELD=1
  # A launcher killed between the files below leaves them apart: every compose call needs them to agree.
  door_companion
  say "$1"
  update_failure_log
  step "Going back to rsc-brain $UPDATE_FROM"
  dc stop app >&2 </dev/null
  door_up 'Going back to the version before.'
  for f in compose.yaml Caddyfile door.Caddyfile; do
    [ -f "$DIR/$STATE/$f.previous" ] && mv -f "$DIR/$STATE/$f.previous" "$DIR/$f"
  done
  [ -f "$DIR/$STATE/env.previous" ] && mv -f "$DIR/$STATE/env.previous" "$DIR/.env"
  ENV_FILE=$DIR/.env
  door_companion
  door_step 'Restoring the copy made before the update. Everything comes back as it was.'
  step "Restoring the copy made before the update ($PRE_COPY), keys and sessions kept"
  restored=0
  dc run --rm -T --no-deps app rsc-brain restore --file "/backups/$PRE_COPY" --keep-keys </dev/null >&2 && restored=1
  # A restore that failed leaves a mark every later command shows (and status fails on) until a restore goes well,
  # this one done again (a launcher killed after a failed restore leaves the journal too) or a restore by hand. Written
  # before the journal goes, so a stop in between leaves one or the other.
  if [ "$restored" = 1 ]; then
    rm -f "${DIR:?}/${STATE:?}/rollback.failed"
  else
    {
      say_env RSC_BRAIN_ROLLBACK_FROM "$UPDATE_FROM"
      say_env RSC_BRAIN_ROLLBACK_TO "$UPDATE_TO"
      say_env RSC_BRAIN_ROLLBACK_COPY "$PRE_COPY"
      say_env RSC_BRAIN_ROLLBACK_RESTORE "sh $PROG restore --file $PRE_COPY --confirm <the installation's name> --dir \"$DIR\""
    } >"$DIR/$STATE/rollback.failed.new" && mv -f "$DIR/$STATE/rollback.failed.new" "$DIR/$STATE/rollback.failed"
  fi
  step "Starting rsc-brain $UPDATE_FROM"
  door_down
  started=0
  dc up -d --remove-orphans >&2 </dev/null && wait_healthy && started=1
  drop_next
  # The settings are back: there is no update in progress any more (a restore that failed is said below).
  rm -f "${DIR:?}/${STATE:?}/update.pending"
  if [ "$restored" = 1 ] && [ "$started" = 1 ]; then
    rm -f "${UPDATE_LOG:?}"
    dc exec -T app rsc-brain maintenance off </dev/null >&2
    if [ -n "$FAILURE_LOG" ]; then
      dc exec -T app rsc-brain update record --failed --from "$UPDATE_FROM" --to "$UPDATE_TO" <"$FAILURE_LOG" >&2
    else
      dc exec -T app rsc-brain update record --failed --from "$UPDATE_FROM" --to "$UPDATE_TO" </dev/null >&2
    fi
    say "The update to $UPDATE_TO failed, and rsc-brain went back to $UPDATE_FROM with its data as it was just before"
    say "the update (the copy $PRE_COPY). Sessions and keys still work. Admin > Backups & system shows the failure."
    [ -n "$FAILURE_LOG" ] && say "The last lines of the service are in \"$FAILURE_LOG\"."
    exit 4
  fi
  if [ "$restored" = 1 ]; then
    say "The data is back as it was just before the update (the copy $PRE_COPY), with sessions and keys kept, and the"
    say "settings of $UPDATE_FROM are back, but rsc-brain $UPDATE_FROM did not start. See why with: docker compose --project-directory \"$DIR\" logs app"
    say "Then start it with: sh $PROG install --dir \"$DIR\""
  else
    say "rsc-brain could not go back to $UPDATE_FROM by itself. Everything up to the update is in the copy $PRE_COPY."
    say "Restore it by hand (everyone signs in again afterwards): sh $PROG restore --file $PRE_COPY --confirm <the installation's name> --dir \"$DIR\""
    say "What the update printed is kept in \"$UPDATE_LOG\"."
  fi
  [ -n "$FAILURE_LOG" ] && say "The last lines of the service are in \"$FAILURE_LOG\"."
  exit 1
}
# Ctrl-C (or a stop) may come while a command's output goes to update.log or /dev/null: what the way back says goes to
# the error stream the launcher started with.
update_interrupted() {
  to_terminal
  if [ "$UPDATE_PHASE" = switched ]; then rollback 'Interrupted: going back.'; fi
  update_abort 'Interrupted.'
}

# What a launcher killed halfway left behind, found by the next one (with the lock held):
# - <state>/update.pending: an update had switched to the new version. It is taken back, as a failed update would be
#   (the copy made before, with its keys kept, and the settings before), and the launcher exits as that did.
# - <state>/env.rotated: a key rotation had made its new key. Only key rotate finishes it; the rest refuse until then,
#   since the data may be sealed with either key.
interrupted_work() {
  rollback_failed_notice
  journal=$DIR/$STATE/update.pending
  if [ -f "$journal" ]; then
    ENV_FILE=$DIR/.env
    NAME=$(env_get RSC_BRAIN_NAME) PROFILES=$(env_get COMPOSE_PROFILES)
    UPDATE_FROM=$(file_get "$journal" RSC_BRAIN_UPDATE_FROM) UPDATE_TO=$(file_get "$journal" RSC_BRAIN_UPDATE_TO)
    PRE_COPY=$(file_get "$journal" RSC_BRAIN_UPDATE_COPY)
    UPDATE_LOG=$DIR/$STATE/update.log
    [ -d "$DIR/$STATE/src.next" ] && NEXT_SRC=$DIR/$STATE/src.next
    case $PRE_COPY in
    rsc-brain-*-pre-update.rscb) ;;
    *)
      say "An update in \"$DIR\" was interrupted, and its journal \"$journal\" cannot be read. Restore the copy made"
      say "before it by hand (the newest *-pre-update.rscb in \"$DIR/backups\"): sh $PROG restore --file F --confirm <the installation's name> --dir \"$DIR\""
      exit 1
      ;;
    esac
    rollback "An update to $UPDATE_TO was interrupted after it had switched to the new version: going back to $UPDATE_FROM."
  fi
  [ "${1:-}" = update-only ] && return 0
  if [ -f "$DIR/$STATE/env.rotated" ]; then
    say "A key rotation in \"$DIR\" was interrupted: the data may already be sealed with the new key, kept in"
    say "\"$DIR/$STATE/env.rotated\". Finish it first with: sh $PROG key rotate --dir \"$DIR\". Nothing was changed."
    exit 1
  fi
  return 0
}
# A rollback whose restore failed left <state>/rollback.failed: said loud by every command that changes something, and
# by status (which then fails), until a restore goes well and removes it.
ROLLBACK_FAILED=0
rollback_failed_notice() {
  mark=$DIR/$STATE/rollback.failed
  [ -f "$mark" ] || return 0
  [ "$ROLLBACK_FAILED" = 1 ] && return 0
  ROLLBACK_FAILED=1
  say ''
  say "!! An update to $(file_get "$mark" RSC_BRAIN_ROLLBACK_TO) failed, and rsc-brain could not go back to"
  say "!! $(file_get "$mark" RSC_BRAIN_ROLLBACK_FROM) by itself: the data may not be as it was. Everything up to that update is in the"
  say "!! copy $(file_get "$mark" RSC_BRAIN_ROLLBACK_COPY). Restore it by hand (everyone signs in again afterwards):"
  say "!!   $(file_get "$mark" RSC_BRAIN_ROLLBACK_RESTORE)"
  say ''
  return 0
}
# Another launcher holds the lock of this folder, and is running.
lock_held() {
  owner=$(cat "$DIR/$STATE/lock/owner" 2>/dev/null) || return 1
  [ "${owner#* }" = "$(host_name)" ] || return 0
  kill -0 "${owner%% *}" 2>/dev/null
}

# ---------------------------------------------------------------------------------------------------- update --check
# Only looks (CA29b): no lock, no journal taken back, nothing stopped, nothing written in the installation. What it
# fetches goes to a temporary folder that goes with it, also when it is stopped.
CHECK_TMP='' CHECK_PID='' CHECK_INSTALLED=''
# Neither asks anyone, and neither waits on a dead connection: at less than a byte a second for 30 seconds git gives up.
check_git() {
  GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND=${GIT_SSH_COMMAND:-ssh -oBatchMode=yes -oConnectTimeout=15 -oServerAliveInterval=15 -oServerAliveCountMax=2} \
    git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 "$@" &
  CHECK_PID=$!
  wait "$CHECK_PID"
}
# notes_of TAG, from a CHANGELOG.md on the standard input: its section, as text, at most 4000 whole characters.
notes_of() {
  no_in=0 no_text=''
  while IFS= read -r no_line || [ -n "$no_line" ]; do
    no_line=${no_line%"$CR"}
    if [ "$no_in" = 0 ]; then
      case $no_line in "## $1" | "## $1 "* | "## $1$TAB"*) no_in=1 ;; esac
    else
      case $no_line in '## '*) break ;; esac
      no_text=$no_text$no_line$NL
    fi
  done
  no_text=$(printf '%s' "$no_text" | printable)
  no_text=${no_text#"${no_text%%[!"$BLANK"]*}"}
  no_text=${no_text%"${no_text##*[!"$BLANK"]}"}
  no_size=$(printf '%s' "$no_text" | wc -c | tr -d ' ')
  if [ "$no_size" -gt 4000 ]; then
    # Up to 4 bytes a character; a character starts at any byte but 10xxxxxx.
    no_count=0 no_bytes=0
    for no_byte in $(printf '%s' "$no_text" | head -c 16004 | od -An -tu1 -v); do
      if [ "$no_byte" -lt 128 ] || [ "$no_byte" -ge 192 ]; then
        no_count=$((no_count + 1))
        [ "$no_count" -gt 4000 ] && break
      fi
      no_bytes=$((no_bytes + 1))
    done
    printf '%s' "$no_text" | head -c "$no_bytes"
    return 0
  fi
  printf '%s' "$no_text"
}
# A JSON string of any text: without control characters but line ends and tabs. Every line is escaped before they are
# joined (a sed that joins as it goes only sees the first).
json_text() {
  printf '"%s"' "$(printf '%s' "$1" | LC_ALL=C tr -d '\001-\010\013-\037' |
    LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$TAB/\\\\t/g" |
    LC_ALL=C sed -e ':a' -e '$!{' -e 'N' -e 'ba' -e '}' -e 's/\n/\\n/g')"
}
check_answer() { # latest newer notes [error]
  printf '{"installed":%s,"latest":%s,"newer":%s,"notes":%s' \
    "$(if [ -n "$CHECK_INSTALLED" ]; then json_str "$CHECK_INSTALLED"; else printf null; fi)" \
    "$(if [ -n "$1" ]; then json_str "$1"; else printf null; fi)" "$2" "$(json_text "$3")"
  [ -z "${4:-}" ] || printf ',"error":%s' "$(json_str "$4")"
  printf '}\n'
}
check_failed() { # error, what to say
  [ "$JSON" = 0 ] || check_answer '' false '' "$1"
  say "$2"
  exit 3
}
update_check() {
  need_installation
  need_docker
  installation_repo
  rollback_failed_notice
  command -v git >/dev/null 2>&1 ||
    missing 'git is not installed (it asks the repository for its versions). Install it: https://git-scm.com/downloads'
  if ! running; then
    if [ -f "$DIR/$STATE/update.pending" ]; then
      lock_held && check_failed updating "An update is running in \"$DIR\": rsc-brain is stopped for now. Run this again when it ends."
      check_failed updating "An update in \"$DIR\" was interrupted. This takes it back: sh $PROG status --dir \"$DIR\". Then run this again."
    fi
    check_failed not_running "rsc-brain is not running, so its version cannot be read. Start it with: sh $PROG install --dir \"$DIR\""
  fi
  ci_said=$(dc exec -T app rsc-brain version </dev/null 2>/dev/null)
  version_ok "$ci_said" ||
    check_failed no_version "rsc-brain in \"$DIR\" does not say its version. Check it with: sh $PROG status --dir \"$DIR\""
  CHECK_INSTALLED=v${ci_said#v}
  CHECK_TMP=$(mktemp -d "${TMPDIR:-/tmp}/rsc-brain-check.XXXXXX") || missing 'Could not make a temporary folder.'
  trap '[ -z "$CHECK_PID" ] || kill "$CHECK_PID" 2>/dev/null; rm -rf "${CHECK_TMP:?}"' EXIT
  trap 'exit 130' HUP INT TERM
  shown=$(repo_public "$REPO")
  if ! check_git ls-remote --tags --refs -- "$REPO" 'v*' \
    >"$CHECK_TMP/refs" 2>"$CHECK_TMP/err" </dev/null; then
    # What git said stays here: it may carry the address with its credentials.
    if grep -Eiq 'could not read (username|password)|terminal prompts disabled|authentication|permission denied|publickey|not found|access denied|host key verification|\b40[13]\b' "$CHECK_TMP/err"; then
      check_failed no_access "Could not check for a new version: $shown does not answer with the access of this machine. Give it read access (an SSH key or git's credential helper), or pass --repo."
    fi
    check_failed network "Could not check for a new version: $shown did not answer. Check the network and run this again."
  fi
  latest=$(newest_of <"$CHECK_TMP/refs")
  [ -n "$latest" ] || check_failed none "Cannot update: no published version yet ($shown has no version tag)."
  notes=''
  if check_git clone -q --depth 1 --no-checkout --single-branch --branch "$latest" -- "$REPO" "$CHECK_TMP/src" \
    >/dev/null 2>&1 </dev/null &&
    git -C "$CHECK_TMP/src" show "refs/tags/$latest:CHANGELOG.md" >"$CHECK_TMP/changelog" 2>/dev/null </dev/null; then
    notes=$(notes_of "$latest" <"$CHECK_TMP/changelog")
  fi
  is_newer=false
  newer "$latest" "$CHECK_INSTALLED" && is_newer=true
  if [ "$JSON" = 1 ]; then
    check_answer "$latest" "$is_newer" "$notes"
  elif [ "$is_newer" = true ]; then
    out "Version $CHECK_INSTALLED is running. Version $latest is available."
    [ -z "$notes" ] || out "$NL""What changes in $latest:$NL$notes$NL"
    out "Update with: sh $PROG update --dir \"$DIR\""
  elif newer "$CHECK_INSTALLED" "$latest"; then
    out "Version $CHECK_INSTALLED is running. This installation is ahead of the newest published version ($latest)."
  else
    out "Version $CHECK_INSTALLED is running. This is the newest."
  fi
  return 0
}

update() {
  need_installation
  installation_repo
  if ! can_ask && [ "$YES" = 0 ]; then
    usage 'There is no terminal to ask on. Pass --yes to update without questions.'
  fi
  take_lock
  need_docker
  interrupted_work
  need_running
  old_image=$(env_get RSC_BRAIN_IMAGE)
  UPDATE_FROM=$(dc exec -T app rsc-brain version </dev/null 2>/dev/null)
  version_ok "$UPDATE_FROM" || {
    say "rsc-brain in \"$DIR\" does not say its version. Check it with: sh $PROG status --dir \"$DIR\". Nothing was changed."
    exit 1
  }
  BUILD=0
  if [ -n "$IMAGE" ]; then
    if [ "$IMAGE" = "$old_image" ]; then
      out "rsc-brain runs $IMAGE already. Nothing to update."
      exit 0
    fi
    docker image inspect "$IMAGE" >/dev/null 2>&1 </dev/null ||
      missing "The image $IMAGE is not on this machine. Build or pull it first, or pass --version to build one from the source."
  else
    command -v git >/dev/null 2>&1 ||
      missing 'git is not installed (it fetches the source of the new version). Install it: https://git-scm.com/downloads, or pass --image with an image already built.'
    asked=$VERSION
    if [ -z "$VERSION" ]; then
      VERSION=$(latest_version)
      [ -n "$VERSION" ] || missing "No published version of rsc-brain at $(repo_public "$REPO"). Pass --version or --image."
    fi
    if same_version "$VERSION" "$UPDATE_FROM" || { [ -z "$asked" ] && ! newer "$VERSION" "$UPDATE_FROM"; }; then
      out "rsc-brain $UPDATE_FROM is installed and $VERSION is the newest asked for. Nothing to update."
      exit 0
    fi
    newer "$VERSION" "$UPDATE_FROM" ||
      usage "$VERSION is not newer than $UPDATE_FROM (installed). rsc-brain only moves forward: its migrations go one way. Nothing was changed."
    IMAGE=rsc-brain:$VERSION
    BUILD=1
  fi
  # Room for the copy made before, twice over, and 1 GB more.
  need_kb=$(($(last_copy_kb) * 2 + 1048576))
  free_kb=$(df -Pk "$DIR" 2>/dev/null | tail -n 1 | tr -s ' ' | cut -d' ' -f4)
  case $free_kb in '' | *[!0-9]*) free_kb=$need_kb ;; esac
  [ "$free_kb" -ge "$need_kb" ] ||
    missing "Only $((free_kb / 1024)) MB are free on the disk of \"$DIR\"; an update needs twice the last copy and 1 GB: $((need_kb / 1024)) MB. Free some space and run this again."
  if can_ask; then
    yes_no "Update rsc-brain in \"$DIR\" from $UPDATE_FROM to ${VERSION:-$IMAGE}? Writes wait meanwhile; a copy is made first, and if anything fails the version before comes back." y || {
      say 'Nothing was changed.'
      exit 1
    }
  fi
  trap update_interrupted HUP INT TERM
  if [ "$BUILD" = 1 ]; then
    NEXT_SRC=$DIR/$STATE/src.next
    rm -rf "${NEXT_SRC:?}"
    step "Fetching the source of rsc-brain $VERSION (rsc-brain $UPDATE_FROM keeps running)"
    (umask 022 && git clone --depth 1 --branch "$VERSION" "$REPO" "$NEXT_SRC") >&2 </dev/null || {
      drop_next
      missing "Could not fetch $VERSION from $(repo_public "$REPO"). Check the version (git tags) and the network."
    }
    step "Building the image $IMAGE"
    docker build -t "$IMAGE" "$NEXT_SRC" >&2 </dev/null || update_abort 'The image did not build: the lines above say why.'
  fi
  UPDATE_TO=$(docker run --rm "$IMAGE" rsc-brain version </dev/null 2>/dev/null)
  version_ok "$UPDATE_TO" || update_abort "The image $IMAGE does not say its version: it is not an rsc-brain image."
  if ! newer "$UPDATE_TO" "$UPDATE_FROM"; then
    drop_next
    usage "$IMAGE is rsc-brain $UPDATE_TO, not newer than $UPDATE_FROM (installed). rsc-brain only moves forward: its migrations go one way. Nothing was changed."
  fi

  # The door's image is here before anything moves: once the service stops is no time to fetch it.
  door_from=$DIR/compose.yaml
  [ "$BUILD" = 1 ] && [ -f "$NEXT_SRC/deploy/compose.yaml" ] && door_from=$NEXT_SRC/deploy/compose.yaml
  door_img=$(door_image "$door_from")
  if [ -n "$door_img" ] && ! docker image inspect "$door_img" >/dev/null 2>&1 </dev/null &&
    ! docker pull "$door_img" >&2 </dev/null; then
    drop_next
    missing "Could not fetch the image $door_img, which answers while rsc-brain is stopped. Check the network and run this again."
  fi

  step 'Turning maintenance on: writes wait («retry after»); reads keep working'
  dc exec -T app rsc-brain maintenance on --reason update </dev/null >&2 ||
    update_abort 'Maintenance could not be turned on (the lines above say why).'
  UPDATE_PHASE=maintenance
  step 'Making a copy of everything before the update'
  made=$(dc exec -T app rsc-brain backup --reason pre-update --json </dev/null)
  PRE_COPY=$(printf '%s\n' "$made" | sed -n 's/.*"file":"\([^"]*\)".*/\1/p' | head -n 1)
  case $PRE_COPY in
  rsc-brain-*-pre-update.rscb) ;;
  *) update_abort 'The copy before the update failed (the lines above say why). Maintenance is off again.' ;;
  esac
  { cp -p "$DIR/.env" "$DIR/$STATE/env.previous" && cp -p "$DIR/compose.yaml" "$DIR/$STATE/compose.yaml.previous"; } ||
    update_abort "Could not keep a copy of the settings in \"$DIR/$STATE\"."
  for f in Caddyfile door.Caddyfile; do
    if [ -f "$DIR/$f" ]; then
      cp -p "$DIR/$f" "$DIR/$STATE/$f.previous" || update_abort "Could not keep a copy of \"$DIR/$f\"."
    fi
  done

  # The journal, before anything is switched: a launcher killed from here on is taken back by the next one.
  journal=$DIR/$STATE/update.pending
  {
    {
      say_env RSC_BRAIN_UPDATE_PHASE switched
      say_env RSC_BRAIN_UPDATE_FROM "$UPDATE_FROM"
      say_env RSC_BRAIN_UPDATE_TO "$UPDATE_TO"
      say_env RSC_BRAIN_UPDATE_COPY "$PRE_COPY"
      say_env RSC_BRAIN_UPDATE_PREVIOUS_IMAGE "$old_image"
      say_env RSC_BRAIN_UPDATE_IMAGE "$IMAGE"
    } >"$journal.new" && mv -f "$journal.new" "$journal"
  } || update_abort "Could not write \"$journal\"."
  checkpoint update-journal
  # From here on, a failure goes back to the copy just made.
  UPDATE_PHASE=switched
  UPDATE_LOG=$DIR/$STATE/update.log
  { env_with RSC_BRAIN_IMAGE "$IMAGE" <"$DIR/$STATE/env.previous" >"$DIR/.env.new" &&
    chmod 600 "$DIR/.env.new" && mv -f "$DIR/.env.new" "$DIR/.env"; } || rollback "Could not write \"$DIR/.env\"."
  if [ "$BUILD" = 1 ]; then
    for f in compose.yaml Caddyfile door.Caddyfile; do
      [ -f "$NEXT_SRC/deploy/$f" ] || continue
      { cp "$NEXT_SRC/deploy/$f" "$DIR/$f.new" && chmod 644 "$DIR/$f.new" && mv -f "$DIR/$f.new" "$DIR/$f"; } ||
        rollback "Could not write \"$DIR/$f\"."
    done
  fi
  ensure_update_dirs || rollback "Could not create \"$DIR/update\"."
  step "Stopping rsc-brain $UPDATE_FROM"
  dc stop app >&2 </dev/null || rollback "rsc-brain $UPDATE_FROM could not be stopped."
  door_up 'Migrating the data.'
  step "Migrating the data for rsc-brain $UPDATE_TO"
  dc run --rm -T --no-deps app rsc-brain migrate </dev/null >"$UPDATE_LOG" 2>&1
  code=$?
  cat "$UPDATE_LOG" >&2
  [ "$code" = 0 ] || rollback "The migration of $UPDATE_TO failed (the lines above say why)."
  step "Starting rsc-brain $UPDATE_TO"
  door_down
  dc up -d --remove-orphans >&2 </dev/null || rollback "rsc-brain $UPDATE_TO did not start."
  wait_healthy || rollback "rsc-brain $UPDATE_TO did not answer within $WAIT_SECONDS seconds."
  now=$(dc exec -T app rsc-brain version </dev/null 2>/dev/null)
  [ "$now" = "$UPDATE_TO" ] || rollback "The service answers as rsc-brain ${now:-(no version)}, not $UPDATE_TO."

  # The new version runs. The tail is not cut: a signal here (a Ctrl-C reaches the whole foreground group) must neither
  # take back an update that has finished nor leave maintenance on (writes refused for up to 30 minutes, the journal
  # gone, the web never told). Signals ignored, and the calls out of the terminal's group, as the way back does.
  trap '' HUP INT TERM
  SHIELD=1
  checkpoint update-confirmed
  rm -f "${journal:?}"
  # A journal that survives would make a later launcher take back an update that went well: not confirmed, back now.
  [ ! -e "$journal" ] || rollback 'The journal could not be removed, so the update was not confirmed.'
  checkpoint update-journal-gone
  step 'Turning maintenance off: writes are taken again'
  dc_bounded exec -T app rsc-brain maintenance off </dev/null >&2 ||
    say "Maintenance could not be turned off; it ends by itself within 30 minutes."
  checkpoint update-maintenance-off
  dc_bounded exec -T app rsc-brain update record --ok --from "$UPDATE_FROM" --to "$UPDATE_TO" </dev/null >&2 ||
    say 'The web could not be told about this update (Admin > Backups & system); the update itself went well.'
  # What is left changes state still (the previous files, the new source: a stop between the two leaves no source), so
  # it is done with signals ignored too.
  rm -f "${DIR:?}/${STATE:?}/env.previous" "${DIR:?}/${STATE:?}/compose.yaml.previous" \
    "${DIR:?}/${STATE:?}/Caddyfile.previous" "${DIR:?}/${STATE:?}/door.Caddyfile.previous" "${UPDATE_LOG:?}" \
    "${DIR:?}/last-failure.log"
  checkpoint update-previous-gone
  if [ "$BUILD" = 1 ]; then
    rm -rf "${DIR:?}/${STATE:?}/src"
    mv "$NEXT_SRC" "$DIR/$STATE/src"
  fi
  # The tail that must not be cut is done; what follows (the updater's files) is a wait that a signal may end.
  SHIELD=0
  trap - HUP INT TERM
  checkpoint update-signals-back
  updater_refresh
  if [ "$JSON" = 1 ]; then
    printf '{"from":%s,"to":%s,"image":%s,"copy":%s,"dir":%s}\n' "$(json_str "$UPDATE_FROM")" \
      "$(json_str "$UPDATE_TO")" "$(json_str "$IMAGE")" "$(json_str "$PRE_COPY")" "$(json_str "$DIR")"
    return 0
  fi
  out "rsc-brain was updated from $UPDATE_FROM to $UPDATE_TO and answers at $(env_get RSC_BRAIN_SITE)."
  out "A copy of everything from just before is kept in \"$DIR/backups\": $PRE_COPY"
  return 0
}

# ------------------------------------------------------------------------------------------------------ web-updates
# Updates from the web (rsc-updates §3.7, §3.9): off until `web-updates enable`. The service never has Docker or the
# credential: it only leaves a mark in <dir>/update/request, which a container of its own (the updater, its own compose
# project, <name>-updater, apart from the service's) takes and answers by running `update` here. Layout, all in <dir>:
#   update/request   the service's marks (the updater only looks at them, never opens them)    0700
#   update/report    what the updater says, read by the service                                0755
#   update/state     the updater's memory (when it checked, which versions failed)             0700
#   updater/         the updater's files and, in credentials/, the access to a private repository   0700
# The updater mounts the Docker socket and <dir> at its own path, nothing else (deploy/compose.updater.yaml).
UPD_FILES='loop.sh credentials.sh Dockerfile'
# `enable` over an updater that works keeps aside, in updater/ itself (so disable and uninstall remove it with the rest),
# the files that hold no secret (updater/previous) and, by a rename, the credential (updater/credentials.old): there is
# never a second copy of a credential. UPD_WAS_ON: there was one.
UPD_WAS_ON=0
UPD_KEPT='compose.updater.yaml rsc-brain.sh loop.sh credentials.sh Dockerfile updater.env passwd'
updater_names() {
  UPD_PROJECT=$NAME-updater
  UPD_IMAGE=rsc-brain-updater:$NAME
}
# The service's folders for the marks and the report, made before the service starts (a bind mount of a folder that is
# not there would be made by Docker, for root).
ensure_update_dirs() {
  for d in update update/request update/report update/state; do
    [ -d "$DIR/$d" ] || mkdir "$DIR/$d" || return 1
  done
  chmod 755 "$DIR/update" "$DIR/update/report" && chmod 700 "$DIR/update/request" "$DIR/update/state" || return 1
  # As for the copies: the service runs as the owner of the folder, or as the image's unprivileged user when root made it.
  [ "$(id -u)" = 0 ] && chown 1000:1000 "$DIR/update/request"
  return 0
}
# docker compose for the updater's own project and file, and nothing of the service's.
uc() {
  (
    for v in COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PATH_SEPARATOR \
      RSC_BRAIN_UPDATER_DIR RSC_BRAIN_UPDATER_UID RSC_BRAIN_UPDATER_GID RSC_BRAIN_UPDATER_SOCKET_GID \
      RSC_BRAIN_UPDATER_HOSTNAME RSC_BRAIN_UPDATER_IMAGE; do unset "$v"; done
    exec docker compose --project-directory "$DIR" -p "$UPD_PROJECT" -f "$DIR/updater/compose.updater.yaml" \
      --env-file "$DIR/updater/updater.env" "$@"
  )
}
# updater_install_file FROM TO MODE: a file of the updater, whole or not at all.
updater_install_file() {
  { cp "$1" "$2.new" && chmod "$3" "$2.new" && mv -f "$2.new" "$2"; } 2>/dev/null
}
# The files of the updater from a folder with the launcher's files (deploy/): 0 when all were put.
updater_files() {
  updater_install_file "$1/compose.updater.yaml" "$DIR/updater/compose.updater.yaml" 644 || return 1
  updater_install_file "$1/rsc-brain.sh" "$DIR/updater/rsc-brain.sh" 755 || return 1
  for f in $UPD_FILES; do
    updater_install_file "$1/updater/$f" "$DIR/updater/$f" 755 || return 1
  done
  return 0
}
updater_source() {
  for d in "$HERE" "$DIR/$STATE/src/deploy"; do
    if [ -f "$d/compose.updater.yaml" ] && [ -f "$d/rsc-brain.sh" ] && [ -f "$d/updater/loop.sh" ] &&
      [ -f "$d/updater/credentials.sh" ] && [ -f "$d/updater/Dockerfile" ]; then
      echo "$d"
      return 0
    fi
  done
  return 1
}
# After an update that went well, the updater runs the files of the new version (its container ends and starts again
# from them). Never fatal: the update itself went well.
updater_refresh() {
  [ -f "$DIR/updater/updater.env" ] || return 0
  [ "$BUILD" = 1 ] || return 0
  ur_src=$DIR/$STATE/src/deploy
  [ -f "$ur_src/updater/loop.sh" ] && [ -f "$ur_src/compose.updater.yaml" ] || return 0
  updater_files "$ur_src" ||
    say "The updater could not be given the files of $UPDATE_TO (it keeps running those it has). Run: sh $PROG web-updates enable --dir \"$DIR\""
  return 0
}
# What a failed or refused enable leaves behind is taken back: the container, the image it built, the folder.
# Whatever is kept aside comes back, and nothing is left over. Safe to run again, and after a run that was cut short.
updater_put_back() {
  if [ -d "$DIR/updater/credentials.old" ]; then
    rm -rf "${DIR:?}/updater/credentials"
    mv "$DIR/updater/credentials.old" "$DIR/updater/credentials"
  fi
  if [ -d "$DIR/updater/previous" ]; then
    for pb in $UPD_KEPT; do
      [ -f "$DIR/updater/previous/$pb" ] || continue
      { cp -p "$DIR/updater/previous/$pb" "$DIR/updater/$pb.new" && mv -f "$DIR/updater/$pb.new" "$DIR/updater/$pb"; } 2>/dev/null
    done
    rm -rf "${DIR:?}/updater/previous"
  fi
  return 0
}
updater_take_back() {
  if [ "$UPD_WAS_ON" = 1 ]; then
    # It was working before this run: only what this run changed is undone, and it keeps running (started again only
    # if this run's start had stopped it). Running this twice does the same as once.
    updater_put_back
    [ -n "$(uc ps -q 2>/dev/null </dev/null)" ] || uc up -d >/dev/null 2>&1 </dev/null
    return 0
  fi
  if [ -f "$DIR/updater/compose.updater.yaml" ] && [ -f "$DIR/updater/updater.env" ]; then
    uc down --remove-orphans >&2 </dev/null
  fi
  docker image rm "$UPD_IMAGE" >/dev/null 2>&1 </dev/null
  rm -rf "${DIR:?}/updater"
  return 0
}
# Every copy of the credential: the one in use, the one kept aside by an enable, and what an enable that was cut short left.
updater_drop_credentials() {
  rm -rf "${DIR:?}/updater/credentials" "${DIR:?}/updater/credentials.old" "${DIR:?}/updater/previous" \
    "${DIR:?}/updater/previous.tmp" \
    "${DIR:?}/${STATE:?}/updater.previous"
}
# updater_remove: no container, no image, no credential, none of what it said. 0 when all is gone.
updater_remove() {
  ur_ok=0
  # The credential first: it goes whatever Docker says.
  updater_drop_credentials
  if [ -d "$DIR/updater" ] || [ -f "$DIR/update/report/updater.json" ]; then
    if docker info >/dev/null 2>&1 </dev/null; then
      if [ -f "$DIR/updater/compose.updater.yaml" ] && [ -f "$DIR/updater/updater.env" ]; then
        uc down --remove-orphans >&2 </dev/null || ur_ok=1
      fi
      ur_left=$(docker ps -aq --filter "label=com.docker.compose.project=$UPD_PROJECT" 2>/dev/null </dev/null)
      # shellcheck disable=SC2086
      [ -z "$ur_left" ] || docker rm -f $ur_left >/dev/null 2>&1 </dev/null || ur_ok=1
      docker image rm "$UPD_IMAGE" >/dev/null 2>&1 </dev/null
    else
      say 'Docker did not answer, so the updater container may still be running: stop it when Docker is back.'
      say "The credential is removed. Run: sh $PROG web-updates disable --dir \"$DIR\" again then."
      ur_ok=1
    fi
  fi
  rm -rf "${DIR:?}/updater"
  rm -f "$DIR/update/report/updater.json" "$DIR/update/report/check.json" "$DIR/update/request/request" \
    "$DIR/update/request/retry"
  if [ -d "$DIR/update/state" ]; then
    rm -rf "${DIR:?}/update/state"
    mkdir "$DIR/update/state" 2>/dev/null && chmod 700 "$DIR/update/state"
  fi
  return "$ur_ok"
}
# A token file: one line of the characters tokens are made of. A key file: a PEM private key. Neither is ever printed.
check_token_file() {
  [ -f "$1" ] && [ -r "$1" ] || usage '--repo-token-file takes a file with the token in it.'
  ct_lines=$(wc -l <"$1" | tr -d ' ')
  ct_token=''
  IFS= read -r ct_token <"$1" || :
  { [ "$ct_lines" -le 1 ] && matches "$ct_token" '^[A-Za-z0-9_.~+/=-]{8,255}$'; } ||
    usage '--repo-token-file takes one line: the token, with no spaces. (It is not shown here.)'
}
check_key_file() {
  [ -f "$1" ] && [ -r "$1" ] || usage '--repo-key takes a file with an SSH private key in it.'
  { [ "$(wc -c <"$1" | tr -d ' ')" -le 16384 ] && head -n 1 "$1" | grep -Eq '^-----BEGIN [A-Z ]*PRIVATE KEY-----$'; } ||
    usage '--repo-key takes an SSH private key file (the one that starts with -----BEGIN ... PRIVATE KEY-----).'
}
web_updates_enable() {
  need_installation
  if [ "$(env_get RSC_BRAIN_COMPANION)" = 1 ]; then
    say 'rsc-brain was installed by rsc-factory: update it from there.'
    say 'Nothing was changed.'
    exit 2
  fi
  installation_repo
  updater_names
  case $DIR in *[:\$]*) usage "Updates from the web need an installation folder without ':' or '\$' in its path (\"$DIR\")." ;; esac
  case $REPO in https://*) https=1 ;; *) https=0 ;; esac
  if [ -n "$REPO_TOKEN" ]; then
    [ "$https" = 1 ] || usage "A token goes with an https address; this installation's repository is not one. Use --repo-key."
    check_token_file "$REPO_TOKEN"
  fi
  if [ -n "$REPO_KEY" ]; then
    [ "$https" = 0 ] || usage "A key goes with an SSH address; this installation's repository is an https one. Use --repo-token-file."
    check_key_file "$REPO_KEY"
  fi
  say 'Read this before turning updates from the web on.'
  say 'A container of its own will run the updates, and it will have full control of Docker on this machine:'
  say 'whoever controls it controls this server. The web can only ask it for an update, and only an administrator who'
  say 'signed in on the web and proved who they are again can ask; but anyone who breaks into that container, or into'
  say "the Docker socket it uses, has the server. Turn it off any time with: sh $PROG web-updates disable --dir \"$DIR\""
  if can_ask; then
    yes_no 'Turn on updates from the web?' n || {
      say 'Nothing was changed.'
      exit 1
    }
  elif [ "$YES" = 0 ]; then
    usage 'There is no terminal to ask on. Pass --yes to turn updates from the web on.'
  fi
  need_docker
  take_lock
  src=$(updater_source) ||
    missing 'The updater files (updater/, compose.updater.yaml) are not next to the launcher. Run it from a copy of the repository (deploy/), or update rsc-brain to a version that has them.'
  # An enable that was cut short (killed, a power cut) left things aside: back to how it was before anything else.
  # A copy that was being made is not whole, and the live files are: it is thrown away. `previous` exists only whole.
  rm -rf "${DIR:?}/updater/previous.tmp"
  if [ -d "$DIR/updater/previous" ] || [ -d "$DIR/updater/credentials.old" ]; then
    say 'An earlier turning on was cut short: the updater goes back to how it was before it.'
    updater_put_back
  fi
  if [ -f "$DIR/updater/updater.env" ]; then
    UPD_WAS_ON=1
    # Built apart and moved into place when whole: `previous` existing means it is complete.
    if ! { mkdir "$DIR/updater/previous.tmp" && chmod 700 "$DIR/updater/previous.tmp"; }; then
      rm -rf "${DIR:?}/updater/previous.tmp"
      failed 4 'Could not keep the updater that runs aside.'
    fi
    for we_f in $UPD_KEPT; do
      [ -f "$DIR/updater/$we_f" ] || continue
      if ! cp -p "$DIR/updater/$we_f" "$DIR/updater/previous.tmp/$we_f" 2>/dev/null; then
        rm -rf "${DIR:?}/updater/previous.tmp"
        failed 4 'Could not keep the updater that runs aside.'
      fi
    done
    if ! mv "$DIR/updater/previous.tmp" "$DIR/updater/previous"; then
      rm -rf "${DIR:?}/updater/previous.tmp"
      failed 4 'Could not keep the updater that runs aside.'
    fi
  fi
  trap 'to_terminal; updater_take_back; exit 4' HUP INT TERM
  if ! { mkdir -p "$DIR/updater/credentials" "$DIR/updater/home" 2>/dev/null &&
    chmod 700 "$DIR/updater" "$DIR/updater/credentials" "$DIR/updater/home"; }; then
    updater_take_back
    failed 4 "Cannot create \"$DIR/updater\"."
  fi
  ensure_update_dirs || {
    updater_take_back
    failed 4 "Cannot create \"$DIR/update\"."
  }
  updater_files "$src" || {
    updater_take_back
    failed 4 "Could not write the updater's files in \"$DIR/updater\"."
  }
  # The access, copied for the updater alone; a secret goes by file, never by argument. One that works is moved aside
  # (a rename, no second copy) until this run has gone well.
  if [ "$UPD_WAS_ON" = 1 ] && { [ -n "$REPO_TOKEN" ] || [ -n "$REPO_KEY" ]; }; then
    if ! { mv "$DIR/updater/credentials" "$DIR/updater/credentials.old" && mkdir "$DIR/updater/credentials" &&
      chmod 700 "$DIR/updater/credentials"; }; then
      updater_take_back
      failed 4 'Could not set the credential aside.'
    fi
  fi
  if [ -n "$REPO_TOKEN" ]; then
    rm -f "$DIR/updater/credentials/key" "$DIR/updater/credentials/known_hosts"
    { cat "$REPO_TOKEN" >"$DIR/updater/credentials/token.new" && chmod 600 "$DIR/updater/credentials/token.new" &&
      mv -f "$DIR/updater/credentials/token.new" "$DIR/updater/credentials/token"; } 2>/dev/null || {
      updater_take_back
      failed 4 'Could not keep the token for the updater.'
    }
  elif [ -n "$REPO_KEY" ]; then
    rm -f "$DIR/updater/credentials/token"
    { cat "$REPO_KEY" >"$DIR/updater/credentials/key.new" && chmod 600 "$DIR/updater/credentials/key.new" &&
      mv -f "$DIR/updater/credentials/key.new" "$DIR/updater/credentials/key"; } 2>/dev/null || {
      updater_take_back
      failed 4 'Could not keep the key for the updater.'
    }
  fi
  # The updater runs as the owner of the installation's settings, so what it writes stays theirs.
  # shellcheck disable=SC2012
  we_ids=$(ls -ldn "$DIR/.env" 2>/dev/null | tr -s ' ' | cut -d' ' -f3,4)
  we_uid=${we_ids% *} we_gid=${we_ids#* }
  matches "$we_uid:$we_gid" '^[0-9]+:[0-9]+$' || {
    updater_take_back
    failed 4 "Cannot tell who owns \"$DIR/.env\"."
  }
  step 'Building the updater image'
  docker build -t "$UPD_IMAGE" - <"$DIR/updater/Dockerfile" >&2 || {
    updater_take_back
    failed 4 'The updater image did not build (the lines above say why). Nothing is running.'
  }
  # The group of the socket as a container sees it, which is not always the host's.
  we_sock=$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$UPD_IMAGE" stat -c %g /var/run/docker.sock 2>/dev/null </dev/null)
  matches "$we_sock" '^[0-9]+$' || {
    updater_take_back
    missing 'Could not read the group of the Docker socket from a container.'
  }
  if ! {
    {
      say_env RSC_BRAIN_UPDATER_DIR "$DIR"
      say_env RSC_BRAIN_UPDATER_UID "$we_uid"
      say_env RSC_BRAIN_UPDATER_GID "$we_gid"
      say_env RSC_BRAIN_UPDATER_SOCKET_GID "$we_sock"
      say_env RSC_BRAIN_UPDATER_HOSTNAME "$UPD_PROJECT"
      say_env RSC_BRAIN_UPDATER_IMAGE "$UPD_IMAGE"
    } >"$DIR/updater/updater.env.new" && mv -f "$DIR/updater/updater.env.new" "$DIR/updater/updater.env"
  }; then
    updater_take_back
    failed 4 "Could not write \"$DIR/updater/updater.env\"."
  fi
  if ! {
    {
      printf 'root:x:0:0:root:/root:/bin/sh\n'
      [ "$we_uid" = 0 ] || printf 'updater:x:%s:%s:rsc-brain updater:%s/updater/home:/bin/sh\n' "$we_uid" "$we_gid" "$DIR"
    } >"$DIR/updater/passwd.new" && chmod 644 "$DIR/updater/passwd.new" && mv -f "$DIR/updater/passwd.new" "$DIR/updater/passwd"
  }; then
    updater_take_back
    failed 4 "Could not write \"$DIR/updater/passwd\"."
  fi
  # The repository must answer with this access, from a container like the updater's, before anything runs.
  step "Checking that $(repo_public "$REPO") answers with this access"
  docker run --rm -u "$we_uid:$we_gid" -v "$DIR:$DIR" -v "$DIR/updater/passwd:/etc/passwd:ro" \
    -e "RSC_BRAIN_UPDATER_DIR=$DIR" -e "HOME=$DIR/updater/home" "$UPD_IMAGE" sh "$DIR/updater/loop.sh" --access </dev/null >&2 || {
    updater_take_back
    say "Could not turn updates from the web on: $(repo_public "$REPO") does not answer with that access."
    say 'Give it read access (--repo-token-file for an https address, --repo-key for SSH) that works from this machine.'
    missing 'The updater was not started.'
  }
  step 'Starting the updater'
  uc up -d >&2 </dev/null || {
    updater_take_back
    failed 4 'The updater did not start (the lines above say why). Everything it made was removed.'
  }
  # A disable that was cut short left its mark. This enable has the lock and the new updater is up: only now is the mark
  # cleared. Had it failed before, the old updater would still be there, and the mark keeps it from starting anything.
  rm -f "$DIR/updater/disabling"
  # What was kept aside goes first: a signal after this finds nothing to put back over the new updater.
  rm -rf "${DIR:?}/updater/previous" "${DIR:?}/updater/credentials.old"
  trap - HUP INT TERM
  out 'Updates from the web are on.'
  out 'An administrator signed in on the web can now update rsc-brain; the updater takes the request and runs the update.'
  out "It controls Docker on this machine. Turn it off with: sh $PROG web-updates disable --dir \"$DIR\""
  return 0
}
web_updates_disable() {
  need_installation
  updater_names
  # The credential goes first, whatever else is going on: a launcher at work must not keep it on disk. Another launcher
  # that holds the lock keeps it until we have it, so nothing of an enable still running can bring a copy back after
  # this has said it is gone: this only says so once it has the lock and has removed the whole folder.
  # The updater is told before the lock is asked for: until a disable has finished it takes the marks and starts nothing.
  [ ! -d "$DIR/updater" ] || : >"$DIR/updater/disabling" 2>/dev/null
  updater_drop_credentials
  LOCK_AFTER_DISABLE_STEP=1
  take_lock
  LOCK_AFTER_DISABLE_STEP=0
  updater_remove || {
    say 'The credential is removed, but the updater could not be fully removed (the lines above say why).'
    exit 1
  }
  out 'Updates from the web are off. To update, run: sh '"$PROG"' update --dir "'"$DIR"'"'
  return 0
}
web_updates_status() {
  need_installation
  updater_names
  if [ "$(env_get RSC_BRAIN_COMPANION)" = 1 ]; then
    out 'Updates from the web are off. rsc-brain was installed by rsc-factory: update it from there.'
    return 0
  fi
  if [ -f "$DIR/updater/disabling" ]; then
    out 'Updates from the web are being turned off: a disable has not finished. The credential is removed, and the updater may still be running (it starts nothing).'
    out "Run: sh $PROG web-updates disable --dir \"$DIR\" again."
    return 0
  fi
  if [ -f "$DIR/updater/updater.env" ] && docker info >/dev/null 2>&1 </dev/null &&
    [ -n "$(uc ps -q 2>/dev/null </dev/null)" ]; then
    out 'Updates from the web are on.'
    return 0
  fi
  out 'Updates from the web are off.'
  out "Turn them on with: sh $PROG web-updates enable --dir \"$DIR\""
  return 0
}

# ------------------------------------------------------------------------------------------------------- key rotate
# A new installation key: everything sealed is sealed again with it (one transaction, with the service stopped), and
# copies from then on use it. Copies made before need the previous key, kept in installation-key-<id>.txt (0600).
key_id_of() {
  kio_key=$1
  if running; then set -- exec -T app; else set -- run --rm -T --no-deps app; fi
  printf '%s\n' "$kio_key" | dc "$@" rsc-brain key id 2>/dev/null
}
key_rotate() {
  need_installation
  [ "$YES" = 1 ] || can_ask || usage 'There is no terminal to confirm on. Pass --yes to rotate the installation key.'
  if [ "$YES" = 0 ]; then
    yes_no "Make a new installation key for rsc-brain in \"$DIR\"? It stops for a moment. Copies made before keep needing the current key, which is kept in a file next to .env." n || {
      say 'Nothing was changed.'
      exit 1
    }
  fi
  take_lock
  need_docker
  interrupted_work update-only
  old=$(env_get RSC_BRAIN_SECRET)
  old_id=$(key_id_of "$old")
  case $old_id in '' | *[!0-9A-Za-z_-]*)
    say 'Could not read the id of the key in use (see: sh rsc-brain.sh status). Nothing was changed.'
    exit 1
    ;;
  esac
  old_file=$DIR/installation-key-$old_id.txt
  if [ ! -f "$old_file" ]; then
    { printf '%s\n' "$old" >"$old_file.new" && chmod 600 "$old_file.new" && mv -f "$old_file.new" "$old_file"; } || {
      say "Could not write \"$old_file\". Nothing was changed."
      exit 1
    }
  fi
  # The new key lives in <state>/env.rotated (the settings with it) until it is in .env. A rotation killed halfway left
  # it there, and the data may be sealed with it already: it is finished with that key, never with another.
  rotated=$DIR/$STATE/env.rotated
  if [ -f "$rotated" ]; then
    new=$(file_get "$rotated" RSC_BRAIN_SECRET)
    if [ ${#new} -lt 32 ] || [ "$new" = "$old" ]; then
      say "A key rotation was interrupted, and \"$rotated\" holds no new key. Nothing was changed: look at that file (it may"
      say 'hold the key the data is sealed with) and remove it only if it does not.'
      exit 1
    fi
    say "A key rotation in \"$DIR\" was interrupted: finishing it with the key it had made."
  else
    new=$(random_hex 48)
    { env_with RSC_BRAIN_SECRET "$new" <"$DIR/.env" >"$rotated.new" && chmod 600 "$rotated.new" && mv -f "$rotated.new" "$rotated"; } || {
      rm -f "${rotated:?}.new"
      say "Could not write \"$rotated\". Nothing was changed."
      exit 1
    }
  fi
  # Between the reseal and the new .env nothing may stop it halfway.
  trap '' HUP INT TERM
  SHIELD=1
  step 'Stopping rsc-brain'
  dc stop app >&2 </dev/null
  step 'Sealing everything sealed with the new key'
  # The reseal goes from the key in the settings it runs with to the key on its standard input; done again, it finds
  # what is sealed with the new key already and changes nothing more.
  if ! printf '%s\n' "$new" | dc run --rm -T --no-deps app rsc-brain key reseal >&2; then
    # It may have written before it failed: the new key is dropped only once everything is sealed with the old one
    # again (that reseal, from the new key to the old, finds nothing to do when nothing was written).
    step 'Making sure everything is sealed with the key in use'
    ENV_FILE=$rotated
    printf '%s\n' "$old" | dc run --rm -T --no-deps app rsc-brain key reseal >&2
    back=$?
    ENV_FILE=$DIR/.env
    if [ "$back" = 0 ]; then rm -f "${rotated:?}"; fi
    step 'Starting rsc-brain again'
    { dc up -d --remove-orphans >&2 </dev/null && wait_healthy; } || say "rsc-brain did not answer. See why with: docker compose --project-directory \"$DIR\" logs app"
    if [ "$back" = 0 ]; then
      say 'The key was not changed (the lines above say why). rsc-brain runs with the key it had.'
    else
      say "The key was not changed, but it cannot be told which key the data is sealed with: the new one is kept in"
      say "\"$rotated\". Run sh $PROG key rotate --dir \"$DIR\" again to finish the rotation once the lines above are dealt with."
    fi
    exit 1
  fi
  mv -f "$rotated" "$DIR/.env" || {
    say "Everything is sealed with the new key, but \"$DIR/.env\" could not be replaced. Move \"$rotated\" to \"$DIR/.env\" before starting rsc-brain."
    exit 1
  }
  trap - HUP INT TERM
  SHIELD=0
  step 'Starting rsc-brain'
  { dc up -d --remove-orphans >&2 </dev/null && wait_healthy; } ||
    say "rsc-brain did not answer after the rotation. See why with: docker compose --project-directory \"$DIR\" logs app"
  new_id=$(key_id_of "$new")
  say "Copies made before need the previous key (id $old_id), kept in \"$old_file\" (only you can read it): the web marks"
  say 'them «Needs the older key». Copies from now on use the new key. Sessions, tokens and connections keep working.'
  if [ "$JSON" = 1 ]; then
    printf '{"keyId":%s,"installationKey":%s,"previousKeyId":%s,"previousKeyFile":%s,"dir":%s}\n' "$(json_str "$new_id")" \
      "$(json_str "$new")" "$(json_str "$old_id")" "$(json_str "$old_file")" "$(json_str "$DIR")"
    return 0
  fi
  if [ -t 1 ]; then
    out "The new installation key (id $new_id). Save it now in a password manager, in place of the previous one:"
    out ''
    out "  $new"
    out ''
  else
    out "The new installation key (id $new_id) is kept in \"$DIR/.env\". Print it with: sh $PROG key show --dir \"$DIR\","
    out 'and save it in a password manager, in place of the previous one.'
  fi
  return 0
}

key_show() {
  need_installation
  # With a rotation left halfway the data may be sealed with the new key, not the one in .env: printing that one could
  # have it saved as the key that opens the copies.
  if [ -f "$DIR/$STATE/env.rotated" ]; then
    say "A key rotation in \"$DIR\" was interrupted: the key in .env may no longer be the one the data is sealed with."
    say "Run sh $PROG key rotate --dir \"$DIR\" to finish the earlier rotation, then print the key. Nothing was printed."
    exit 1
  fi
  if [ "$YES" = 0 ]; then
    can_ask || usage 'There is no terminal to confirm on. Pass --yes to print the installation key.'
    yes_no 'The installation key opens every copy of this installation. Print it here?' n || exit 1
  fi
  env_get RSC_BRAIN_SECRET
}

uninstall() {
  need_installation
  take_lock
  if [ "$DELETE_DATA" = 1 ]; then
    if [ "$CONFIRM_SET" = 0 ]; then
      can_ask || usage "Deleting the data needs --confirm $NAME (the installation's name). Nothing was deleted."
      ask "This deletes the database and the copies of $NAME for good. Type its name ($NAME) to go on: "
      CONFIRM=$ANSWER
    fi
    [ "$CONFIRM" = "$NAME" ] || usage "That is not the installation's name ($NAME). Nothing was deleted."
  fi
  need_docker
  interrupted_work
  db=$(env_get RSC_BRAIN_DB)
  updater_names
  updater_remove || say 'The updater could not be fully removed (the lines above say why).'
  if [ "$DELETE_DATA" = 0 ]; then
    step 'Stopping rsc-brain and removing its containers'
    dc down --remove-orphans >&2 </dev/null || exit 1
    out "rsc-brain was removed from this machine's containers. Its database, the copies in \"$DIR/backups\" and the"
    out "installation key (\"$DIR/.env\") are kept: sh $PROG install --dir \"$DIR\" brings it back as it was."
    return 0
  fi
  db_name=$(env_get RSC_BRAIN_DB_NAME)
  if [ "$db" != bundled ] && [ -n "$ADMIN_URL_FILE" ]; then
    read_url "$ADMIN_URL_FILE"
    step "Removing the database $db_name and the role $db_name"
    printf '%s\n' "$RU" | dc run --rm -T --no-deps app rsc-brain db drop --database "$db_name" --role "$db_name" \
      --confirm "$db_name" >&2 || {
      say 'The database was not removed (the line above says why). Nothing else was deleted.'
      exit 1
    }
  fi
  step 'Stopping rsc-brain and removing its containers, network and volumes'
  dc down -v --remove-orphans >&2 </dev/null || exit 1
  printf '%s\n' "$(env_get RSC_BRAIN_SECRET)" >"$DIR/installation-key.txt"
  chmod 600 "$DIR/installation-key.txt"
  rm -rf "${DIR:?}/backups" "${DIR:?}/${STATE:?}" "${DIR:?}/compose.yaml" "${DIR:?}/Caddyfile" "${DIR:?}/door.Caddyfile" "${DIR:?}/.env" \
    "${DIR:?}/compose.companion.yaml" "${DIR:?}/last-failure.log" "${DIR:?}/update"
  out "rsc-brain and its copies were deleted from \"$DIR\"."
  if [ "$db" != bundled ] && [ -z "$ADMIN_URL_FILE" ]; then
    out "Its database is on your PostgreSQL and was not touched: remove the database rsc-brain used (and its role) there,"
    out "or run this again with --db-admin-url-file."
  fi
  out "The installation key is kept in \"$DIR/installation-key.txt\" (copies you downloaded need it). Delete it when"
  out 'you no longer need them.'
  return 0
}

warn_shell_vars
# A closed error stream or standard output is no reason to stop (dash ends a script whose `exec` cannot redirect):
# what would go there goes nowhere. Each is tried in a subshell, on another descriptor (dash takes >&1 as nothing to
# do), and the error stream without 2>/dev/null, which would open it.
if (exec 4>&2); then exec 4>&2; else exec 4>/dev/null; fi
if (exec 5>&1) 2>/dev/null; then exec 5>&1; else exec 5>/dev/null; fi
case $CMD in
install) install ;;
update) if [ "$CHECK" = 1 ]; then update_check; else update; fi ;;
status) status ;;
backup) backup ;;
backups) backups ;;
restore) restore ;;
'key show') key_show ;;
'key rotate') key_rotate ;;
'web-updates enable') web_updates_enable ;;
'web-updates disable') web_updates_disable ;;
'web-updates status') web_updates_status ;;
uninstall) uninstall ;;
esac
