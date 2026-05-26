#!/usr/bin/env bash
set -euo pipefail

error() {
    echo "$@" >&2; exit 1
}

infer_defaults() {
    case "${1##*.}" in
        html) echo "archive" ;;
        icml) echo "icml"   ;;
    esac
}

PROJECT_ROOT="$(dirname "$(readlink -f "$0")")"

if [ $# -lt 1 ]; then
    error "Usage: mydoc [input-file|input-format] <output-file|defaults-name> [pandoc options...]"
fi

INPUT_ARGS=()

if [[ $# -eq 1 ]]; then
    OUTPUT="$1"
    shift
else
    INPUT_ARGS=("-f" "$1")
    OUTPUT="$2"
    if [[ "$1" =~ \.[a-zA-Z0-9]+$ ]]; then
        input="$1"
        [[ "$input" != /* ]] && input="$PWD/$input"
        INPUT_ARGS=("$input")
    fi
    shift 2
fi

DEFAULTS="$PROJECT_ROOT/defaults/$OUTPUT.yml"
if [[ -f "$DEFAULTS" ]]; then
    OUTPUT="-"
else
    [[ "$OUTPUT" != /* ]] && OUTPUT="$PWD/$OUTPUT"
    name="$(infer_defaults "$OUTPUT")"
    [[ -z "$name" ]] && error "Error: cannot infer output format"
    DEFAULTS="$PROJECT_ROOT/defaults/$name.yml"
fi

cd "$PROJECT_ROOT"
exec pandoc "-d" "$DEFAULTS" "${INPUT_ARGS[@]}" "-o" "$OUTPUT" "$@"