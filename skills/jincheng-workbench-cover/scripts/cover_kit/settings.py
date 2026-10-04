"""封面素材/封面设置.json：默认照片、默认对标、一批几张。工作台和这个 Skill 都会写它（约定见 docs/开发记录.md「封面 Skill」）。

{ "photo": "我的照片/正脸.jpg", "benchmark": "抖音-某某", "batchSize": 10 }

- photo：相对「封面素材」的路径；没设是 null。benchmark：对标账号文件夹名；没设是 null。batchSize：一批默认几张，默认 10。
- 文件不存在等于三项都没设、一批 10 张。写的时候整份读出来、改一项、先写临时文件再换过去，不认识的键原样留着。
"""
import hashlib
import json
import os
import shutil
from collections import OrderedDict

from . import UserError
from . import images as I
from .text import read_bytes, read_json, update_text

FILE = "封面设置.json"
PHOTO_DIR = "我的照片"
FAV_DIR = "收藏"
DEFAULT_BATCH = 10
MAX_BATCH = 30  # 对标原图最多拆 30 张；一批再多，只能反复用同几张构图
VI_FILE = "VI拆解.md"
STYLE_PREFIX = "风格名："


def path(places):
    return os.path.join(places["cover_assets"], FILE)


def read(places):
    """读封面设置。返回 {"file", "exists", "raw", "photo", "benchmark", "batch_size", "problems"}：
    raw 是文件里的原样（保留键的先后），后三项是整理好的值；某一项写得不对按没设（一批 10 张）处理，并记进 problems。
    文件写坏了（不是合法的 JSON）直接报错，不悄悄当成没设。"""
    file = path(places)
    out = {"file": file, "exists": os.path.isfile(file), "raw": OrderedDict(), "photo": None, "benchmark": None,
           "batch_size": DEFAULT_BATCH, "problems": []}
    if not out["exists"]:
        return out
    try:
        raw = read_json(file)
    except ValueError as e:
        raise UserError("封面设置写坏了，不是合法的 JSON：%s（%s）。改好它再试；或者把它挪进回收站，照片、默认对标就都按没设算。" % (file, e))
    except OSError as e:
        raise UserError("读不出封面设置 %s：%s" % (file, e))
    if not isinstance(raw, dict):
        out["problems"].append("最外层应该是 { … }，按三项都没设处理")
        return out
    out["raw"] = raw
    photo, benchmark, batch = raw.get("photo"), raw.get("benchmark"), raw.get("batchSize", DEFAULT_BATCH)
    if isinstance(photo, str) and photo.strip():
        out["photo"] = photo.strip()
    elif photo is not None:
        out["problems"].append("photo 应该是一个路径或者 null，按没设处理")
    if isinstance(benchmark, str) and benchmark.strip():
        out["benchmark"] = benchmark.strip()
    elif benchmark is not None:
        out["problems"].append("benchmark 应该是对标账号文件夹名或者 null，按没设处理")
    if isinstance(batch, int) and not isinstance(batch, bool) and batch >= 1:
        out["batch_size"] = batch
    else:
        out["problems"].append("batchSize 应该是不小于 1 的整数，按 10 张处理")
    return out


def update(places, key, value):
    """改一项：整份读出来、改这一项、写回（先写临时文件再换过去）；别的键原样。写完读回来核对。"""
    file = path(places)

    def change(old):
        if old.strip():
            try:
                data = json.loads(old, object_pairs_hook=OrderedDict)
            except ValueError as e:
                raise UserError("封面设置写坏了，不是合法的 JSON：%s（%s）。改好它再试。" % (file, e))
            if not isinstance(data, dict):
                raise UserError("封面设置的最外层应该是 { … }：%s。改好它再试。" % file)
        else:
            data = OrderedDict([("photo", None), ("benchmark", None), ("batchSize", DEFAULT_BATCH)])
        data[key] = value
        return json.dumps(data, ensure_ascii=False, indent=2) + "\n"

    os.makedirs(os.path.dirname(file), exist_ok=True)
    update_text(file, change)
    check = read(places)
    got = {"photo": check["photo"], "benchmark": check["benchmark"], "batchSize": check["batch_size"]}[key]
    if got != value:
        raise UserError("封面设置写进去以后读回来对不上（%s 应该是 %r，读到 %r）：%s" % (key, value, got, file))
    return check


# ---------- 照片 ----------

def photo_path(places, rel):
    return os.path.join(places["cover_assets"], rel) if rel else None


def photos(places):
    """我的照片/ 里的照片（按名字排）。"""
    folder = os.path.join(places["cover_assets"], PHOTO_DIR)
    try:
        names = sorted(n for n in os.listdir(folder) if not n.startswith(".") and os.path.splitext(n)[1].lower() in I.PHOTO_EXTS)
    except OSError:
        return []
    return [os.path.join(folder, n) for n in names if os.path.isfile(os.path.join(folder, n))]


