"""评论：认列、清洗、按视频分组、在「评论导入」里找、整理成评论数据、核对 AI 写的分析。

分工：程序管计数、去重、认列、核对引用；读懂评论、分类、写结论和选题是 AI 的事。
AI 的分析里只写评论的短编号（c1、c2……），条数、点赞合计、原话都由程序从评论原文取，AI 改不了数字、也引不错原话。
评论数据里不存评论者的昵称、用户编号、主页链接：分析用不上，报告里也不该出现。
"""
import os
import re
from collections import Counter, OrderedDict

from . import UserError
from . import platforms
from .tables import SUFFIXES, read_table
from .text import now_iso, parse_count, parse_time, short

# 认列：每样东西常见的几种叫法（比较前去掉空格、下划线、横线，英文不分大小写）。
# 社媒助手 2026 年 6 月的帮助文档写的抖音评论字段：评论ID、视频ID、视频链接、用户UID、用户链接、抖音号、用户名称、
# 评论内容、评论图片、评论时间、IP地址、点赞数、子评论数、一级评论ID……；老版本导出过「点赞量」「评论图片链接」。
FIELDS = OrderedDict([
    ("cid", ("评论id", "评论编号", "评论唯一标识", "cid", "commentid", "id")),
    ("text", ("评论内容", "评论", "内容", "评论文本", "评论正文", "回复内容", "文本", "text", "content", "comment",
              "commenttext", "commentcontent")),
    ("likes", ("点赞数", "点赞量", "点赞", "赞", "赞数", "获赞", "获赞数", "喜欢数", "likecount", "likes", "diggcount",
               "likedcount", "like", "digg")),
    ("time", ("评论时间", "时间", "发布时间", "创建时间", "回复时间", "评论日期", "日期", "createtime", "createdat",
              "commentedat", "time", "timestamp", "date", "publishtime")),
    ("user", ("用户名称", "用户昵称", "昵称", "评论者", "评论人", "用户名", "评论用户", "nickname", "username",
              "user.nickname", "author", "usernickname")),
    ("ip", ("ip地址", "ip属地", "属地", "地区", "地域", "ip", "iplabel", "iplocation", "location", "region", "评论ip")),
    ("replies", ("子评论数", "回复数", "回复量", "子评论数量", "楼中楼数", "回复条数", "replycount", "replycommenttotal",
                 "subcommentcount", "replies", "replytotal")),
    ("parent", ("一级评论id", "父评论id", "上级评论id", "根评论id", "回复的评论id", "所属评论id", "parentcommentid",
                "rootcommentid", "parentid", "replyid", "rootid")),
    ("video_id", ("视频id", "作品id", "笔记id", "awemeid", "videoid", "noteid", "itemid")),
    ("video_url", ("视频链接", "作品链接", "笔记链接", "视频地址", "作品地址", "笔记地址", "链接", "url", "videourl",
                   "noteurl", "shareurl", "awemeurl")),
    ("video_title", ("视频标题", "作品标题", "笔记标题", "视频描述", "作品描述", "笔记描述", "title")),
    ("image", ("评论图片", "评论图片链接", "图片", "图片链接", "评论配图", "image", "images", "imagelist", "pictures",
               "imageurl")),
    ("level", ("评论层级", "评论级别", "层级", "是否回复", "评论类型", "level", "isreply", "commentlevel")),
])
# 认得、但故意不用的列：涉及评论者个人信息，或者分析用不上
KNOWN_UNUSED = (
    "用户uid", "用户id", "用户链接", "用户主页", "用户主页链接", "抖音号", "小红书号", "快手号", "头像", "用户头像", "性别",
    "一级评论内容", "一级评论用户id", "一级评论用户名称", "引用的评论id", "引用的评论内容", "引用的用户id", "引用的用户名称",
    "uid", "secuid", "userid", "user.uid", "user.secuid", "user.userid", "user.shortid", "user.uniqueid",
)
FIELD_LABELS = {
    "cid": "评论编号", "text": "评论内容", "likes": "点赞数", "time": "评论时间", "user": "评论者昵称（只用来去重，不存）",
    "ip": "IP 属地", "replies": "回复数", "parent": "回复的是哪条评论", "video_id": "视频或笔记编号",
    "video_url": "视频或笔记链接", "video_title": "视频或笔记标题", "image": "评论图片", "level": "评论层级",
}
KINDS = ("需求", "痛点", "疑问", "反馈", "求资料", "其他")
LEVEL_TOP, LEVEL_REPLY, LEVEL_UNKNOWN = "一级", "回复", "未知"
NO_VIDEO = "（表里没写是哪条）"


