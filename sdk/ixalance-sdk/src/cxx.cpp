/* cxx.cpp — the freestanding C++ runtime bits, for guests written in C++.
 *
 * Square is C++, so the SDK carries operator new/delete over the SDK heap.
 * These live in their own archive member: a C-only guest never references them
 * and the linker never pulls this object in, so it costs nothing.
 *
 * Compiled with -fno-exceptions and -fno-rtti; there is no unwinder in a guest
 * and nothing to unwind to. A failed allocation returns null rather than
 * throwing, which is what the pre-standard code in this corpus expects anyway.
 */

#include "ixalance.h"

void *operator new(size_t n)        { return malloc(n); }
void *operator new[](size_t n)      { return malloc(n); }
void operator delete(void *p)       { free(p); }
void operator delete[](void *p)     { free(p); }
void operator delete(void *p, size_t)   { free(p); }
void operator delete[](void *p, size_t) { free(p); }
