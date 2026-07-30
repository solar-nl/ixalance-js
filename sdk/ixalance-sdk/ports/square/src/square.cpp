/* square.cpp — Square-specific support for the iXalance port.
 *
 * The iXalance SDK owns the ABI, video conversion, host clock/music access,
 * heap, libc, math, and C++ runtime. This file retains only the production's
 * packed-file/LZW layer, 320x480 compositor, legacy fproc scheduler, startup,
 * and small demo-side compatibility helpers. Source line references point
 * into source/squarewin32src/square_w32/source/. */

#include "stdafx.h"
#include "common.h"

/* stuff.h remaps malloc & co to the MY* accounting wrappers for demo code;
 * this file implements both layers, so use the raw names locally. */
#undef malloc
#undef calloc
#undef realloc
#undef free

/* ---- embedded production assets and Square's assembly bridge ---------- */
extern "C" {
extern const unsigned char squarepak_data[];
extern const unsigned squarepak_len;
extern const unsigned char peoplelzw_data[];
extern const unsigned peoplelzw_len;
extern const unsigned char zeboulzw_data[];
extern const unsigned zeboulzw_len;
extern const unsigned char squademo_data[];
extern const unsigned squademo_len;
void radialblur_call(unsigned char *dest, int ix, int iy, float *f,
                     int *xtab, int *ytab);
}
/* _BLUR.aSM's _BILTAB, renamed to BILTAB for ELF by the build script. */
extern "C" unsigned char *BILTAB;

/* ======================================================================= */
/* original-source compatibility not provided by the SDK                   */
/* ======================================================================= */
extern "C" {

/* UTILS.CPP:47-98 accounting wrappers (the demo calls these via stuff.h) */
SLONG curalloc = 0, maxalloc = 0;
void *MYMALLOC(size_t n) { return malloc(n); }
void *MYCALLOC(size_t num, size_t size) { return calloc(num, size); }
void *MYREALLOC(void *p, size_t n) { return realloc(p, n); }
void MYFREE(void *p) { free(p); }
void *testmalloc(size_t n) { return malloc(n); }

int holdrand = 1;                                       /* asm1.cpp:31-34 */
int alexrand(void) { return rand(); }
int _blurwid = 320;                                     /* asm1.cpp:2028 */
void setblurwid(int w) { _blurwid = w; }

int kbhit(void) { return 0; }         /* conio in a GUI app: never true (see notes) */
int getch(void) { return 0; }
void beep(void) {}
int printf(const char *, ...) { return 0; }
void exit(int) { ixa_exit(); }
void error(unsigned char *s) { (void)s; exit(-1); }
}

/* ======================================================================= */
/* embedded files as stdio-lookalikes (winmain.cpp's MEMFILE, in spirit)   */
/* ======================================================================= */
struct MEMFILE { const unsigned char *data; unsigned len, pos; };
static MEMFILE memfiles[3];

static MEMFILE *fopen_mem(const char *name) {
    if (strnicmp(name, "square.pak", 11) == 0) {
        memfiles[0].data = squarepak_data; memfiles[0].len = squarepak_len;
        memfiles[0].pos = 0; return &memfiles[0];
    }
    if (strnicmp(name, "people.lzw", 11) == 0) {
        memfiles[1].data = peoplelzw_data; memfiles[1].len = peoplelzw_len;
        memfiles[1].pos = 0; return &memfiles[1];
    }
    if (strnicmp(name, "zebou.lzw", 10) == 0) {
        memfiles[2].data = zeboulzw_data; memfiles[2].len = zeboulzw_len;
        memfiles[2].pos = 0; return &memfiles[2];
    }
    return 0;
}
static unsigned fread_mem(void *buf, unsigned n, MEMFILE *f) {
    if (f->pos + n > f->len) n = f->len - f->pos;
    memcpy(buf, f->data + f->pos, n);
    f->pos += n;
    return n;
}
static void fseek_mem(MEMFILE *f, unsigned pos) { f->pos = pos < f->len ? pos : f->len; }

