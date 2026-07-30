#!/bin/sh -e
# Square port build: verbatim demo sources + iXalance SDK -> square.ixa
cd "$(dirname "$0")"
SRC=../../../../source/squarewin32src/square_w32/source
IXA_SDK=$(cd ../.. && pwd)
export IXA_SDK
. "$IXA_SDK/ixa-env.sh"

mkdir -p build parts
"$IXA_SDK/build.sh"

# Drop artifacts from the pre-SDK build so the build directory cannot make it
# look as though Square still links its retired private veneer/runtime.
rm -f build/host.o build/shim.o build/square.elf build/square.exe

# Part sources compile verbatim; they are copied so their quoted includes
# resolve to include/'s substitute stdafx.h/common.h instead of the originals.
cp "$SRC/DCT.CPP" parts/DCT.CPP
# DEMO2.CPP:266 relies on MSVC's leaked for-scope; re-declare the index there.
LC_ALL=C sed '266s/for (c1=/for (int c1=/' "$SRC/DEMO2.CPP" > parts/DEMO2.CPP
cp "$SRC/DEMO5.CPP" parts/DEMO5.CPP
# Preserve the final order-7 sphere camera for the first order-8 frame. This
# makes the shared sphere mesh an exact visual handoff even when browser setup
# advances the XM before the planet part can present.
LC_ALL=C sed 's|cam2.posn=mycam.posn\*(4/60.f);|cam2.posn=mycam.posn*(4/60.f); setspherehandoff(\&cam2,verth/60.f);|' \
  "$SRC/BJORK.CPP" > parts/BJORK.CPP
# DEMO3's two authoring-only save paths still mention stdio. The freestanding
# header supplies inert write-side shims; playback reads use LFILE throughout.
cp "$SRC/DEMO3.CPP" parts/DEMO3.CPP
cp "$SRC/CELLTAB.CPP" parts/CELLTAB.CPP
# DEMO1.CPP:678-684 uses `or` as a variable (a C++ alternative token) and
# declares it K&R implicit-int; rename it and give it a type. The original
# blurproc leaves a narrow border unwritten, so clear that border before each
# cube DOF pass rather than letting stale indices leak between effects.
LC_ALL=C sed -e '678,684s/[[:<:]]or[[:>:]]/orr/g' -e '678s/static orr=0;/static int orr=0;/' \
  -e 's|blurproc(screenbuf+64000,screenbuf);|clearblurborder(screenbuf+64000); blurproc(screenbuf+64000,screenbuf);|' \
  -e 's|blurproc(screenbuf+128000,screenbuf+64000);|clearblurborder(screenbuf+128000); blurproc(screenbuf+128000,screenbuf+64000);|' \
  -e '803s/noisefade/noisefadeblack/' \
  -e '933s/noisefade/noisefadeblack/' \
  -e '1347s|dofproc();|theta += 1.63*1.25*0.0031*dofproc();|' \
  -e '1393s|lazyinterpolate(t,&mycam);|int spherehandoffframe=takespherehandoff(\&mycam); if (!spherehandoffframe) lazyinterpolate(t,\&mycam);|' \
  -e '1463s|drawsphere(theta);|if (spherehandoffframe) { screenbuf+=64000; drawsphere2(\&mycam,spherehandoffscale()); screenbuf-=64000; } else drawsphere(theta);|' \
  "$SRC/DEMO1.CPP" > parts/DEMO1.CPP
# DEMO4.CPP re-uses for-scoped indices after their loops (MSVC leaked them);
# hoist the two declarations those five sites need.
LC_ALL=C sed -e '651s/^{/{\tint c1, x;/' "$SRC/DEMO4.CPP" > parts/DEMO4.CPP

# _BLUR.aSM is NASM already; strip only the MASM 'END' terminator NASM rejects.
LC_ALL=C sed '/^END/d' "$SRC/_BLUR.aSM" > build/blur.asm

$IXA_AS asm/radialblur.asm -o build/radialblur.o
$IXA_AS asm/asm1.asm -o build/asm1.o
$IXA_AS asm/data.asm -I "$SRC/demo/" -o build/data.o
$IXA_AS build/blur.asm -o build/blur.o
# ELF has no underscore prefix; rename the symbols C code references.
i686-elf-objcopy --redefine-sym _cliptab128=cliptab128 \
                 --redefine-sym _cliptab=cliptab \
                 --redefine-sym _BILTAB=BILTAB \
                 --redefine-sym _divide21=divide21 build/blur.o

CXX="$IXA_CXX -std=gnu++98 -w -fno-operator-names -fpermissive -Iinclude -I$SRC"
$CXX -c src/square.cpp -o build/square.o
$CXX -c src/stubs.cpp -o build/stubs.o
$CXX -c parts/DCT.CPP -o build/dct.o
$CXX -c parts/DEMO2.CPP -o build/demo2.o
$CXX -c parts/DEMO5.CPP -o build/demo5.o
$CXX -c parts/DEMO1.CPP -o build/demo1.o
$CXX -c parts/DEMO4.CPP -o build/demo4.o
$CXX -c parts/BJORK.CPP -o build/bjork.o
$CXX -c parts/DEMO3.CPP -o build/demo3.o
$CXX -c parts/CELLTAB.CPP -o build/celltab.o

"$IXA_SDK/ixa-package.sh" -o square.ixa --name " Square" --fast \
  build/square.o build/stubs.o build/dct.o build/demo2.o build/demo5.o \
  build/demo1.o build/demo4.o build/bjork.o build/demo3.o build/celltab.o \
  build/asm1.o build/blur.o build/data.o build/radialblur.o
