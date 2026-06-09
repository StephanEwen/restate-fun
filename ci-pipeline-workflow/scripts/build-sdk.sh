#!/usr/bin/env bash
#
# CI stage 1: build Restate's TypeScript SDK and run its test suite.
# Runs inside a `node:22` container started by the CiPipeline workflow.
# The workflow detects completion by POLLING the container state — this script
# knows nothing about Restate.
#
# Env (set by the workflow):
#   BUILD_DATA_DIR  shared artifact dir, mounted at the same path as on the host
#   RUN_ID          pipeline run id (the workflow key)
#   SDK_GIT_REF     branch, tag or commit SHA of restatedev/sdk-typescript
set -euo pipefail

: "${BUILD_DATA_DIR:?}" "${RUN_ID:?}"
SDK_GIT_REF="${SDK_GIT_REF:-main}"

WS="${BUILD_DATA_DIR}/${RUN_ID}/workspace/sdk-typescript"
mkdir -p "$(dirname "$WS")"

# Idempotent checkout (the workflow may retry this container). Full clone so
# branches, tags and commit SHAs all work as refs.
if [ ! -d "$WS/.git" ]; then
  git clone https://github.com/restatedev/sdk-typescript.git "$WS"
fi
cd "$WS"
git fetch --tags origin
git checkout --force "$SDK_GIT_REF"
git reset --hard "origin/${SDK_GIT_REF}" 2>/dev/null || true # align if it's a branch

# pnpm via corepack, non-interactive; share the package store across runs.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export npm_config_store_dir="${BUILD_DATA_DIR}/.pnpm-store"
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test

echo "=== SDK build & tests passed ==="