/* ======================================================================= */
/* LZW decoder — C port of asmexpand (lzwasm.cpp:25-144) + the file layer  */
/* from UTILS.CPP:617-874.                                                 */
/* ======================================================================= */
extern "C" {

/* The asm uses an 8-byte stride ({char at +0, parent dword at +4}), not the
 * C header's 12-byte DICTIONARY — see `lea ebx,[eax*8]` at lzwasm.cpp:69.
 * `dict` keeps the header's type; the decoder views it 8-byte-strided. */
struct DICT8 { unsigned char ch; unsigned char pad[3]; SLONG parent; };
DICTIONARY *dict;
unsigned char decode_stack[TABLE_SIZE];
ULONG next_code;
SLONG current_code_bits;
ULONG next_bump_code;
ULONG new_code, old_code;
LONG character;
BYTE *RAMPtr, RAMRack, RAMMask;
LONG numdecode;

LONG RAMReadBits(LONG n) {                              /* UTILS.CPP:813-824 */
    LONG mask = 1L << (n - 1), val = 0;
    while (mask) {
        if (RAMMask == 0x80) RAMRack = *RAMPtr++;
        if (RAMMask & RAMRack) val |= mask;
        RAMMask >>= 1;
        if (!RAMMask) RAMMask = 0x80;
        mask >>= 1;
    }
    return val;
}

SLONG asmexpand(void *buf, SLONG amount) {
    DICT8 *d8 = (DICT8 *)dict;
    UBYTE *dst = (UBYTE *)buf;
    SLONG remaining = amount;
    LONG nd = numdecode;

    for (;;) {
        while (nd > 0) {                                /* outer2: drain stack */
            nd--;
            *dst++ = decode_stack[nd];
            if (--remaining == 0) goto done;
        }
        for (;;) {                                      /* inner: refill */
            ULONG code = (ULONG)RAMReadBits(current_code_bits);
            new_code = code;
            if (code == END_OF_STREAM) { nd = 0; goto done; }
            if (code == FLUSH_CODE) {
                next_code = FIRST_CODE;
                current_code_bits = 9;
                old_code = (ULONG)RAMReadBits(current_code_bits);
                character = (LONG)(old_code & 0xff);
                decode_stack[0] = (UBYTE)old_code;
                nd = 1;
                break;
            }
            if (code == BUMP_CODE) { current_code_bits++; continue; }

            ULONG sp = 0;
            ULONG cur = code;
            if (cur >= next_code) {                     /* KwKwK case */
                decode_stack[0] = (UBYTE)character;
                sp = 1;
                cur = old_code;
            }
            while (cur > 255) {
                decode_stack[sp++] = d8[cur].ch;
                cur = (ULONG)d8[cur].parent;
            }
            decode_stack[sp] = (UBYTE)cur;
            character = (LONG)(UBYTE)cur;
            sp++;
            nd = (LONG)sp;
            d8[next_code].ch = (UBYTE)cur;
            d8[next_code].parent = (SLONG)old_code;
            next_code++;
            old_code = new_code;
            break;
        }
    }
done:
    numdecode = nd;
    return amount - remaining;
}

void resetlzw(LFILE *f) {                               /* UTILS.CPP:779-789 */
    RAMRack = 0;
    RAMMask = 0x80;
    RAMPtr = f->buf;
    if (!dict) dict = (DICTIONARY *)malloc((TABLE_SIZE + 1) * sizeof(DICTIONARY));
    next_code = FIRST_CODE;
    current_code_bits = 9;
    old_code = (ULONG)RAMReadBits(current_code_bits);
    decode_stack[0] = (UBYTE)old_code;
    character = (LONG)old_code;
    numdecode = 1;
}

/* ---- SQUARE.PAK library (UTILS.CPP:629-726) --------------------------- */
struct LIBREC { unsigned char name[12]; SLONG posn, clen, len; };
static MEMFILE *libfi;
static LIBREC *libdata;
static SLONG numlibfiles;

SLONG openlibf(unsigned char *fname) {
    SLONG c1;
    libfi = fopen_mem((const char *)fname);
    if (!libfi) return -1;
    fread_mem(&c1, 4, libfi);
    if (c1 != 'XELA') return -1;                        /* bytes "ALEX" */
    fread_mem(&numlibfiles, 4, libfi);
    libdata = (LIBREC *)calloc(numlibfiles, sizeof(LIBREC));
    fread_mem(&c1, 4, libfi);
    fseek_mem(libfi, c1);
    fread_mem(libdata, numlibfiles * sizeof(LIBREC), libfi);
    return 0;
}
void closelibf(void) {}

static SLONG findlibname(unsigned char *fname) {
    for (SLONG c1 = 0; c1 < numlibfiles; c1++)
        if (strnicmp((char *)fname, (char *)libdata[c1].name, 12) == 0) return c1;
    return -1;
}

LFILE *openf(unsigned char *fname) {
    if (numlibfiles && strnicmp((char *)fname, "data\\", 5) == 0) fname += 5;
    LFILE *f = (LFILE *)malloc(sizeof(LFILE));
    SLONG idx = numlibfiles ? findlibname(fname) : -1;
    if (idx >= 0) {
        f->len = libdata[idx].len;
        f->buf = (UBYTE *)malloc(libdata[idx].clen);
        fseek_mem(libfi, libdata[idx].posn);
        fread_mem(f->buf, libdata[idx].clen, libfi);
        resetlzw(f);
        f->fi = (FILE *)libfi;
        return f;
    }
    MEMFILE *m = fopen_mem((const char *)fname);        /* the "ohdear" path */
    if (!m) { error((unsigned char *)"file not found"); return 0; }
    f->fi = (FILE *)m;
    f->buf = 0;
    f->len = (SLONG)m->len;
    m->pos = 0;
    return f;
}

LFILE *openflzw(unsigned char *fname) {                 /* UTILS.CPP:729-748 */
    LFILE *f = openf(fname);
    if (!f->buf) {
        f->buf = (UBYTE *)malloc(f->len);
        fread_mem(f->buf, (unsigned)f->len, (MEMFILE *)f->fi);
        resetlzw(f);
    }
    return f;
}

void closef(LFILE *f) { free(f->buf); free(f); }

SLONG readf(LFILE *f, void *buf, SLONG count) {         /* UTILS.CPP:791-799 */
    if (count <= 0) return 0;
    if (f->fi == (FILE *)libfi || f->buf) return asmexpand(buf, count);
    return (SLONG)fread_mem(buf, (unsigned)count, (MEMFILE *)f->fi);
}

SLONG seekf(LFILE *f, SLONG pos) {
    if (f->fi == (FILE *)libfi) return -1;
    fseek_mem((MEMFILE *)f->fi, (unsigned)pos);
    return pos;
}

SLONG seeklzw(LFILE *f, SLONG pos) {                    /* UTILS.CPP:759-777 */
    if (pos == 0) return 0;
    resetlzw(f);
    UBYTE *b = (UBYTE *)malloc(pos);
    asmexpand(b, pos);
    free(b);
    return pos;
}
}

