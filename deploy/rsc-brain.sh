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
# source is cloned from.

set -u
umask 077

PROG=rsc-brain.sh
REPO=${RSC_BRAIN_REPO:-https://github.com/ericrisco/rsc-brain.git}
TTY=${RSC_BRAIN_TTY:-/dev/tty}
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
NL='
'
CR=$(printf '\r')
MIN_FREE_KB=2097152

USAGE="Usage: sh $PROG <command> [options]

Commands:
  install           install rsc-brain, or apply new settings to an installation (its key and data are kept)
  status [--json]   whether rsc-brain runs and answers
  backup [--json]   make an encrypted copy of everything now
  backups [--json]  list the copies
  restore --file F --confirm NAME [--key-file K]
                    replace everything with the copy F (a copy of what is there is made first). NAME is the
                    installation's name as the web shows it; K holds the key the copy was made with (default: this
                    installation's). Everyone signs in again afterwards
  key show          print the installation key (it opens the copies; keep it safe)
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
install | status | backup | backups | restore | uninstall) ;;
key)
  [ "${1:-}" = show ] || usage 'Say key show.'
  CMD='key show'
  shift
  ;;
*) usage "Unknown command. $USAGE" ;;
esac

MODE='' DOMAIN='' DB='' DB_URL_FILE='' ADMIN_URL_FILE='' FACTORY_DB='' PORT='' HTTP_PORT='' HTTPS_PORT=''
DIR='' DIR_GIVEN=0 NAME='' VERSION='' IMAGE='' COPY_FILE='' KEY_FILE='' CONFIRM='' CONFIRM_SET=0 DELETE_DATA=0
OPT=''
# The option goes with these commands only.
only() {
  case " $* " in
  *" $CMD "*) ;;
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
  --version) only install && value "$@" && VERSION=$2 && shift ;;
  --image) only install && value "$@" && IMAGE=$2 && shift ;;
  --file) only restore && value "$@" && COPY_FILE=$2 && shift ;;
  --key-file) only restore && value "$@" && KEY_FILE=$2 && shift ;;
  --confirm) only restore uninstall && value "$@" && CONFIRM=$2 && CONFIRM_SET=1 && shift ;;
  --delete-data) only uninstall && DELETE_DATA=1 ;;
  --dir) value "$@" && DIR=$2 && DIR_GIVEN=1 && shift ;;
  --yes) YES=1 ;;
  --json) only install status backup backups restore && JSON=1 ;;
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
  [ -n "$VERSION" ] && [ -n "$IMAGE" ] && usage 'Pass --version or --image, not both.'
  [ -z "$VERSION" ] || matches "$VERSION" '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
    usage '--version takes a published version such as v1.2.0.'
  [ -z "$IMAGE" ] || matches "$IMAGE" '^[A-Za-z0-9][A-Za-z0-9._/:@-]*$' || usage '--image takes an image name such as rsc-brain:v1.2.0.'
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
env_get() { sed -n "s/^$1='\\(.*\\)'\$/\\1/p" "$DIR/.env" | head -n 1; }

# Where an installation is when --dir is not given: the one for this machine, or the one for a server.
find_dir() {
  [ -n "$DIR" ] && return
  for d in "${HOME:-/nonexistent}/rsc-brain" /opt/rsc-brain; do
    if [ -f "$d/.env" ]; then
      DIR=$d
      return
    fi
  done
  DIR=${HOME:-/nonexistent}/rsc-brain
}
need_installation() {
  find_dir
  if [ ! -f "$DIR/.env" ]; then
    say "No rsc-brain installation in $DIR. Pass --dir with the folder it was installed in. Nothing was changed."
    exit 3
  fi
  NAME=$(env_get RSC_BRAIN_NAME)
  PROFILES=$(env_get COMPOSE_PROFILES)
}

