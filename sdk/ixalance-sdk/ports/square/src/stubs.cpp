/* stubs.cpp — platform/editor facilities that production playback does not
 * use. All render-path routines live in the compiled parts or asm1.asm. */
#include "stdafx.h"
#include "common.h"

extern "C" {
/* mouse (UTILS.CPP:604-614 — real ones are stubs in the Win32 port too) */
int mxv, myv, mx, my, mb;
void GetMouseV() {}
void GetMouse() {}

/* DEMO3 camera authoring is not part of playback. */
int flushall() { return 0; }
FILE *fopen(const char *, const char *) { return 0; }
size_t fwrite(const void *, size_t, size_t, FILE *) { return 0; }
int fclose(FILE *) { return 0; }

/* rasterizer state (asm1.cpp:242-246, UTILS.CPP:11) — flattri/flatquad/
 * flatfill/addedge are now real, in asm1.asm */
int miny, maxy;
int cval;
void resetedges() { miny = 200; maxy = 0; }             /* asm1.cpp:686-690 */

/* video-mode helpers: the host owns the mode, so these stay no-ops as in the
 * Win32 port (UTILS.CPP:304-377) */
void tweak(int, int) {}

/* debug/authoring facilities the Win32 port already stubbed out */
void monow(int, unsigned char *) {}                     /* MAIN.CPP:180 */
int fxkeys() { return 0; }                              /* FX.CPP */
void computefade(unsigned char *) {}                    /* offline tool path */
int sprintf(char *buf, const char *, ...) { buf[0] = 0; return 0; }
}