/* ======================================================================= */
/* video: Square's winpal + wina000 compositor -> SDK ARGB32 canvas        */
/* ======================================================================= */
extern "C" {
unsigned char winpal[256][4];
unsigned char wina000[480][320];

/* CopyPal2Screen keeps the original algorithm (winmain.cpp:20-69), producing
 * the same 320x240 ARGB32 canvas the Win32 port handed tinyptc. The SDK
 * negotiates the host mode and presents that stable canvas. */
#define W32_WIDTH 320
#define W32_HEIGHT 240
static int pixel[W32_WIDTH * W32_HEIGHT * 2];

void CopyPal2Screen(unsigned char *src, int numy) {     /* winmain.cpp:25-69 */
    int *winpali = (int *)winpal;
    int *dest = pixel;
    int half = 0;
    if (numy > 240) { numy /= 2; half = 1; }
    int cury = 0;
    if (numy < 240) {
        int bb = (240 - numy) / 2;
        for (int yy = 0; yy < bb; yy++) {
            for (int xx = 0; xx < 320; xx++) *dest++ = winpali[0];
            cury++;
        }
    }
    if (half) {
        for (int yy = 0; yy < numy; yy++) {
            for (int xx = 0; xx < 320; xx++, src++) *dest++ = (winpali[*src] + winpali[src[320]]) >> 1;
            src += 320;
            cury++;
        }
    } else {
        for (int yy = 0; yy < numy; yy++) {
            for (int xx = 0; xx < 320; xx++) *dest++ = winpali[*src++];
            cury++;
        }
    }
    while (cury < 240) {
        for (int xx = 0; xx < 320; xx++) *dest++ = winpali[0];
        cury++;
    }
    ixa_canvas canvas;
    ixa_canvas_init(&canvas, pixel, W32_WIDTH, W32_HEIGHT, IXA_ARGB32);
    ixa_present(&canvas);
}

}

