#!/usr/bin/env bash
set -euo pipefail

pyftsubset "fonts/$1.ttf"  \
  --unicodes-file=fonts/unicodes.txt \
  --flavor="woff2" \
  --output-file="static/$1.woff2" \
  --ignore-missing-glyphs \
  --layout-features=c2sc,fina,init,ss06,tnum,case,dlig,liga,frac,ss03,ss02,locl,onum,pcap,pnum,smcp,ss04,ss05,swsh,kern,mark