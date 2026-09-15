#!/usr/bin/env bash
set -euo pipefail
REPO_URL="${1:?usage: build-image.sh <ecr-repo-url> [tag]}"
TAG="${2:-$(git rev-parse --short HEAD)}"
REGION="${AWS_REGION:-us-east-1}"
REGISTRY="${REPO_URL%%/*}"

# Callers capture this script's stdout with $(...) expecting exactly one line:
# the pushed image URI on the last line. Everything else must go to stderr.
# `docker login --password-stdin` prints "Login Succeeded" to stdout, and
# `docker buildx build --push` prints build/push progress to stdout too, so
# both are redirected here.
{ aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"; } 1>&2
docker buildx build --platform linux/arm64 -f apps/mcp-server/Dockerfile -t "$REPO_URL:$TAG" -t "$REPO_URL:latest" --push . 1>&2
echo "$REPO_URL:$TAG"