static int tweaked = 2, lines400 = 0, page = 0;
void swapscreens(void *src, void *src2) {               /* UTILS.CPP:447-480 */
    (void)src2;
    if (tweaked && lines400) { xcopy(40, (unsigned char *)src, 400); page = (page + 1) % 3; }
    else xcopy(20, (unsigned char *)src, 200);
}
void swapscreens2(void *src) { xcopy(0, (unsigned char *)src, 240); }
void swapscreens3(void *src) { xcopy(0, (unsigned char *)src, 480); }

/* ======================================================================= */
/* timing + music sync                                                     */
/* ======================================================================= */
extern "C" {
int currow, curord, curpat, curpos;
SLONG midastime = 0;
static SLONG lasttime = 0;
static int herz_accum = 0;                /* TBL1's 140 Hz -> 60 Hz, x3/7 */

void UpdateInfo(void) {                                 /* MAIN.CPP:34-61 */
    curord = (int)ixa_music_order();
    currow = (int)ixa_music_row();
    curpat = curord;
    curpos = currow + curord * 64;
}
}

/* mytimeproc (MAIN.CPP:110-123) without the thread: TBL1 makes herzcount tick
 * at 140 Hz and midastime wants 60 Hz, so scale by 3/7 with a remainder. */
static void poll_timer(void) {
    ixa_poll();                            /* refresh ticks and music position */
    int dt = ixa_ticks();                  /* SDK owns the read/zero protocol */
    herz_accum += dt * 3;
    midastime += herz_accum / 7;
    herz_accum %= 7;
}

/* fproc scheduler (UTILS.CPP:108-275). faderfproc registers at pal 0 here and
 * runs once per 60 Hz tick from dofproc, which is the DOS cadence; the Win32
 * port ran it from a multimedia-timer thread instead (MAIN.CPP:151). */
#define NUMFPROC 8
static TIMERFN fprocl[NUMFPROC];
static int fproct[NUMFPROC], fprocp[NUMFPROC];

void resetfproc() {
    lasttime = midastime;
    memset(fprocl, 0, sizeof(fprocl));
    memset(fproct, 0, sizeof(fproct));
}
void addfproc(TIMERFN p, int pal) {
    for (int c1 = 0; c1 < NUMFPROC; c1++) {
        if (fprocl[c1] == 0 || fprocl[c1] == p) {
            fprocl[c1] = p; fproct[c1] = lasttime; fprocp[c1] = pal;
            p();
            return;
        }
    }
}
void removefproc(TIMERFN p) {
    for (int c1 = 0; c1 < NUMFPROC; c1++)
        if (fprocl[c1] == p) { fprocl[c1] = 0; fproct[c1] = 0; }
}
int dofproc(int pal) {
    if (pal) {
        for (int c1 = 0; c1 < NUMFPROC; c1++)
            if (fprocl[c1] && fprocp[c1] == pal) fprocl[c1]();
        return 0;
    }
    poll_timer();
    UpdateInfo();
    SLONG t = midastime;
    SLONG dt = t - lasttime;
    int r = (int)dt;
    lasttime = t;
    while (dt > 0) {
        for (int c1 = 0; c1 < NUMFPROC; c1++)
            if (fprocl[c1] && fprocp[c1] == 0) fprocl[c1]();
        dt--;
    }
    UpdateInfo();
    return r;
}

