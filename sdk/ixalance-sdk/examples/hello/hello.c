/* hello.c — the SDK's example guest.
 *
 * This animated interference pattern began as the ABI proof and is now
 * rewritten against the SDK. The interesting difference is what is NO LONGER
 * here: no gfxmodeinfo field offsets, no RGB565 packing, no assumption that a
 * pixel is two bytes or that a scanline is 640 of them. This guest draws into
 * an 8-bit paletted buffer — the format the DOS-era productions actually used
 * — and lets ixa_present() reach whatever the host declared.
 *
 * Build:  ./build.sh
 * Run:    node ../../../../run.mjs run hello.ixa '' 1000000000
 */

#include <ixalance.h>

#define W 320
#define H 200

static unsigned char screen[W * H];
static unsigned char palette[256 * 3];      /* 6-bit VGA components, 0..63 */

/* A fire-ish ramp: black through red and orange into white. Written at VGA's
 * native 6-bit depth so ixa_present() gets to demonstrate the widening. */
static void build_palette(int rotate)
{
    int i;
    for (i = 0; i < 256; i++) {
        int v = (i + rotate) & 255;
        int r = v < 96 ? v * 63 / 96 : 63;
        int g = v < 96 ? 0 : (v < 192 ? (v - 96) * 63 / 96 : 63);
        int b = v < 192 ? 0 : (v - 192) * 63 / 63;
        palette[i * 3 + 0] = (unsigned char)r;
        palette[i * 3 + 1] = (unsigned char)g;
        palette[i * 3 + 2] = (unsigned char)(b > 63 ? 63 : b);
    }
}

int ixa_main(void)
{
    ixa_canvas canvas;
    unsigned char *scratch;
    double t = 0.0;
    int frames = 0;

    /* Both memory paths: a raw arena block straight from the host, and the
     * SDK heap on top of it. */
    scratch = (unsigned char *)ixa_partmem(65536);
    if (scratch) scratch[0] = 42;
    {
        void *tmp = malloc(4096);
        free(tmp);
    }

    /* Stand in for a real precalculation pass. A guest that grinds away
     * without ever calling back into the host freezes the music and the
     * player's UI, so pump the clocks from inside long loops. */
    {
        int i;
        for (i = 0; i < 16; i++) {
            build_palette(i);
            ixa_tick_update();              /* farbasic: no frame presented */
        }
    }

    ixa_canvas_init(&canvas, screen, W, H, IXA_INDEX8);
    canvas.palette = palette;
    canvas.palette_bits = 6;                /* VGA range — say so, or it dims */

    /* ~6 seconds. ixa_seconds() stays correct even if a guest starts music
     * partway through and the host's tick rate doubles under it. */
    while (ixa_seconds() < 6.0 && frames < 4000) {
        int x, y;
        double sx = sin(t) * 48.0;
        double sy = cos(t * 0.7) * 32.0;
        int ox = (int)sx, oy = (int)sy;

        for (y = 0; y < H; y++) {
            unsigned char *row = screen + y * W;
            for (x = 0; x < W; x++) {
                int a = (x + ox) ^ (y + oy);
                int b = ((x - ox) * (y - oy)) >> 6;
                row[x] = (unsigned char)((a + b) & 255);
            }
        }

        build_palette((int)(t * 40.0));
        ixa_present(&canvas);               /* converts + presents + pumps */

        ixa_ticks();                        /* consume, TBL-style */
        t = ixa_seconds();
        frames++;
    }

    return 0;
}
