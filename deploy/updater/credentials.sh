#!/bin/sh
# What git asks for when it needs a user name or a password (GIT_ASKPASS). It answers for the host of rsc-brain's
# repository (RSC_BRAIN_UPDATER_REPO_HOST) and for no other: a redirect or a submodule elsewhere gets nothing. The token
# is read from <installation>/updater/credentials/token, which `web-updates enable` made for its owner alone; it is
# never an argument and never written anywhere.
set -u
dir=${RSC_BRAIN_UPDATER_DIR:-}
host=${RSC_BRAIN_UPDATER_REPO_HOST:-}
[ -n "$dir" ] && [ -n "$host" ] || exit 1
file=$dir/updater/credentials/token
[ -f "$file" ] && [ ! -L "$file" ] || exit 1
# The address in the question: https://[user@]host[:port][/path], between quotes.
case ${1:-} in *\'*\'*) ;; *) exit 1 ;; esac
asked=${1#*\'}
asked=${asked%%\'*}
case $asked in https://*) ;; *) exit 1 ;; esac
asked=${asked#https://}
asked=${asked%%/*}
asked=${asked##*@}
[ "$asked" = "$host" ] || exit 1
[ "$(wc -l <"$file" | tr -d ' ')" -le 1 ] || exit 1
IFS= read -r token <"$file" || [ -n "$token" ] || exit 1
case $token in '' | *[!A-Za-z0-9_.~+/=-]*) exit 1 ;; esac
case $1 in
Username*) printf '%s\n' x-access-token ;;
Password*) printf '%s\n' "$token" ;;
*) exit 1 ;;
esac
