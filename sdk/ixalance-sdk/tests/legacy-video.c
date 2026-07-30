/* One-frame guest for native-driver display negotiation regressions. */
#include <ixalance.h>

static uint32_t pixels[2] = {
    0x00ff0000u,       /* red   */
    0x0000ff00u        /* green */
};

int ixa_main(void)
{
    ixa_canvas canvas;
    ixa_canvas_init(&canvas, pixels, 2, 1, IXA_ARGB32);
    ixa_present(&canvas);
    return 0;
}