def _norm(header):
    text = str(header or "").strip().lower()
    text = re.sub(r"[（(][^）)]*[）)]$", "", text)  # 去掉末尾括号里的说明，比如「点赞数（采集时）」
    return re.sub(r"[\s_\-·]+", "", text)


def recognize(headers):
    """认列：返回 {要的东西: 表头}、认得但不用的列、认不出的列。同一样东西只认第一列。"""
    wanted = {}
    unused, unknown = [], []
    lookup = {}
    for field, names in FIELDS.items():
        for name in names:
            lookup.setdefault(name, field)
    unused_set = set(KNOWN_UNUSED)
    for header in headers:
        key = _norm(header)
        if key in unused_set:
            unused.append(header)
            continue
        field = lookup.get(key)
        if field and field not in wanted:
            wanted[field] = header
            continue
        if field:  # 第二个同样意思的列
            unused.append(header)
            continue
        # 退一步：表头里带着三个字以上的常见叫法（比如「评论点赞数」「评论内容原文」），取最长的那个
        loose, best = None, 0
        for name, f in lookup.items():
            if len(name) >= 3 and not re.fullmatch(r"[a-z.]+", name) and name in key and f not in wanted and len(name) > best:
                loose, best = f, len(name)
        if loose:
            wanted[loose] = header
        else:
            unknown.append(header)
    return wanted, unused, unknown


_EMOJI_CODE = re.compile(r"\[[^\[\]\s]{1,12}\]")
_MENTION = re.compile(r"@\S+")
_EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿⬀-⯿️‍⃣]+")
_NON_WORD = re.compile(r"[\W_]+", re.UNICODE)


def noise_reason(text, has_image=False):
    """没法分析的评论：空白、只有图片、只有表情或 @、只有一个字。返回原因，正常评论返回 None。"""
    if not (text or "").strip():
        return "只有图片" if has_image else "空白"
    core = _EMOJI_CODE.sub("", text)
    core = _MENTION.sub("", core)
    core = _EMOJI.sub("", core)
    core = _NON_WORD.sub("", core)
    if not core:
        return "只有表情或@"
    if len(core) <= 1:
        return "只有一个字"
    return None


def _level(row, wanted):
    if "parent" in wanted:
        parent = str(row.get(wanted["parent"], "") or "").strip()
        return (LEVEL_TOP, None) if parent in ("", "0", "None", "null") else (LEVEL_REPLY, parent)
    if "level" in wanted:
        value = str(row.get(wanted["level"], "") or "").strip().lower()
        if value in ("二级", "回复", "子评论", "楼中楼", "reply", "2", "true", "是", "二级评论"):
            return LEVEL_REPLY, None
        if value in ("一级", "主评论", "评论", "top", "1", "false", "否", "一级评论"):
            return LEVEL_TOP, None
    return LEVEL_UNKNOWN, None


def _video_key(video_id, video_url):
    if video_id:
        return video_id
    if video_url:
        return platforms.canonical_link(video_url)
    return NO_VIDEO