/* mypal lives here (UTILS.CPP:23); the fader, destpal and every setpal*
 * variant now come from DEMO4.CPP compiled verbatim. */
extern "C" { UBYTE mypal[256][3]; }

/* ======================================================================= */
/* demo globals + helpers used by the ported parts                         */
/* ======================================================================= */
extern "C" {
UBYTE *screenbuf;
UBYTE *zbuf;
UBYTE *tex[8];
UBYTE *texptr;
UBYTE *fadeptr;
UBYTE *ghostptr;
UBYTE *multab;
static UBYTE *texram;
unsigned char noisetab[NOISETABSIZE + 16];
unsigned char noisetab2[NOISETABSIZE + 16];
}

/* blurproc writes rows 2..196 and columns 0..317. Its running sum crosses
 * scanline boundaries, so stale values in the untouched right edge can wrap
 * into the following row and select an unrelated palette ramp. Square reuses
 * these buffers between parts; clear precisely the border blurproc omits. */
void clearblurborder(void *destv) {
    UBYTE *dest = (UBYTE *)destv;
    memset(dest, 0, 320 * 2);
    for (int y = 2; y < 197; y++) {
        dest[y * 320 + 318] = 0;
        dest[y * 320 + 319] = 0;
    }
    memset(dest + 197 * 320, 0, 320 * 3);
}

/* The cube noise pass is a darkening/dither pass. Rare stacked y-bars can push
 * its base shade over 47 into cube.fad's fade-to-white half, producing yellow
 * and gray pixels in regions which should remain black. Leave three rows for
 * noisefade's 0..3 per-pixel dither and clamp only that accidental crossover;
 * the blue DOF values and later additive composites retain their full ramps. */
void noisefadeblack(void *destsrc, unsigned char *yshades, int seed) {
    UBYTE darkshades[200];
    for (int row = 0; row < 200; row++)
        darkshades[row] = yshades[row] > 44 ? 44 : yshades[row];
    noisefade(destsrc, darkshades, seed);
}

/* The order-7 wire sphere and order-8 planet use the same mesh. Browser-side
 * asset setup can consume several music rows between them, so retain the exact
 * final projection camera for the first planet frame; subsequent frames resume
 * planet.fpl at the elapsed animation time. */
static CAM spherehandoff;
static int spherehandoffvalid = 0;
static float spherehandoffsize = 1;
void setspherehandoff(CAM *cam, float scale) {
    spherehandoff = *cam;
    spherehandoffsize = scale;
    spherehandoffvalid = 1;
}
int takespherehandoff(CAM *cam) {
    if (!spherehandoffvalid) return 0;
    *cam = spherehandoff;
    spherehandoffvalid = 0;
    return 1;
}
float spherehandoffscale(void) { return spherehandoffsize; }

/* loadraw comes from DEMO5.CPP, compiled verbatim. */

void calcfocus(float f, float blurfactor) {             /* UTILS.CPP:189-208 */
    int c0, c1, c2;
    float f2;
    f = 1.f / f;
    blurfactor *= 20000;
    for (c0 = 0; c0 < 256; c0++) {
        f2 = (1.f / (0.5f + c0)) - f;
        if (f2 < 0) f2 *= 6;
        c1 = (int)((SQR(f2)) * blurfactor);
        if (c1 > 255) c1 = 255;
        c2 = (128 - c1); if (c2 < 0) c2 = 0; zmaptab1[c0] = c2;
        c2 = c1; if (c2 > 128) c2 = 256 - c2; zmaptab2[c0] = c2;
        c2 = 128 - zmaptab2[c0] - zmaptab1[c0]; if (c2 < 0) c2 = 0; zmaptab3[c0] = c2;
    }
}

