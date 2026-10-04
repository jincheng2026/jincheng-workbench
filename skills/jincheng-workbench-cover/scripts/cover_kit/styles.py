"""风格：一组拿来学的封面图，加上从它们拆出来的封面 VI。两种来源，一个说法（约定见 docs/开发记录.md「封面 Skill」第二版）：

    | 来源             | 风格编号                                        | 文件夹                         |
    | 对标账号         | 账号文件夹名，比如「抖音-某某」                   | <对标账号>/<平台>-<账号名>/     |
    | 你放进来的几张图 | 「风格/<文件夹名>」，比如「风格/2026-10-04_8张」   | <封面素材>/风格/<文件夹名>/     |

- 两种文件夹里拆 VI 的东西一样：封面/（K01、K02……，改名前后的对照在 封面/原文件名.md）、VI研究/、VI拆解.md（第二行「风格名：…」）、默认构图.json。
- 「你放进来的几张图」的文件夹由工作台建：图按原文件名放进 封面/，再写 风格.json（{"from", "createdAt", "count"}），建好就不改名。
  这里的 split 把其中几张挪进一个新的风格文件夹（只对这一种；对标账号不拆分文件夹）。
- 默认构图.json：{"ids": ["K03", …], "by": "AI" 或 "你", "updatedAt": "<带时区的时间>"}。出一批时默认参考这几张；
  by 是「你」的（用户在工作台改过）AI 不覆盖。编号必须是这个风格 封面/ 里有的图。
"""
import os
import re
from collections import OrderedDict
from datetime import datetime

from . import UserError
from . import images as I
from .text import minute, natural_key, now, read_json, unique_dir, unique_file, write_json, write_text

STYLE_DIR = "风格"
ID_PREFIX = STYLE_DIR + "/"
STYLE_JSON = "风格.json"
COMPOSITIONS = "默认构图.json"
COVERS = "封面"
VI_FILE = "VI拆解.md"
STYLE_NAME_PREFIX = "风格名："
NAMES_FILE = "原文件名.md"
MOVES_HEAD = "## 挪动记录"
KIND_ACCOUNT, KIND_IMAGES = "account", "images"
K_FILE = re.compile(r"^K(\d{2,3})\.([A-Za-z0-9]+)$")
DEFAULT_COMPOSITIONS = 5
BY_AI, BY_USER = "AI", "你"


def styles_root(places):
    return os.path.join(places["cover_assets"], STYLE_DIR)


def stamp():
    """带时区的现在时间，到秒：2026-10-04T21:00:00+08:00。"""
    return now().astimezone().replace(microsecond=0).isoformat()


def style_name(folder):
    """这个风格的风格名：VI拆解.md 第二行「风格名：…」。没有 VI拆解.md 或者没写，返回 None。"""
    try:
        with open(os.path.join(folder, VI_FILE), encoding="utf-8-sig") as f:
            lines = f.read().splitlines()
    except OSError:
        return None
    if len(lines) >= 2 and lines[1].startswith(STYLE_NAME_PREFIX):
        name = lines[1][len(STYLE_NAME_PREFIX):].strip()
        return name or None
    return None


def account_label(folder):
    """给人看的账号名：档案.json 的 account_name；没有就用文件夹名去掉「平台-」。"""
    try:
        name = (read_json(os.path.join(folder, "档案.json")) or {}).get("account_name")
        if isinstance(name, str) and name.strip():
            return name.strip()
    except (OSError, ValueError, AttributeError):
        pass
    base = os.path.basename(folder)
    return base.split("-", 1)[1] if "-" in base else base


def account_platform(folder):
    try:
        value = (read_json(os.path.join(folder, "档案.json")) or {}).get("platform")
        if isinstance(value, str) and value.strip():
            return value.strip()
    except (OSError, ValueError, AttributeError):
        pass
    base = os.path.basename(folder)
    return base.split("-", 1)[0] if "-" in base else None


