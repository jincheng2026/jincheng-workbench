"""拆封面 VI 的文件活：整理对标封面（补封面、改名 K01…、写清单），建研究清单、校验、出对照网页、导出 VI拆解.md。
脚本只管整理文件、查引用、算频次、拼页面，不替 AI 看图。

从学员版 cover-vi 的三个脚本（建清单.py、vi.py、导出VI拆解.py）搬来，方法和字段不变，改了这些：
- 只用 Python 自带的模块：宽高从文件头读，重复按文件内容的 sha256 认；装了 Pillow 时多解码一遍、多按像素认重复（images.py）。
- 文件位置照工作台的约定：封面在对标账号文件夹的「封面/」，研究数据在「VI研究/」，对照网页出在「调研报告/<日期>_<账号名>封面VI/」，
  VI拆解.md 在对标账号文件夹里，第二行是「风格名：…」。
- 清单里的图片路径写成相对 VI研究/ 的（工作文件夹挪了位置也能用），不写本机的完整路径。
"""
import hashlib
import html
import json
import os
import re
import shutil
from collections import OrderedDict
from datetime import datetime, timezone

from . import UserError
from . import images as I
from . import settings as S
from .text import natural_key, read_json, safe_name, today, unique_dir, unique_file, write_json, write_text

COVERS = "封面"
STUDY_DIR = "VI研究"
NAMES_FILE = "原文件名.md"
RECORDS = "records.json"
INVENTORY = "inventory.json"
STUDY = "study.json"
REPORT_TYPE = "封面VI"
KPAT = re.compile(r"^K(\d{2,3})\.([A-Za-z0-9]+)$")
ID = re.compile(r"^[A-Za-z0-9_-]+$")
OBS_FIELDS = ("visible_text", "subject_action", "space", "typography", "color_material", "interpretation", "transfer")
CASE_FIELDS = ("name", "when", "relations", "keep", "replace", "inputs", "failure")
LABELS = {"visible_text": "可见文字", "subject_action": "主体与动作", "space": "空间关系", "typography": "文字处理", "color_material": "色彩与材质",
          "interpretation": "解释", "transfer": "迁移建议", "when": "何时选用", "relations": "必须成立的关系", "keep": "保留", "replace": "替换",
          "inputs": "所需素材", "failure": "失败表现"}
REVIEW_NAMES = {"not-reviewed": "未复核", "self-reviewed": "执行者已自行复核", "not-run": "未执行", "partial": "部分完成", "reviewed": "本轮已检查",
                "pending": "待用户评审", "accepted": "用户已认可所述范围", "rejected": "用户未认可所述范围"}
ASSETS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "assets")
FEATURED = ("代表作封面-",)  # --from 写的是对标账号文件夹本身时，只拿这几张（头像、主页截图不是封面）


class StudyError(UserError):
    """清单或研究数据不合格：消息就是要改的地方。"""


def require(condition, message):
    if not condition:
        raise StudyError(message)


def folders(account):
    return os.path.join(account, COVERS), os.path.join(account, STUDY_DIR)


def account_label(account):
    """给人看的账号名：档案.json 的 account_name；没有就用文件夹名去掉「平台-」。"""
    try:
        name = (read_json(os.path.join(account, "档案.json")) or {}).get("account_name")
        if isinstance(name, str) and name.strip():
            return name.strip()
    except (OSError, ValueError, AttributeError):
        pass
    base = os.path.basename(account)
    return base.split("-", 1)[1] if "-" in base else base


def _load(path, what):
    if not os.path.isfile(path):
        raise UserError("还没有 %s：%s" % (what, path))
    try:
        return read_json(path)
    except ValueError as e:
        raise UserError("%s 不是合法的 JSON：%s（%s）" % (what, path, e))


# ---------- 第一步：补封面、改名、写清单 ----------

def _iso(published):
    """作品.json 的发布时间（「2026-09-30 08:00」，拉数据那台电脑的本机时间）换成带时区的写法。读不出返回 None。"""
    text = str(published or "").strip()
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text[:19] if fmt.endswith("%S") else text[:16], fmt).astimezone().isoformat()
        except ValueError:
            continue
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return (dt if dt.tzinfo else dt.astimezone()).isoformat()
    except ValueError:
        return None


def _old_names(covers_dir):
    """原文件名.md 里已有的对照：[(新名, 原名)]"""
    try:
        with open(os.path.join(covers_dir, NAMES_FILE), encoding="utf-8-sig") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        cells = [c.strip() for c in line.strip().strip("|").split("|")] if line.strip().startswith("|") else []
        if len(cells) >= 2 and KPAT.match(cells[0]):
            out.append((cells[0], cells[1]))
    return out


def _write_names(covers_dir, rows, skipped):
    lines = ["# 原文件名对照", "", "封面/ 里的图按顺序改名成 K01、K02……（从新到旧；不知道发布时间的按给的顺序），原来的名字记在这里。图没有删，只是改了名。", "",
             "| 新名 | 原名 |", "| --- | --- |"]
    lines += ["| %s | %s |" % (new, old.replace("|", "／")) for new, old in rows]
    if skipped:
        lines += ["", "没纳入的（报告网页显示不了这几种格式，转成 jpg 或 png 再放进来）：" + "、".join(skipped)]
    write_text(os.path.join(covers_dir, NAMES_FILE), "\n".join(lines) + "\n")


