"""图片：从文件头认格式、读宽高（JPEG 还读拍摄方向），算 sha256，下载封面。只用 Python 自带的模块。

装了 Pillow 时多做两件事（没装照样全程能跑）：逐张真的解码一遍，确认图片没坏；按像素算一个指纹，
同一张图换了元数据也认得出是重复的。环境变量 COVER_NO_PILLOW=1 时当作没装（测试用）。
缩略图不做：报告网页直接用原图副本。
"""
import hashlib
import os
import struct
import urllib.error
import urllib.parse
import urllib.request

from .text import write_bytes

# 报告网页能显示、工作台也能给浏览器看的四种（lib/research.mjs 的 REPORT_MIME 里有）
FORMAT_OF_EXT = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP", ".gif": "GIF"}
EXT_OF_FORMAT = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif"}
# 认得是图片、但报告网页显示不了的：记下来、不纳入
SKIPPED_EXTS = {".heic": "heic", ".heif": "heic", ".bmp": "bmp", ".tif": "tiff", ".tiff": "tiff", ".avif": "avif"}
PHOTO_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".heic")
MAX_DOWNLOAD = 20 * 1024 * 1024
_HEIC_BRANDS = (b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1")


class ImageError(ValueError):
    """图片读不出来：不是图片、文件头坏了、Pillow 解不开。"""


def sniff(data):
    """看文件头认格式：JPEG、PNG、WEBP、GIF、HEIC；认不出返回 None。"""
    if data[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF"
    if data[4:8] == b"ftyp" and data[8:12] in _HEIC_BRANDS:
        return "HEIC"
    return None


def _jpeg(data):
    """JPEG：一段一段往下找 SOF（帧头，里面有宽高）；路过 APP1 的 Exif 时读拍摄方向。"""
    i, orientation, n = 2, 1, len(data)
    while i + 4 <= n:
        if data[i] != 0xFF:
            raise ImageError("JPEG 的文件头坏了")
        marker = data[i + 1]
        if marker == 0xFF:  # 填充字节
            i += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:  # 没有长度的标记
            i += 2
            continue
        if marker in (0xD9, 0xDA):  # 到了图像数据还没有帧头
            break
        length = struct.unpack(">H", data[i + 2:i + 4])[0]
        if length < 2:
            raise ImageError("JPEG 的文件头坏了")
        if marker == 0xE1 and data[i + 4:i + 10] == b"Exif\x00\x00":
            orientation = _exif_orientation(data[i + 10:i + 2 + length]) or orientation
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            if i + 9 > n:
                break
            height, width = struct.unpack(">HH", data[i + 5:i + 9])
            return width, height, orientation
        i += 2 + length
    raise ImageError("JPEG 里找不到宽高")


def _exif_orientation(tiff):
    """Exif（TIFF 格式）第一个目录里 0x0112 那一项：拍摄方向 1 到 8；读不到返回 None。"""
    if len(tiff) < 8 or tiff[:2] not in (b"II", b"MM"):
        return None
    order = "<" if tiff[:2] == b"II" else ">"
    try:
        offset = struct.unpack(order + "I", tiff[4:8])[0]
        count = struct.unpack(order + "H", tiff[offset:offset + 2])[0]
        for k in range(count):
            at = offset + 2 + 12 * k
            tag, kind = struct.unpack(order + "HH", tiff[at:at + 4])
            if tag == 0x0112 and kind == 3:
                value = struct.unpack(order + "H", tiff[at + 8:at + 10])[0]
                return value if 1 <= value <= 8 else None
    except struct.error:
        return None
    return None


def _webp(data):
    kind = data[12:16]
    if kind == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
        width, height = struct.unpack("<HH", data[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if kind == b"VP8L" and data[20:21] == b"\x2f":
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if kind == b"VP8X":
        return int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1
    raise ImageError("WebP 的文件头坏了")


def dimensions(data):
    """(格式, 宽, 高, 拍摄方向)。拍摄方向只有 JPEG 读，别的都当 1（不用转）。"""
    fmt = sniff(data)
    if fmt == "PNG":
        if data[12:16] != b"IHDR" or len(data) < 24:
            raise ImageError("PNG 的文件头坏了")
        width, height = struct.unpack(">II", data[16:24])
        return fmt, width, height, 1
    if fmt == "JPEG":
        width, height, orientation = _jpeg(data)
        return fmt, width, height, orientation
    if fmt == "WEBP":
        width, height = _webp(data)
        return fmt, width, height, 1
    if fmt == "GIF":
        width, height = struct.unpack("<HH", data[6:10])
        return fmt, width, height, 1
    if fmt == "HEIC":
        raise ImageError("heic 格式的图报告网页显示不了")
    raise ImageError("认不出这是什么图片")


def pillow():
    """装了 Pillow 就返回 (Image, ImageOps)，没装（或者 COVER_NO_PILLOW=1）返回 None。"""
    if os.environ.get("COVER_NO_PILLOW") == "1":
        return None
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None
    return Image, ImageOps


def file_info(path):
    """一张图的指纹和尺寸：sha256（文件字节）、格式、宽高、按拍摄方向转过来以后的宽高、字节数；
    装了 Pillow 时再加 pixel_sha256（按像素算的指纹），并真的解码一遍。读不出来抛 ImageError。"""
    with open(path, "rb") as f:
        raw = f.read()
    if not raw:
        raise ImageError("是空文件")
    fmt, width, height, orientation = dimensions(raw)
    if width <= 0 or height <= 0:
        raise ImageError("宽高读出来是 0")
    display = [height, width] if orientation in (5, 6, 7, 8) else [width, height]
    info = {"sha256": hashlib.sha256(raw).hexdigest(), "pixel_sha256": None, "format": fmt,
            "size": [width, height], "display_size": display, "bytes": len(raw)}
    pil = pillow()
    if pil:
        Image, ImageOps = pil
        try:
            with Image.open(path) as image:
                image.load()
                visual = ImageOps.exif_transpose(image).convert("RGBA")
                info["pixel_sha256"] = hashlib.sha256(str(visual.size).encode() + visual.tobytes()).hexdigest()
        except Exception as e:  # Pillow 的各种解码错误
            raise ImageError("Pillow 解不开，图片多半坏了（%s）" % e)
    return info


def image_size(path):
    """只要宽高（转过拍摄方向的）：读不出来返回 None。"""
    try:
        with open(path, "rb") as f:
            head = f.read(256 * 1024)
        fmt, width, height, orientation = dimensions(head)
    except (OSError, ImageError, struct.error):
        return None
    return (height, width) if orientation in (5, 6, 7, 8) else (width, height)


# ---------- 下载封面 ----------

def allowed_url(url):
    """只下 https 的；http 只认本机地址（给测试用）。"""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if parts.scheme == "https":
        return True
    return parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost")


class NetworkError(OSError):
    """连不上网（AI 工具的沙箱不让命令联网、电脑没联网、域名解析不了、超时）：和「链接过期了」分开说。"""


def download(url, dest_base, timeout=20):
    """下载一张图存成 dest_base + 扩展名（扩展名按实际格式）。链接打不开、不是图片返回 None；
    根本连不上网抛 NetworkError（这时后面的也不用再试了）。"""
    if not url or not allowed_url(url):
        return None
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            data = resp.read(MAX_DOWNLOAD + 1)
    except urllib.error.HTTPError:  # 服务器回了话：多半是带签名的链接过期了
        return None
    except (OSError, ValueError) as e:
        raise NetworkError(str(getattr(e, "reason", e) or e))
    if not data or len(data) > MAX_DOWNLOAD:
        return None
    fmt = sniff(data)
    if fmt not in EXT_OF_FORMAT:
        return None
    path = dest_base + EXT_OF_FORMAT[fmt]
    write_bytes(path, data)
    return path
