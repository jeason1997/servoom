/* File-level 0x13: multi-panel sand drawing replay; no AES/compression.
 * See docs/FORMAT_0x13.md. Keep normal strokes pixel-by-pixel, fills atomic. */
#include "decoders/decoders.h"
#include "util/bytes.h"
#include <stdlib.h>
#include <string.h>

servoom_status sv_decode_fmt19(const uint8_t *data, size_t len, servoom_pixel_bean **out)
{
    *out = NULL;
    if (len < 3 || !data[0] || !data[1] || data[0] > 16 || data[1] > 16)
        return SERVOOM_ERR_CORRUPT;
    int rows = data[0], cols = data[1];
    size_t tiles = (size_t)rows * (size_t)cols, fs = tiles * 768;
    size_t pos = 3 + (size_t)data[2] * fs;
    if (pos > len || len - pos < 3)
        return SERVOOM_ERR_CORRUPT;
    int speed = sv_be16(data + pos), background = data[pos + 2];
    pos += 3;
    if (background > 1 || (background && len - pos < fs))
        return SERVOOM_ERR_CORRUPT;
    const uint8_t *initial = background ? data + pos : NULL;
    if (background) pos += fs;
    if (len - pos < 4) return SERVOOM_ERR_CORRUPT;
    uint32_t steps = sv_be32(data + pos);
    pos += 4;
    size_t start = pos, frames = (size_t)background;
    /* Validate the entire command stream and count output frames before allocating. */
    for (uint32_t step = 0; step < steps; ++step) {
        if (len - pos < 5) return SERVOOM_ERR_CORRUPT;
        unsigned encoded = sv_be16(data + pos), count = encoded & 0x7fff;
        pos += 5;
        if (len - pos < (size_t)count * 2) return SERVOOM_ERR_CORRUPT;
        for (unsigned p = 0; p < count; ++p)
            if ((size_t)data[pos + p * 2] >= tiles) return SERVOOM_ERR_CORRUPT;
        pos += (size_t)count * 2;
        frames += (!encoded || (encoded & 0x8000)) ? 1 : count;
        if (frames > (512u * 1024u * 1024u) / fs) return SERVOOM_ERR_CORRUPT;
    }
    if (pos != len) return SERVOOM_ERR_CORRUPT;
    if (!frames) frames = 1;
    servoom_pixel_bean *bean = sv_bean_new(19, (int)frames, speed, rows, cols);
    uint8_t *canvas = (uint8_t *)calloc(fs, 1);
    if (!bean || !canvas) {
        if (bean) { free(bean->frames); free(bean); }
        free(canvas);
        return SERVOOM_ERR_NOMEM;
    }
    if (initial) sv_compact_frame(initial, fs, rows, cols, canvas);
    size_t index = 0;
    if (background) { memcpy(bean->frames, canvas, fs); index++; }
    pos = start;
    for (uint32_t step = 0; step < steps; ++step) {
        unsigned encoded = sv_be16(data + pos), count = encoded & 0x7fff;
        const uint8_t *color = data + pos + 2;
        pos += 5;
        if (!encoded) {
            for (size_t p = 0; p < fs; p += 3) memcpy(canvas + p, color, 3);
        } else {
            for (unsigned p = 0; p < count; ++p) {
                unsigned tile = data[pos++], pixel = data[pos++];
                size_t x = (tile % (unsigned)cols) * 16 + pixel % 16;
                size_t y = (tile / (unsigned)cols) * 16 + pixel / 16;
                memcpy(canvas + (y * (size_t)cols * 16 + x) * 3, color, 3);
                if (!(encoded & 0x8000)) {
                    memcpy(bean->frames + index * fs, canvas, fs);
                    index++;
                }
            }
        }
        if (!encoded || (encoded & 0x8000)) {
            memcpy(bean->frames + index * fs, canvas, fs);
            index++;
        }
    }
    free(canvas);
    *out = bean;
    return SERVOOM_OK;
}
