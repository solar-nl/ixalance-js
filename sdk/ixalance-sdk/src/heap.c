/* heap.c — a real allocator over the host's part-memory arena.
 *
 * The host only offers a bump allocator (farmalloc), and it never frees: the
 * whole arena is reclaimed between parts. That is fine for a guest that
 * allocates a handful of buffers up front, and useless for one that churns
 * short-lived meshes and textures — it would walk off the end of the arena.
 *
 * So the SDK reserves one large block from the host and manages it here as an
 * implicit block list with first-fit allocation and bidirectional coalescing.
 * Lifted from the pre-SDK Square port, where it carried the whole production,
 * with the arena size made a guest decision.
 *
 * An implicit list (walk the blocks, no side table) is the right trade here:
 * allocation volume in a demo part is low, and guest memory spent on allocator
 * bookkeeping is memory not spent on textures.
 */

#include "ixalance.h"

void *ixa_host_malloc(unsigned bytes);

void *ixa_partmem(unsigned bytes) { return ixa_host_malloc(bytes); }

typedef struct {
    uint32_t size;              /* whole block including this header */
    uint32_t used;
    uint32_t magic;
    uint32_t reserved;          /* keeps the header 16-byte aligned */
} block;

#define MAGIC 0x49584131u       /* "IXA1" */

static unsigned char *base;
static uint32_t arena;

int ixa_heap_reserve(unsigned bytes)
{
    block *b;
    if (base) return 0;                         /* already reserved */
    if (bytes < sizeof(block) + 16) return 0;

    base = (unsigned char *)ixa_host_malloc(bytes);
    if (!base) return 0;
    arena = bytes;

    b = (block *)base;
    b->size = arena;
    b->used = 0;
    b->magic = MAGIC;
    b->reserved = 0;
    return 1;
}

static void heap_init(void)
{
    if (!base) ixa_heap_reserve(IXA_HEAP_DEFAULT_BYTES);
}

/* Carve `want` bytes off the front of b, if the remainder is worth tracking. */
static void split(block *b, uint32_t want)
{
    block *tail;
    if (b->size < want + sizeof(block) + 16) return;
    tail = (block *)((unsigned char *)b + want);
    tail->size = b->size - want;
    tail->used = 0;
    tail->magic = MAGIC;
    tail->reserved = 0;
    b->size = want;
}

/* Absorb every free block immediately following b. */
static void join_next(block *b)
{
    unsigned char *next = (unsigned char *)b + b->size;
    while (next < base + arena) {
        block *n = (block *)next;
        if (n->magic != MAGIC || n->used) break;
        b->size += n->size;
        next = (unsigned char *)b + b->size;
    }
}

static uint32_t round_up(size_t n)
{
    return ((uint32_t)n + (uint32_t)sizeof(block) + 15u) & ~15u;
}

void *malloc(size_t n)
{
    unsigned char *p;
    uint32_t want;

    heap_init();
    if (!base) return 0;
    if (!n) n = 4;
    if (n > arena - sizeof(block) - 15) return 0;
    want = round_up(n);

    for (p = base; p < base + arena; ) {
        block *b = (block *)p;
        if (b->magic != MAGIC || b->size < sizeof(block)) ixa_exit();  /* corrupt */
        if (!b->used) {
            join_next(b);
            if (b->size >= want) {
                split(b, want);
                b->used = 1;
                return b + 1;
            }
        }
        p += b->size;
    }
    return 0;
}

void *calloc(size_t count, size_t size)
{
    size_t total = count * size;
    void *p;
    if (count && total / count != size) return 0;       /* overflow */
    p = malloc(total);
    if (p) memset(p, 0, total);
    return p;
}

void free(void *p)
{
    block *b, *prev = 0;
    unsigned char *q;

    if (!p) return;
    b = (block *)p - 1;
    if (!base || (unsigned char *)b < base || (unsigned char *)b >= base + arena
        || b->magic != MAGIC) {
        ixa_exit();
    }
    b->used = 0;
    join_next(b);

    /* Coalesce backwards too, or a free/alloc cycle fragments the arena into
     * unusable slivers. Finding the predecessor means walking from the start,
     * which an implicit list makes unavoidable and cheap enough here. */
    for (q = base; q < (unsigned char *)b; ) {
        block *cur = (block *)q;
        if (cur->magic != MAGIC || !cur->size) ixa_exit();
        prev = cur;
        q += cur->size;
    }
    if (prev && !prev->used) join_next(prev);
}

void *realloc(void *p, size_t n)
{
    block *b;
    uint32_t old, want;
    void *q;

    if (!p) return malloc(n);
    if (!n) { free(p); return 0; }

    b = (block *)p - 1;
    if (b->magic != MAGIC || !b->used) ixa_exit();
    old = b->size - (uint32_t)sizeof(block);
    want = round_up(n);

    if (want <= b->size) { split(b, want); return p; }

    /* Grow in place if the next block is free and big enough. */
    {
        unsigned char *next = (unsigned char *)b + b->size;
        if (next < base + arena) {
            block *nb = (block *)next;
            if (nb->magic == MAGIC && !nb->used && b->size + nb->size >= want) {
                b->size += nb->size;
                split(b, want);
                return p;
            }
        }
    }

    q = malloc(n);
    if (!q) return 0;
    memcpy(q, p, old < n ? old : n);
    free(p);
    return q;
}
