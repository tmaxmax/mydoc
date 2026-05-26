#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(dirname "$(realpath "$0")")"

if [ $# -ne 2 ]; then
    echo "Usage: mydoc <input-file> <output-file>"
    exit 1
fi

INPUT="$1"
OUTPUT="$2"
shift 2

case "${OUTPUT##*.}" in
    html)  FORMAT="archive" ;;
    icml)  FORMAT="icml"   ;;
    *)     echo "Unknown output format" >&2; exit 1 ;;
esac

DEFAULTS="$PROJECT_ROOT/defaults/${FORMAT}.yml"

exec pandoc -d "$DEFAULTS" "$INPUT" -o "$OUTPUT" "$@"