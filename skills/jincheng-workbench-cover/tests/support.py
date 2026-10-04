"""测试用的小工具：假的家目录和工作台设置、现造的小图片、只听 127.0.0.1 的小服务、跑命令。

所有测试都在系统临时文件夹里造假的家目录和工作文件夹，不碰真实的设置、照片和 ~/.codex；
图片全是测试代码现造的纯色图和三色条纹图（裁图测试用），仓库里不放任何真实图片；小服务只监听 127.0.0.1，不连外网。
"""
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
SCRIPTS = os.path.join(SKILL, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)


# ---------- 现造图片 ----------

def png(width, height, color=(200, 60, 60)):
    """一张纯色 PNG（真的能解码）。"""
    raw = b"".join(b"\x00" + bytes(color) * width for _ in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def jpeg(width, height, orientation=None):
    """一张灰色的基线 JPEG（真的能解码）：每个 8×8 块只有一个为 0 的直流系数。
    霍夫曼表只放用得到的两个符号（直流的「0 类」、交流的「块结束」），各一位码。orientation 给了就带一段 Exif 写拍摄方向。"""
    def seg(marker, payload):
        return b"\xff" + bytes([marker]) + struct.pack(">H", len(payload) + 2) + payload

    out = b"\xff\xd8" + seg(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")
    if orientation:
        tiff = b"MM\x00\x2a" + struct.pack(">I", 8) + struct.pack(">H", 1) + struct.pack(">HHIHH", 0x0112, 3, 1, orientation, 0) + struct.pack(">I", 0)
        out += seg(0xE1, b"Exif\x00\x00" + tiff)
    out += seg(0xDB, b"\x00" + bytes([1] * 64))
    out += seg(0xC0, struct.pack(">BHHB", 8, height, width, 1) + b"\x01\x11\x00")
    one_code = bytes([1] + [0] * 15)
    out += seg(0xC4, b"\x00" + one_code + b"\x00")  # 直流表 0：只有「0 类」，码是 0
    out += seg(0xC4, b"\x10" + one_code + b"\x00")  # 交流表 0：只有「块结束」，码是 0
    out += seg(0xDA, b"\x01\x01\x00\x00\x3f\x00")
    blocks = math.ceil(width / 8.0) * math.ceil(height / 8.0)
    bits = "00" * blocks
    bits += "1" * (-len(bits) % 8)
    data = bytes(int(bits[i:i + 8], 2) for i in range(0, len(bits), 8))
    return out + data + b"\xff\xd9"


def banded_png(width, height, band, vertical=False):
    """一张三色条纹的 PNG（真的能解码）：上下（vertical 时是左右）各 band 像素宽的红条和蓝条，中间是绿的。
    从中间裁掉的多于 band 时，裁出来的应该整张是绿的；裁偏了就会带上红或蓝。"""
    red, green, blue = (255, 0, 0), (0, 255, 0), (0, 0, 255)
    if vertical:
        row = b"\x00" + bytes(red) * band + bytes(green) * (width - 2 * band) + bytes(blue) * band
        raw = row * height
    else:
        raw = b"".join(b"\x00" + bytes(red if y < band else blue if y >= height - band else green) * width for y in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def png_pixels(data):
    """读一张 8 位、不隔行的 PNG（灰、RGB、RGBA 都行）：返回 (宽, 高, 取色函数 pixel(x, y) → (r, g, b))。
    只用 Python 自带的 zlib 解五种行过滤；给裁图测试看 sips 裁出来的图是不是从中间裁的。"""
    pos, idat, info = 8, b"", None
    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            info = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    width, height, depth, color, _c, _f, interlace = info
    if depth != 8 or interlace:
        raise ValueError("只认 8 位、不隔行的 PNG（这张是 %d 位、隔行 %d）" % (depth, interlace))
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[color]
    stride = width * channels
    raw = zlib.decompress(idat)
    rows, prev, i = [], bytearray(stride), 0
    for _ in range(height):
        kind, line = raw[i], bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            a = line[x - channels] if x >= channels else 0
            b = prev[x]
            c = prev[x - channels] if x >= channels else 0
            if kind == 1:
                line[x] = (line[x] + a) & 255
            elif kind == 2:
                line[x] = (line[x] + b) & 255
            elif kind == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif kind == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(bytes(line))
        prev = line

    def pixel(x, y):
        cell = rows[y][x * channels:(x + 1) * channels]
        return (cell[0],) * 3 if channels < 3 else tuple(cell[:3])

    return width, height, pixel


def gif_head(width, height):
    """只有文件头的 GIF（只用来测读宽高）。"""
    return b"GIF89a" + struct.pack("<HH", width, height) + b"\x00\x00\x00"


def webp_head(kind, width, height):
    """只有文件头的 WebP（只用来测读宽高）：kind 是 VP8、VP8L、VP8X。"""
    if kind == "VP8":
        body = b"\x00\x00\x00" + b"\x9d\x01\x2a" + struct.pack("<HH", width, height)
        chunk = b"VP8 "
    elif kind == "VP8L":
        bits = (width - 1) | ((height - 1) << 14)
        body = b"\x2f" + bits.to_bytes(4, "little")
        chunk = b"VP8L"
    else:
        body = b"\x00\x00\x00\x00" + (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little")
        chunk = b"VP8X"
    payload = chunk + struct.pack("<I", len(body)) + body
    return b"RIFF" + struct.pack("<I", len(payload) + 4) + b"WEBP" + payload


def heic_head():
    return b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic"


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb" if isinstance(data, bytes) else "w") as f:
        f.write(data)
    return path


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


# ---------- 假的家目录 ----------

class TempWorkbench(object):
    """一个假的家目录：工作台设置指向里面的工作文件夹，位置全按默认（和 lib/config.mjs 一样）。"""

    def __init__(self, ports=None, paths=None):
        self.home = tempfile.mkdtemp(prefix="cover-skill-test-")
        self.config_dir = os.path.join(self.home, "config")
        self.work = os.path.join(self.home, "Documents", "工作文件夹")
        os.makedirs(self.config_dir)
        os.makedirs(os.path.join(self.work, "内容草稿"))
        settings = {"workFolder": self.work}
        if ports:
            settings["ports"] = ports
        if paths:
            settings["paths"] = paths
        self.write_settings(settings)
        self.drafts = os.path.join(self.work, "内容草稿")
        self.assets = os.path.join(self.work, "封面素材")
        self.accounts = os.path.join(self.work, "市场调研", "对标账号")
        self.reports = os.path.join(self.work, "市场调研", "调研报告")
        self.codex = os.path.join(self.home, "codex-home")
        self.locked = []

    @property
    def settings_file(self):
        return os.path.join(self.config_dir, "config.json")

    def write_settings(self, settings):
        with open(os.path.join(self.config_dir, "config.json"), "w", encoding="utf-8") as f:
            json.dump(settings, f, ensure_ascii=False)

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("COVER_", "CODEX_"))}
        env.update({"HOME": self.home, "WORKBENCH_CONFIG_DIR": self.config_dir, "PYTHONDONTWRITEBYTECODE": "1",
                    "CODEX_HOME": self.codex})
        env.update({k: v for k, v in extra.items() if v is not None})
        return env

    def topic(self, cid, title, kind="口播"):
        """一张选题卡：选题库/<类型>/待做/T002_….md"""
        return write(os.path.join(self.work, "选题库", kind, "待做", "%s_%s.md" % (cid, title.replace(" ", ""))),
                     "# %s %s\n\n- **来源**：自己的想法\n" % (cid, title))

    def draft(self, cid, name):
        folder = os.path.join(self.drafts, "%s_%s" % (cid, name))
        os.makedirs(os.path.join(folder, "封面候选"), exist_ok=True)
        return folder

    def style_folder(self, name, images, created="2026-10-04T20:30:00+08:00"):
        """工作台在「封面」页建的一组放进来的图：封面素材/风格/<name>/封面/ 里按原文件名放图，再写 风格.json。
        images：{原文件名: 图片字节}。返回文件夹。"""
        folder = os.path.join(self.assets, "风格", name)
        for filename, data in images.items():
            write(os.path.join(folder, "封面", filename), data)
        write(os.path.join(folder, "风格.json"), json.dumps({"from": "放进来的图", "createdAt": created, "count": len(images)}, ensure_ascii=False))
        return folder

    def photo(self, name, data, minutes_ago=0):
        """放一张照片进「人物参考图片」，修改时间往前拨 minutes_ago 分钟（照片按放进来的先后排，就是按这个时间）。"""
        import time
        path = write(os.path.join(self.assets, "人物参考图片", name), data)
        stamp = time.time() - minutes_ago * 60
        os.utime(path, (stamp, stamp))
        return path

    def account(self, folder_name, account_name=None, works=None):
        """一个对标账号文件夹：档案.json（调研 Skill 的格式），works 给了再写 作品.json。"""
        folder = os.path.join(self.accounts, folder_name)
        os.makedirs(folder, exist_ok=True)
        platform, _, name = folder_name.partition("-")
        profile = {"platform": platform, "account_name": account_name or name, "url": "", "note": "", "tags": [],
                   "updated_at": "2026-10-04T10:00:00+08:00", "source": "manual"}
        write(os.path.join(folder, "档案.json"), json.dumps(profile, ensure_ascii=False))
        if works is not None:
            write(os.path.join(folder, "作品.json"), json.dumps({"platform": platform, "account_name": name, "works": works}, ensure_ascii=False))
        return folder

    def lock(self, folder, mode):
        os.chmod(folder, mode)
        self.locked.append(folder)

    def cleanup(self):
        for folder in self.locked:  # 改回能读写，临时文件夹才删得掉
            try:
                os.chmod(folder, 0o755)
            except OSError:
                pass
        shutil.rmtree(self.home, ignore_errors=True)

    def all_text(self, folder):
        chunks = []
        for root, _dirs, files in os.walk(folder):
            for name in files:
                with open(os.path.join(root, name), "rb") as f:
                    chunks.append(f.read().decode("utf-8", "replace"))
        return "\n".join(chunks)


def run_cli(args, env, cwd=None):
    """像 AI 那样在终端里跑命令，返回 (退出码, 输出)。"""
    done = subprocess.run([sys.executable, os.path.join(SCRIPTS, "cover.py")] + list(args), env=env, cwd=cwd,
                          capture_output=True, text=True, timeout=120)
    return done.returncode, done.stdout + done.stderr


def sips_here():
    """这台电脑上有没有 sips（macOS 自带的图片工具）：裁图的测试要真的用它。"""
    return bool(shutil.which("sips") or os.path.isfile("/usr/bin/sips"))


NO_SIPS = "这台电脑上没有 sips（macOS 自带的图片工具，别的系统没有）：真的裁图的测试跳过；没有 sips 时说清楚的那一条照样跑"


def pillow_here():
    """这个测试进程里能不能用 Pillow（直接调函数的测试看这个）。"""
    try:
        from PIL import Image, ImageOps  # noqa: F401
    except ImportError:
        return False
    return True


_CLI_PILLOW = []


def pillow_in_cli():
    """用假的家目录跑命令时能不能用 Pillow（跑 cover.py 的测试看这个）：
    装在「用户自己的 site-packages」里的 Pillow 跟着家目录走，换了家目录就找不到了。"""
    if not _CLI_PILLOW:
        home = tempfile.mkdtemp(prefix="cover-skill-pillow-")
        try:
            env = {k: v for k, v in os.environ.items() if not k.startswith("COVER_")}
            env["HOME"] = home
            done = subprocess.run([sys.executable, "-c", "from PIL import Image, ImageOps"], env=env, capture_output=True, timeout=60)
            _CLI_PILLOW.append(done.returncode == 0)
        finally:
            shutil.rmtree(home, ignore_errors=True)
    return _CLI_PILLOW[0]


# ---------- 只听 127.0.0.1 的小服务 ----------

class LocalServer(object):
    """在 127.0.0.1 上起一个小服务。routes：{路径: (状态码, 内容类型, 字节)}。记下每次请求的路径。"""

    def __init__(self, routes=None):
        self.routes = dict(routes or {})
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                outer.requests.append({"path": self.path, "host": self.headers.get("Host")})
                status, kind, data = outer.routes.get(self.path.split("?")[0], (404, "text/plain", b"not found"))
                if callable(data):
                    data = data(self.headers)
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", kind)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.base = "http://127.0.0.1:%d" % self.port
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