class Style(object):
    """一个风格：kind 是 account（对标账号）或 images（你放进来的图），id 是风格编号，folder 是它的文件夹。"""

    def __init__(self, kind, sid, folder):
        self.kind = kind
        self.id = sid
        self.folder = folder

    @property
    def is_account(self):
        return self.kind == KIND_ACCOUNT

    @property
    def covers(self):
        return os.path.join(self.folder, COVERS)

    @property
    def vi_file(self):
        return os.path.join(self.folder, VI_FILE)

    def name(self):
        return style_name(self.folder)

    def done(self):
        return os.path.isfile(self.vi_file)

    def done_date(self):
        """VI拆解.md 最后一次导出是哪天。"""
        try:
            return datetime.fromtimestamp(os.path.getmtime(self.vi_file)).strftime("%Y-%m-%d")
        except OSError:
            return None

    def images(self):
        """封面/ 里报告网页能显示的图（文件名，按人的习惯排）。"""
        try:
            names = os.listdir(self.covers)
        except OSError:
            return []
        return sorted((n for n in names if not n.startswith(".") and os.path.splitext(n)[1].lower() in I.FORMAT_OF_EXT
                       and os.path.isfile(os.path.join(self.covers, n))), key=natural_key)

    def k_images(self):
        """封面/ 里已经编了号的图：{"K01": "K01.jpg", …}。"""
        out = OrderedDict()
        for name in self.images():
            m = K_FILE.match(name)
            if m:
                out["K%02d" % int(m.group(1))] = name
        return out

    def label(self):
        """给人看的名字：对标账号是账号名；放进来的图是「放进来的 N 张图」。"""
        if self.is_account:
            return account_label(self.folder)
        return "放进来的 %d 张图" % len(self.images())

    def source_text(self):
        """一句话说这个风格从哪来：对标账号「某某」（抖音）；你放进工作台「封面」的图「风格/…」。"""
        if self.is_account:
            platform = account_platform(self.folder)
            return "对标账号「%s」%s" % (account_label(self.folder), "（%s）" % platform if platform else "")
        return "你放进工作台「封面」的图「%s」" % self.id

    def __repr__(self):
        return "Style(%s)" % self.id


def _missing(places, raw):
    return UserError("认不出风格「%s」：「对标账号」里没有「%s」（%s），「封面素材/风格」里也没有（%s）。风格编号写对标账号的文件夹名（比如「抖音-某某」），"
                     "或者「风格/<文件夹名>」（你放进工作台「封面」的那组图），现有的风格用 where 看。是个新博主、有主页链接的话，先用调研 Skill 把他加进对标账号；"
                     "只有他的一批封面图的话，先用调研 Skill 手动建档（account add --manual），再接着做。"
                     % (raw, raw, places["accounts"], styles_root(places)))


def resolve(places, text):
    """风格编号 → Style。认：对标账号文件夹名（「抖音-某某」）、「风格/<文件夹名>」、两种文件夹（或它的 封面/）的完整路径；
    只写了 <文件夹名> 的，对标账号里没有就去「封面素材/风格」里找。找不到报错。"""
    raw = str(text or "").strip()
    value = raw.replace("／", "/").rstrip("/")
    if not value:
        raise UserError("要告诉我是哪个风格：对标账号写它的文件夹名（比如「抖音-某某」），你放进工作台「封面」的那组图写「风格/<文件夹名>」"
                        "（比如「风格/2026-10-04_8张」）。现有的风格用 where 看。")
    root = styles_root(places)
    if value.startswith(ID_PREFIX):
        name = value[len(ID_PREFIX):]
        if name and "/" not in name and not name.startswith(".") and os.path.isdir(os.path.join(root, name)):
            return Style(KIND_IMAGES, ID_PREFIX + name, os.path.join(root, name))
        raise _missing(places, raw)
    if "/" not in value and not value.startswith("."):
        if os.path.isdir(os.path.join(places["accounts"], value)):
            return Style(KIND_ACCOUNT, value, os.path.join(places["accounts"], value))
        if os.path.isdir(os.path.join(root, value)):
            return Style(KIND_IMAGES, ID_PREFIX + value, os.path.join(root, value))
        raise _missing(places, raw)
    path = os.path.expanduser(value)
    if os.path.isabs(path):
        path = os.path.abspath(path)
        if os.path.basename(path) == COVERS:
            path = os.path.dirname(path)
        name = os.path.basename(path)
        if os.path.isdir(path) and name and not name.startswith("."):
            parent = os.path.realpath(os.path.dirname(path))
            if parent == os.path.realpath(places["accounts"]):
                return Style(KIND_ACCOUNT, name, os.path.join(places["accounts"], name))
            if parent == os.path.realpath(root):
                return Style(KIND_IMAGES, ID_PREFIX + name, os.path.join(root, name))
    raise _missing(places, raw)