def rows_from_table(table, platform_hint=None):
    """表格 → 统一格式的评论行（还没去重、没编号）。认不出评论内容那一列时直接报错。"""
    wanted, unused, unknown = recognize(table.headers)
    if "text" not in wanted:
        raise UserError("认不出哪一列是评论内容。这个表的表头是：%s。告诉我哪一列是评论，或者重新导出带「评论内容」的表。"
                        % "、".join(table.headers[:30] or ["（没有表头）"]))
    rows = []
    for raw in table.rows:
        get = lambda f: raw.get(wanted[f], "") if f in wanted else ""  # noqa: E731
        text = get("text")
        text = "" if text is None else str(text).replace("\r\n", "\n").replace("\r", "\n").strip()
        image = get("image")
        has_image = bool(image) and str(image).strip() not in ("", "[]", "0", "None")
        level, parent = _level(raw, wanted)
        video_url = str(get("video_url") or "").strip()
        video_id = str(get("video_id") or "").strip()
        if not video_id and video_url:
            video_id = platforms.video_id_from_link(video_url) or ""
        ip = re.sub(r"^(ip属地|ip地址|ip)\s*[:：]?\s*", "", str(get("ip") or "").strip(), flags=re.I)
        rows.append({
            "cid": str(get("cid") or "").strip(),
            "video_id": video_id,
            "video_url": video_url,
            "video_title": str(get("video_title") or "").strip(),
            "text": text,
            "likes": parse_count(get("likes")),
            "time": parse_time(get("time"), table.date1904),
            "ip": ip,
            "level": level,
            "parent": parent,
            "replies": parse_count(get("replies")),
            "has_image": has_image,
            "_user": str(get("user") or "").strip(),
        })
    platform = platform_hint
    if not platform:
        for row in rows:
            platform = platforms.detect_platform(row["video_url"])
            if platform:
                break
    columns = {
        "recognized": OrderedDict((f, wanted[f]) for f in FIELDS if f in wanted),
        "unused": unused,
        "unrecognized": unknown,
    }
    return rows, columns, platform


def group_videos(rows):
    """按视频分组，返回 [{key, id, url, title, rows}]，条数多的在前。"""
    groups = OrderedDict()
    for row in rows:
        key = _video_key(row["video_id"], row["video_url"])
        g = groups.setdefault(key, {"key": key, "id": row["video_id"], "url": row["video_url"], "title": row.get("video_title") or "", "rows": 0})
        g["rows"] += 1
        if not g["url"] and row["video_url"]:
            g["url"] = row["video_url"]
        if not g["title"] and row.get("video_title"):
            g["title"] = row["video_title"]
    return sorted(groups.values(), key=lambda g: -g["rows"])


def matches_target(group, target):
    """这一组评论是不是用户说的那条视频：编号一样，或者链接里带着这个编号，或者链接一样。"""
    tid, turl = target.get("id"), target.get("url")
    if tid and (group["id"] == tid or (group["url"] and tid in group["url"])):
        return True
    if turl and group["url"] and platforms.canonical_link(group["url"]) == platforms.canonical_link(turl):
        return True
    return False


