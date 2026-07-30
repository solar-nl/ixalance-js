#!/bin/sh -e
# Build the SDK example guest into hello.ixa.
cd "$(dirname "$0")"

IXA_SDK=$(cd ../.. && pwd)
export IXA_SDK
. "$IXA_SDK/ixa-env.sh"

[ -f "$IXA_LIB" ] || "$IXA_SDK/build.sh"

$IXA_CC -Wall -Wextra -c hello.c -o hello.o
"$IXA_SDK/ixa-package.sh" -o hello.ixa --name "SDK Hello" hello.o
