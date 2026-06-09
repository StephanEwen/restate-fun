#!/usr/bin/env bash
#
# CI stage 4: run the SDK conformance tests from restatedev/e2e against the
# service image that stage 2 built from the fresh SDK.
#
# Runs inside an `eclipse-temurin:21` container with the host docker socket
# mounted: testcontainers inside gradle drives the HOST docker daemon — which
# is also why BUILD_DATA_DIR is mounted at its host path.
#
# Callback contract: as its last act this script resolves the Restate
# awakeable (AWAKEABLE_ID) over the ingress — pass or fail — which resumes the
# suspended workflow. If this container dies first, the workflow's orTimeout
# backstop fires instead.
#
# Env (set by the workflow): BUILD_DATA_DIR, RUN_ID, E2E_GIT_REF,
# SERVICE_IMAGE, RESTATE_INGRESS_URL, AWAKEABLE_ID, IMAGE_PULL_POLICY
set -uo pipefail

: "${BUILD_DATA_DIR:?}" "${RUN_ID:?}" "${SERVICE_IMAGE:?}" "${RESTATE_INGRESS_URL:?}" "${AWAKEABLE_ID:?}"
E2E_GIT_REF="${E2E_GIT_REF:-main}"
# CACHED: never try to pull SERVICE_IMAGE from a registry — it only exists in
# the local daemon.
IMAGE_PULL_POLICY="${IMAGE_PULL_POLICY:-CACHED}"

resolve_awakeable() {
  curl -fsS -X POST "${RESTATE_INGRESS_URL}/restate/awakeables/${AWAKEABLE_ID}/resolve" \
    -H 'content-type: application/json' --data "$1" ||
    echo "WARN: could not resolve awakeable (the workflow will hit its timeout backstop)"
}

abort() {
  echo "ERROR: $1"
  resolve_awakeable "{\"passed\":false,\"report\":\"$1\"}"
  exit 1
}

# The base image is a bare JDK; install the tools this script needs.
apt-get update -qq >/dev/null && apt-get install -y -qq git curl >/dev/null 2>&1 ||
  abort "apt-get install git/curl failed"

WS="${BUILD_DATA_DIR}/${RUN_ID}/e2e"
if [ ! -d "$WS/.git" ]; then
  git clone https://github.com/restatedev/e2e.git "$WS" || abort "git clone restatedev/e2e failed"
fi
cd "$WS" || abort "cd e2e workspace failed"
git fetch --tags origin && git checkout --force "$E2E_GIT_REF" || abort "git checkout ${E2E_GIT_REF} failed"
git reset --hard "origin/${E2E_GIT_REF}" 2>/dev/null || true

export TEST_REPORT_DIR="${BUILD_DATA_DIR}/${RUN_ID}/reports"
export GRADLE_USER_HOME="${BUILD_DATA_DIR}/.gradle-home" # cache gradle dist + deps across runs
mkdir -p "$TEST_REPORT_DIR"

./gradlew --no-daemon :sdk-tests:run \
  --args="run --image-pull-policy=${IMAGE_PULL_POLICY} --service-container-image=${SERVICE_IMAGE}"
RC=$?

if [ "$RC" -eq 0 ]; then
  resolve_awakeable "{\"passed\":true,\"report\":\"sdk-tests passed; reports in ${TEST_REPORT_DIR}\"}"
else
  resolve_awakeable "{\"passed\":false,\"report\":\"gradle :sdk-tests:run exited with ${RC}; see e2e.log and ${TEST_REPORT_DIR}\"}"
fi
exit "$RC"