def import_photo(places, source):
    """把一张照片放进「我的照片」：已经在里面的不动；在外面的复制进去（同名不同图就加 -2，同一张图不重复放）。
    返回 (相对「封面素材」的路径, 完整路径)。不改默认照片。"""
    src = os.path.abspath(os.path.expanduser(source))
    if not os.path.isfile(src):
        inside = os.path.join(places["cover_assets"], source)
        if os.path.isfile(inside):
            src = os.path.abspath(inside)
        else:
            raise UserError("找不到这张照片：%s。把照片的完整路径给我（拖进对话的照片，先存成文件再给路径）。" % src)
    ext = os.path.splitext(src)[1].lower()
    kind = I.sniff(read_bytes(src)[:64])
    if ext not in I.PHOTO_EXTS or kind not in ("JPEG", "PNG", "WEBP", "HEIC"):
        raise UserError("这不像照片：%s。能用的有 jpg、png、webp、heic。" % os.path.basename(src))
    folder = os.path.join(places["cover_assets"], PHOTO_DIR)
    os.makedirs(folder, exist_ok=True)
    if os.path.dirname(os.path.realpath(src)) == os.path.realpath(folder):
        dest = os.path.join(folder, os.path.basename(src))
    else:
        stem, suffix = os.path.splitext(os.path.basename(src))
        suffix = ".jpg" if suffix.lower() == ".jpeg" else suffix.lower()
        digest = hashlib.sha256(read_bytes(src)).hexdigest()
        dest, n = os.path.join(folder, stem + suffix), 2
        while os.path.exists(dest) and hashlib.sha256(read_bytes(dest)).hexdigest() != digest:
            dest = os.path.join(folder, "%s-%d%s" % (stem, n, suffix))
            n += 1
        if not os.path.exists(dest):
            shutil.copyfile(src, dest)
    return PHOTO_DIR + "/" + os.path.basename(dest), dest


def set_photo(places, source):
    """把一张照片设成默认照片：先放进「我的照片」，再改设置。返回 (相对「封面素材」的路径, 完整路径)。"""
    rel, dest = import_photo(places, source)
    update(places, "photo", rel)
    return rel, dest


# ---------- 默认对标 ----------

def style_name(account_folder):
    """这个对标账号的风格名：VI拆解.md 第二行「风格名：…」。没有 VI拆解.md 或者没写，返回 None。"""
    try:
        with open(os.path.join(account_folder, VI_FILE), encoding="utf-8-sig") as f:
            lines = f.read().splitlines()
    except OSError:
        return None
    if len(lines) >= 2 and lines[1].startswith(STYLE_PREFIX):
        name = lines[1][len(STYLE_PREFIX):].strip()
        return name or None
    return None


def account_folder(places, name):
    """对标账号文件夹：写文件夹名（「抖音-某某」），也可以写它的完整路径。找不到报错。"""
    text = str(name or "").strip().rstrip("/")
    if not text:
        raise UserError("要告诉我是哪个对标账号（「市场调研/对标账号」里的文件夹名，比如「抖音-某某」）。")
    candidate = os.path.abspath(os.path.expanduser(text))
    if os.path.isdir(candidate) and is_account_dir(places, candidate):
        return candidate
    inside = os.path.join(places["accounts"], text)
    if os.path.isdir(inside) and "/" not in text and not text.startswith("."):
        return inside
    raise UserError("「对标账号」里没有「%s」（%s）。有主页链接的话，先用调研 Skill 把这个博主加进对标账号；"
                    "只有一批封面图的话，先用调研 Skill 手动建档（account add --manual），再接着做。" % (text, places["accounts"]))


def is_account_dir(places, folder):
    return os.path.realpath(os.path.dirname(folder)) == os.path.realpath(places["accounts"])


def vi_accounts(places):
    """拆过封面 VI（有 VI拆解.md）的对标账号：[(文件夹名, 风格名)]，和还没拆的个数。"""
    done, todo = [], 0
    try:
        names = sorted(n for n in os.listdir(places["accounts"]) if not n.startswith("."))
    except OSError:
        return done, todo
    for name in names:
        folder = os.path.join(places["accounts"], name)
        if not os.path.isdir(folder):
            continue
        if os.path.isfile(os.path.join(folder, VI_FILE)):
            done.append((name, style_name(folder)))
        else:
            todo += 1
    return done, todo


def set_benchmark(places, name):
    folder = account_folder(places, name)
    if not os.path.isfile(os.path.join(folder, VI_FILE)):
        raise UserError("「%s」还没有 VI拆解.md：先拆它的封面 VI（vi prepare、看图写观察、vi export），再设成默认对标。" % os.path.basename(folder))
    update(places, "benchmark", os.path.basename(folder))
    return os.path.basename(folder), style_name(folder)


def set_batch(places, count):
    try:
        n = int(str(count).strip())
    except ValueError:
        raise UserError("一批几张要写数字，比如 10（收到的是「%s」）。" % count)
    if not 1 <= n <= MAX_BATCH:
        raise UserError("一批要在 1 到 %d 张之间（对标原图最多拆 %d 张，一批再多只能反复用同几张构图）。" % (MAX_BATCH, MAX_BATCH))
    update(places, "batchSize", n)
    return n