def _k_files(covers_dir):
    """封面/ 里已经叫 Kxx 的图：{编号数字: 文件名}；同一个编号有两个文件就报错。"""
    found = {}
    for name in sorted(os.listdir(covers_dir)):
        m = KPAT.match(name)
        if not m or os.path.splitext(name)[1].lower() not in I.FORMAT_OF_EXT:
            continue
        n = int(m.group(1))
        if n in found:
            raise UserError("封面/ 里有两个 K%02d（%s、%s）：留一个，另一个改个别的名字再跑。" % (n, found[n], name))
        found[n] = name
    return found


def _digest(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def prepare(account, max_count=30, source=None):
    """把对标账号的封面整理好：缺的从 作品.json 的封面链接下载（最近的 max_count 张，下过的不重下）；
    source 给了就从那个文件夹复制图进来；然后把不叫 Kxx 的图按顺序改名、写 原文件名.md、生成 VI研究/records.json。"""
    covers, study = folders(account)
    os.makedirs(covers, exist_ok=True)
    os.makedirs(study, exist_ok=True)
    old_records = {}
    if os.path.isfile(os.path.join(study, RECORDS)):
        try:
            for r in read_json(os.path.join(study, RECORDS)).get("records") or []:
                if isinstance(r, dict) and r.get("id"):
                    old_records[r["id"]] = r
        except (OSError, ValueError, AttributeError):
            old_records = {}
    names = _old_names(covers)
    report = {"downloaded": 0, "download_failed": 0, "copied": 0, "renamed": 0, "skipped": [], "skipped_source": [], "work_json": False,
              "cover_urls": 0, "network": None}
    known_digests = {_digest(os.path.join(covers, n)) for n in os.listdir(covers)
                     if os.path.isfile(os.path.join(covers, n)) and os.path.splitext(n)[1].lower() in I.FORMAT_OF_EXT}
    meta = {}  # 文件名 → 这张从哪来、作品编号、发布时间

    # 1. 用户给的文件夹：复制进来（不动原文件夹）
    if source:
        src = os.path.abspath(os.path.expanduser(source))
        if not os.path.isdir(src):
            raise UserError("找不到封面所在的文件夹：%s" % src)
        same_account = os.path.realpath(src) == os.path.realpath(account)
        if os.path.realpath(src) != os.path.realpath(covers):
            for name in sorted(os.listdir(src), key=natural_key):
                path = os.path.join(src, name)
                ext = os.path.splitext(name)[1].lower()
                if name.startswith(".") or not os.path.isfile(path):
                    continue
                if same_account and not name.startswith(FEATURED):
                    continue
                if ext in I.SKIPPED_EXTS:
                    report["skipped_source"].append(name)
                    continue
                if ext not in I.FORMAT_OF_EXT:
                    continue
                digest = _digest(path)
                if digest in known_digests:
                    continue
                stem, suffix = os.path.splitext(name)
                if KPAT.match(name):  # 别处叫 K01 的图，到这里要接着已有的编号排，先换个名字
                    stem = "来自-" + stem
                target = unique_file(covers, stem, suffix)
                shutil.copyfile(path, target)
                known_digests.add(digest)
                meta[os.path.basename(target)] = {"source": "从用户给的文件夹复制的图片", "origin": "%s（从 %s 复制）" % (name, os.path.basename(src) or src)}
                report["copied"] += 1

    # 2. 作品.json 里有封面链接：封面不够 max_count 张时，按发布时间从新到旧下载，下过的作品不再下
    works_file = os.path.join(account, "作品.json")
    if os.path.isfile(works_file):
        report["work_json"] = True
        try:
            works = read_json(works_file).get("works") or []
        except (OSError, ValueError, AttributeError):
            works = []
        works = [w for w in works if isinstance(w, dict) and isinstance(w.get("cover_url"), str) and w.get("cover_url").strip()]
        report["cover_urls"] = len(works)
        have_ids = {str(r.get("work_id")) for r in old_records.values() if r.get("work_id")}
        for _new, old in names:
            m = re.match(r"^作品 (\S+) 的封面", old)
            if m:
                have_ids.add(m.group(1))
        count = len([n for n in os.listdir(covers) if os.path.splitext(n)[1].lower() in I.FORMAT_OF_EXT and not n.startswith(".")])
        works.sort(key=lambda w: (_iso(w.get("published_at")) is None, -(_stamp(w.get("published_at")) or 0)))
        for w in works:
            if count >= max_count:
                break
            wid = str(w.get("id") or "").strip()
            if not wid or wid in have_ids:
                continue
            try:
                path = I.download(w["cover_url"].strip(), _free_base(covers, "作品" + safe_name(wid, 60, "")))
            except I.NetworkError as e:  # 连不上网：后面的也不用试了
                report["network"] = str(e) or "连不上"
                break
            if not path:
                report["download_failed"] += 1
                continue
            digest = _digest(path)
            if digest in known_digests:  # 同一张图已经有了（比如用户自己放过）
                os.unlink(path)
                have_ids.add(wid)
                continue
            known_digests.add(digest)
            have_ids.add(wid)
            published = _iso(w.get("published_at"))
            meta[os.path.basename(path)] = {"source": "作品.json 里这条作品的封面链接（下载的原图）", "work_id": wid, "published_at": published,
                                            "origin": "作品 %s 的封面（%s发布，从 作品.json 的封面链接下载）" % (wid, (str(w.get("published_at")) + " ") if w.get("published_at") else "")}
            report["downloaded"] += 1
            count += 1

    # 3. 不叫 Kxx 的图按顺序改名：有发布时间的从新到旧在前，别的按文件名（用户给的顺序）
    k_files = _k_files(covers)
    loose = []
    for name in os.listdir(covers):
        path = os.path.join(covers, name)
        ext = os.path.splitext(name)[1].lower()
        if name.startswith(".") or not os.path.isfile(path) or KPAT.match(name) and ext in I.FORMAT_OF_EXT:
            continue
        if ext in I.SKIPPED_EXTS:
            if name not in report["skipped"]:
                report["skipped"].append(name)
            continue
        if ext in I.FORMAT_OF_EXT:
            loose.append(name)
    dated = sorted([n for n in loose if (meta.get(n) or {}).get("published_at")], key=lambda n: meta[n]["published_at"], reverse=True)
    undated = sorted([n for n in loose if n not in dated], key=natural_key)
    nxt = max(k_files) if k_files else 0
    renamed = []
    for name in dated + undated:
        nxt += 1
        ext = os.path.splitext(name)[1].lower()
        new = "K%02d%s" % (nxt, ".jpg" if ext == ".jpeg" else ext)
        os.rename(os.path.join(covers, name), os.path.join(covers, new))
        info = meta.get(name) or {"source": "用户放进 封面/ 的图片", "origin": name}
        meta[new] = info
        renamed.append((new, info["origin"]))
    report["renamed"] = len(renamed)
    _write_names(covers, names + renamed, sorted(report["skipped"], key=natural_key))

    # 4. VI研究/records.json：封面/ 里全部 Kxx，编号从小到大
    k_files = _k_files(covers)
    if not k_files:
        report["count"] = 0
        return report
    origin_of = dict(names + renamed)
    records = []
    for n in sorted(k_files):
        name = k_files[n]
        rid = "K%02d" % n
        old = old_records.get(rid) or {}
        info = meta.get(name) or {}
        same_file = old.get("file") == "../%s/%s" % (COVERS, name)
        work_id = info.get("work_id") or (old.get("work_id") if same_file else None)
        published = info.get("published_at") or (old.get("published_at") if same_file else None)
        if not work_id:
            m = re.match(r"^作品 (\S+) 的封面（(\d{4}-\d{2}-\d{2} \d{2}:\d{2})?", origin_of.get(name, ""))
            if m:
                work_id = m.group(1)
                published = published or _iso(m.group(2))
        source = info.get("source") or old.get("source") or ("作品.json 里这条作品的封面链接（下载的原图）" if work_id else "用户放进 封面/ 的图片")
        records.append(OrderedDict([
            ("id", rid), ("account_id", None), ("work_id", work_id), ("file", "../%s/%s" % (COVERS, name)),
            ("published_at", published), ("date_source", "作品.json（调研 Skill 拉的作品数据）" if published else "未知"),
            ("source", source), ("preservation", "original-download" if work_id else "provided-copy"),
        ]))
    label = account_label(account)
    all_dated = all(r["published_at"] for r in records)
    downloaded = sum(1 for r in records if r["work_id"])
    if downloaded == len(records):
        verification = "对标账号「%s」最近作品的封面，从调研 Skill 拉的作品数据（作品.json）里的封面链接下载；没有在平台上逐张核验" % label
    elif downloaded:
        verification = "对标账号「%s」的封面：%d 张从作品数据里的封面链接下载，%d 张是用户放进来的；没有在平台上逐张核验" % (label, downloaded, len(records) - downloaded)
    else:
        verification = "用户放进对标账号「%s」封面文件夹的本地图片；没有在线核验，发布时间未知" % label
    selection = OrderedDict([("mode", "latest" if all_dated else "provided"), ("limit", max_count),
                             ("reason", "按作品发布时间取最近的 %d 张" % max_count if all_dated else "研究用户提供的样本，按编号顺序取前 %d 张" % max_count)])
    data = OrderedDict([("account", OrderedDict([("id", None), ("label", label), ("verification", verification)])),
                        ("selection", selection), ("records", records)])
    out = os.path.join(study, RECORDS)
    if os.path.isfile(out):
        os.replace(out, os.path.join(study, "records.上一次.json"))
    write_json(out, data)
    report.update({"count": len(records), "first": records[0]["id"], "last": records[-1]["id"], "records": out, "covers": covers,
                   "mode": selection["mode"]})
    return report


def _free_base(folder, stem):
    """下载的图存成 stem + 实际扩展名：哪种扩展名都还没有同名文件的 stem（不覆盖已有的图）。"""
    candidate, n = stem, 2
    while any(os.path.exists(os.path.join(folder, candidate + ext)) for ext in set(I.EXT_OF_FORMAT.values()) | {".jpeg"}):
        candidate = "%s-%d" % (stem, n)
        n += 1
    return os.path.join(folder, candidate)


def _stamp(published):
    iso = _iso(published)
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso).timestamp()
    except ValueError:
        return None


