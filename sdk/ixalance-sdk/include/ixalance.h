/* ixalance.h — the iXalance guest SDK.
 *
 * A freestanding toolkit for authoring .ixa productions: everything a guest
 * needs to talk to an iXalance host, and nothing specific to any one demo.
 *
 * A guest is an i386 flat binary that the host far-calls once. It implements
 * ixa_main(), draws, presents frames, and returns. See ABI.md for the raw
 * stack-frame contract this header sits on top of.
 *
 * Portability is the point. A guest built against this header targets
 * ixalance-js and the native iXalance players because nothing here assumes a
 * pixel format, a resolution, or a tick rate — all three are negotiated from
 * the host at runtime. Native-player compatibility is kept defensive: some
 * drivers omit fields that can be recovered from the rest of gfxmodeinfo.
 */

#ifndef IXALANCE_H
#define IXALANCE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ===================================================================== */
/* lifecycle                                                             */
/* ===================================================================== */

/* The guest's entry point. Implement this; crt0 calls it. Returning ends the
 * part and hands control back to the container script. */
int ixa_main(void);

/* End the part immediately from anywhere, unwinding to the host return
 * address crt0 saved. Does not return. */
void ixa_exit(void) __attribute__((noreturn));

/* ===================================================================== */
/* display                                                               */
/* ===================================================================== */

/* The host's truecolour mode, read out of gfxmodeinfo. Every field is
 * host-declared: none of it may be assumed. */
typedef struct {
    unsigned char *fb;      /* linear framebuffer (tclfb)                */
    unsigned width;         /* tcxres                                     */
    unsigned height;        /* tcyres                                     */
    unsigned pitch;         /* tcscanlen — bytes per scanline, not pixels */
    unsigned bytespp;       /* bytes per pixel, derived from bits         */
    int bits;               /* tcbitmode, or inferred: 15, 16, 24 or 32   */
    int rshift, gshift, bshift;  /* rcomp/gcomp/bcomp — left shifts       */
    int rbits, gbits, bbits;     /* rmask/gmask/bmask — component widths  */
} ixa_display;

/* Snapshot the current mode. Cheap; call it after any event that could have
 * changed the mode rather than caching across parts. */
void ixa_display_query(ixa_display *d);

/* Pack 8-bit-per-component colour into the host's native pixel value. */
static inline uint32_t ixa_pack(const ixa_display *d, unsigned r, unsigned g, unsigned b)
{
    return (uint32_t)(((r >> (8 - d->rbits)) << d->rshift)
                    | ((g >> (8 - d->gbits)) << d->gshift)
                    | ((b >> (8 - d->bbits)) << d->bshift));
}

/* Store one native pixel at p, honouring bytespp. */
static inline void ixa_store(const ixa_display *d, unsigned char *p, uint32_t v)
{
    p[0] = (unsigned char)v;
    p[1] = (unsigned char)(v >> 8);
    if (d->bytespp >= 3) p[2] = (unsigned char)(v >> 16);
    if (d->bytespp == 4) p[3] = (unsigned char)(v >> 24);
}

/* Address of pixel (x, y) in the host framebuffer. */
static inline unsigned char *ixa_pixel(const ixa_display *d, unsigned x, unsigned y)
{
    return d->fb + y * d->pitch + x * d->bytespp;
}

/* Present the host framebuffer as it stands, and pump the host's clocks.
 * Guests that draw straight into ixa_display.fb call this; guests that draw
 * into a canvas call ixa_present() instead. */
void ixa_show(void);

/* Pump the host's clocks (messages, music position, herzcount) WITHOUT
 * presenting a frame. Use inside long precalculation loops so the music keeps
 * running and the host stays responsive. */
void ixa_poll(void);

/* ===================================================================== */
/* canvas — draw in a stable format, let the SDK reach the host's         */
/* ===================================================================== */

enum {
    IXA_INDEX8 = 0,     /* 8-bit paletted, the classic demoscene buffer   */
    IXA_ARGB32 = 1      /* 0xAARRGGBB, one uint32_t per pixel             */
};

typedef struct {
    void *pixels;
    unsigned width, height;
    unsigned pitch;             /* bytes per scanline; 0 means packed     */
    int format;                 /* IXA_INDEX8 or IXA_ARGB32               */

    /* IXA_INDEX8 only: 256 entries of {r, g, b}. VGA palettes are 6-bit
     * (0..63) — say so, or a 6-bit palette renders at a quarter brightness. */
    const unsigned char *palette;
    int palette_bits;           /* 6 for VGA, 8 for full range            */
} ixa_canvas;