void putpixel(int x, int y, int c) {                    /* UTILS.CPP:314-317 */
    if (x >= 0 && y >= 0 && x < 320 && y < 200) screenbuf[y * 320 + x] = c;
}

void readghost(unsigned char *fname) {                  /* UTILS.CPP:597-602 */
    LFILE *f = openf(fname);
    readf(f, ghostptr, 256 * 256);
    closef(f);
}

void fixpal(unsigned char *fname, int nc, int fc) {     /* MAIN.CPP:196-202 */
    LFILE *f = openf(fname);
    readf(f, mypal[fc], nc * 3);
    closef(f);
}

/* getwibble now comes from DEMO2.CPP, compiled verbatim. */

extern "C" {
UBYTE zmaptab1[256], zmaptab2[256], zmaptab3[256];      /* UTILS.CPP:121-123 */
UBYTE linecol = 64;                                     /* UTILS.CPP:13 */
SLONG edgebuf[200][2];
SLONG squaretab[256];
SLONG reciptab[2049];

LONG findcol(SLONG r, SLONG g, SLONG b) {                /* UTILS.CPP:518-550 */
    if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0;
    r /= 32; g /= 32; b /= 32;
    if (r > 63) r = 63; if (g > 63) g = 63; if (b > 63) b = 63;
    SLONG best = 0, mind = 0x7fffffff;
    for (SLONG i = 0; i < 256; i++) {
        SLONG d = squaretab[abs((SLONG)mypal[i][0] - r)]
                + squaretab[abs((SLONG)mypal[i][1] - g)]
                + squaretab[abs((SLONG)mypal[i][2] - b)];
        if (d < mind) {
            best = i; mind = d;
            if (!d) return i;
        }
    }
    return best;
}

extern int miny, maxy;
int checkfill(void *destv, int col) {                    /* asm1.cpp:1523-1588 */
    if (!destv || maxy <= miny) return -1;
    UBYTE *dest = (UBYTE *)destv;
    int drawn = 0;
    for (int y = miny; y < maxy; y++) {
        int x0 = (int)((ULONG)edgebuf[y][0] >> 16);
        int x1 = (int)((ULONG)edgebuf[y][1] >> 16);
        for (int x = x0; x < x1; x++) {
            UBYTE *p = dest + y * 320 + x;
            if (!*p) { *p = (UBYTE)col; drawn++; }
        }
    }
    return drawn;
}
}

void readfade(unsigned char *fname) {                   /* UTILS.CPP:571-579 */
    LFILE *f = openf(fname);
    readf(f, fadeptr + 256 * 16, 256 * 64);
    for (int c1 = 0; c1 < 16; c1++) memcpy(fadeptr + c1 * 256, fadeptr + 16 * 256, 256);
    for (int c1 = 0; c1 < 64; c1++) memcpy(fadeptr + (80 + c1) * 256, fadeptr + 79 * 256, 256);
    closef(f);
}





/* SHIT.CPP:16-77 — mtab + BILTAB setup and the RadialBlur register shim */
static unsigned char mtab[64 * 256 * 2];
void shit_init(void) {
    unsigned char *moo = mtab;
    for (int i = 0; i < 64; i++)
        for (int c = -256; c < 256; c++)
            *moo++ = (unsigned char)(int)((c * i) / 64.0);
    BILTAB = mtab + 256;
}

static int xTab[320];
static int yTab[200];
void RadialBlur(unsigned char *dest, float fx, float fy, float f, float zoom) {
    int *boo = xTab;
    for (int x = 0; x < 320; x++) {
        float dist = (float)x - fx;
        *boo++ = (int)(dist * 64.0 * zoom);
    }
    boo = yTab;
    for (int y = 0; y < 200; y++) {
        float dist = (float)y - fy;
        *boo++ = (int)(dist * 64.0 * zoom);
    }
    radialblur_call(dest, (int)fx, (int)fy, &f, xTab, yTab);
}