def build_dataset(rows, columns, platform, source, videos_meta=None):
    """去重、标无效、编短号（c1、c2……），算基本统计。videos_meta：TikHub 拿到的视频标题、平台上显示的评论总数。"""
    seen, kept, duplicates = set(), [], 0
    for row in rows:
        key = ("id", row["video_id"], row["cid"]) if row["cid"] else ("row", row["video_id"], row["text"], row["time"], row["_user"])
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        kept.append(row)
    by_cid = {}
    comments = []
    for i, row in enumerate(kept, 1):
        item = OrderedDict()
        item["ref"] = "c%d" % i
        if row["cid"]:
            item["cid"] = row["cid"]
            by_cid.setdefault(row["cid"], item["ref"])
        item["video"] = _video_key(row["video_id"], row["video_url"])
        item["text"] = row["text"]
        item["likes"] = row["likes"]
        item["time"] = row["time"]
        item["ip"] = row["ip"] or None
        item["level"] = row["level"]
        if row["parent"]:
            item["parent"] = row["parent"]
        if row["replies"] is not None:
            item["replies"] = row["replies"]
        item["has_image"] = row["has_image"]
        if row.get("by_author"):
            item["by_author"] = True  # 作者本人的评论或回复（TikHub 的数据里有这个标记）
        item["noise"] = noise_reason(row["text"], row["has_image"])
        comments.append(item)
    for item in comments:
        if item.get("parent") and item["parent"] in by_cid:
            item["parent_ref"] = by_cid[item["parent"]]
    valid = [c for c in comments if not c["noise"]]
    times = sorted(c["time"] for c in valid if c["time"] and re.match(r"\d{4}-", c["time"]))
    videos = []
    meta = videos_meta or {}
    for g in group_videos([dict(r, video_title=r.get("video_title", "")) for r in kept]):
        info = meta.get(g["key"], {})
        videos.append(OrderedDict([
            ("key", g["key"]), ("id", g["id"] or None), ("url", info.get("url") or g["url"] or None),
            ("title", info.get("title") or g["title"] or None),
            ("comment_count_reported", info.get("comment_count")),
            ("rows", sum(1 for c in comments if c["video"] == g["key"])),
            ("valid", sum(1 for c in valid if c["video"] == g["key"])),
        ]))
    stats = OrderedDict([
        ("rows_in", len(rows)),
        ("duplicates", duplicates),
        ("noise", len(comments) - len(valid)),
        ("noise_reasons", dict(Counter(c["noise"] for c in comments if c["noise"]))),
        ("valid", len(valid)),
        ("top_level", sum(1 for c in valid if c["level"] == LEVEL_TOP)),
        ("replies", sum(1 for c in valid if c["level"] == LEVEL_REPLY)),
        ("level_unknown", sum(1 for c in valid if c["level"] == LEVEL_UNKNOWN)),
        ("with_image", sum(1 for c in valid if c["has_image"])),
        ("likes_total", sum(c["likes"] or 0 for c in valid)),
        ("likes_missing", sum(1 for c in valid if c["likes"] is None)),
        ("ip_known", sum(1 for c in valid if c["ip"])),
        ("time_from", times[0] if times else None),
        ("time_to", times[-1] if times else None),
    ])
    return OrderedDict([
        ("kind", "评论数据"),
        ("version", 1),
        ("created_at", now_iso()),
        ("platform", platform or None),
        ("source", source),
        ("videos", videos),
        ("columns", columns),
        ("stats", stats),
        ("comments", comments),
    ])


def dataset_from_file(path, target=None, all_videos=False, display_path=None):
    """读社媒助手（或别的工具）导出的评论表，整理成评论数据。target：只要这条视频的评论。"""
    table = read_table(path)
    rows, columns, platform = rows_from_table(table, (target or {}).get("platform"))
    groups = group_videos(rows)
    if target and (target.get("id") or target.get("url")):
        keep = [g["key"] for g in groups if matches_target(g, target)]
        if not keep:
            if len(groups) == 1 and groups[0]["key"] == NO_VIDEO:
                keep = [NO_VIDEO]  # 表里没写是哪条视频：用户自己说是这条，就当是这条
            else:
                raise UserError("这个文件里没有这条视频的评论。文件里有：%s。" % describe_groups(groups))
        rows = [r for r in rows if _video_key(r["video_id"], r["video_url"]) in keep]
    elif len(groups) > 1 and not all_videos:
        raise UserError("这个文件里有 %d 条视频（或笔记）的评论：%s。告诉我分析哪一条（用 --video 加链接或编号），"
                        "或者加 --all-videos 一起分析。" % (len(groups), describe_groups(groups)))
    source = OrderedDict([
        ("kind", "导入的表格"),
        ("file", display_path or os.path.basename(path)),
        ("format", table.kind),
        ("note", table.note or None),
    ])
    meta = {}
    if target and target.get("id"):
        meta[target["id"]] = {"url": target.get("url")}
    return build_dataset(rows, columns, platform, source, meta)


def describe_groups(groups, limit=6):
    parts = []
    for g in groups[:limit]:
        label = g["title"] and short(g["title"], 18) or g["id"] or g["url"] or g["key"]
        parts.append("%s（%d 条）" % (label, g["rows"]))
    if len(groups) > limit:
        parts.append("还有 %d 条" % (len(groups) - limit))
    return "；".join(parts)


# ---------- 在「评论导入」和以前的报告里找 ----------

def import_files(imports_dir):
    try:
        names = sorted(os.listdir(imports_dir))
    except OSError:
        return []
    out = []
    for name in names:
        if name.startswith(".") or name.startswith("~$"):
            continue
        path = os.path.join(imports_dir, name)
        if os.path.isfile(path) and os.path.splitext(name)[1].lower() in SUFFIXES + (".xls",):
            out.append(path)
    return out