# docker compose, always for this installation's project and files (and never anything else's).
dc() {
  if [ -f "$DIR/compose.override.yaml" ]; then
    set -- -f "$DIR/compose.yaml" -f "$DIR/compose.override.yaml" "$@"
  else
    set -- -f "$DIR/compose.yaml" "$@"
  fi
  for p in $(printf '%s' "$PROFILES" | tr ',' ' '); do
    set -- --profile "$p" "$@"
  done
  docker compose --project-directory "$DIR" -p "$NAME" --env-file "$DIR/.env" "$@"
}

running() { [ -n "$(dc ps -q app 2>/dev/null </dev/null)" ]; }
healthy() { dc exec -T app wget -q -O /dev/null http://127.0.0.1:8090/v1/health >/dev/null 2>&1 </dev/null; }
wait_healthy() {
  i=0
  while [ "$i" -lt 120 ]; do
    healthy && return 0
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------------------------------------- requirements (CA4)
missing() {
  say "$1"
  say 'Nothing was changed.'
  exit 3
}
need_docker() {
  command -v docker >/dev/null 2>&1 ||
    missing 'Docker is not installed. Install Docker Desktop (macOS) or Docker Engine (Linux): https://docs.docker.com/get-docker/ and run this again.'
  docker info >/dev/null 2>&1 </dev/null ||
    missing 'Docker is not running. Start Docker Desktop (or the docker service: sudo systemctl start docker) and run this again.'
  docker compose version >/dev/null 2>&1 </dev/null ||
    missing 'Docker Compose v2 is missing (the "docker compose" command). Install it: https://docs.docker.com/compose/install/'
}

port_busy() {
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 2 127.0.0.1 "$1" >/dev/null 2>&1 </dev/null
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi
  return 1
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
  port_busy "$fp" || return 0
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
    [ -r "$1" ] || usage "The file $1 cannot be read."
    RU=$(cat -- "$1")
  fi
  case $RU in
  *"$NL"* | *"$CR"* | *"'"*) usage "The URL in $1 holds a line break or a quote; percent-encode a quote as %27." ;;
  postgres://?* | postgresql://?*) ;;
  *) usage "The file $1 does not hold a PostgreSQL URL (postgres://...)." ;;
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

# ---------------------------------------------------------------------------------------------------------- install
# What this run made, so a failure takes back exactly that.
MADE_DIR=0 MADE_IMAGE=0 MADE_FILES='' PROVISIONED=0 STARTED=0 REINSTALL=0

take_back() {
  if [ "$REINSTALL" = 1 ]; then
    if [ -f "$DIR/.env.previous" ]; then
      mv -f "$DIR/.env.previous" "$DIR/.env"
      PROFILES=$(env_get COMPOSE_PROFILES)
      step 'Starting the previous settings again'
      dc up -d --remove-orphans >&2 </dev/null || say "The previous installation did not start either: see 'docker compose logs' in $DIR."
    fi
    return
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
  for f in $MADE_FILES; do rm -rf "${DIR:?}/$f"; done
  [ "$MADE_DIR" = 1 ] && rmdir "$DIR" 2>/dev/null
  [ "$MADE_IMAGE" = 1 ] && docker image rm "$IMAGE" >/dev/null 2>&1 </dev/null
  return 0
}
# failed CODE MESSAGE: take back what this run made, then exit with CODE (4: failed and put back; 3: a requirement).
failed() {
  say "$2"
  take_back
  if [ "$1" = 3 ]; then say 'Nothing was changed.'; else
    if [ "$REINSTALL" = 1 ]; then say 'The previous settings were put back.'; else say 'Everything it made was removed.'; fi
  fi
  exit "$1"
}

say_env() { printf "%s='%s'\n" "$1" "$2"; }
write_env() {
  {
    echo '# rsc-brain settings, written by rsc-brain.sh. Only its owner may read this file: it holds the'
    echo '# installation key, which opens every copy. Change settings by running rsc-brain.sh install again.'
    say_env RSC_BRAIN_NAME "$NAME"
    say_env COMPOSE_PROJECT_NAME "$NAME"
    say_env COMPOSE_PROFILES "$PROFILES"
    say_env RSC_BRAIN_MODE "$MODE"
    say_env RSC_BRAIN_DB "$DB"
    say_env RSC_BRAIN_IMAGE "$IMAGE"
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
    [ "$DB" = bundled ] && say_env POSTGRES_PASSWORD "$PG_PASSWORD"
    say_env RSC_BRAIN_DATABASE_URL "$DATABASE_URL"
    say_env RSC_BRAIN_SECRET "$SECRET"
  } >"$DIR/.env.new" && chmod 600 "$DIR/.env.new" && mv -f "$DIR/.env.new" "$DIR/.env"
}

random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

install() {
  # Where, and what is there already.
  if [ -z "$DIR" ]; then
    case $MODE in
    local) DIR=${HOME:-/nonexistent}/rsc-brain ;;
    server) DIR=/opt/rsc-brain ;;
    *) find_dir ;;
    esac
  fi
  if [ -f "$DIR/.env" ]; then
    REINSTALL=1
    OLD_NAME=$(env_get RSC_BRAIN_NAME)
    OLD_DB=$(env_get RSC_BRAIN_DB)
    OLD_IMAGE=$(env_get RSC_BRAIN_IMAGE)
    [ -n "$NAME" ] && [ "$NAME" != "$OLD_NAME" ] && usage "The installation in $DIR is called $OLD_NAME; its name cannot change."
    NAME=$OLD_NAME
    [ -n "$DB" ] && [ "$DB" != "$OLD_DB" ] &&
      usage "The installation in $DIR uses the $OLD_DB database, and install keeps it. To move to another one: make a copy (backup), uninstall, install anew and restore the copy."
    DB=$OLD_DB
    if { [ -n "$IMAGE" ] && [ "$IMAGE" != "$OLD_IMAGE" ]; } || { [ -n "$VERSION" ] && [ "rsc-brain:$VERSION" != "$OLD_IMAGE" ]; }; then
      usage "The installation in $DIR runs $OLD_IMAGE. Changing the version is an update (a copy first, then the new version, and back if it fails); install keeps the version."
    fi
    IMAGE=$OLD_IMAGE VERSION=''
    if [ -z "$MODE" ]; then
      MODE=$(env_get RSC_BRAIN_MODE)
      DOMAIN=$(env_get RSC_BRAIN_DOMAIN)
    fi
    [ -n "$PORT" ] || PORT=$(env_get RSC_BRAIN_PUBLISH | sed 's/.*://')
    [ -n "$HTTP_PORT" ] || HTTP_PORT=$(env_get RSC_BRAIN_HTTP_PORT)
    [ -n "$HTTPS_PORT" ] || HTTPS_PORT=$(env_get RSC_BRAIN_HTTPS_PORT)
    [ -n "$DB_URL_FILE$ADMIN_URL_FILE" ] && say 'The installation keeps its database: the URL file is not used.'
    DB_URL_FILE='' ADMIN_URL_FILE='' FACTORY_DB=$(env_get RSC_BRAIN_FACTORY_DB)
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
    [ "$MODE" = server ] && [ "$DIR_GIVEN" = 0 ] && [ "$REINSTALL" = 0 ] && DIR=/opt/rsc-brain
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

  # Requirements: nothing is changed until all of them are met.
  step 'Checking what rsc-brain needs'
  need_docker
  BUILD=0
  if [ -z "$IMAGE" ]; then
    command -v git >/dev/null 2>&1 ||
      missing 'git is not installed (it fetches the source to build rsc-brain). Install it: https://git-scm.com/downloads, or pass --image with an image already built.'
    if [ -z "$VERSION" ]; then
      VERSION=$(git ls-remote --tags --refs "$REPO" 'v*' 2>/dev/null </dev/null | sed -n 's|.*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' |
        sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
      if [ -n "$VERSION" ]; then VERSION=v$VERSION; else
        say "No published version of rsc-brain at $REPO yet: building its main branch."
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
    missing "Only $((free_kb / 1024)) MB are free on the disk of $DIR; rsc-brain needs at least 2 GB (images, database and copies). Free some space, or pass --dir on another disk."
  # Its own running installation holds its ports: those are not «in use».
  OWN=0
  [ "$REINSTALL" = 1 ] && PROFILES=$(env_get COMPOSE_PROFILES) && running && OWN=1
  if [ "$OWN" = 0 ] || [ "127.0.0.1:$PORT" != "$(env_get RSC_BRAIN_PUBLISH)" ]; then free_port PORT --port; fi
  if [ "$MODE" = server ]; then
    if [ "$OWN" = 0 ] || [ "$(env_get RSC_BRAIN_MODE)" != server ] || [ "$HTTP_PORT" != "$(env_get RSC_BRAIN_HTTP_PORT)" ]; then free_port HTTP_PORT --http-port; fi
    if [ "$OWN" = 0 ] || [ "$(env_get RSC_BRAIN_MODE)" != server ] || [ "$HTTPS_PORT" != "$(env_get RSC_BRAIN_HTTPS_PORT)" ]; then free_port HTTPS_PORT --https-port; fi
  fi
  DB_URL='' ADMIN_URL=''
  if [ -n "$DB_URL_FILE" ]; then
    read_url "$DB_URL_FILE"
    DB_URL=$RU
  fi
  if [ -n "$ADMIN_URL_FILE" ]; then
    read_url "$ADMIN_URL_FILE"
    ADMIN_URL=$RU
  fi

  # A new installation never takes the name of one Docker already holds (a failure would take its volumes down).
  if [ "$REINSTALL" = 0 ]; then
    if [ -n "$(docker ps -a -q --filter "label=com.docker.compose.project=$NAME" 2>/dev/null </dev/null)" ] ||
      docker volume inspect "${NAME}_pgdata" >/dev/null 2>&1 </dev/null; then
      missing "Docker already holds an installation called $NAME (its containers or its database volume ${NAME}_pgdata), and $DIR has no .env for it. Pass --dir with its folder, or --name with another name for a new one."
    fi
    pick_subnet
  fi
  if [ "$MODE" = server ]; then
    SITE=https://$DOMAIN
    [ "$HTTPS_PORT" = 443 ] || SITE=$SITE:$HTTPS_PORT
  else
    SITE=http://localhost:$PORT
  fi
  if can_ask; then
    if [ "$REINSTALL" = 1 ]; then q="Apply these settings to rsc-brain in $DIR ($MODE, $SITE)? Its key and data are kept."; else
      q="Install rsc-brain in $DIR ($MODE, $SITE, $DB database)?"
    fi
    yes_no "$q" y || {
      say 'Nothing was changed.'
      exit 1
    }
  fi

  # From here on, a failure takes back what this run made.
  if [ ! -d "$DIR" ]; then
    mkdir -p "$DIR" || missing "Cannot create $DIR. Pass --dir with a folder you may write in (or run as root for /opt)."
    MADE_DIR=1
    chmod 700 "$DIR"
  fi
  if [ "$BUILD" = 1 ]; then
    docker image inspect "$IMAGE" >/dev/null 2>&1 </dev/null || MADE_IMAGE=1
    step "Fetching the source of rsc-brain $VERSION"
    rm -rf "${DIR:?}/src"
    MADE_FILES="$MADE_FILES src"
    git clone --depth 1 --branch "$VERSION" "$REPO" "$DIR/src" >&2 </dev/null ||
      failed 3 "Could not fetch $VERSION from $REPO. Check the version (git tags) and the network."
    step "Building the image $IMAGE (a few minutes the first time)"
    docker build -t "$IMAGE" "$DIR/src" >&2 </dev/null || failed 4 "The image did not build: the lines above say why."
  fi
  # A database it is given is checked before anything is made in it.
  check_url=$DB_URL
  [ -n "$ADMIN_URL" ] && check_url=$ADMIN_URL
  if [ -n "$check_url" ]; then
    step 'Checking the PostgreSQL'
    printf '%s\n' "$check_url" | docker run --rm -i --add-host host.docker.internal:host-gateway "$IMAGE" rsc-brain db check --url-stdin --json >/dev/null ||
      failed 3 'That PostgreSQL cannot hold rsc-brain (the line above says why).'
  fi

  [ -d "$DIR/backups" ] || {
    mkdir "$DIR/backups"
    MADE_FILES="$MADE_FILES backups"
  }
  # The service writes the copies as the owner of the folder; as root, as the image's unprivileged user.
  if [ "$(id -u)" = 0 ]; then
    RUN_UID=1000 RUN_GID=1000
    chown 1000:1000 "$DIR/backups"
  else
    RUN_UID=$(id -u) RUN_GID=$(id -g)
  fi
  chmod 700 "$DIR/backups"

  if [ "$REINSTALL" = 1 ]; then
    cp -p "$DIR/.env" "$DIR/.env.previous"
    SECRET=$(env_get RSC_BRAIN_SECRET)
    PG_PASSWORD=$(env_get POSTGRES_PASSWORD)
    DATABASE_URL=$(env_get RSC_BRAIN_DATABASE_URL)
    SUBNET=$(env_get RSC_BRAIN_SUBNET) IP_RANGE=$(env_get RSC_BRAIN_IP_RANGE) PROXY_IP=$(env_get RSC_BRAIN_PROXY_IP)
  else
    SECRET=$(random_hex 48)
    PG_PASSWORD=$(random_hex 32)
    DATABASE_URL=$DB_URL
    MADE_FILES="$MADE_FILES .env"
  fi
  [ "$DB" = bundled ] || PG_PASSWORD=''
  PROFILES=''
  [ "$DB" = bundled ] && PROFILES=bundled
  [ "$MODE" = server ] && PROFILES=${PROFILES:+$PROFILES,}server
  if [ "$MODE" = server ]; then LOCAL_ONLY=0 TRUSTED=$PROXY_IP; else LOCAL_ONLY=1 TRUSTED=''; fi
  write_env || failed 4 "Could not write $DIR/.env."
  # The compose file and the Caddyfile of the version installed.
  src=$HERE
  [ "$BUILD" = 1 ] && src=$DIR/src/deploy
  for f in compose.yaml Caddyfile; do
    if [ -f "$src/$f" ]; then
      [ -f "$DIR/$f" ] || MADE_FILES="$MADE_FILES $f"
      cp "$src/$f" "$DIR/$f.new" && mv -f "$DIR/$f.new" "$DIR/$f"
    elif [ ! -f "$DIR/$f" ]; then
      failed 3 "$f is not next to the launcher. Run it from a copy of the repository (deploy/), or with --version."
    fi
  done
  chmod 644 "$DIR/compose.yaml" "$DIR/Caddyfile"

  STARTED=1
  if [ "$DB" = bundled ]; then
    step 'Starting PostgreSQL'
    dc up -d --wait postgres >&2 </dev/null || failed 4 'PostgreSQL did not start: the lines above say why.'
    [ -z "$DATABASE_URL" ] && ADMIN_URL="postgres://postgres:$PG_PASSWORD@postgres:5432/postgres"
  fi
  if [ -z "$DATABASE_URL" ]; then
    step "Making the database and the role $DB_NAME (no superuser)"
    set --
    [ "$DB" = shared ] && set -- --isolate-from "$FACTORY_DB"
    made=$(printf '%s\n' "$ADMIN_URL" | dc run --rm -T --no-deps app rsc-brain db provision --database "$DB_NAME" \
      --role "$DB_NAME" "$@" --json)
    code=$?
    case $code in
    0) PROVISIONED=1 ;;
    2 | 3) failed "$code" 'The database could not be made (the line above says why).' ;;
    *) failed 4 'The database could not be made (the lines above say why).' ;;
    esac
    DATABASE_URL=$(printf '%s\n' "$made" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
    case $DATABASE_URL in '' | *"'"*) failed 4 'The database was made, but its URL could not be read.' ;; esac
    write_env || failed 4 "Could not write $DIR/.env."
  fi

  step 'Starting rsc-brain'
  dc up -d --remove-orphans >&2 </dev/null || failed 4 'rsc-brain did not start: the lines above say why.'
  step 'Waiting for rsc-brain to answer'
  wait_healthy || failed 4 "rsc-brain did not answer within 2 minutes. See why with: docker compose --project-directory $DIR logs app"
  rm -f "$DIR/.env.previous"
  version=$(dc exec -T app rsc-brain version </dev/null 2>/dev/null)
  key_id=$(printf '%s' "$SECRET" | dc exec -T app rsc-brain key id 2>/dev/null)

  if [ "$JSON" = 1 ]; then
    printf '{"url":%s,"mode":%s,"db":%s,"installationKey":%s,"keyId":%s,"version":%s,"dir":%s}\n' \
      "$(json_str "$SITE")" "$(json_str "$MODE")" "$(json_str "$DB")" "$(json_str "$SECRET")" \
      "$(json_str "$key_id")" "$(json_str "$version")" "$(json_str "$DIR")"
    return 0
  fi
  out ''
  out "rsc-brain $version is running at $SITE"
  if [ "$REINSTALL" = 1 ]; then
    out 'Its settings were applied; the installation key, the data and the copies are as they were.'
    return 0
  fi
  out 'Open it to finish the first-time setup: there you make the administration account.'
  [ "$MODE" = server ] && out "($DOMAIN must point at this server; the certificate arrives by itself on the first visit.)"
  out ''
  if [ -t 1 ]; then
    out "The installation key (id $key_id) opens your copies; without it they cannot be restored. Save it now in a"
    out 'password manager:'
    out ''
    out "  $SECRET"
    out ''
    out "Print it again with: sh $PROG key show --dir $DIR"
  else
    out "The installation key (id $key_id) opens your copies; without it they cannot be restored. It is kept in"
    out "$DIR/.env. Print it with: sh $PROG key show --dir $DIR, and save it in a password manager."
  fi
  out "Copies are made every day at 03:00 (UTC) in $DIR/backups; list them with: sh $PROG backups --dir $DIR"
  return 0
}

