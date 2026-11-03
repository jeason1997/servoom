# File-level 0x13: multi-tile sand drawing replay

Implemented in `python/servoom/pixel_bean_decoder.py` (`SandMultiDecoder`), synchronized
to `docs/src/python/pixel_bean_decoder.py`, and in `c/src/decoders/fmt19_sand.c`.
This is **not** the 0x13 palette-extension frame type inside a 0x1A container.

## Evidence and semantics

The installed official Android APK's decompiled `T2.b.p(byte[])` reads this container;
`T2.c.D(PixelBean)` writes it. `SandJson.initEveryStep()` describes step compositing,
`p069h3.e.d()` describes playback, and `p024c3.b.n()` maps tile/pixel addresses.
The APK labels it “新多屏沙画”. The implementation follows these operations, not a guess
based on the initial byte. No AES, LZO, zstd, palette or XOR is involved.

## Binary layout

All integers are unsigned; multi-byte integers are big-endian. Offsets include the
format byte:

| Offset | Length | Meaning |
| --- | --- | --- |
| 0 | 1 | 0x13 (decimal 19) |
| 1 | 1 | Number of 16-pixel tile rows R |
| 2 | 1 | Number of 16-pixel tile columns C |
| 3 | 1 | Thumbnail count P; **not** replay frame count |
| 4 | P × R × C × 768 | Raw RGB thumbnails in tile order |
| 4 + P × R × C × 768 | 2 | Delay per replay frame in milliseconds |
| next | 1 | Initial background flag, 0 or 1 |
| next, if flag=1 | R × C × 768 | Initial raw RGB canvas in tile order |
| next | 4 | Number of drawing records S |
| next | variable | Exactly S records, described below |

Each record starts with `[count_flags BE16][red u8][green u8][blue u8]`:

- `count_flags == 0`: paint the entire canvas this color; emit one frame.
- Otherwise, `count = count_flags & 0x7fff`, followed by `count` two-byte addresses
  `[tile u8][pixel u8]`. With bit 15 clear, update and emit **after each address**.
  With bit 15 set (area fill), update every listed address and emit **once**.
  This is an explicit pixel list; do not run a flood-fill algorithm.

Start on black unless an initial background exists; the background itself emits one
frame. Preserve previous pixels across records. If the replay has no frames, return
one black frame. A zero-address area-fill record emits the unchanged canvas.

Tile order is row-major, as is pixel order within a 16×16 tile:

```
x = (tile % C) * 16 + (pixel % 16)
y = (tile / C) * 16 + (pixel / 16)   // integer division
RGB offset in a tiled canvas = (tile * 256 + pixel) * 3
RGB offset in a row-major canvas = (y * C * 16 + x) * 3
```

Readers reject truncated input, dimensions outside 1..16 tiles per axis, invalid
background flags, tile addresses outside R×C, trailing bytes, and expanded animations
over 512 MiB. The latter is a host-side resource limit, not an official format limit.

## Verified real sample

Public sample: https://f.divoom-gz.com/group1/M00/10/29/L1ghblz9PM-EMQPvAAAAAL5g85k.252062

- File size: 77,020 bytes.
- File SHA-256: `c229a9eec4410dc5c35ac2d7c6d48bfa953586d86dc17c2788b48e94ac57e1aa`.
- R=2, C=2, P=24; thumbnail payload ends at offset 73,732.
- Delay=20 ms, no initial background, 43 records: 37 strokes and 6 atomic fills.
- Full replay: 32×32, **268 frames**, 5,360 ms before looping.
- Final colors: black `(0,0,0)`, blue `(0,170,255)`, white `(255,255,255)`.
- All 24 embedded thumbnails match decoded replay states pixel-for-pixel.
- SHA-256 of all row-major RGB frames concatenated:
  `d4225ab0f6b96b7521673fcb3f3da5110c3bfddf112d7f7ae1988466d5bce1d1`.
- CPython, compiled C, and the production Pyodide browser decoder produce that same
  hash. Browser export produced 13,384-byte WebP and 47,443-byte GIF files in this run;
  encoded sizes can vary with library versions.

This verifies the supplied sample and synthetic edge cases; it does not establish
coverage of every historical sand-drawing variant.

## MCU port and memory

The C implementation is C99 and uses no format-specific external codec dependency.
Its existing PixelBean API allocates all output RGB frames, so it is a host reference,
not an appropriate allocation strategy for RP2040. For this sample the output is
823,296 bytes, plus a 3,072-byte working canvas and the input file.

A streaming MCU implementation only needs one RGB canvas (`R*C*768` bytes), a five-byte
record header, and a two-byte address. Seek past thumbnails, read speed and background,
then replay records. Present the canvas and wait `speed` after each normal pixel, after
each atomic fill, and after the initial background when present. Keep the canvas
between steps. At loop end, seek back and reset to the initial background/black.
For 32×32, decoder working RAM is about 3 KiB, excluding display/SD buffers. At 256×256
it is 192 KiB and the display's additional buffers must be budgeted separately.

Do not append the 24 thumbnail frames to the drawing replay; that would duplicate
content and change timing. For thumbnails only, the raw preview section can be read
without parsing the drawing records.

## Reproduce

Download the sample separately (no account or login required), then run from repo root:

```powershell
$env:PYTHONPATH='python'
$env:SERVOOM_FORMAT19_SAMPLE='E:/Projects/Divoom/format13-research/sample.dat'
python -m pytest python/tests/test_format19_sand.py python/tests/test_synthetic_formats.py -q
node docs/scripts/sync-python.mjs
```

Without the sample environment variable, only the real-sample test is skipped.
The C test target is `test_format19`; it tests non-square tile mapping, initial
background, per-pixel strokes, atomic fills, clearing, every truncated prefix, invalid
tile addresses and empty replay. It can also be compiled independently of other codecs:

```sh
cc -std=c99 -Wall -Wextra -Wconversion -Wno-sign-conversion -Werror \
  -fsanitize=address,undefined -ffunction-sections -fdata-sections \
  -I c/src -I c/include c/tests/test_format19.c \
  c/src/decoders/fmt19_sand.c c/src/decoders/common.c \
  -Wl,--gc-sections -o /tmp/test_format19
/tmp/test_format19
```

No RP2040 project or device was modified as part of this implementation.