# ---------- 第二步：研究清单 ----------

def _timestamp(value):
    require(isinstance(value, str) and value.strip(), "缺少发布时间，不能说是最近的样本")
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise StudyError("发布时间不合法：%s" % value)
    if dt.tzinfo is None:
        require(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value), "发布时间缺少时区：%s" % value)
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _image_info(path, rid):
    try:
        return I.file_info(path)
    except FileNotFoundError:
        raise StudyError("%s 的图片找不到了：%s" % (rid, path))
    except (OSError, I.ImageError) as e:
        raise StudyError("%s 打不开（%s）：%s" % (rid, e, path))


def inventory(account):
    """读 VI研究/records.json，查每张能不能打开、有没有重复、纳入了哪些，写 VI研究/inventory.json。"""
    _covers, study = folders(account)
    input_path = os.path.join(study, RECORDS)
    data = _load(input_path, "VI研究/records.json（先跑 vi prepare）")
    require(isinstance(data, dict), "records.json 最外层要是 { … }")
    account_info = data.get("account", {})
    require(isinstance(account_info, dict) and account_info.get("label") and account_info.get("verification"), "account 要有 label 和 verification")
    selection = data.get("selection", {})
    mode, limit = selection.get("mode", "provided"), selection.get("limit", 30)
    require(mode in ("provided", "latest"), "selection.mode 只能是 provided 或 latest")
    require(limit is None or (type(limit) is int and limit > 0), "limit 要是正整数或者 null")
    rows = data.get("records")
    require(isinstance(rows, list) and rows, "records 里至少要有一张图")
    records, seen, known_accounts = [], set(), set()
    for row in rows:
        require(isinstance(row, dict), "records 里每一项都要是 { … }")
        rid = row.get("id", "")
        require(isinstance(rid, str) and ID.fullmatch(rid) and rid not in seen, "图片编号不对或者重复了：%s" % rid)
        seen.add(rid)
        require(isinstance(row.get("file"), str) and row["file"], "%s 缺 file" % rid)
        info = _image_info(os.path.normpath(os.path.join(study, row["file"])), rid)
        if row.get("account_id"):
            known_accounts.add(str(row["account_id"]))
        wid = row.get("work_id")
        require(wid is None or (isinstance(wid, str) and wid.strip()), "%s 的 work_id 要是文字或者 null" % rid)
        require(row.get("preservation", "unknown") in ("original-download", "provided-copy", "historical-transcode", "unknown"), "%s 的 preservation 不对" % rid)
        merged = OrderedDict(row)
        merged.update(info)
        merged["file"], merged["work_id"], merged["selected"] = row["file"], wid, False
        records.append(merged)
    if account_info.get("id"):
        known_accounts.add(str(account_info["id"]))
    require(len(known_accounts) <= 1, "账号标识对不上：先核对是不是同一个博主，不合并")

    groups = OrderedDict()
    for row in records:
        key = ("work", row["work_id"]) if row["work_id"] else ("local-image", row["pixel_sha256"] or row["sha256"])
        groups.setdefault(key, []).append(row)
    candidates, excluded = [], []
    for group in groups.values():
        variants = {r["pixel_sha256"] or r["sha256"] for r in group}
        choices = [r for r in group if r.get("selected_version") is True]
        require(len(choices) <= 1, "同一个作品只能选一个 selected_version")
        require(len(variants) == 1 or len(choices) == 1, "同一个作品有几张不同的封面：在 records.json 里给要研究的那张写 selected_version: true，不自动丢")
        chosen = choices[0] if choices else group[0]
        candidates.append(chosen)
        for row in group:
            if row is not chosen:
                same = (row["pixel_sha256"] or row["sha256"]) == (chosen["pixel_sha256"] or chosen["sha256"])
                row["exclusion_reason"] = "相同作品或像素的重复记录" if same else "保留的非研究封面版本"
                row["represented_by"] = chosen["id"]
                excluded.append(row["id"])
    date_only = False
    if mode == "latest":
        for row in candidates:
            require(row.get("date_source"), "%s 缺 date_source" % row["id"])
        precision = {bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", row.get("published_at") or "")) for row in candidates}
        require(len(precision) == 1, "完整时间和只有日期的不能混着排：核对时间，或者改成 provided")
        date_only = True in precision
        candidates.sort(key=lambda r: _timestamp(r.get("published_at")), reverse=True)
        if date_only and limit is not None and len(candidates) > limit:
            require(candidates[limit - 1]["published_at"] != candidates[limit]["published_at"], "截止处有同一天的几张、没有具体时间，定不了最近的范围：补上时间，或者把那一天的都纳入")
    picked = candidates if limit is None else candidates[:limit]
    selected_ids = [r["id"] for r in picked]
    for row in records:
        row["selected"] = row["id"] in selected_ids
        if row["selected"]:
            row["inclusion_reason"] = selection.get("reason") or ("按真实发布时间纳入最近样本" if mode == "latest" else "用户提供的样本范围")
        elif row["id"] not in excluded:
            row["exclusion_reason"] = "超出本次研究数量范围"
    limitations = []
    if date_only:
        limitations.append("来源只有日期，可按日期分组；同日作品的先后顺序未核验")
    if mode == "provided":
        limitations.append("研究的是提供的样本，不据此宣称账号最新或完整历史")
    if len(picked) < 30:
        limitations.append("实际研究 %d 张；样本量与覆盖范围限制规则的外推" % len(picked))
    if any(not r.get("work_id") for r in picked):
        limitations.append("部分作品 ID 未知，按独立图片去重，不能确认独立作品总数")
    if any(not r.get("account_id") for r in picked):
        limitations.append("部分图片没有账号 ID，身份字段检查不等于平台核验")
    if I.pillow() is None:
        limitations.append("本机没有 Pillow：宽高从文件头读，重复按文件内容认，没有逐张解码确认图片完整")
    result = OrderedDict([
        ("schema_version", 1), ("account", account_info), ("selection", OrderedDict(list(selection.items()) + [("mode", mode), ("limit", limit)])),
        ("counts", _counts(records, picked)), ("selected_ids", selected_ids), ("limitations", limitations), ("records", records),
    ])
    out = os.path.join(study, INVENTORY)
    if os.path.isfile(out):
        os.replace(out, os.path.join(study, "inventory.上一次.json"))
    write_json(out, result)
    return result, out


def _counts(records, picked):
    return OrderedDict([
        ("imported_records", len(records)),
        ("known_works", len({r["work_id"] for r in records if r.get("work_id")})),
        ("unknown_work_records", sum(1 for r in records if r.get("work_id") is None)),
        ("unique_images", len({r.get("pixel_sha256") or r.get("sha256") for r in records})),
        ("research_images", len(picked)),
        ("research_known_works", len({r["work_id"] for r in picked if r.get("work_id")})),
    ])


# ---------- 第三步：校验 ----------

def _nonempty(data, fields, context):
    for key in fields:
        require(isinstance(data.get(key), str) and data[key].strip(), "%s 缺少有效的 %s" % (context, key))


def _id_list(value, allowed, context, allow_empty=True):
    require(isinstance(value, list) and all(isinstance(x, str) for x in value), "%s 要是编号列表" % context)
    require(len(value) == len(set(value)), "%s 有重复的编号" % context)
    require(set(value) <= set(allowed), "%s 引用了范围外的编号：%s" % (context, "、".join(sorted(set(value) - set(allowed)))))
    require(allow_empty or value, "%s 不能是空的" % context)
    return set(value)


def load_pair(account):
    _covers, study = folders(account)
    inv = _load(os.path.join(study, INVENTORY), "VI研究/inventory.json（先跑 vi inventory）")
    study_path = os.path.join(study, STUDY)
    if not os.path.isfile(study_path):
        raise UserError("还没有 VI研究/study.json：逐张看图以后，照 references/evidence.md 的格式写进 %s。" % study_path)
    return inv, _load(study_path, "VI研究/study.json"), study


def validate(inv, study, base):
    """查引用、必填字段、逐图观察齐不齐、频次分组、图片还在不在、字节和尺寸变没变。不合格抛 StudyError。"""
    require(isinstance(inv, dict) and inv.get("schema_version") == 1, "inventory.json 的 schema_version 不对：重新跑 vi inventory")
    require(isinstance(study, dict), "study.json 最外层要是 { … }")
    records = inv.get("records", [])
    require(len({r["id"] for r in records}) == len(records), "清单里的编号重复了")
    rows = {r["id"]: r for r in records}
    selected = _id_list(inv.get("selected_ids"), rows, "selected_ids", False)
    require(selected == {r["id"] for r in records if r.get("selected") is True}, "selected 标记和 selected_ids 对不上：重新跑 vi inventory")
    can_pixel = I.pillow() is not None
    for rid in selected:
        row = rows[rid]
        info = _image_info(os.path.normpath(os.path.join(base, row["file"])), rid)
        keys = ["sha256", "size", "display_size"] + (["pixel_sha256"] if can_pixel and row.get("pixel_sha256") else [])
        require(all(info[k] == row.get(k) for k in keys), "%s 的图片字节或尺寸变了：重新跑 vi prepare 和 vi inventory" % rid)
    require(inv.get("counts", {}) == _counts(records, [rows[r] for r in inv["selected_ids"]]), "清单里的数量和成员对不上：重新跑 vi inventory")
    _nonempty(study, ("title", "summary"), "study.json")
    require(isinstance(study.get("limitations"), list), "study.json 的 limitations 要是列表")
    observations = study.get("observations", [])
    require(isinstance(observations, list), "study.json 的 observations 要是列表")
    obs_ids = _id_list([o.get("id") for o in observations if isinstance(o, dict)], selected, "observations", False)
    missing = sorted(selected - obs_ids)
    require(not missing, "研究范围里还有图没写逐图观察：%s" % "、".join(missing))
    for obs in observations:
        _nonempty(obs, OBS_FIELDS, obs["id"])
        inspect = obs.get("inspection", {})
        require(isinstance(inspect, dict) and inspect.get("status") == "inspected", "%s 还没有实际逐图看过（inspection.status 要是 inspected）" % obs["id"])
        _nonempty(inspect, ("method",), obs["id"] + " 的 inspection")
        require(isinstance(inspect.get("uncertainties"), list), "%s 缺 uncertainties（没有就写空列表）" % obs["id"])
    for group_name in ("rules", "cases"):
        group = study.get(group_name)
        require(isinstance(group, list) and group, "%s 不能是空的；只有一张图也能交付有边界的特征和案例" % group_name)
        ids = [r.get("id") for r in group if isinstance(r, dict)]
        require(len(ids) == len(group) and all(isinstance(i, str) and ID.fullmatch(i) for i in ids) and len(ids) == len(set(ids)), "%s 的编号不对或者重复了" % group_name)
        for rule in group:
            evidence = _id_list(rule.get("evidence_ids"), selected, "%s 的 evidence_ids" % rule["id"], False)
            if group_name == "cases":
                _nonempty(rule, CASE_FIELDS, rule["id"])
                continue
            _nonempty(rule, ("name", "claim", "scope", "boundary", "confidence"), rule["id"])
            exceptions = _id_list(rule.get("exception_ids"), selected, "%s 的 exception_ids" % rule["id"])
            require(not evidence & exceptions, "%s 的证据和例外有同一张图" % rule["id"])
            freq = rule.get("frequency")
            if freq is not None:
                require(isinstance(freq, dict), "%s 的 frequency 要是 { … } 或者 null" % rule["id"])
                _nonempty(freq, ("criterion",), rule["id"] + " 的 frequency")
                scope = _id_list(freq.get("scope_ids"), selected, "%s 的 frequency.scope_ids" % rule["id"], False)
                p, a, u = [_id_list(freq.get(k), scope, "%s 的 %s" % (rule["id"], k)) for k in ("present_ids", "absent_ids", "unknown_ids")]
                require(not (p & a or p & u or a & u) and p | a | u == scope, "%s 的频次三组要互不重复、合起来正好是统计范围" % rule["id"])
                require(evidence <= p and not exceptions & p, "%s 的证据要在命中组里，例外不能在命中组里" % rule["id"])
    review = study.get("review", {})
    require(isinstance(review, dict), "study.json 的 review 要是 { … }")
    choices = {"visual_facts": ("not-reviewed", "self-reviewed"), "migration": ("not-run", "partial", "reviewed"), "aesthetic": ("pending", "accepted", "rejected")}
    for k, values in choices.items():
        require(review.get(k) in values, "review.%s 只能是 %s" % (k, "、".join(values)))
    if review["migration"] != "not-run" or review["aesthetic"] != "pending":
        _nonempty(review, ("evidence",), "review")
    return {"checked_images": len(selected), "rules": len(study["rules"]), "cases": len(study["cases"]),
            "limits": "仅检查文件、结构和引用；不代表视觉事实、网页交互或审美已通过"}


def check(account):
    inv, study, base = load_pair(account)
    return validate(inv, study, base)


# ---------- 第四步：出对照网页 ----------

def frequency_text(rule):
    freq = rule.get("frequency")
    if not freq:
        return "未主张频次"
    p, a, u = [len(freq[k]) for k in ("present_ids", "absent_ids", "unknown_ids")]
    return "%d / %d 张可判，另有 %d 张不可判；统计范围共 %d 张" % (p, p + a, u, p + a + u)


def build(account, reports_dir):
    """先校验，过了才在「调研报告」里新建「<日期>_<账号名>封面VI」：index.html、VI规范.md、清单和研究数据、images/、meta.json。
    同一天再出一次，文件夹名后面加 -2，不覆盖旧的。"""
    inv, study, base = load_pair(account)
    result = validate(inv, study, base)
    label = account_label(account)
    os.makedirs(reports_dir, exist_ok=True)
    out = unique_dir(reports_dir, "%s_%s封面VI" % (today(), safe_name(label, 40, "对标账号")))
    os.makedirs(os.path.join(out, "images"))
    portable = json.loads(json.dumps(inv), object_pairs_hook=OrderedDict)
    by_id = {}
    for row in portable["records"]:
        if row["selected"]:
            target = "images/" + row["id"] + I.EXT_OF_FORMAT[row["format"]]
            shutil.copyfile(os.path.normpath(os.path.join(base, row["file"])), os.path.join(out, target))
            require(_digest(os.path.join(out, target)) == row["sha256"], "图片副本和原图对不上：%s" % row["id"])
            row["file"] = target
            by_id[row["id"]] = row
        else:
            row["file"] = None  # 没纳入的不跟着报告走
    write_json(os.path.join(out, INVENTORY), portable)
    write_json(os.path.join(out, STUDY), study)
    esc = lambda v: html.escape(str(v), quote=True)  # noqa: E731
    refs = lambda ids: " ".join('<a class="evidence" href="#sample-%s">%s</a>' % (esc(i), esc(i)) for i in ids) or "无"  # noqa: E731
    rules_html = []
    for rule in study["rules"]:
        frequency = rule.get("frequency")
        members = ""
        if frequency:
            members = '<details><summary>查看完整统计成员</summary>' + "".join("<p>%s：%s</p>" % (label_, refs(frequency[key])) for key, label_ in (("scope_ids", "统计范围"), ("present_ids", "命中"), ("absent_ids", "未命中"), ("unknown_ids", "不可判"))) + "</details>"
        rules_html.append('<article class="rule"><h3>%s</h3><p>%s</p><dl><dt>适用范围</dt><dd>%s</dd><dt>证据</dt><dd>%s</dd><dt>例外</dt><dd>%s</dd><dt>边界</dt><dd>%s</dd><dt>判断依据</dt><dd>%s</dd></dl><p class="muted">%s</p>%s</article>'
                          % (esc(rule["name"]), esc(rule["claim"]), esc(rule["scope"]), refs(rule["evidence_ids"]), refs(rule["exception_ids"]), esc(rule["boundary"]), esc(rule["confidence"]), esc(frequency_text(rule)), members))
    cases_html = []
    for case in study["cases"]:
        lines = "".join("<dt>%s</dt><dd>%s</dd>" % (LABELS[k], esc(case[k])) for k in CASE_FIELDS if k != "name")
        cases_html.append('<article class="rule"><h3>%s</h3><p>%s</p><dl>%s</dl></article>' % (esc(case["name"]), refs(case["evidence_ids"]), lines))
    observations = {o["id"]: o for o in study["observations"]}
    cards = []
    md = ["# " + study["title"], "", study["summary"], "", "## 研究范围", "", "研究 %d 张，来源说明：%s" % (len(inv["selected_ids"]), inv["account"]["verification"]), ""]
    limitations = list(OrderedDict.fromkeys(list(inv["limitations"]) + list(study["limitations"])))
    md += ["## 限制", ""] + ["- " + x for x in limitations] + ["", "## 视觉规则", ""]
    md_refs = lambda ids: "、".join("[%s](%s)" % (i, by_id[i]["file"]) for i in ids) or "无"  # noqa: E731
    for rule in study["rules"]:
        md += ["### " + rule["name"], "", rule["claim"], "", "适用范围：" + rule["scope"], "证据：" + md_refs(rule["evidence_ids"]), "例外：" + md_refs(rule["exception_ids"]),
               "边界：" + rule["boundary"], "判断依据：" + rule["confidence"], frequency_text(rule), ""]
        if rule.get("frequency"):
            md += ["%s：%s" % (label_, md_refs(rule["frequency"][key])) for key, label_ in (("scope_ids", "统计范围"), ("present_ids", "命中"), ("absent_ids", "未命中"), ("unknown_ids", "不可判"))] + [""]
    md += ["## 构图复用案例", ""]
    for case in study["cases"]:
        md += ["### " + case["name"], "", "证据：" + md_refs(case["evidence_ids"]), ""] + ["%s：%s" % (LABELS[k], case[k]) for k in CASE_FIELDS if k != "name"] + [""]
    md += ["## 逐图观察", ""]
    for rid in inv["selected_ids"]:
        row, obs = by_id[rid], observations[rid]
        dims = " × ".join(map(str, row["display_size"]))
        inspection = obs["inspection"]
        uncertainties = "；".join(inspection["uncertainties"]) or "当前观察未记录局部不确定项"
        details = "".join("<dt>%s</dt><dd>%s</dd>" % (LABELS[k], esc(obs[k])) for k in OBS_FIELDS)
        search = json.dumps(obs, ensure_ascii=False)
        cards.append('<article class="sample" id="sample-%s" data-search="%s"><div class="visual"><button class="enlarge" data-id="%s" data-src="%s" aria-label="放大 %s"><img loading="lazy" src="%s" alt="%s 来源封面" width="%d" height="%d"></button><p>%s · %s px</p><button class="compare" data-id="%s" data-src="%s" aria-pressed="false">加入对比</button></div><div><h3>%s</h3><p class="muted">来源：%s<br>发布时间：%s · %s</p><dl>%s</dl><p class="inspection">实际检查：%s<br>不确定项：%s</p></div></article>'
                     % (esc(rid), esc(search), esc(rid), esc(row["file"]), esc(rid), esc(row["file"]), esc(rid), row["display_size"][0], row["display_size"][1], esc(rid), esc(dims),
                        esc(rid), esc(row["file"]), esc(rid), esc(row.get("source") or "未知"), esc(row.get("published_at") or "未知"), esc(row.get("preservation", "unknown")),
                        details, esc(inspection["method"]), esc(uncertainties)))
        md += ["### " + rid, "", "![%s](%s)" % (rid, row["file"]), "", "尺寸：%s px；发布时间：%s；来源：%s" % (dims, row.get("published_at") or "未知", row.get("source") or "未知"), ""]
        md += ["%s：%s" % (LABELS[k], obs[k]) for k in OBS_FIELDS] + ["实际检查：" + inspection["method"], "不确定项：" + uncertainties, ""]
    review = "；".join("%s：%s" % (label_, REVIEW_NAMES[study["review"][key]]) for key, label_ in (("visual_facts", "画面事实"), ("migration", "迁移验证"), ("aesthetic", "审美评审")))
    if study["review"].get("evidence"):
        review += "。依据：" + study["review"]["evidence"]
    md += ["## 验证边界", "", review, "", result["limits"]]
    write_text(os.path.join(out, "VI规范.md"), "\n\n".join(md))
    with open(os.path.join(ASSETS, "report.html"), encoding="utf-8") as f:
        template = f.read()
    replacements = {"TITLE": esc(study["title"]), "SUMMARY": esc(study["summary"]),
                    "SCOPE": esc("%d 张研究封面 · %d 张独立图片 · %d 条导入记录" % (len(inv["selected_ids"]), inv["counts"]["unique_images"], inv["counts"]["imported_records"])),
                    "SOURCE": esc(inv["account"]["verification"]), "LIMITATIONS": "".join("<li>%s</li>" % esc(x) for x in limitations), "REVIEW": esc(review),
                    "RULES": "".join(rules_html), "CASES": "".join(cases_html), "CARDS": "".join(cards)}
    write_text(os.path.join(out, "index.html"), re.sub(r"\{\{([A-Z]+)\}\}", lambda m: replacements[m.group(1)], template))
    meta = OrderedDict([("title", "%s的封面 VI" % label), ("date", today()), ("type", REPORT_TYPE), ("source", os.path.basename(account)),
                        ("pages", ["index.html"]), ("workbenchVisible", True)])
    write_json(os.path.join(out, "meta.json"), meta)
    result.update({"output": out, "index": os.path.join(out, "index.html"), "title": meta["title"]})
    return result


def latest_report(account, reports_dir):
    """这个对标账号最近一次出的封面 VI 报告文件夹（meta.json 的 type 是「封面VI」、source 是它的文件夹名）。没有返回 None。"""
    name = os.path.basename(account)
    found = []
    try:
        entries = os.listdir(reports_dir)
    except OSError:
        return None
    for entry in entries:
        meta_path = os.path.join(reports_dir, entry, "meta.json")
        try:
            meta = read_json(meta_path)
        except (OSError, ValueError):
            continue
        if isinstance(meta, dict) and meta.get("type") == REPORT_TYPE and meta.get("source") == name:
            found.append((str(meta.get("date") or ""), natural_key(entry), entry))
    if not found:
        return None
    return os.path.join(reports_dir, max(found)[2])


# ---------- 第五步：导出 VI拆解.md ----------

def check_style(style):
    name = str(style or "").strip()
    require(name and "\n" not in name and "：" not in name, "风格名要是一句话里的四到八个字，比如「暖黄手写风」")
    require(4 <= len(name) <= 8, "风格名要四到八个字（「%s」是 %d 个字），说得出画面特点，比如「暖黄手写风」" % (name, len(name)))
    return name


def export(account, reports_dir, style=None):
    """把 study.json（逐图观察、规则、案例）导出成做封面时读的 VI拆解.md，放在对标账号文件夹里。第二行固定「风格名：…」。
    style 不给时沿用 VI拆解.md 里原来的风格名。"""
    covers, study_dir = folders(account)
    study_path = os.path.join(study_dir, STUDY)
    if not os.path.isfile(study_path):
        raise UserError("还没有 VI研究/study.json：先逐张看图、写观察（格式见 references/evidence.md）。")
    study = _load(study_path, "VI研究/study.json")
    inv_path = os.path.join(study_dir, INVENTORY)
    inv = _load(inv_path, "VI研究/inventory.json") if os.path.isfile(inv_path) else None
    style = check_style(style) if style else S.style_name(account)
    if not style:
        raise UserError("要给这套风格起个名字：加 --style「四到八个字」，说得出画面特点，比如「暖黄手写风」。")
    label = account_label(account)
    obs = {o["id"]: o for o in study.get("observations", []) if isinstance(o, dict) and o.get("id")}
    ids = list(inv["selected_ids"]) if inv else sorted(obs)
    files = {}
    if inv:
        for r in inv["records"]:
            files[r["id"]] = COVERS + "/" + os.path.basename(r["file"])
    if os.path.isdir(covers):
        for name in os.listdir(covers):
            stem = os.path.splitext(name)[0]
            if stem in ids and stem not in files:
                files[stem] = COVERS + "/" + name
    link = lambda i: "[%s](%s)" % (i, files.get(i, i))  # noqa: E731
    links = lambda arr: "、".join(link(i) for i in arr) if arr else "无"  # noqa: E731
    report = latest_report(account, reports_dir)
    where = "能点原图对比的网页在工作台「市场调研」的调研报告「%s」里" % os.path.basename(report) if report else "能点原图对比的网页还没出（vi build）"
    md = ["# %s：封面 VI 拆解" % label, S.STYLE_PREFIX + style, ""]
    md.append("对象是对标账号「%s」的 %d 张封面（封面/ 里的 %s 到 %s）。%s观察和迁移建议不是作者的官方规范，也不以播放量证明效果。完整研究数据在 VI研究/，%s。"
              % (label, len(ids), ids[0] if ids else "", ids[-1] if ids else "", (study.get("summary", "").strip() + " ") if study.get("summary") else "", where))
    md.append("")
    md.append("用法：做封面时每张候选选一张原图当构图参考，实际打开看，再照下面的「保留关系」写画面；原图会作为第二张输入图交给生图工具，提示词里必须写明「只换成我这个人，不混脸、不继承对方的发型衣服」。")
    md.append("")
    md.append("## 整体规律")
    md.append("")
    for r in study.get("rules", []):
        line = "- **%s。** %s" % (r["name"].rstrip("。"), r["claim"].strip())
        extras = []
        if r.get("scope"):
            extras.append("适用：%s" % r["scope"])
        if r.get("exception_ids"):
            extras.append("例外：%s" % links(r["exception_ids"]))
        if r.get("evidence_ids"):
            extras.append("证据：%s" % links(r["evidence_ids"]))
        if extras:
            line += "（" + "；".join(extras) + "）"
        md.append(line)
    md.append("")
    md.append("## 整组最值得保留的关系")
    md.append("")
    for c in study.get("cases", []):
        md.append("- **%s。** %s 保留：%s 替换：%s（看 %s）" % (c["name"].rstrip("。"), c["relations"].strip(), c["keep"].strip(), c["replace"].strip(), links(c["evidence_ids"])))
    md.append("")
    md.append("## 逐图保留关系与容易丢失的部分")
    md.append("")
    md.append("| 原图 | 需要保留的空间和视觉关系 | 迁移时避免 |")
    md.append("|---|---|---|")
    for i in ids:
        o = obs.get(i, {})
        keep = "；".join(x.strip() for x in (o.get("subject_action", ""), o.get("space", "")) if x)
        md.append("| %s | %s | %s |" % (link(i), keep.replace("|", "／").replace("\n", " "), o.get("transfer", "").replace("|", "／").replace("\n", " ")))
    md.append("")
    md.append("## 选图建议")
    md.append("")
    for c in study.get("cases", []):
        md.append("- %s：%s。失败表现：%s" % (c["when"].strip().rstrip("。"), links(c["evidence_ids"]), c["failure"].strip()))
    md.append("")
    md.append("一张候选只选一个主要构图参考。同一原图可以发展多个确有区别的方案，不要求每题覆盖固定类别。原图是构图参照，用户人像是唯一身份参照。")
    md.append("")
    md.append("## 逐图观察")
    md.append("")
    md.append("| 编号与原图 | 人物动作 | 空间结构 | 文字、材质与变化 |")
    md.append("|---|---|---|---|")
    for i in ids:
        o = obs.get(i, {})
        tm = "；".join(x.strip() for x in (o.get("typography", ""), o.get("color_material", "")) if x)
        cells = [link(i), o.get("subject_action", ""), o.get("space", ""), tm]
        md.append("| " + " | ".join(c.replace("|", "／").replace("\n", " ") for c in cells) + " |")
    md.append("")
    md.append("## 限制与验证边界")
    md.append("")
    lim = list(OrderedDict.fromkeys(list(inv["limitations"] if inv else []) + list(study.get("limitations", []))))
    for x in lim:
        md.append("- %s" % x)
    rv = study.get("review", {})
    names = {"not-reviewed": "未复核", "self-reviewed": "执行者已自行复核", "not-run": "未执行", "partial": "部分完成", "reviewed": "本轮已检查",
             "pending": "待用户评审", "accepted": "用户已认可", "rejected": "用户未认可"}
    md.append("- 画面事实：%s；迁移验证：%s；审美评审：%s" % (names.get(rv.get("visual_facts"), rv.get("visual_facts")), names.get(rv.get("migration"), rv.get("migration")),
                                                     names.get(rv.get("aesthetic"), rv.get("aesthetic"))))
    md.append("")
    out = os.path.join(account, S.VI_FILE)
    write_text(out, "\n".join(md))
    return {"path": out, "count": len(ids), "rules": len(study.get("rules", [])), "cases": len(study.get("cases", [])), "style": style, "report": report}