# --------------------------------------------------------------------------------------------- the other commands
status() {
  need_installation
  need_docker
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
    out "rsc-brain in $DIR: $site ($mode, $db database, $image)"
    if [ "$is_healthy" = true ]; then
      out "Running version $version and answering."
      dc exec -T app rsc-brain maintenance status </dev/null 2>/dev/null
    elif [ "$is_running" = true ]; then
      out "Running but not answering. See why with: docker compose --project-directory $DIR logs app"
    else
      out "Not running. Start it with: sh $PROG install --dir $DIR"
    fi
  fi
  [ "$is_healthy" = true ]
}

need_running() {
  running || {
    say "rsc-brain is not running. Start it with: sh $PROG install --dir $DIR"
    exit 1
  }
}

backup() {
  need_installation
  need_docker
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
  [ -f "$COPY_FILE" ] && [ -r "$COPY_FILE" ] || usage "The copy $COPY_FILE cannot be read."
  [ -z "$KEY_FILE" ] || [ -r "$KEY_FILE" ] || usage "The key file $KEY_FILE cannot be read."
  need_installation
  if [ "$CONFIRM_SET" = 0 ]; then
    can_ask || usage "Pass --confirm with the installation's name (as the web shows it; on a new installation, the name in the copy)."
    ask "Restoring replaces everything in rsc-brain with the copy. Type the installation's name to go on: "
    CONFIRM=$ANSWER
  fi
  need_docker
  base=$(basename -- "$COPY_FILE" | tr -c 'A-Za-z0-9._\n-' '_')
  target=$DIR/backups/$base
  copy_dir=$(cd -- "$(dirname -- "$COPY_FILE")" && pwd)
  if [ "$copy_dir/$(basename -- "$COPY_FILE")" != "$target" ]; then
    [ -e "$target" ] && usage "A copy named $base is in $DIR/backups already: restore that one (--file $target) or rename yours."
    cp -- "$COPY_FILE" "$target" || exit 1
    [ "$(id -u)" = 0 ] && chown 1000:1000 "$target"
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
  step 'Starting rsc-brain again'
  if ! { dc up -d >&2 </dev/null && wait_healthy; }; then
    say "rsc-brain did not answer after the restore. See why with: docker compose --project-directory $DIR logs app"
  fi
  if [ "$code" = 0 ]; then
    say 'Restored. Every key, session and connection made before no longer works: everyone has to sign in again.'
    return 0
  fi
  [ "$code" = 2 ] && return 2
  return 1
}

