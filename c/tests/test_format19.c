/* Standalone format-19 tests; can also compile with just fmt19_sand.c/common.c. */
#include "decoders/decoders.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>

static void release(servoom_pixel_bean *b) { free(b->frames); free(b); }

int main(void)
{
    /* Body after 0x13: 1x2 tiles, one thumbnail, 20 ms, initial RGB(10,20,30). */
    uint8_t data[3 + 1536 + 3 + 1536 + 4 + 9 + 9 + 5] = {1, 2, 1};
    size_t pos = 3 + 1536;
    data[pos++] = 0; data[pos++] = 20; data[pos++] = 1;
    for (size_t i = 0; i < 1536; i += 3) {
        data[pos + i] = 10; data[pos + i + 1] = 20; data[pos + i + 2] = 30;
    }
    pos += 1536;
    data[pos + 3] = 3; pos += 4;
    const uint8_t commands[] = {
        0,2,255,1,2,0,0,1,255,       /* two individually visible pixels */
        128,2,3,4,250,0,17,1,17,     /* two pixels, one atomic fill frame */
        0,0,7,8,9                    /* full canvas clear */
    };
    memcpy(data + pos, commands, sizeof commands);
    servoom_pixel_bean *b = NULL;
    assert(sv_decode_fmt19(data, sizeof data, &b) == SERVOOM_OK);
    assert(b && b->width == 32 && b->height == 16 && b->total_frames == 5 && b->speed == 20);
    size_t fs = 1536;
    assert(memcmp(b->frames, "\x0a\x14\x1e", 3) == 0);
    assert(memcmp(b->frames + fs, "\xff\x01\x02", 3) == 0);
    assert(memcmp(b->frames + 2 * fs - 3, "\x0a\x14\x1e", 3) == 0);
    assert(memcmp(b->frames + 3 * fs - 3, "\xff\x01\x02", 3) == 0);
    assert(memcmp(b->frames + 3 * fs + (32 + 1) * 3, "\x03\x04\xfa", 3) == 0);
    assert(memcmp(b->frames + 3 * fs + (32 + 17) * 3, "\x03\x04\xfa", 3) == 0);
    for (size_t i = 0; i < fs; i += 3)
        assert(memcmp(b->frames + 4 * fs + i, "\x07\x08\x09", 3) == 0);
    release(b);
    /* Every prefix is truncated, and invalid tiles cannot write out of bounds. */
    for (size_t i = 0; i < sizeof data; ++i) {
        b = NULL;
        assert(sv_decode_fmt19(data, i, &b) == SERVOOM_ERR_CORRUPT && !b);
    }
    data[pos + 5] = 2;
    assert(sv_decode_fmt19(data, sizeof data, &b) == SERVOOM_ERR_CORRUPT && !b);
    const uint8_t empty[] = {1,1,0,0,20,0,0,0,0,0};
    assert(sv_decode_fmt19(empty, sizeof empty, &b) == SERVOOM_OK);
    assert(b->total_frames == 1 && b->frames[0] == 0);
    release(b);
    return 0;
}