def scan_imports(imports_dir):
    """把「评论导入」里每个文件读一遍：分别是哪几条视频的评论、各多少条；读不了的也列出来和原因。"""
    found = []
    for path in import_files(imports_dir):
        entry = {"path": path, "name": os.path.basename(path), "mtime": os.path.getmtime(path), "groups": [], "problem": None}
        try:
            table = read_table(path)
            rows, _cols, platform = rows_from_table(table)
            entry["platform"] = platform
            entry["groups"] = group_videos(rows)
        except UserError as e:
            entry["problem"] = str(e)
        found.append(entry)
    return found


def scan_reports(reports_dir):
    """以前做过的评论数据（比如用 TikHub 采过的）：调研报告/*/评论数据.json。"""
    out = []
    try:
        names = sorted(os.listdir(reports_dir))
    except OSError:
        return out
    from .text import read_json
    for name in names:
        path = os.path.join(reports_dir, name, "评论数据.json")
        if not os.path.isfile(path):
            continue
        try:
            data = read_json(path)
        except (OSError, ValueError):
            continue
        out.append({"path": path, "folder": os.path.dirname(path), "name": name, "source": data.get("source") or {},
                    "videos": data.get("videos") or [], "created_at": data.get("created_at")})
    return out


# ---------- AI 写的分析：核对引用、算条数 ----------

def _refs(value, valid, noise, problems, where):
    """把一串评论短号核对一遍：不存在、是无效评论的都记下来。"""
    out = []
    if value is None:
        return out
    if not isinstance(value, list):
        problems.append("%s 应该是评论短号的数组（比如 [\"c1\", \"c7\"]）" % where)
        return out
    for item in value:
        ref = item.get("ref") if isinstance(item, dict) else item
        if not isinstance(ref, str) or not ref:
            problems.append("%s 里有一项不是评论短号：%r" % (where, item))
            continue
        if ref in noise:
            problems.append("%s 引用的 %s 是无效评论（%s），不能当依据" % (where, ref, noise[ref]))
            continue
        if ref not in valid:
            problems.append("%s 引用的 %s 在评论数据里找不到" % (where, ref))
            continue
        if ref not in out:
            out.append(ref)
    return out


def sample_label(n):
    """条数多少，说成人话。规则写在报告的「样本够不够」里。"""
    if n >= 10:
        return "够看出方向"
    if n >= 4:
        return "有一些，还要再看"
    return "很少，只是线索"


