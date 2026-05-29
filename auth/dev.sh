#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(git rev-parse --show-toplevel)"

export RP_ORIGIN="http://localhost:9000"
export HMAC_SECRET="7beb6f96010969799fac3674f30588da37f1f7615e695ab53f0d70052bfdd6fa"
export USER_FILE="$PROJECT_ROOT/out/user.json"
export ADDR="localhost:9000"
export REGISTER_ADDR="localhost:9001"

go run "$PROJECT_ROOT/auth"