/* ======================================================================= */
/* ixa_main: oldmain's production startup and complete active part order. */
/* ======================================================================= */
extern void testvideo();                                /* DCT.CPP:318 */
extern void dnapart();                                  /* DEMO5.CPP:91 */
extern void brainpart(int end);                         /* DEMO5.CPP:252 */
extern void ronipart();                                 /* DEMO5.CPP:587 */
extern void ronipart2();                                /* DEMO5.CPP:523 */
extern void tunnelpart();                               /* DEMO5.CPP:724 */
extern void cubespart2();                               /* DEMO1.CPP:856 */
extern void title();                                    /* DEMO4.CPP:906 */
extern void spherepart();                               /* DEMO1.CPP:1234 */
extern void cubespart();                                /* DEMO1.CPP:703 */
extern void calcsphere();                               /* DEMO1.CPP:972 */
extern void tub();                                      /* DEMO2.CPP:309 */
extern void makebjorkpath();                            /* BJORK.CPP:175 */
extern void babypart();                                 /* DEMO4.CPP:650 */
extern void calcmap();                                  /* DEMO3.CPP:63 */
extern void tracemap();                                 /* DEMO3.CPP:288 */
extern void runfpath();                                 /* DEMO3.CPP:711 */
extern void loadfont();                                 /* DEMO1.CPP:176 */
extern void init3d();                                   /* DEMO1.CPP:246 */

extern "C" int ixa_main(void) {
    /* Square uses nearly all of the historical 13 MiB part arena. Reserve the
     * SDK heap before openlibf()/calcmap() make the first allocation. The host
     * charges one extra page for an exact page-sized request. */
    if (!ixa_heap_reserve(13u * 1024u * 1024u - 4096u)) return 1;

    if (openlibf((unsigned char *)"square.pak") < 0) return 1;

    /* MAIN.CPP:252: prepare the marching-cubes field before initdemo. */
    calcmap();

    /* initdemo() subset (UTILS.CPP:127-165) */
    texram = new UBYTE[65536 * 10];
    texptr = tex[0] = (UBYTE *)(((SLONG)(texram + 65535)) & 0xffff0000);
    for (int c1 = 1; c1 < 8; c1++) tex[c1] = tex[0] + c1 * 65536;
    fadeptr = tex[7];
    ghostptr = tex[6];
    multab = tex[0] + 8 * 65536;
    UBYTE *b = multab;
    for (int c1 = 0; c1 < 256; c1++)
        for (int c2 = 0; c2 < 256; c2++) {
            int c3 = c1 * c2 / 128;
            if (c3 > 255) c3 = 255;
            *b++ = (UBYTE)c3;
        }
    for (unsigned c1 = 0; c1 < sizeof(noisetab); c1++) noisetab[c1] = (rand() >> 2) & 3;
    for (unsigned c1 = 0; c1 < sizeof(noisetab2); c1++) noisetab2[c1] = (rand() >> 2) & 127;
    for (int c1 = 0; c1 < 256; c1++) squaretab[c1] = c1 * c1;
    for (int c1 = 0; c1 < 2049; c1++) if (c1 != 1024) reciptab[c1] = 65536 / (c1 - 1024);
    calcfocus(128, 100);

    screenbuf = new UBYTE[76800 * 4 + 320 * 16];
    memset(screenbuf, 0, 4 * 76800 + 320 * 16);
    screenbuf += 320 * 8;
    zbuf = new UBYTE[64000 + 320 * 16];
    memset(zbuf, 0, 64000 + 320 * 16);
    zbuf += 320 * 8;

    loadfont();
    init3d();

    /* MAIN.CPP:257,279: finish precalculation before starting the music. */
    tracemap();
    shit_init();
    calcsphere();

    ixa_music_start(squademo_data, squademo_len);
    resetfproc();
    addfproc(faderfproc, 0);

    /* MAIN.CPP:317-369, preserving every active production part. */
    title();
    makebjorkpath();
    spherepart();
    tub();
    cubespart();
    dnapart();
    babypart();
    runfpath();
    tunnelpart();
    ronipart();
    brainpart(CUBES2START);
    cubespart2();
    ronipart2();
    brainpart(TVSTART + 8);

    testvideo();
    return 0;
}
