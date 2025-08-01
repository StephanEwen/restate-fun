#!/usr/bin/env bash

export RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT=5min
export RESTATE_WORKER__INVOKER__ABORT_TIMEOUT=15min
export RESTATE_ADMIN__experimental_feature_force_journal_retention=1day
export RESTATE_WORKER__INVOKER__RETRY_POLICY__MAX_INTERVAL=1s

npx @restatedev/restate-server@1.4.2
