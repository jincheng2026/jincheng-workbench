"""图片：不装 Pillow 也能从文件头认格式、读宽高和拍摄方向；装了 Pillow 时多解码一遍；下载只认 https 和本机地址。"""
import hashlib
import os
import shutil
import tempfile
import unittest
from unittest import mock

from support import LocalServer, gif_head, heic_head, jpeg, pillow_here, png, webp_head, write

from cover_kit import images as I


class HeaderTest(unittest.TestCase):
    def test_四种格式都从文件头读出宽高(self):
        self.assertEqual(I.dimensions(png(7, 9)), ("PNG", 7, 9, 1))
        self.assertEqual(I.dimensions(jpeg(30, 40)), ("JPEG", 30, 40, 1))
        self.assertEqual(I.dimensions(gif_head(11, 12)), ("GIF", 11, 12, 1))
        for kind, size in (("VP8", (13, 14)), ("VP8L", (15, 16)), ("VP8X", (17, 18))):
            self.assertEqual(I.dimensions(webp_head(kind, *size)), ("WEBP",) + size + (1,), kind)

    def test_JPEG_读拍摄方向_竖拍的宽高对调(self):
        self.assertEqual(I.dimensions(jpeg(30, 40, orientation=6)), ("JPEG", 30, 40, 6))
        tmp = tempfile.mkdtemp()
        try:
            path = write(os.path.join(tmp, "竖拍.jpg"), jpeg(30, 40, orientation=6))
            with mock.patch.dict(os.environ, {"COVER_NO_PILLOW": "1"}):
                info = I.file_info(path)
            self.assertEqual((info["size"], info["display_size"]), ([30, 40], [40, 30]))
            self.assertEqual(I.image_size(path), (40, 30))
        finally:
            shutil.rmtree(tmp)

    def test_认不出的和坏的都说清楚(self):
        self.assertEqual(I.sniff(heic_head()), "HEIC")
        self.assertIsNone(I.sniff(b"hello world, not an image"))
        with self.assertRaises(I.ImageError):
            I.dimensions(b"hello world, not an image")
        with self.assertRaises(I.ImageError):
            I.dimensions(heic_head())
        with self.assertRaises(I.ImageError):
            I.dimensions(b"\xff\xd8\xff\xe0\x00\x10JFIF")  # 只有开头一段，没有帧头

    def test_没有Pillow_按文件内容算指纹(self):
        tmp = tempfile.mkdtemp()
        try:
            data = png(5, 6)
            path = write(os.path.join(tmp, "a.png"), data)
            with mock.patch.dict(os.environ, {"COVER_NO_PILLOW": "1"}):
                self.assertIsNone(I.pillow())
                info = I.file_info(path)
            self.assertEqual(info["sha256"], hashlib.sha256(data).hexdigest())
            self.assertIsNone(info["pixel_sha256"])
            self.assertEqual((info["format"], info["size"], info["bytes"]), ("PNG", [5, 6], len(data)))
        finally:
            shutil.rmtree(tmp)

    @unittest.skipUnless(pillow_here(), "这台电脑的 Python 没装 Pillow：装了 Pillow 才有的那两项检查跳过")
    def test_装了Pillow_多解码一遍_坏图报出来(self):
        tmp = tempfile.mkdtemp()
        try:
            good = write(os.path.join(tmp, "好.jpg"), jpeg(16, 16))
            info = I.file_info(good)
            self.assertEqual(len(info["pixel_sha256"]), 64)
            broken = write(os.path.join(tmp, "坏.png"), png(8, 8)[:40])  # 文件头完整、图像数据断了
            with self.assertRaises(I.ImageError):
                I.file_info(broken)
            with mock.patch.dict(os.environ, {"COVER_NO_PILLOW": "1"}):
                self.assertIsNone(I.file_info(broken)["pixel_sha256"])  # 没装时只看文件头，照样读得出宽高
        finally:
            shutil.rmtree(tmp)


class DownloadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_只下https和本机地址(self):
        self.assertTrue(I.allowed_url("https://p3.example.com/cover.jpg"))
        self.assertTrue(I.allowed_url("http://127.0.0.1:9/x.png"))
        self.assertFalse(I.allowed_url("http://example.com/cover.jpg"))
        self.assertFalse(I.allowed_url("file:///etc/passwd"))
        self.assertIsNone(I.download("ftp://example.com/x.jpg", os.path.join(self.tmp, "x")))

    def test_按实际格式存_不是图片的不存(self):
        server = LocalServer({"/a": (200, "application/octet-stream", jpeg(16, 16)), "/b": (200, "text/html", b"<html>login</html>"),
                              "/gone": (403, "text/plain", b"expired")})
        try:
            path = I.download(server.base + "/a", os.path.join(self.tmp, "封面"))
            self.assertEqual(os.path.basename(path), "封面.jpg")
            self.assertIsNone(I.download(server.base + "/b", os.path.join(self.tmp, "网页")))
            self.assertIsNone(I.download(server.base + "/gone", os.path.join(self.tmp, "过期")))
            self.assertEqual(sorted(os.listdir(self.tmp)), ["封面.jpg"])
        finally:
            server.close()
        with self.assertRaises(I.NetworkError):  # 服务停了：连不上，不当成链接过期
            I.download(server.base + "/a", os.path.join(self.tmp, "又一张"))


if __name__ == "__main__":
    unittest.main()
