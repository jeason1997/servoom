"""File-level 0x13 drawing replay, distinct from 0x1A frame type 0x13."""
import io
import struct
import hashlib
import os
from pathlib import Path
from PIL import Image, ImageSequence

import numpy as np
import pytest

from servoom.pixel_bean_decoder import PixelBeanDecoder


def drawing(records, background=None):
    # Non-square 1x2 canvas tests tile-to-canvas mapping as well as RGB order.
    return (bytes([19, 1, 2, 1]) + bytes(1536) + struct.pack('>H', 20)
            + bytes([background is not None]) + (background or b'')
            + struct.pack('>I', len(records)) + b''.join(records))


def record(count, color, positions=b''):
    return struct.pack('>H', count) + bytes(color) + positions


def decode(data):
    return PixelBeanDecoder.decode_stream(io.BytesIO(data))


def test_stroke_fill_clear_and_background():
    data = drawing([
        record(2, (255, 1, 2), bytes([0, 0, 1, 255])),
        record(0x8002, (3, 4, 250), bytes([0, 17, 1, 17])),
        record(0, (7, 8, 9)),
    ], background=bytes([10, 20, 30]) * 512)
    bean = decode(data)
    assert (bean.width, bean.height, bean.speed, bean.total_frames) == (32, 16, 20, 5)
    frames = bean.frames_data
    assert frames[0][0, 0].tolist() == [10, 20, 30]
    assert frames[1][0, 0].tolist() == [255, 1, 2]
    assert frames[1][15, 31].tolist() == [10, 20, 30]
    assert frames[2][15, 31].tolist() == [255, 1, 2]
    assert frames[3][1, 1].tolist() == frames[3][1, 17].tolist() == [3, 4, 250]
    assert np.all(frames[4] == [7, 8, 9])
    assert frames[0][0, 0].tolist() == [10, 20, 30]  # snapshots are independent


def test_empty_replay_is_one_black_frame():
    bean = decode(drawing([]))
    assert bean.total_frames == 1 and not bean.frames_data[0].any()


@pytest.mark.parametrize('mutate', [
    lambda d: d[:-1],
    lambda d: d + b'\x00',
    lambda d: bytes([19, 0]) + d[2:],
    lambda d: d[:-2] + bytes([2, 0]),  # tile 2 outside the 1x2 canvas
])
def test_invalid_data_is_rejected(mutate):
    data = drawing([record(1, (1, 2, 3), bytes([0, 0]))])
    with pytest.raises(ValueError):
        decode(mutate(data))


@pytest.mark.skipif(not os.environ.get('SERVOOM_FORMAT19_SAMPLE'), reason='optional real sample')
def test_real_sample_pixels_timing_and_embedded_previews():
    data = Path(os.environ['SERVOOM_FORMAT19_SAMPLE']).read_bytes()
    assert hashlib.sha256(data).hexdigest() == 'c229a9eec4410dc5c35ac2d7c6d48bfa953586d86dc17c2788b48e94ac57e1aa'
    bean = decode(data)
    assert (bean.width, bean.height, bean.total_frames, bean.speed) == (32, 32, 268, 20)
    assert hashlib.sha256(b''.join(f.tobytes() for f in bean.frames_data)).hexdigest() == 'd4225ab0f6b96b7521673fcb3f3da5110c3bfddf112d7f7ae1988466d5bce1d1'
    # Independent on-disk RGB thumbnails corroborate colors, tile order and states.
    previews = (np.frombuffer(data[4:73732], np.uint8)
                .reshape(24, 2, 2, 16, 16, 3).transpose(0, 1, 3, 2, 4, 5)
                .reshape(24, 32, 32, 3))
    assert all(any(np.array_equal(p, f) for f in bean.frames_data) for p in previews)
    # Exporters may merge repeated frames; compare the complete pixel timeline.
    for exporter in (bean.save_to_gif, bean.save_to_webp):
        output = io.BytesIO()
        exporter(output)
        output.seek(0)
        image = Image.open(output)
        index = 0
        for frame in ImageSequence.Iterator(image):
            rgb = np.asarray(frame.convert('RGB'))  # load before reading WebP duration
            duration = frame.info['duration']
            assert duration % bean.speed == 0
            for _ in range(duration // bean.speed):
                assert np.array_equal(rgb, bean.frames_data[index])
                index += 1
        assert index == bean.total_frames
