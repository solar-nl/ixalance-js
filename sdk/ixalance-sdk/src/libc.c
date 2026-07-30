/* libc.c — the freestanding subset a guest actually needs.
 *
 * -ffreestanding removes the library but not the compiler's right to SYNTHESISE
 * calls to memcpy/memset/memmove/memcmp when it recognises a loop or a struct
 * copy. Those four must exist even in a guest that never names them, which is
 * why they live in the SDK rather than in each production's shim.
 *
 * rand() is deliberately Watcom's LCG, not a better generator: the DOS-era
 * productions in this corpus were tuned against those exact sequences, and a
 * different stream changes what the noise tables and starfields look like.
 */

#include "ixalance.h"

void *memcpy(void *dst, const void *src, size_t n)
{
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
    while (n--) *d++ = *s++;
    return dst;
}

void *memmove(void *dst, const void *src, size_t n)
{
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
    if (d < s) { while (n--) *d++ = *s++; }
    else { d += n; s += n; while (n--) *--d = *--s; }
    return dst;
}

void *memset(void *dst, int c, size_t n)
{
    unsigned char *d = (unsigned char *)dst;
    while (n--) *d++ = (unsigned char)c;
    return dst;
}

int memcmp(const void *a, const void *b, size_t n)
{
    const unsigned char *p = (const unsigned char *)a;
    const unsigned char *q = (const unsigned char *)b;
    while (n--) { if (*p != *q) return *p - *q; p++; q++; }
    return 0;
}

size_t strlen(const char *s)
{
    const char *p = s;
    while (*p) p++;
    return (size_t)(p - s);
}

char *strcpy(char *dst, const char *src)
{
    char *d = dst;
    while ((*d++ = *src++) != 0) { }
    return dst;
}

int strcmp(const char *a, const char *b)
{
    while (*a && *a == *b) { a++; b++; }
    return (int)(unsigned char)*a - (int)(unsigned char)*b;
}

int strncmp(const char *a, const char *b, size_t n)
{
    while (n--) {
        if (*a != *b) return (int)(unsigned char)*a - (int)(unsigned char)*b;
        if (!*a) return 0;
        a++; b++;
    }
    return 0;
}

static int lower(int c) { return (c >= 'A' && c <= 'Z') ? c + 32 : c; }

int strnicmp(const char *a, const char *b, size_t n)
{
    while (n--) {
        int d = lower((unsigned char)*a) - lower((unsigned char)*b);
        if (d) return d;
        if (!*a) return 0;
        a++; b++;
    }
    return 0;
}

int abs(int x) { return x < 0 ? -x : x; }

/* Watcom's LCG — the sequence the original productions were authored against. */
static uint32_t rand_state = 0x1234ABCDu;

int rand(void)
{
    rand_state = rand_state * 1103515245u + 12345u;
    return (int)((rand_state >> 16) & 0x7fff);
}

void srand(unsigned seed) { rand_state = seed; }