def all_styles(places):
    """全部风格：先对标账号（按文件夹名），再放进来的图（按文件夹名）。"""
    out = []
    for base, kind in ((places["accounts"], KIND_ACCOUNT), (styles_root(places), KIND_IMAGES)):
        try:
            names = sorted((n for n in os.listdir(base) if not n.startswith(".")), key=natural_key)
        except OSError:
            continue
        for name in names:
            folder = os.path.join(base, name)
            if os.path.isdir(folder):
                out.append(Style(kind, name if kind == KIND_ACCOUNT else ID_PREFIX + name, folder))
    return out


# ---------- 原图编号 ----------

def k_id(text):
    """「K3」「k03」「K003」都认成 K03；认不出返回 None。"""
    m = re.fullmatch(r"[Kk]\s*0*(\d{1,3})", str(text or "").strip())
    if not m or int(m.group(1)) < 1:
        return None
    return "K%02d" % int(m.group(1))


def parse_ids(values, what="原图编号"):
    """几个原图编号：可以是一个列表，也可以是「K03,K07」「K03、K07」「K03 K07」。去掉重复、保留先后。写错的报错。"""
    items = values if isinstance(values, (list, tuple)) else [values]
    out, bad = [], []
    for item in items:
        for part in re.split(r"[,，、;；\s]+", str(item or "").strip()):
            if not part:
                continue
            kid = k_id(part)
            if kid is None:
                bad.append(part)
            elif kid not in out:
                out.append(kid)
    if bad:
        raise UserError("%s写成 K03 这样（收到的有「%s」）。" % (what, "」「".join(bad)))
    return out


def check_ids(style, ids, what="原图编号"):
    """这几个编号都要是这个风格 封面/ 里有的图；不是的报错。返回 {编号: 文件名}。"""
    have = style.k_images()
    missing = [i for i in ids if i not in have]
    if missing:
        if have:
            ks = list(have)
            range_text = "有 %s" % (ks[0] if len(ks) == 1 else "%s 到 %s" % (ks[0], ks[-1]))
        else:
            range_text = "还没有编号的图，先跑 vi prepare"
        raise UserError("「%s」的 封面/ 里没有 %s（%s）：%s要是这个风格 封面/ 里真有的图。" % (style.id, "、".join(missing), range_text, what))
    return OrderedDict((i, have[i]) for i in ids)


# ---------- 默认构图.json ----------

def read_compositions(style):
    """默认构图.json：{"ids", "by", "updatedAt", "path", "problem"}；没有这个文件返回 None。写坏了 problem 写原因、ids 是空的。"""
    path = os.path.join(style.folder, COMPOSITIONS)
    if not os.path.isfile(path):
        return None
    out = {"ids": [], "by": None, "updatedAt": None, "path": path, "problem": None}
    try:
        data = read_json(path)
    except (OSError, ValueError) as e:
        out["problem"] = "默认构图.json 写坏了（%s）" % e
        return out
    if not isinstance(data, dict) or not isinstance(data.get("ids"), list):
        out["problem"] = "默认构图.json 里要有 ids（原图编号的列表）"
        return out
    ids = []
    for x in data["ids"]:
        kid = k_id(x)
        if kid and kid not in ids:
            ids.append(kid)
    out.update(ids=ids, by=data.get("by") if isinstance(data.get("by"), str) else None,
               updatedAt=data.get("updatedAt") if isinstance(data.get("updatedAt"), str) else None)
    return out


