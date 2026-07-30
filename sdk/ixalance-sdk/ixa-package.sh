#!/bin/sh -e
# ixa-package.sh — link guest objects against the SDK and emit a .ixa container.
#
#   ixa-package.sh -o out.ixa --name "My Demo" [--script "exe 1; pop"]
#                  [--fast] [--keep] guest1.o [guest2.o ...]
#
# Runs the three back-end stages a guest always needs:
#   1. ld    — crt0.o + guest objects + libixa.a through the SDK link script,
#              keeping relocations (--emit-relocs) because they ARE the D32
#              fixup stream.
#   2. elf2d32 — ELF32 to a DOS/32A "Adam" linear executable, self-verifying.
#   3. mkixa   — wrap the executable in a container with a script that pushes
#                and pops it. Also self-verifying: every block is round-tripped
#                back through lib/ixa.js before the file is written.
#
# The default script "exe 1; pop" is the minimal one-part production: push
# block 1 as an executable, then pop it (which is what actually runs it).

IXA_SDK=$(cd "$(dirname "$0")" && pwd)
export IXA_SDK
. "$IXA_SDK/ixa-env.sh"

TOOLS="$IXA_SDK/../tools"

OUT=""
NAME=""
SCRIPT="exe 1; pop"
FAST=""
KEEP=""
OBJS=""

while [ $# -gt 0 ]; do
    case "$1" in
        -o)       OUT="$2"; shift 2 ;;
        --name)   NAME="$2"; shift 2 ;;
        --script) SCRIPT="$2"; shift 2 ;;
        --fast)   FAST="--fast"; shift ;;
        --keep)   KEEP=1; shift ;;
        -*)       echo "ixa-package: unknown option $1" >&2; exit 1 ;;
        *)        OBJS="$OBJS $1"; shift ;;
    esac
done

[ -n "$OUT" ]  || { echo "ixa-package: -o <out.ixa> is required" >&2; exit 1; }
[ -n "$OBJS" ] || { echo "ixa-package: no guest objects given" >&2; exit 1; }
[ -n "$NAME" ] || NAME=$(basename "$OUT" .ixa)

if [ ! -f "$IXA_LIB" ] || [ ! -f "$IXA_CRT0" ]; then
    echo "ixa-package: SDK not built — run $IXA_SDK/build.sh first" >&2
    exit 1
fi

STEM="${OUT%.ixa}"

$IXA_LD -o "$STEM.elf" "$IXA_CRT0" $OBJS "$IXA_LIB"
node "$TOOLS/elf2d32.mjs" "$STEM.elf" "$STEM.exe"
node "$TOOLS/mkixa.mjs" -o "$OUT" --name "$NAME" $FAST --script "$SCRIPT" "$STEM.exe"

[ -n "$KEEP" ] || rm -f "$STEM.elf" "$STEM.exe"

echo "packaged: $OUT"
