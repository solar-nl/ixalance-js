# ixa-env.sh — the SDK's compiler settings, shared by the SDK build and by
# guest build scripts. Source it after setting IXA_SDK to the SDK directory:
#
#   IXA_SDK=../..; . "$IXA_SDK/ixa-env.sh"
#   $IXA_CC -c mypart.c -o mypart.o
#
# Every flag here is load-bearing:
#
#   -march=i486    the host CPU core implements the 486 instruction set plus
#                  the x87; anything newer (cmov, SSE) will not decode.
#   -ffreestanding no hosted library, and main() carries no special meaning.
#   -fno-pic       the D32 fixup stream relocates absolute addresses. Position-
#                  independent code would route through a GOT that has no
#                  loader to fill it in.
#   -fno-builtin   keep the compiler from open-coding calls into a libc that
#                  is not there.
#   -fsigned-char  the DOS-era sources assume signed char.
#   -fno-asynchronous-unwind-tables
#                  .eh_frame is discarded by the link script; do not emit it.

: "${IXA_SDK:?set IXA_SDK to the SDK directory before sourcing ixa-env.sh}"

IXA_ARCH_FLAGS="-march=i486 -ffreestanding -fsigned-char -fno-pic \
-fno-asynchronous-unwind-tables -fno-builtin -O2"

IXA_CC="i686-elf-gcc $IXA_ARCH_FLAGS -I$IXA_SDK/include"
IXA_CXX="i686-elf-g++ $IXA_ARCH_FLAGS -fno-exceptions -fno-rtti -I$IXA_SDK/include"
IXA_AS="nasm -f elf32"
IXA_LD="i686-elf-ld --emit-relocs -T $IXA_SDK/ixa.ld"
IXA_LIB="$IXA_SDK/lib/libixa.a"
IXA_CRT0="$IXA_SDK/lib/crt0.o"

export IXA_SDK IXA_ARCH_FLAGS IXA_CC IXA_CXX IXA_AS IXA_LD IXA_LIB IXA_CRT0