/* Convert the canvas into the host's pixel format and present it.
 *
 * The canvas is centred in the host mode; a canvas larger than the mode is
 * centre-cropped, a smaller one is letterboxed against the border colour
 * (palette entry 0 for IXA_INDEX8, black for IXA_ARGB32). This is the same
 * policy the Win32 players used, so a production looks identical wherever it
 * runs. Calls ixa_show() for you. */
void ixa_present(const ixa_canvas *c);

/* Initialise a canvas descriptor. pitch defaults to packed rows. */
void ixa_canvas_init(ixa_canvas *c, void *pixels, unsigned w, unsigned h, int format);

/* ===================================================================== */
/* timing                                                                */
/* ===================================================================== */

/* Consume the host's tick accumulator: returns the ticks elapsed since the
 * last call and zeroes the counter, which is the protocol every original part
 * follows. Does NOT pump the host — call ixa_show() or ixa_poll() first, or
 * this returns 0 forever. */
int ixa_ticks(void);

/* Ticks per second for the value ixa_ticks() returns: 70 before music starts,
 * 140 after ixa_music_start(). The rate change is not a bug to work around —
 * it is how the host gives a music-driven part finer resolution. Divide by
 * this rather than by a literal. */
unsigned ixa_tick_rate(void);

/* Seconds elapsed since the part started, accumulated from ticks at whatever
 * rate was in force. Rate-change safe. */
double ixa_seconds(void);

/* Advance ixa_seconds()/ixa_ticks() bookkeeping without drawing. Equivalent to
 * ixa_poll() followed by draining the tick counter into the clock. */
void ixa_tick_update(void);

/* ===================================================================== */
/* music                                                                 */
/* ===================================================================== */

/* Hand the host an in-memory XM module and start playback (fardoint 'TBL1').
 * Bumps the tick rate to 140 Hz. Call this after precalculation, at the point
 * the production is meant to begin — the host starts the song immediately. */
void ixa_music_start(const void *xm, unsigned length);

/* Current playback position, refreshed by ixa_show()/ixa_poll(). These read
 * the host's `mustime` pair directly and are the cheap way to sync visuals. */
unsigned ixa_music_order(void);   /* pattern order index */
unsigned ixa_music_row(void);     /* row within the pattern */

/* fardoint 'TBL3': (row + 1) | (order << 8), or 0 if nothing is playing.
 * A round trip through the host, so prefer ixa_music_row()/order() in a loop.
 * Useful as a "has the music started yet" probe. */
unsigned ixa_music_pos(void);

/* ===================================================================== */
/* memory                                                                */
/* ===================================================================== */

/* Raw host allocation (farmalloc) out of the part-memory arena. Never freed
 * individually — the host releases the whole arena between parts. Note the
 * host rounds (bytes + 4096) DOWN to a page, so an exactly page-sized request
 * costs one extra page. */
void *ixa_partmem(unsigned bytes);

/* Reserve the SDK heap up front. Optional: the first malloc() reserves
 * IXA_HEAP_DEFAULT_BYTES on its own. Call before any malloc() if the guest
 * wants a different split between the heap and direct ixa_partmem() use.
 * Returns 0 on failure. */
#define IXA_HEAP_DEFAULT_BYTES (8u * 1024u * 1024u)
int ixa_heap_reserve(unsigned bytes);

/* A real allocator over that arena: first-fit with coalescing, so guests that
 * allocate and free short-lived buffers (meshes, textures, scratch) work
 * without leaking the arena away one bump at a time. */
void *malloc(size_t n);
void *calloc(size_t count, size_t size);
void *realloc(void *p, size_t n);
void free(void *p);

/* ===================================================================== */
/* mini libc                                                             */
/* ===================================================================== */

void *memcpy(void *dst, const void *src, size_t n);
void *memmove(void *dst, const void *src, size_t n);
void *memset(void *dst, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);
size_t strlen(const char *s);
char *strcpy(char *dst, const char *src);
int strcmp(const char *a, const char *b);
int strncmp(const char *a, const char *b, size_t n);
int strnicmp(const char *a, const char *b, size_t n);

int abs(int x);
int rand(void);
void srand(unsigned seed);

/* ===================================================================== */
/* x87 math                                                              */
/* ===================================================================== */

double sin(double x);
double cos(double x);
double tan(double x);
double atan(double x);
double atan2(double y, double x);
double sqrt(double x);
double fabs(double x);
double floor(double x);
double ceil(double x);
double fmod(double x, double y);
double exp(double x);
double log(double x);
double pow(double x, double y);

#define IXA_PI 3.14159265358979323846

#ifdef __cplusplus
}
#endif

#endif /* IXALANCE_H */
