"""封面素材/封面设置.json：主照片、默认风格、一批几张。工作台和这个 Skill 都会写它（约定见 docs/开发记录.md「封面 Skill」）。

{ "photo": "人物参考图片/正脸.jpg", "benchmark": "风格/2026-10-04_8张", "batchSize": 5 }

- photo：主照片，相对「封面素材」的路径；没设是 null。出封面时「人物参考图片」里的图默认都用：主照片在前，再按放进来的先后，
  一张封面最多 3 张当长相参考（photo_set）。
- benchmark：默认风格的风格编号（对标账号文件夹名，或者「风格/<文件夹名>」，见 styles.py）；没设是 null。键名不改，老文件照样读。
- batchSize：一批默认几张，默认 5。
- 文件不存在等于三项都没设、一批 5 张。写的时候整份读出来、改一项、先写临时文件再换过去，不认识的键原样留着。
"""
import hashlib
import json
import os
import shutil
from collections import OrderedDict

from . import UserError
from . import images as I
from . import styles as ST
from .text import read_bytes, read_json, update_text

FILE = "封面设置.json"
PHOTO_DIR = "人物参考图片"  # 做封面时照着它画人；工作台「封面」页角上那块也叫这个（2026-10-04 原作者改的叫法，原来叫「我的照片」）
FAV_DIR = "收藏"
DEFAULT_BATCH = 5
MAX_BATCH = 30  # 一批再多，只能反复用同几张构图
MAX_PHOTOS = 3  # 一张封面最多给生图几张照片当长相参考


def path(places):
    return os.path.join(places["cover_assets"], FILE)


def read(places):
    """读封面设置。返回 {"file", "exists", "raw", "photo", "benchmark", "batch_size", "problems"}：
    raw 是文件里的原样（保留键的先后），后三项是整理好的值；某一项写得不对按没设（一批 5 张）处理，并记进 problems。
    文件写坏了（不是合法的 JSON）直接报错，不悄悄当成没设。"""
    file = path(places)
    out = {"file": file, "exists": os.path.isfile(file), "raw": OrderedDict(), "photo": None, "benchmark": None,
           "batch_size": DEFAULT_BATCH, "problems": []}
    if not out["exists"]:
        return out
    try:
        raw = read_json(file)
    except ValueError as e:
        raise UserError("封面设置写坏了，不是合法的 JSON：%s（%s）。改好它再试；或者把它挪进回收站，主照片、默认风格就都按没设算。" % (file, e))
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
        out["problems"].append("benchmark 应该是风格编号或者 null，按没设处理")
    if isinstance(batch, int) and not isinstance(batch, bool) and batch >= 1:
        out["batch_size"] = batch
    else:
        out["problems"].append("batchSize 应该是不小于 1 的整数，按 5 张处理")
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
    """人物参考图片/ 里的图：按放进来的先后（文件的修改时间从早到晚，和工作台列照片用的是同一个时间；一样时按名字）。"""
    folder = os.path.join(places["cover_assets"], PHOTO_DIR)
    try:
        names = [n for n in os.listdir(folder) if not n.startswith(".") and os.path.splitext(n)[1].lower() in I.PHOTO_EXTS]
    except OSError:
        return []
    found = []
    for name in names:
        path = os.path.join(folder, name)
        try:
            if os.path.isfile(path):
                found.append((os.path.getmtime(path), name, path))
        except OSError:
            continue
    return [path for _t, _n, path in sorted(found)]


def photo_set(places, settings=None, limit=MAX_PHOTOS):
    """出封面用哪几张人物参考图片：「人物参考图片」里的默认都用，主照片（封面设置的 photo）在前，再按放进来的先后；一张封面最多 limit 张。
    返回 {"all": 全部（排好的完整路径）, "used": 这次用的, "primary": 主照片（设置里写的）, "primary_abs", "primary_missing": 设了但找不到}。"""
    cs = settings or read(places)
    primary = cs["photo"]
    primary_abs = photo_path(places, primary) if primary else None
    ok = bool(primary_abs and os.path.isfile(primary_abs))
    ordered = [primary_abs] if ok else []
    for path in photos(places):
        if not (ok and os.path.realpath(path) == os.path.realpath(primary_abs)):
            ordered.append(path)
    return {"all": ordered, "used": ordered[:limit], "primary": primary, "primary_abs": primary_abs,
            "primary_ok": ok, "primary_missing": bool(primary and not ok)}


def find_photo(places, value):
    """这次说要用的一张照片：完整路径，或者相对「封面素材」的路径，或者「人物参考图片」里的文件名。不复制、不改设置。找不到、不像图片报错。"""
    text = str(value or "").strip()
    candidates = [os.path.abspath(os.path.expanduser(text))] if os.path.isabs(os.path.expanduser(text)) else [
        os.path.join(places["cover_assets"], text), os.path.join(places["cover_assets"], PHOTO_DIR, text)]
    path = next((c for c in candidates if os.path.isfile(c)), None)
    if not path:
        raise UserError("找不到这张图「%s」：写完整路径，或者「人物参考图片」里的文件名（%s）。" % (text, os.path.join(places["cover_assets"], PHOTO_DIR)))
    if os.path.splitext(path)[1].lower() not in I.PHOTO_EXTS or I.sniff(read_bytes(path)[:64]) not in ("JPEG", "PNG", "WEBP", "HEIC"):
        raise UserError("这不像照片：%s。能用的有 jpg、png、webp、heic。" % path)
    return os.path.abspath(path)


def import_photo(places, source):
    """把一张照片放进「人物参考图片」：已经在里面的不动；在外面的复制进去（同名不同图就加 -2，同一张图不重复放）。
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
    """把一张照片设成主照片：先放进「人物参考图片」，再改设置。返回 (相对「封面素材」的路径, 完整路径)。"""
    rel, dest = import_photo(places, source)
    update(places, "photo", rel)
    return rel, dest


# ---------- 默认风格 ----------

def set_benchmark(places, text):
    """把一个拆过封面 VI 的风格设成默认风格：写它的风格编号（对标账号文件夹名，或者「风格/<文件夹名>」）。返回 (风格编号, 风格名)。"""
    style = ST.resolve(places, text)
    if not style.done():
        raise UserError("「%s」还没有 VI拆解.md：先拆它的封面 VI（vi prepare、看图写观察、vi export），再设成默认风格。" % style.id)
    update(places, "benchmark", style.id)
    return style.id, style.name()


def set_batch(places, count):
    try:
        n = int(str(count).strip())
    except ValueError:
        raise UserError("一批几张要写数字，比如 5（收到的是「%s」）。" % count)
    if not 1 <= n <= MAX_BATCH:
        raise UserError("一批要在 1 到 %d 张之间（一批再多，只能反复用同几张构图）。" % MAX_BATCH)
    update(places, "batchSize", n)
    return n