def write_compositions(style, ids, by=BY_AI):
    """写默认构图：已经有、by 是「你」的（用户在工作台改过）不覆盖。返回 (写了没有, 现在的默认构图)。"""
    current = read_compositions(style)
    if current and not current["problem"] and current["by"] == BY_USER:
        return False, current
    write_json(os.path.join(style.folder, COMPOSITIONS), OrderedDict([("ids", list(ids)), ("by", by), ("updatedAt", stamp())]))
    return True, read_compositions(style)


def compositions_from_study(study, have, limit=DEFAULT_COMPOSITIONS):
    """没说默认构图时：按 study.json 里案例的顺序，取前 limit 个不重复、封面/ 里真有的原图编号。"""
    out = []
    for case in study.get("cases") or []:
        if not isinstance(case, dict):
            continue
        for x in case.get("evidence_ids") or []:
            kid = k_id(x)
            if kid and kid in have and kid not in out:
                out.append(kid)
            if len(out) >= limit:
                return out
    return out


def describe_compositions(info):
    """给人看的一句：K03、K07（AI 挑的）。"""
    if not info:
        return "还没有"
    if info["problem"]:
        return info["problem"]
    if not info["ids"]:
        return "是空的"
    by = {BY_AI: "AI 挑的", BY_USER: "你改过的"}.get(info["by"], "不知道谁定的")
    return "%s（%s）" % ("、".join(info["ids"]), by)


# ---------- 风格.json（只有放进来的图有）----------

def read_style_json(folder):
    try:
        data = read_json(os.path.join(folder, STYLE_JSON))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


# ---------- 原文件名.md ----------

NAMES_INTRO = "封面/ 里的图按顺序改名成 K01、K02……（从新到旧；不知道发布时间的按给的顺序），原来的名字记在这里。图没有删，只是改了名。"


def read_names(covers_dir):
    """原文件名.md：(对照表 [(新名, 原名)], 挪动记录 [「- …」那几行])。没有这个文件就都是空的。"""
    try:
        with open(os.path.join(covers_dir, NAMES_FILE), encoding="utf-8-sig") as f:
            lines = f.read().splitlines()
    except OSError:
        return [], []
    rows, moves, in_moves = [], [], False
    for line in lines:
        s = line.strip()
        if s.startswith("## "):
            in_moves = s == MOVES_HEAD
            continue
        if in_moves:
            if s.startswith("- "):
                moves.append(s)
            continue
        cells = [c.strip() for c in s.strip("|").split("|")] if s.startswith("|") else []
        if len(cells) >= 2 and K_FILE.match(cells[0]):
            rows.append((cells[0], cells[1]))
    return rows, moves


def write_names(covers_dir, rows, skipped=(), moves=()):
    lines = ["# 原文件名对照", "", NAMES_INTRO, "", "| 新名 | 原名 |", "| --- | --- |"]
    lines += ["| %s | %s |" % (new, old.replace("|", "／")) for new, old in rows]
    if skipped:
        lines += ["", "没纳入的（报告网页显示不了这几种格式，转成 jpg 或 png 再放进来）：" + "、".join(skipped)]
    if moves:
        lines += ["", MOVES_HEAD, ""] + list(moves)
    write_text(os.path.join(covers_dir, NAMES_FILE), "\n".join(lines) + "\n")


def _skipped_line(covers_dir):
    try:
        with open(os.path.join(covers_dir, NAMES_FILE), encoding="utf-8-sig") as f:
            for line in f:
                if line.startswith("没纳入的"):
                    return [x for x in line.split("：", 1)[1].strip().split("、") if x]
    except (OSError, IndexError):
        pass
    return []


