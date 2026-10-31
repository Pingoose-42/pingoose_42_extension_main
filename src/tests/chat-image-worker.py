#!/usr/bin/env python3
"""Headless tests against the real GJS/GdkPixbuf helper (no Shell or remote peers)."""
import base64
import json
import os
from pathlib import Path
import struct
import subprocess
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[2]
MAX_BYTES = 10 * 1024 * 1024
GJS = os.environ.get("PINGOOSE_TEST_GJS", "gjs")


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def png(width, height, alpha=False, exact_bytes=None):
    channels = 4 if alpha else 3
    color = bytes([32, 170, 110, 128] if alpha else [32, 170, 110])
    compressor = zlib.compressobj()
    row = b"\0" + color * width
    compressed = b"".join(compressor.compress(row) for _ in range(height)) + compressor.flush()
    image = b"\x89PNG\r\n\x1a\n" + chunk(
        b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6 if alpha else 2, 0, 0, 0)
    ) + chunk(b"IDAT", compressed)
    if exact_bytes:
        # A valid ancillary chunk makes the original file exactly the byte limit.
        image += chunk(b"npAD", b"\0" * (exact_bytes - len(image) - 24))
    return image + chunk(b"IEND", b"")


class ImageWorkerTests(unittest.TestCase):
    def jpeg_fixture(self, width, height):
        # Encode our generated PNG through the actual installed JPEG saver.
        # No external fixture, Pillow, display server or extra codec dependency.
        script = """
imports.gi.versions.GdkPixbuf = '2.0';
const { GLib, GdkPixbuf } = imports.gi;
const loader = GdkPixbuf.PixbufLoader.new_with_mime_type('image/png');
loader.write(GLib.base64_decode(ARGV[0]));
loader.close();
const [saved, bytes] = loader.get_pixbuf().save_to_bufferv('jpeg', ['quality'], ['95']);
if (!saved) throw Error('JPEG fixture encoding failed');
print(GLib.base64_encode(bytes));
"""
        result = subprocess.run(
            [GJS, "-c", script, base64.b64encode(png(width, height)).decode("ascii")],
            text=True, capture_output=True, timeout=45, cwd=ROOT,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("CRITICAL", result.stderr)
        contents = base64.b64decode(result.stdout.strip(), validate=True)
        self.assertTrue(contents.startswith(b"\xff\xd8\xff"), "Native saver produced JPEG")
        return contents

    def run_helper(self, contents, mime="image/png", expected_error=None):
        image = {"mime": mime, "size": len(contents), "name": "fixture.png",
                 "data": base64.b64encode(contents).decode("ascii")}
        result = subprocess.run(
            [GJS, str(ROOT / "src/worker/chatImage.js"), "--preview"],
            input=json.dumps(image), text=True, capture_output=True, timeout=45, cwd=ROOT,
        )
        lines = result.stdout.strip().splitlines()
        self.assertTrue(lines, result.stderr)
        response = json.loads(lines[-1])
        if expected_error:
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(response, {"type": "error", "code": expected_error})
            return None
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(response["type"], "result")
        preview = response["value"]
        channels = 4 if preview["alpha"] else 3
        pixels = base64.b64decode(preview["data"], validate=True)
        self.assertGreater(preview["width"], 0)
        self.assertGreater(preview["height"], 0)
        self.assertLessEqual(preview["width"], 256)
        self.assertLessEqual(preview["height"], 192)
        self.assertEqual(preview["rowstride"], preview["width"] * channels)
        self.assertEqual(len(pixels), preview["rowstride"] * preview["height"])
        self.assertNotIn("CRITICAL", result.stderr)
        return preview

    def test_landscape_preserves_ratio(self):
        preview = self.run_helper(png(1024, 256))
        self.assertEqual((preview["width"], preview["height"]), (256, 64))

    def test_portrait_preserves_ratio(self):
        preview = self.run_helper(png(64, 320))
        self.assertEqual((preview["width"], preview["height"]), (38, 192))

    def test_small_image_is_not_upscaled(self):
        preview = self.run_helper(png(7, 3))
        self.assertEqual((preview["width"], preview["height"]), (7, 3))

    def test_alpha_and_tight_rows(self):
        preview = self.run_helper(png(17, 11, alpha=True))
        self.assertTrue(preview["alpha"])
        self.assertEqual(base64.b64decode(preview["data"])[3], 128)

    def test_jpeg_native_encode_and_decode(self):
        preview = self.run_helper(self.jpeg_fixture(32, 12), mime="image/jpeg")
        self.assertEqual((preview["width"], preview["height"]), (32, 12))
        self.assertFalse(preview["alpha"])
        pixel = base64.b64decode(preview["data"])[:3]
        for actual, expected in zip(pixel, (32, 170, 110)):
            self.assertLessEqual(abs(actual - expected), 3, "JPEG retains the source colour")

    def test_jpeg_exif_orientation_six(self):
        contents = self.jpeg_fixture(32, 12)
        # APP1 contains a little-endian TIFF IFD with Orientation=6 (90° CW).
        # The encoded JPEG geometry stays 32x12; only the displayed pixels rotate.
        tiff = b"II" + struct.pack("<HIH", 42, 8, 1)
        tiff += struct.pack("<HHIH", 0x0112, 3, 1, 6) + b"\0\0" + struct.pack("<I", 0)
        exif = b"Exif\0\0" + tiff
        marker = b"\xff\xe1" + struct.pack(">H", len(exif) + 2) + exif
        preview = self.run_helper(contents[:2] + marker + contents[2:], mime="image/jpeg")
        self.assertEqual((preview["width"], preview["height"]), (12, 32))

    def test_small_gif_decodes_without_upscaling(self):
        # A generated 2x1 GIF with two colours. LZW codes (3 bits, LSB first)
        # are clear=4, palette index=0, palette index=1, end=5.
        contents = b"GIF89a" + struct.pack("<HHBBB", 2, 1, 0x80, 0, 0)
        contents += bytes((32, 170, 110, 240, 20, 70))
        contents += b"," + struct.pack("<HHHHB", 0, 0, 2, 1, 0)
        contents += b"\x02\x02\x44\x0a\x00;"
        preview = self.run_helper(contents, mime="image/gif")
        self.assertEqual((preview["width"], preview["height"]), (2, 1))
        channels = 4 if preview["alpha"] else 3
        pixels = base64.b64decode(preview["data"])
        self.assertEqual(pixels[:3], bytes((32, 170, 110)))
        self.assertEqual(pixels[channels:channels + 3], bytes((240, 20, 70)))

    def test_large_dimensions_with_small_file(self):
        preview = self.run_helper(png(5000, 4000))
        self.assertEqual((preview["width"], preview["height"]), (240, 192))

    def test_exact_size_limit(self):
        original = png(64, 48, exact_bytes=MAX_BYTES)
        self.assertEqual(len(original), MAX_BYTES)
        preview = self.run_helper(original)
        self.assertEqual((preview["width"], preview["height"]), (64, 48))

    def test_one_byte_over_limit(self):
        self.run_helper(png(64, 48, exact_bytes=MAX_BYTES + 1), expected_error="invalid-request")

    def test_truncated_png(self):
        self.run_helper(png(64, 48)[:40], expected_error="invalid-image")

    def test_false_mime(self):
        self.run_helper(png(7, 3), mime="image/jpeg", expected_error="invalid-request")

    def test_svg_is_not_accepted(self):
        self.run_helper(b'<svg xmlns="http://www.w3.org/2000/svg"/>',
                        mime="image/svg+xml", expected_error="invalid-request")


if __name__ == "__main__":
    unittest.main(verbosity=2)
