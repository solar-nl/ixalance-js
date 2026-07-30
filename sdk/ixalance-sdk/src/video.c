/* video.c — display negotiation and the portable presenter.
 *
 * Generalised from the pre-SDK Square port's ptc_update(), which was itself
 * the tinyptc call the Win32 port made. The Square version hardcoded a
 * 320x240 ARGB32 canvas; this one takes any canvas in either of the two
 * formats the corpus actually uses and reaches any host pixel format.
 *
 * Nothing here assumes RGB565. ixalance-js happens to pin the mode to
 * 320x200/565 (lib/machine.js setVideoResolution), but native players negotiate
 * a real display, and a guest built on this SDK has to keep working there.
 * That backward compatibility is the whole reason the conversion is
 * table-driven rather than inlined.
 */

#include "ixalance.h"

/* Tgfxmodeinfo is #pragma pack(1), so several 32-bit fields sit at odd
 * offsets. Read byte-wise rather than casting: the layout is the contract, and
 * an unaligned cast invites the compiler to assume alignment it does not have.
 * Field offsets come from ixalance.h's struct (mirrored in lib/machine.js GFX). */
#define GFX_TCLFB      4
#define GFX_TCSCANLEN  34
#define GFX_TCXRES     38
#define GFX_TCYRES     42
#define GFX_TCBITMODE  52
#define GFX_RCOMP      53
#define GFX_GCOMP      54
#define GFX_BCOMP      55
#define GFX_RMASK      56
#define GFX_GMASK      57
#define GFX_BMASK      58

extern unsigned char *ixa_gfxinfo;

void ixa_host_showp(void);
void ixa_host_basic(void);

static uint32_t rd32(const unsigned char *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8)
         | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static int valid_bitmode(int bits)
{
    return bits == 15 || bits == 16 || bits == 24 || bits == 32;
}

/* Some native drivers fill the framebuffer, pitch and RGB component fields
 * but leave tcbitmode at its zero-initialised value. Recover the storage width
 * without assuming 565:
 *
 * - component widths distinguish 15/16-bit storage from 24/32-bit storage;
 * - pitch/width distinguishes packed RGB24 from 32-bit storage whose masks
 *   still add up to 24;
 * - pitch alone is the last resort when the component widths are absent.
 *
 * Scanline padding is smaller than a pixel for normal display widths, so the
 * integer quotient remains the storage width. Component widths take priority
 * for 15/16-bit modes, where a very narrow padded surface could otherwise look
 * like 32-bit storage. */
static unsigned infer_bytespp(unsigned pitch, unsigned width, unsigned mask_bits)
{
    unsigned stride_bytes = width ? pitch / width : 0;

    if (mask_bits && mask_bits <= 16) return 2;
    if (mask_bits > 24) return 4;
    if (mask_bits) return stride_bytes >= 4 ? 4 : 3;
    return stride_bytes >= 1 && stride_bytes <= 4 ? stride_bytes : 0;
}

void ixa_display_query(ixa_display *d)
{
    const unsigned char *g = ixa_gfxinfo;
    unsigned mask_bits;

    d->fb     = (unsigned char *)(size_t)rd32(g + GFX_TCLFB);
    d->pitch  = rd32(g + GFX_TCSCANLEN);
    d->width  = rd32(g + GFX_TCXRES);
    d->height = rd32(g + GFX_TCYRES);
    d->bits   = g[GFX_TCBITMODE];

    d->rshift = g[GFX_RCOMP];
    d->gshift = g[GFX_GCOMP];
    d->bshift = g[GFX_BCOMP];
    d->rbits  = g[GFX_RMASK];
    d->gbits  = g[GFX_GMASK];
    d->bbits  = g[GFX_BMASK];

    if (valid_bitmode(d->bits)) {
        /* 15-bit modes are stored in 2 bytes, not 1.875. */
        d->bytespp = (d->bits == 15) ? 2 : (unsigned)((d->bits + 7) / 8);
        return;
    }

    mask_bits = (unsigned)(d->rbits + d->gbits + d->bbits);
    d->bytespp = infer_bytespp(d->pitch, d->width, mask_bits);
    if (!d->bytespp) {
        d->bits = 0;
    } else if (mask_bits == 15 && d->bytespp == 2) {
        d->bits = 15;
    } else {
        d->bits = (int)(d->bytespp * 8);
    }
}

void ixa_show(void) { ixa_host_showp(); }
void ixa_poll(void) { ixa_host_basic(); }

