#!/usr/bin/env bash

set -euo pipefail

DEFAULTS="$1"
INPUT="$2"
OUTPUT="$3"
shift 3

. "$NVM_DIR/nvm.sh"

pandoc -d "defaults/$DEFAULTS.yml" "/data/$INPUT" -o "/data/$OUTPUT" "$@"