/* common.h substitute for the iXalance port.
 *
 * Mirrors the original common.h but swaps the Win32/DOS system headers for a
 * freestanding SDK prelude, then includes the ORIGINAL demo headers (coords.h,
 * sync.h, stuff.h, demo1.h — found via -I into the original source tree) so
 * every demo-side declaration is the 1997 one. */
#ifndef PORT_COMMON_H
#define PORT_COMMON_H

#include <ixalance.h>

typedef unsigned char  UBYTE;
typedef signed char    SBYTE;
typedef unsigned char  BYTE;
typedef unsigned short UWORD;
typedef signed short   SWORD;
typedef unsigned short WORD;
typedef unsigned int   ULONG;
typedef signed int     SLONG;
typedef signed int     LONG;
typedef unsigned int   UDWORD;
typedef signed int     SDWORD;
#ifndef NULL
#define NULL 0
#endif

#define CHAR unsigned char
#define VOID void
#define PI 3.14159265493
#define SQR(x) ((x)*(x))
#define CALLBACK

/* ---- legacy facilities not supplied by the SDK ----------------------- */
typedef struct FILE_opaque FILE;    /* stuff.h's LFILE carries a FILE*; opaque here */
extern "C" {
void exit(int code);
int printf(const char *fmt, ...);
int kbhit(void);
int getch(void);
int flushall(void);

/* DEMO3's camera-path authoring helpers are linked but unreachable during
 * playback. Their write-side stdio calls are inert in this port. */
FILE *fopen(const char *name, const char *mode);
size_t fwrite(const void *ptr, size_t size, size_t count, FILE *stream);
int fclose(FILE *stream);

int sprintf(char *buf, const char *fmt, ...);

void UpdateInfo(void);
}

#include "coords.h"
#include "sync.h"

#ifdef __cplusplus
extern "C" {
#endif

extern unsigned char winpal[256][4];
extern unsigned char wina000[480][320];
extern void xcopy(int yofs, unsigned char *src, int numy);
extern void CopyPal2Screen(unsigned char *src, int numy);
extern void clearblurborder(void *dest);
extern void noisefadeblack(void *destsrc, unsigned char *yshades, int seed);

#include "stuff.h"
#include "demo1.h"

extern void setspherehandoff(CAM *cam, float scale);
extern int takespherehandoff(CAM *cam);
extern float spherehandoffscale(void);

#ifdef __cplusplus
}
#endif

#endif