def check_analysis(dataset, analysis):
    """核对 AI 写的分析.json。返回（整理好的分析，问题，提醒）。有问题就不出报告。"""
    problems, warnings = [], []
    if not isinstance(analysis, dict):
        return None, ["分析.json 最外层应该是 { … }"], []
    valid = {c["ref"]: c for c in dataset["comments"] if not c["noise"]}
    noise = {c["ref"]: c["noise"] for c in dataset["comments"] if c["noise"]}

    def text_of(value, where, limit=None, required=True):
        if value is None or (isinstance(value, str) and not value.strip()):
            if required:
                problems.append("%s 不能是空的" % where)
            return ""
        if not isinstance(value, str):
            problems.append("%s 应该是一段文字" % where)
            return ""
        value = value.strip()
        if limit and len(value) > limit:
            warnings.append("%s 有 %d 个字，读起来偏长（建议 %d 字以内）" % (where, len(value), limit))
        return value

    def quotes_of(value, allowed, where):
        out = []
        for item in value or []:
            ref = item.get("ref") if isinstance(item, dict) else item
            excerpt = item.get("excerpt") if isinstance(item, dict) else None
            if ref not in valid:
                _refs([ref], valid, noise, problems, where)
                continue
            if allowed is not None and ref not in allowed:
                problems.append("%s 的原话 %s 不在这一类的评论里" % (where, ref))
                continue
            if excerpt is not None:
                if not isinstance(excerpt, str) or not excerpt.strip() or excerpt.strip() not in valid[ref]["text"]:
                    problems.append("%s 的原话 %s 摘的那一段，在评论原文里找不到（摘录必须一字不差）" % (where, ref))
                    continue
                excerpt = excerpt.strip()
            out.append({"ref": ref, "excerpt": excerpt})
        return out

    title = text_of(analysis.get("title"), "title（报告标题）", 40)
    categories, cat_ids = [], set()
    raw_cats = analysis.get("categories")
    if not isinstance(raw_cats, list) or not raw_cats:
        problems.append("categories（分类）至少要有一类")
        raw_cats = []
    for i, cat in enumerate(raw_cats, 1):
        where = "第 %d 个分类" % i
        if not isinstance(cat, dict):
            problems.append("%s 应该是 { … }" % where)
            continue
        cid = cat.get("id")
        if not isinstance(cid, str) or not re.fullmatch(r"[A-Za-z0-9_\-一-鿿]{1,40}", cid or ""):
            problems.append("%s 的 id 要写（字母、数字、汉字，40 字以内）" % where)
            cid = "cat%d" % i
        if cid in cat_ids:
            problems.append("分类 id「%s」重复了" % cid)
        cat_ids.add(cid)
        name = text_of(cat.get("name"), where + " 的 name（类名）", 20)
        where = "分类「%s」" % (name or cid)
        kind = cat.get("kind")
        if kind not in KINDS:
            problems.append("%s 的 kind 只能是 %s 之一" % (where, "、".join(KINDS)))
        members = _refs(cat.get("comments"), valid, noise, problems, where + " 的 comments")
        if not members:
            problems.append("%s 一条评论都没有" % where)
        quotes = quotes_of(cat.get("quotes"), set(members), where + " 的 quotes")
        if members and not quotes:
            quotes = [{"ref": r, "excerpt": None} for r in sorted(members, key=lambda r: -(valid[r]["likes"] or 0))[:2]]
            warnings.append("%s 没挑原话，先放了点赞最多的 %d 条" % (where, len(quotes)))
        categories.append({"id": cid, "name": name, "kind": kind, "summary": text_of(cat.get("summary"), where + " 的 summary（这一类在说什么）", 160),
                           "comments": members, "quotes": quotes[:4]})
    by_cat = {c["id"]: c for c in categories}

    takeaways = []
    raw_take = analysis.get("takeaways")
    if not isinstance(raw_take, list) or not raw_take:
        problems.append("takeaways（第一屏的结论）至少要有一条")
        raw_take = []
    if len(raw_take) > 6:
        warnings.append("结论有 %d 条，第一屏放不下，建议留最要紧的 3 到 5 条" % len(raw_take))
    for i, item in enumerate(raw_take, 1):
        where = "第 %d 条结论" % i
        if not isinstance(item, dict):
            problems.append("%s 应该是 { … }" % where)
            continue
        text = text_of(item.get("text"), where + " 的 text", 80)
        evidence = _refs(item.get("evidence"), valid, noise, problems, where + " 的 evidence")
        cats = _cat_list(item.get("categories", item.get("category")), by_cat, problems, where)
        if not evidence and not cats:
            problems.append("%s 没有依据：evidence 写评论短号，或者 categories 写分类 id" % where)
        support = _union([evidence] + [by_cat[c]["comments"] for c in cats])
        quote = evidence[0] if evidence else (by_cat[cats[0]]["quotes"][0]["ref"] if cats and by_cat[cats[0]]["quotes"] else None)
        takeaways.append({"text": text, "evidence": evidence, "categories": cats, "count": len(support), "quote": quote})

    topics = []
    raw_topics = analysis.get("topics")
    if not isinstance(raw_topics, list) or not raw_topics:
        problems.append("topics（能直接拍的选题）至少要有一条")
        raw_topics = []
    for i, item in enumerate(raw_topics, 1):
        where = "第 %d 个选题" % i
        if not isinstance(item, dict):
            problems.append("%s 应该是 { … }" % where)
            continue
        cats = _cat_list(item.get("categories"), by_cat, problems, where)
        evidence = _refs(item.get("evidence"), valid, noise, problems, where + " 的 evidence")
        if not cats and not evidence:
            problems.append("%s 没有依据：categories 写分类 id，或者 evidence 写评论短号" % where)
        support = _union([evidence] + [by_cat[c]["comments"] for c in cats])
        quote = evidence[0] if evidence else (by_cat[cats[0]]["quotes"][0]["ref"] if cats and by_cat[cats[0]]["quotes"] else None)
        topics.append({"title": text_of(item.get("title"), where + " 的 title", 40),
                       "why": text_of(item.get("why"), where + " 的 why（为什么值得拍）", 120),
                       "audience": text_of(item.get("audience"), where + " 的 audience（拍给谁）", 40, required=False),
                       "categories": cats, "evidence": evidence, "count": len(support), "quote": quote})

    persona = {"summary": "", "groups": []}
    raw_p = analysis.get("persona")
    if raw_p is not None:
        if not isinstance(raw_p, dict):
            problems.append("persona（人群画像）应该是 { … }")
        else:
            persona["summary"] = text_of(raw_p.get("summary"), "persona 的 summary", 200, required=False)
            for i, g in enumerate(raw_p.get("groups") or [], 1):
                where = "人群画像第 %d 组" % i
                if not isinstance(g, dict):
                    problems.append("%s 应该是 { … }" % where)
                    continue
                members = _refs(g.get("comments"), valid, noise, problems, where + " 的 comments")
                if not members:
                    problems.append("%s 一条评论都没有：只写评论里自己说出来的身份，并附上是哪几条" % where)
                persona["groups"].append({"name": text_of(g.get("name"), where + " 的 name", 20),
                                          "description": text_of(g.get("description"), where + " 的 description", 120, required=False),
                                          "comments": members})
    caveats = [c.strip() for c in analysis.get("caveats") or [] if isinstance(c, str) and c.strip()]

    covered = set(_union([c["comments"] for c in categories]))
    left = [r for r in valid if r not in covered]
    if valid and len(left) / float(len(valid)) > 0.3:
        warnings.append("还有 %d 条有效评论（%.0f%%）没归进任何一类：读一下是不是漏了一类，确实是闲聊再放着"
                        % (len(left), 100.0 * len(left) / len(valid)))
    for cat in categories:
        if 0 < len(cat["comments"]) < 4:
            warnings.append("分类「%s」只有 %d 条，报告里会标「很少，只是线索」" % (cat["name"], len(cat["comments"])))
    result = {"title": title, "takeaways": takeaways, "topics": topics, "categories": categories,
              "persona": persona, "caveats": caveats, "uncategorized": left}
    return result, problems, warnings


