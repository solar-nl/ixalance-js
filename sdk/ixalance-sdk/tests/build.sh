#!/bin/sh -e
cd "$(dirname "$0")"

IXA_SDK=$(cd .. && pwd)
export IXA_SDK
. "$IXA_SDK/ixa-env.sh"

"$IXA_SDK/build.sh"
$IXA_CC -Wall -Wextra -c legacy-video.c -o legacy-video.o
"$IXA_SDK/ixa-package.sh" -o legacy-video.ixa --name "SDK Legacy Video" \
  --fast legacy-video.o
node legacy-video.mjs