def original_name(old, current):
    """改名前叫什么（挪回原文件名用）：原文件名.md 里记的原名去掉「（从 … 复制）」；下载的（作品 … 的封面）和记不清的，用现在的名字。"""
    text = re.sub(r"（从 .+ 复制）$", "", str(old or "")).strip()
    if not text or text.startswith("作品 ") or "/" in text or "\\" in text or text.startswith("."):
        return current
    stem, ext = os.path.splitext(text)
    if not stem or ext.lower() not in I.FORMAT_OF_EXT:
        return text + os.path.splitext(current)[1]
    return text


# ---------- 拆出来不是一种风格：分出去 ----------

def split(places, style, ids):
    """把「你放进来的图」这种风格里的几张，挪进一个新的风格文件夹（风格/<原文件夹名>-2，重名往后排），挪回原文件名；
    两边的 封面/原文件名.md 都记一笔，新文件夹写 风格.json；原来的风格.json 的张数、默认构图.json 里挪走的编号跟着改。"""
    if style.is_account:
        raise UserError("「%s」是对标账号：对标账号不拆分文件夹。他的封面里有两种风格的，在 VI拆解里写明（分成两组规律，各写适用范围），不用 style split。" % style.id)
    wanted = parse_ids(ids)
    if not wanted:
        raise UserError("要写分出去哪几张：style split \"%s\" K04 K07 K09" % style.id)
    have = style.k_images()
    if not have:
        raise UserError("「%s」的 封面/ 里还没有编了号的图（K01 这种）：先跑 vi prepare 把图编上号，逐张看完再分。" % style.id)
    picked = check_ids(style, wanted, "要分出去的")
    if len(picked) >= len(have):
        raise UserError("不能全挪走：分出去的是其中一部分，剩下的留在「%s」（现在一共 %d 张）。" % (style.id, len(have)))
    root = styles_root(places)
    target = unique_dir(root, os.path.basename(style.folder))  # 原来的名字已经有了：从 -2 往后排
    new_id = ID_PREFIX + os.path.basename(target)
    os.makedirs(os.path.join(target, COVERS))
    rows, moves = read_names(style.covers)
    old_of = dict(rows)
    when = minute()
    moved = []
    for kid, name in picked.items():
        restored = original_name(old_of.get(name), name)
        stem, ext = os.path.splitext(restored)
        dest = unique_file(os.path.join(target, COVERS), stem, ext)
        os.rename(os.path.join(style.covers, name), dest)
        moved.append((kid, name, os.path.basename(dest)))
    moved_names = {m[1] for m in moved}
    write_names(style.covers, [r for r in rows if r[0] not in moved_names], _skipped_line(style.covers),
                moves + ["- %s 分出去 %d 张，挪进了 %s，名字改回原名：%s" % (when, len(moved), new_id, "、".join("%s → %s" % (m[1], m[2]) for m in moved))])
    write_names(os.path.join(target, COVERS), [], (),
                ["- %s 从 %s 分过来 %d 张，名字改回原名：%s" % (when, style.id, len(moved), "、".join("%s（那边的 %s）" % (m[2], m[1]) for m in moved))])
    write_json(os.path.join(target, STYLE_JSON), OrderedDict([("from", "从 %s 分出来" % style.id), ("createdAt", stamp()), ("count", len(moved))]))
    left = style.k_images()
    changed = []
    meta = read_style_json(style.folder)
    if meta is not None and meta.get("count") != len(style.images()):
        meta["count"] = len(style.images())
        write_json(os.path.join(style.folder, STYLE_JSON), meta)
        changed.append("风格.json 的张数改成了 %d" % meta["count"])
    comp = read_compositions(style)
    if comp and not comp["problem"] and set(comp["ids"]) & set(picked):
        keep = [i for i in comp["ids"] if i not in picked]
        write_json(comp["path"], OrderedDict([("ids", keep), ("by", comp["by"] or BY_AI), ("updatedAt", stamp())]))
        changed.append("默认构图去掉了挪走的 %s，剩 %s" % ("、".join(i for i in comp["ids"] if i in picked), "、".join(keep) or "没有"))
    return {"new_id": new_id, "new_folder": target, "moved": moved, "left": list(left), "changed": changed,
            "had_vi": style.done(), "new_style": Style(KIND_IMAGES, new_id, target)}
