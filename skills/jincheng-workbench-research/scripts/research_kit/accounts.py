"""对标账号：「市场调研/对标账号/<平台>-<账号名>/」里的 档案.json、作品.json 和图片；账号研究的计算。

档案.json 的字段和工作台界面那边约定好：platform、account_name、url、note、tags（数组）、updated_at，
可选 followers、bio、source（"tikhub" 或 "manual"）。不往里加别的键；作品数据放旁边的 作品.json。
图片：头像.<扩展名>、主页截图-1.<扩展名>……、代表作封面-1.<扩展名>……
"""
import os
import re
import shutil
import statistics
import urllib.parse
import urllib.request
from collections import OrderedDict
from datetime import timedelta

from . import UserError
from . import platforms as P
from .comments import _norm
from .tables import read_table
from .text import now_iso, parse_count, parse_time, read_json, safe_name, short, text_to_datetime, write_json

PROFILE_FILE = "档案.json"
WORKS_FILE = "作品.json"
PROFILE_KEYS = ("platform", "account_name", "url", "note", "tags", "updated_at", "followers", "bio", "source")
REQUIRED_KEYS = ("platform", "account_name", "url", "note", "tags", "updated_at")
SOURCES = ("tikhub", "manual")
IMAGE_TYPES = {"image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/heic": ".heic"}
IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic")
MAX_IMAGE = 8 * 1024 * 1024


def folder_name(platform, name):
    return "%s-%s" % (safe_name(platform, 10, "其他"), safe_name(name, 40))