key_show() {
  need_installation
  if [ "$YES" = 0 ]; then
    can_ask || usage 'There is no terminal to confirm on. Pass --yes to print the installation key.'
    yes_no 'The installation key opens every copy of this installation. Print it here?' n || exit 1
  fi
  env_get RSC_BRAIN_SECRET
}

uninstall() {
  need_installation
  if [ "$DELETE_DATA" = 1 ]; then
    if [ "$CONFIRM_SET" = 0 ]; then
      can_ask || usage "Deleting the data needs --confirm $NAME (the installation's name). Nothing was deleted."
      ask "This deletes the database and the copies of $NAME for good. Type its name ($NAME) to go on: "
      CONFIRM=$ANSWER
    fi
    [ "$CONFIRM" = "$NAME" ] || usage "That is not the installation's name ($NAME). Nothing was deleted."
  fi
  need_docker
  db=$(env_get RSC_BRAIN_DB)
  if [ "$DELETE_DATA" = 0 ]; then
    step 'Stopping rsc-brain and removing its containers'
    dc down --remove-orphans >&2 </dev/null || exit 1
    out "rsc-brain was removed from this machine's containers. Its database, the copies in $DIR/backups and the"
    out "installation key ($DIR/.env) are kept: sh $PROG install --dir $DIR brings it back as it was."
    return 0
  fi
  db_name=$(env_get RSC_BRAIN_DB_NAME)
  if [ "$db" != bundled ]; then
    if [ -n "$ADMIN_URL_FILE" ]; then
      read_url "$ADMIN_URL_FILE"
      step "Removing the database $db_name and the role $db_name"
      printf '%s\n' "$RU" | dc run --rm -T --no-deps app rsc-brain db drop --database "$db_name" --role "$db_name" \
        --confirm "$db_name" >&2 || {
        say 'The database was not removed (the line above says why). Nothing else was deleted.'
        exit 1
      }
    fi
  fi
  step 'Stopping rsc-brain and removing its containers, network and volumes'
  dc down -v --remove-orphans >&2 </dev/null || exit 1
  printf '%s\n' "$(env_get RSC_BRAIN_SECRET)" >"$DIR/installation-key.txt"
  chmod 600 "$DIR/installation-key.txt"
  rm -rf "${DIR:?}/backups" "${DIR:?}/src" "$DIR/compose.yaml" "$DIR/Caddyfile" "$DIR/.env" "$DIR/.env.previous"
  out "rsc-brain and its copies were deleted from $DIR."
  if [ "$db" != bundled ] && [ -z "$ADMIN_URL_FILE" ]; then
    out "Its database is on your PostgreSQL and was not touched: remove the database rsc-brain used (and its role) there,"
    out "or run rsc-brain db drop with an administration login."
  fi
  out "The installation key is kept in $DIR/installation-key.txt (copies you downloaded need it). Delete it when you"
  out 'no longer need them.'
  return 0
}

case $CMD in
install) install ;;
status) status ;;
backup) backup ;;
backups) backups ;;
restore) restore ;;
'key show') key_show ;;
uninstall) uninstall ;;
esac
