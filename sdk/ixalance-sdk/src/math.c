/* math.c — libm on the bare x87.
 *
 * There is no libm in a freestanding guest, and the i486 target has no SSE, so
 * every function here is the FPU instruction that implements it. This is not a
 * compromise: it is what the original Watcom-built productions compiled down
 * to, so the results match bit for bit where the instruction is exact.
 *
 * The GCC extended-asm constraints are load-bearing:
 *   "=t"  -> output is st(0)
 *   "0"   -> input tied to that same st(0)
 *   "u"   -> second input in st(1)
 * and an "st(1)" CLOBBER declares "this asm popped st(1)". Omitting that
 * clobber on a two-operand instruction leaks an x87 stack slot per call, and
 * the eighth call silently returns NaN.
 */

#include "ixalance.h"

double sin(double x)  { double r; __asm__ ("fsin"  : "=t"(r) : "0"(x)); return r; }
double cos(double x)  { double r; __asm__ ("fcos"  : "=t"(r) : "0"(x)); return r; }
double sqrt(double x) { double r; __asm__ ("fsqrt" : "=t"(r) : "0"(x)); return r; }
double fabs(double x) { double r; __asm__ ("fabs"  : "=t"(r) : "0"(x)); return r; }

/* fptan leaves tan(x) in st(1) and pushes a redundant 1.0; drop it. */
double tan(double x)
{
    double r;
    __asm__ ("fptan\n\tfstp %%st(0)" : "=t"(r) : "0"(x));
    return r;
}

/* fpatan computes atan(st(1)/st(0)) and pops, so atan(x) is atan(x/1). */
double atan(double x)
{
    double r;
    __asm__ ("fld1\n\tfpatan" : "=t"(r) : "0"(x));
    return r;
}

/* Quadrant-correct by construction: fpatan inspects both signs. */
double atan2(double y, double x)
{
    double r;
    __asm__ ("fpatan" : "=t"(r) : "0"(x), "u"(y) : "st(1)");
    return r;
}

/* frndint honours the rounding mode, so floor/ceil are the same instruction
 * under two different control words. Save and restore it — leaving the FPU in
 * round-toward-minus-infinity would skew every later conversion in the guest. */
static double rnd_with_mode(double x, unsigned short mode)
{
    unsigned short cw, cw2;
    double r;
    __asm__ volatile ("fnstcw %0" : "=m"(cw));
    cw2 = (unsigned short)((cw & ~0x0c00) | mode);
    __asm__ volatile ("fldcw %0" :: "m"(cw2));
    __asm__ ("frndint" : "=t"(r) : "0"(x));
    __asm__ volatile ("fldcw %0" :: "m"(cw));
    return r;
}

double floor(double x) { return rnd_with_mode(x, 0x0400); }   /* toward -inf */
double ceil(double x)  { return rnd_with_mode(x, 0x0800); }   /* toward +inf */

/* fprem is a partial remainder: it may need several passes, signalled by C2 in
 * the status word (which sahf lands in the parity flag). */
double fmod(double x, double y)
{
    double r;
    __asm__ ("1: fprem\n\t"
             "fnstsw %%ax\n\t"
             "sahf\n\t"
             "jp 1b\n\t"
             "fstp %%st(1)"
             : "=t"(r) : "0"(x), "u"(y) : "ax", "cc", "st(1)");
    return r;
}

/* e^x = 2^(x * log2 e). f2xm1 only covers a fractional exponent in [-1, 1], so
 * split into integer and fractional parts and reassemble with fscale. */
double exp(double x)
{
    double r;
    __asm__ ("fldl2e\n\tfmulp %%st(1)\n\t"
             "fld %%st(0)\n\tfrndint\n\tfsubr %%st(0), %%st(1)\n\tfxch\n\t"
             "f2xm1\n\tfld1\n\tfaddp\n\tfscale\n\tfstp %%st(1)"
             : "=t"(r) : "0"(x));
    return r;
}

/* ln x = log2(x) * ln 2, which is exactly what fyl2x computes. */
double log(double x)
{
    double r;
    __asm__ ("fldln2\n\tfxch\n\tfyl2x" : "=t"(r) : "0"(x));
    return r;
}

/* 2^(y * log2 x). Positive bases only — the demos never raise a negative one,
 * and fyl2x would fault if they did. */
double pow(double x, double y)
{
    double r;
    __asm__ ("fyl2x\n\t"
             "fld %%st(0)\n\tfrndint\n\tfsubr %%st(0), %%st(1)\n\tfxch\n\t"
             "f2xm1\n\tfld1\n\tfaddp\n\tfscale\n\tfstp %%st(1)"
             : "=t"(r) : "0"(x), "u"(y) : "st(1)");
    return r;
}