def check_profile(data):
    """核对 档案.json 合不合约定，返回问题列表（空列表就是合格）。"""
    problems = []
    if not isinstance(data, dict):
        return ["档案.json 最外层应该是 { … }"]
    for key in REQUIRED_KEYS:
        if key not in data:
            problems.append("缺 %s" % key)
    for key in data:
        if key not in PROFILE_KEYS:
            problems.append("多了约定以外的键 %s" % key)
    for key in ("platform", "account_name"):
        if key in data and (not isinstance(data[key], str) or not data[key].strip()):
            problems.append("%s 要是不空的文字" % key)
    for key in ("url", "note", "bio"):
        if key in data and not isinstance(data[key], str):
            problems.append("%s 要是文字" % key)
    if "tags" in data and (not isinstance(data["tags"], list) or not all(isinstance(t, str) and t.strip() for t in data["tags"])):
        problems.append("tags 要是文字数组")
    if "updated_at" in data and not (isinstance(data["updated_at"], str) and re.match(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", data["updated_at"])):
        problems.append("updated_at 要是带时间的日期，比如 2026-10-03T15:04:05+08:00")
    if "followers" in data and (not isinstance(data["followers"], int) or isinstance(data["followers"], bool) or data["followers"] < 0):
        problems.append("followers 要是不小于 0 的整数")
    if "source" in data and data["source"] not in SOURCES:
        problems.append("source 只能是 tikhub 或 manual")
    return problems


def list_accounts(accounts_dir):
    out = []
    try:
        names = sorted(os.listdir(accounts_dir))
    except OSError:
        return out
    for name in names:
        folder = os.path.join(accounts_dir, name)
        path = os.path.join(folder, PROFILE_FILE)
        if name.startswith(".") or not os.path.isfile(path):
            continue
        try:
            data = read_json(path)
        except (OSError, ValueError):
            data = None
        out.append({"folder": folder, "name": name, "profile": data})
    return out


def find_account(accounts_dir, platform, url=None, name=None):
    """已经建过档的：同平台、链接一样；没有链接时按「平台-账号名」文件夹名找。"""
    want = P.canonical_link(url) if url else None
    for item in list_accounts(accounts_dir):
        data = item["profile"] or {}
        if data.get("platform") == platform and want and data.get("url") and P.canonical_link(data["url"]) == want:
            return item["folder"]
    if name:
        folder = os.path.join(accounts_dir, folder_name(platform, name))
        if os.path.isdir(folder):
            try:
                old_url = (read_json(os.path.join(folder, PROFILE_FILE)) or {}).get("url") or ""
            except (OSError, ValueError, AttributeError):
                old_url = ""
            if not want or not old_url or P.canonical_link(old_url) == want:  # 链接不一样就是同名的另一个人
                return folder
    return None


def resolve_account(accounts_dir, text):
    """「账号研究」里用户说的博主：可以是链接，也可以是「对标账号」里的文件夹名或账号名。"""
    text = str(text or "").strip()
    target = P.parse_target(text)
    if target["url"]:
        folder = find_account(accounts_dir, target["platform"], target["url"]) if target["platform"] else None
        return target, folder
    for item in list_accounts(accounts_dir):
        data = item["profile"] or {}
        if text in (item["name"], data.get("account_name")):
            url = data.get("url") or ""
            t = P.parse_target(url) if url else {"platform": data.get("platform"), "url": None, "id": None, "user_id": None, "short": False}
            t["platform"] = data.get("platform") or t.get("platform")
            return t, item["folder"]
    raise UserError("「对标账号」里没找到「%s」。给我这个博主的主页链接，或者先把他加进对标账号。" % text)


def save_profile(accounts_dir, platform, account_name, url="", note=None, tags=None, followers=None, bio=None, source="manual", folder=None):
    """新建或更新一个对标账号的 档案.json。已有的备注和标签，这次没给新的就保留。返回 (文件夹, 是不是新建的)。"""
    if not account_name or not str(account_name).strip():
        raise UserError("要有账号名才能建档。")
    folder = folder or find_account(accounts_dir, platform, url, account_name)
    created = folder is None
    if created:
        folder = os.path.join(accounts_dir, folder_name(platform, account_name))
        if os.path.exists(folder):  # 同名但不是同一个人（链接不一样）
            n = 2
            while os.path.exists("%s-%d" % (folder, n)):
                n += 1
            folder = "%s-%d" % (folder, n)
    old = {}
    path = os.path.join(folder, PROFILE_FILE)
    if os.path.isfile(path):
        try:
            old = read_json(path)
        except (OSError, ValueError):
            old = {}
    data = OrderedDict()
    data["platform"] = platform
    data["account_name"] = str(account_name).strip()
    data["url"] = str(url or old.get("url") or "")
    data["note"] = str(note if note is not None else old.get("note") or "")
    data["tags"] = _tags(tags) if tags is not None else [t for t in old.get("tags") or [] if isinstance(t, str) and t.strip()]
    data["updated_at"] = now_iso()
    count = parse_count(followers) if followers is not None else old.get("followers")
    if isinstance(count, int) and count >= 0:
        data["followers"] = count
    bio = bio if bio is not None else old.get("bio")
    if isinstance(bio, str) and bio.strip():
        data["bio"] = bio.strip()
    data["source"] = source if source in SOURCES else "manual"
    problems = check_profile(data)
    if problems:
        raise UserError("档案.json 没通过核对：%s" % "；".join(problems))
    os.makedirs(folder, exist_ok=True)
    write_json(path, data)
    return folder, created


def _tags(value):
    if isinstance(value, str):
        value = re.split(r"[,，、;；/\s]+", value)
    out = []
    for t in value or []:
        t = str(t).strip().lstrip("#")
        if t and t not in out:
            out.append(t)
    return out


def save_works(folder, profile, works, source):
    """作品.json：这次拉到的最近作品（不存图片链接：带签名、会过期）。"""
    payload = OrderedDict([
        ("platform", profile.get("platform")),
        ("account_name", profile.get("name")),
        ("url", profile.get("url")),
        ("fetched_at", now_iso()),
        ("source", source),
        ("followers", profile.get("followers")),
        ("works_total", profile.get("works_total")),
        ("likes_total", profile.get("likes_total")),
        ("works", [_public_work(w) for w in works]),
    ])
    write_json(os.path.join(folder, WORKS_FILE), payload)
    return payload


def _public_work(w):
    keys = ("id", "url", "title", "desc", "published_at", "duration_seconds", "type", "likes", "comments", "collects", "shares", "pinned", "tags", "cover")
    return OrderedDict((k, w.get(k)) for k in keys if k in w)


# ---------- 图片 ----------

def _allowed_image_url(url):
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if parts.scheme == "https":
        return True
    return parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost")  # 只给测试用


def download_image(url, dest_base, opener=None, timeout=20):
    """下载一张图片存成 dest_base + 扩展名。失败返回 None，不影响建档。"""
    if not url or not _allowed_image_url(url):
        return None
    opener = opener or urllib.request.build_opener()
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": ""})
    try:
        with opener.open(request, timeout=timeout) as resp:
            kind = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            data = resp.read(MAX_IMAGE + 1)
    except (OSError, ValueError):
        return None
    if len(data) > MAX_IMAGE or not data:
        return None
    suffix = IMAGE_TYPES.get(kind) or _sniff(data)
    if not suffix:
        return None
    for old in IMAGE_SUFFIXES:  # 换扩展名时不留下旧的那张
        if os.path.exists(dest_base + old) and dest_base + old != dest_base + suffix:
            os.unlink(dest_base + old)
    path = dest_base + suffix
    with open(path, "wb") as f:
        f.write(data)
    return path


def _sniff(data):
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    return None


def copy_images(paths, folder, stem):
    """用户给的截图、封面：复制进账号文件夹，按「主页截图-1」「代表作封面-1」往后编号，不覆盖已有的。"""
    saved = []
    for src in paths or []:
        src = os.path.expanduser(src)
        if not os.path.isfile(src):
            raise UserError("找不到图片：%s" % src)
        suffix = os.path.splitext(src)[1].lower()
        if suffix not in IMAGE_SUFFIXES:
            raise UserError("这不像图片文件（%s）。能用的有 jpg、png、webp、gif、heic。" % os.path.basename(src))
        n = 1
        while any(os.path.exists(os.path.join(folder, "%s-%d%s" % (stem, n, s))) for s in IMAGE_SUFFIXES):
            n += 1
        dest = os.path.join(folder, "%s-%d%s" % (stem, n, ".jpg" if suffix == ".jpeg" else suffix))
        shutil.copyfile(src, dest)
        saved.append(dest)
    return saved


def save_tikhub_images(folder, profile, works, opener=None, covers=3):
    """头像和互动最多的几条作品的封面。"""
    saved = []
    avatar = download_image(profile.get("avatar_url"), os.path.join(folder, "头像"), opener)
    if avatar:
        saved.append(avatar)
    ranked = sorted([w for w in works if w.get("cover_url")], key=lambda w: -(interactions(w) or 0))
    for i, w in enumerate(ranked[:covers], 1):
        path = download_image(w["cover_url"], os.path.join(folder, "代表作封面-%d" % i), opener)
        if path:
            w["cover"] = os.path.basename(path)
            saved.append(path)
    return saved


# ---------- 社媒助手导出的博主作品表 ----------

WORK_FIELDS = OrderedDict([
    ("id", ("视频id", "作品id", "笔记id", "awemeid", "noteid", "videoid", "id")),
    ("url", ("视频链接", "作品链接", "笔记链接", "链接", "url", "shareurl")),
    ("title", ("视频描述", "作品描述", "笔记标题", "标题", "视频标题", "作品标题", "描述", "title", "desc")),
    ("likes", ("点赞量", "点赞数", "点赞", "获赞", "likes", "diggcount", "likedcount")),
    ("comments", ("评论量", "评论数", "评论", "comments", "commentcount")),
    ("collects", ("收藏量", "收藏数", "收藏", "collects", "collectcount", "collectedcount")),
    ("shares", ("分享量", "分享数", "转发量", "转发数", "分享", "shares", "sharecount")),
    ("published_at", ("发布时间", "创建时间", "发布日期", "时间", "createtime", "publishtime")),
    ("duration", ("视频时长", "时长", "duration")),
    ("type", ("视频类型", "笔记类型", "作品类型", "类型", "type")),
    ("author", ("达人昵称", "博主昵称", "作者昵称", "作者", "昵称", "nickname")),
    ("followers", ("粉丝数", "粉丝量", "粉丝", "followers", "fans")),
    ("account_url", ("达人链接", "博主链接", "作者链接", "主页链接")),
])


def works_from_file(path):
    """读社媒助手导出的「达人作品数据」表 → (博主信息, 作品列表, 认不出的列)。"""
    table = read_table(path)
    lookup = {}
    for field, names in WORK_FIELDS.items():
        for name in names:
            lookup.setdefault(name, field)
    wanted, unknown = {}, []
    for header in table.headers:
        field = lookup.get(_norm(header))
        if field and field not in wanted:
            wanted[field] = header
        else:
            unknown.append(header)
    if "likes" not in wanted or ("id" not in wanted and "url" not in wanted):
        raise UserError("认不出这是博主作品表：至少要有作品编号或链接、点赞数这两列。表头是：%s" % "、".join(table.headers[:30]))
    works, info = [], {"name": None, "followers": None, "url": None}
    for raw in table.rows:
        get = lambda f: raw.get(wanted[f], "") if f in wanted else ""  # noqa: E731
        url = str(get("url") or "").strip()
        wid = str(get("id") or "").strip() or P.video_id_from_link(url) or ""
        desc = str(get("title") or "").strip()
        works.append({
            "id": wid, "url": url or P.work_link(P.detect_platform(url) or P.DOUYIN, wid),
            "title": short(desc.split("#")[0].strip() or desc, 80), "desc": desc,
            "published_at": parse_time(get("published_at"), table.date1904),
            "duration_seconds": _duration(get("duration")),
            "type": str(get("type") or "").strip() or None,
            "likes": parse_count(get("likes")), "comments": parse_count(get("comments")),
            "collects": parse_count(get("collects")), "shares": parse_count(get("shares")),
            "pinned": False, "tags": [],
        })
        info["name"] = info["name"] or str(get("author") or "").strip() or None
        info["followers"] = info["followers"] or parse_count(get("followers"))
        info["url"] = info["url"] or str(get("account_url") or "").strip() or None
    return info, [w for w in works if w["id"] or w["url"]], unknown


def _duration(value):
    text = str(value or "").strip()
    if not text:
        return None
    m = re.fullmatch(r"(?:(\d+):)?(\d+):(\d{2})", text)
    if m:
        h, mi, s = m.groups()
        return int(h or 0) * 3600 + int(mi) * 60 + int(s)
    n = parse_count(text.rstrip("s秒"))
    if n is None:
        return None
    return round(n / 1000.0, 1) if n > 10000 else n  # 毫秒还是秒


# ---------- 账号研究：最近什么最火 ----------

METRICS = (("likes", "点赞"), ("comments", "评论"), ("collects", "收藏"), ("shares", "分享"))
FRESH_DAYS = 3  # 发布不到 3 天的还在涨，不参与判断
FACTOR = 2.0  # 互动数达到平时水平的 2 倍算「明显更火」
MIN_SAMPLE = 8  # 发布满 3 天的作品少于 8 条，只排序、不判断


def interactions(w):
    """互动数 = 点赞 + 评论 + 收藏 + 分享。点赞都没有就算数据不全。"""
    if w.get("likes") is None:
        return None
    return sum(w.get(k) or 0 for k, _l in METRICS)


def analyze_works(works, as_of_text=None):
    as_of = text_to_datetime((as_of_text or "")[:16].replace("T", " ")) or None
    rows = []
    for w in works:
        row = dict(w)
        row["interactions"] = interactions(w)
        published = text_to_datetime(w.get("published_at"))
        row["fresh"] = bool(as_of and published and as_of - published < timedelta(days=FRESH_DAYS))
        rows.append(row)
    mature = [r for r in rows if r["interactions"] is not None and not r["fresh"]]
    median = statistics.median([r["interactions"] for r in mature]) if mature else None
    metric_medians = {}
    for key, _label in METRICS:
        values = [r[key] for r in mature if r.get(key) is not None]
        metric_medians[key] = statistics.median(values) if values else None
    enough = len(mature) >= MIN_SAMPLE and median
    for r in rows:
        r["ratio"] = round(r["interactions"] / float(median), 1) if (median and r["interactions"] is not None) else None
        # 四项里涨得最多的那一项：是这一项平时的 2 倍以上、又比整条的倍数高，才单独写出来（比如收藏特别高）
        best = None
        for key, label in METRICS:
            m = metric_medians.get(key)
            if m and r.get(key) is not None:
                times = r[key] / float(m)
                if best is None or times > best[0]:
                    best = (times, label)
        spikes = []
        if best and best[0] >= FACTOR and (r["ratio"] is None or best[0] > r["ratio"]):
            spikes.append("%s是平时的 %.1f 倍" % (best[1], best[0]))
        r["spikes"] = spikes
        if r["interactions"] is None:
            r["status"] = "数据不全"
        elif r["fresh"]:
            r["status"] = "还在涨"
        elif enough and r["interactions"] >= FACTOR * median:
            r["status"] = "明显更火"
        else:
            r["status"] = "平时水平"
    rows.sort(key=lambda r: (r["interactions"] is None, -(r["interactions"] or 0)))
    dates = sorted(r["published_at"] for r in rows if r.get("published_at") and re.match(r"\d{4}-", r["published_at"]))
    return {
        "count": len(rows),
        "mature": len(mature),
        "fresh": sum(1 for r in rows if r["fresh"]),
        "incomplete": sum(1 for r in rows if r["interactions"] is None),
        "pinned": sum(1 for r in rows if r.get("pinned")),
        "median": median,
        "metric_medians": metric_medians,
        "enough": bool(enough),
        "standouts": [r["id"] for r in rows if r["status"] == "明显更火"],
        "time_from": dates[0] if dates else None,
        "time_to": dates[-1] if dates else None,
        "rows": rows,
        "rules": {"fresh_days": FRESH_DAYS, "factor": FACTOR, "min_sample": MIN_SAMPLE},
    }


def check_account_analysis(data, analysis):
    """AI 给账号研究写的观察：每条要说清看到了什么，并写上是哪几条作品。"""
    problems = []
    ids = set(r["id"] for r in data["analysis"]["rows"])
    if not isinstance(analysis, dict):
        return None, ["分析.json 最外层应该是 { … }"]
    out = {"summary": "", "observations": []}
    summary = analysis.get("summary")
    if summary is not None:
        if not isinstance(summary, str):
            problems.append("summary 要是一段文字")
        else:
            out["summary"] = summary.strip()
    for i, ob in enumerate(analysis.get("observations") or [], 1):
        where = "第 %d 条观察" % i
        if not isinstance(ob, dict):
            problems.append("%s 应该是 { … }" % where)
            continue
        title, text = ob.get("title"), ob.get("text")
        if not isinstance(title, str) or not title.strip():
            problems.append("%s 要有 title" % where)
        if not isinstance(text, str) or not text.strip():
            problems.append("%s 要有 text" % where)
        works = ob.get("works") or []
        bad = [w for w in works if w not in ids]
        if bad:
            problems.append("%s 写的作品 %s 不在这次的作品里" % (where, "、".join(map(str, bad))))
        if not works:
            problems.append("%s 要写是哪几条作品（works 写作品编号）" % where)
        out["observations"].append({"title": (title or "").strip(), "text": (text or "").strip(), "works": [w for w in works if w in ids]})
    return out, problems
