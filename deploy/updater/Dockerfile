# The image of rsc-brain's updater (deploy/updater/loop.sh): the Docker client with Compose, and only what the launcher
# needs besides: git and ssh to fetch a version, perl for a session of its own where the system has no setsid.
FROM docker:29.1.5-cli@sha256:931f63d7100eb6734405d92d8bd9f4aa708c587510e5cc673bb9ac196a3d733f
RUN apk add --no-cache git openssh-client perl