void ixa_canvas_init(ixa_canvas *c, void *pixels, unsigned w, unsigned h, int format)
{
    c->pixels = pixels;
    c->width = w;
    c->height = h;
    c->pitch = w * (format == IXA_ARGB32 ? 4u : 1u);
    c->format = format;
    c->palette = 0;
    c->palette_bits = 8;
}

/* Expand an n-bit palette component to full 8-bit range. Scaling by
 * 255/(2^bits - 1) maps the maximum to 0xff exactly, so a 6-bit VGA 0x3f comes
 * out white rather than the 0xfc a bare left-shift would give. */
static unsigned widen(unsigned v, int bits)
{
    unsigned max;
    if (bits >= 8) return v & 0xff;
    if (bits <= 0) return 0;
    max = (1u << bits) - 1u;
    v &= max;
    return (v * 255u + max / 2u) / max;
}

static void fill_span(const ixa_display *d, unsigned char *p, unsigned count, uint32_t v)
{
    while (count--) {
        ixa_store(d, p, v);
        p += d->bytespp;
    }
}

void ixa_present(const ixa_canvas *c)
{
    ixa_display d;
    uint32_t lut[256];
    uint32_t border;
    unsigned copy_w, copy_h, sx0, sy0, dx0, dy0, y;
    unsigned cpitch;

    ixa_display_query(&d);
    if (d.bits <= 8 || d.bytespp < 2 || d.bytespp > 4) {
        /* An 8-bit host mode would need the guest's palette pushed through the
         * driver, which this SDK deliberately does not do: every shipped
         * iXalance player negotiates a truecolour mode. */
        ixa_exit();
    }

    cpitch = c->pitch ? c->pitch : c->width * (c->format == IXA_ARGB32 ? 4u : 1u);

    /* Rebuild the palette lookup every frame so palette animation and fades —
     * the bread and butter of this corpus — just work. 256 packs per frame is
     * noise next to the blit. */
    if (c->format == IXA_INDEX8) {
        const unsigned char *pal = c->palette;
        int i;
        for (i = 0; i < 256; i++) {
            unsigned r = 0, g = 0, b = 0;
            if (pal) {
                r = widen(pal[i * 3 + 0], c->palette_bits);
                g = widen(pal[i * 3 + 1], c->palette_bits);
                b = widen(pal[i * 3 + 2], c->palette_bits);
            }
            lut[i] = ixa_pack(&d, r, g, b);
        }
        border = lut[0];
    } else {
        border = ixa_pack(&d, 0, 0, 0);
    }

    /* Centre the canvas: crop it if it is larger than the mode, letterbox it
     * against the border colour if it is smaller. */
    copy_w = c->width  < d.width  ? c->width  : d.width;
    copy_h = c->height < d.height ? c->height : d.height;
    sx0 = (c->width  - copy_w) / 2;
    sy0 = (c->height - copy_h) / 2;
    dx0 = (d.width   - copy_w) / 2;
    dy0 = (d.height  - copy_h) / 2;

    for (y = 0; y < d.height; y++) {
        unsigned char *drow = d.fb + y * d.pitch;

        if (y < dy0 || y >= dy0 + copy_h) {
            fill_span(&d, drow, d.width, border);
            continue;
        }

        if (dx0) fill_span(&d, drow, dx0, border);
        if (dx0 + copy_w < d.width)
            fill_span(&d, drow + (dx0 + copy_w) * d.bytespp,
                      d.width - dx0 - copy_w, border);

        {
            unsigned char *dst = drow + dx0 * d.bytespp;
            unsigned sy = sy0 + (y - dy0);
            unsigned x;

            if (c->format == IXA_INDEX8) {
                const unsigned char *src = (const unsigned char *)c->pixels
                                         + sy * cpitch + sx0;
                for (x = 0; x < copy_w; x++) {
                    ixa_store(&d, dst, lut[*src++]);
                    dst += d.bytespp;
                }
            } else {
                const unsigned char *srcb = (const unsigned char *)c->pixels
                                          + sy * cpitch + sx0 * 4;
                for (x = 0; x < copy_w; x++) {
                    uint32_t argb = rd32(srcb);
                    ixa_store(&d, dst,
                              ixa_pack(&d, (argb >> 16) & 0xff,
                                           (argb >> 8) & 0xff,
                                            argb & 0xff));
                    srcb += 4;
                    dst += d.bytespp;
                }
            }
        }
    }

    ixa_host_showp();
}
