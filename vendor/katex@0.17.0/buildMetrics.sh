#!/usr/bin/env bash
set -euo pipefail

perl ./mapping.pl | python3 ./extract_tfms.py | python3 ./extract_ttfs.py | python3 ./format_json.py --width > ./dist/fontMetricsData.js