def _cat_list(value, by_cat, problems, where):
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        problems.append("%s 的 categories 应该是分类 id 的数组" % where)
        return []
    out = []
    for cid in value:
        if cid not in by_cat:
            problems.append("%s 写的分类「%s」在 categories 里没有" % (where, cid))
        elif cid not in out:
            out.append(cid)
    return out


def _union(lists):
    out, seen = [], set()
    for items in lists:
        for x in items:
            if x not in seen:
                seen.add(x)
                out.append(x)
    return out


def ip_ranking(dataset, limit=8):
    """IP 属地前几名（只算有效评论）。"""
    counter = Counter(c["ip"] for c in dataset["comments"] if not c["noise"] and c["ip"])
    return counter.most_common(limit)


def listing(dataset, start=1, limit=300):
    """给 AI 读的评论清单：一行一条，c 编号、点赞、层级、属地、时间、原文。无效评论不列。"""
    valid = [c for c in dataset["comments"] if not c["noise"]]
    multi = len(dataset.get("videos") or []) > 1
    lines = []
    for c in valid[start - 1:start - 1 + limit]:
        parts = [c["ref"], "赞%s" % ("?" if c["likes"] is None else c["likes"]), c["level"]]
        if c.get("parent_ref"):
            parts[-1] = "回复%s" % c["parent_ref"]
        if c.get("by_author"):
            parts.append("作者")
        if c["ip"]:
            parts.append(c["ip"])
        if c["time"]:
            parts.append(c["time"][:10])
        if multi:
            parts.append("视频:%s" % short(c["video"], 20))
        text = c["text"].replace("\n", " / ")
        lines.append("%s | %s" % (" ".join(parts), text))
    return lines, len(valid)
