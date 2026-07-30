/* time.c — the host tick accumulator, wall clock, and music sync.
 *
 * The host does not hand the guest a clock; it hands it `herzcount`, an int in
 * shared memory that the host increments and the guest is expected to zero.
 * Every original part follows that read-then-zero protocol, and the counter
 * only advances when the guest gives the host a chance to run — which means a
 * loop that never calls ixa_show()/ixa_poll() sees time stand still.
 *
 * The rate is not fixed. It is 70 Hz until the guest starts music through
 * fardoint('TBL1'), at which point the host raises it to 140 Hz
 * (lib/machine.js:314) so a music-driven part gets finer resolution. Guests
 * that divide by a hardcoded 70 run at half speed for the entire soundtrack.
 * ixa_seconds() folds the rate change in as it happens.
 */

#include "ixalance.h"

extern volatile int *ixa_herzcount;
extern volatile unsigned char *ixa_mustime;

void ixa_host_basic(void);
unsigned ixa_host_doint(unsigned code, const void *ptr, unsigned len);

#define TBL1 0x54424C31u        /* start XM  */
#define TBL3 0x54424C33u        /* position  */

static unsigned tick_rate = 70;
static double elapsed;

/* The single place the host counter is consumed, so the wall clock can never
 * disagree with what callers were told. */
static int drain(void)
{
    int dt = *ixa_herzcount;
    *ixa_herzcount = 0;
    if (dt < 0) dt = 0;                 /* the host clamps, but be defensive */
    elapsed += (double)dt / (double)tick_rate;
    return dt;
}

int ixa_ticks(void) { return drain(); }

unsigned ixa_tick_rate(void) { return tick_rate; }

double ixa_seconds(void) { return elapsed; }

void ixa_tick_update(void)
{
    ixa_host_basic();
    drain();
}

void ixa_music_start(const void *xm, unsigned length)
{
    ixa_host_doint(TBL1, xm, length);
    /* The host bumps its timer to 140 Hz as part of servicing TBL1; mirror
     * that here so ixa_seconds() keeps converting correctly from now on. */
    tick_rate = 140;
}

unsigned ixa_music_order(void) { return ixa_mustime[0]; }
unsigned ixa_music_row(void)   { return ixa_mustime[1]; }

unsigned ixa_music_pos(void) { return ixa_host_doint(TBL3, 0, 0); }
