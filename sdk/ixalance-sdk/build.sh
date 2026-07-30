#!/bin/sh -e
# build.sh — build the SDK itself: lib/crt0.o and lib/libixa.a
#
# crt0.o is kept OUT of the archive on purpose. ld would pull it in to resolve
# ENTRY(_start), but linking it explicitly first is what guarantees the entry
# veneer lands at the front of .text and, more importantly, makes the link line
# self-documenting: every guest starts with the same object.

IXA_SDK=$(cd "$(dirname "$0")" && pwd)
export IXA_SDK
. "$IXA_SDK/ixa-env.sh"

cd "$IXA_SDK"
mkdir -p build lib

$IXA_AS src/crt0.asm -o lib/crt0.o

OBJS=""
for unit in video time heap libc math; do
    $IXA_CC -Wall -Wextra -c "src/$unit.c" -o "build/$unit.o"
    OBJS="$OBJS build/$unit.o"
done

# C++ support lives in its own member so C-only guests never pull it in.
$IXA_CXX -Wall -Wextra -c src/cxx.cpp -o build/cxx.o
OBJS="$OBJS build/cxx.o"

rm -f lib/libixa.a
i686-elf-ar rcs lib/libixa.a $OBJS

echo "SDK built: lib/libixa.a lib/crt0.o"
