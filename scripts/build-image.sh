#!/usr/bin/env bash
set -euo pipefail
REPO_URL="${1:?usage: build-image.sh <ecr-repo-url> [tag]}"
TAG="${2:-$(git rev-parse --short HEAD)}"
REGION="${AWS_REGION:-us-east-1}"
REGISTRY="${REPO_URL%%/*}"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker buildx build --platform linux/arm64 -f apps/mcp-server/Dockerfile -t "$REPO_URL:$TAG" -t "$REPO_URL:latest" --push .
echo "$REPO_URL:$TAG"
