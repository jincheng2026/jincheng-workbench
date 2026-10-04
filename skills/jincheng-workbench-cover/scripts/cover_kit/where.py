"""cover.py where：工作台仓库、设置文件、工作文件夹、这个对话打开的文件夹和读写、工作台在不在运行、封面素材和封面设置、
人物参考图片（出封面用哪几张）、全部风格（对标账号和放进来的图：风格名、几张原图、默认构图、是不是默认风格）；
给了内容编号，再说这条内容的草稿文件夹、封面候选、下一张的编号、第几批、上一批用的尺寸、生成记录在哪、工作台里这条选题的页面。
「当前打开的文件夹」「读写」两行的查法和说法照创作页的 where.py。只读，不改任何文件
（查能不能写时，在工作文件夹里建一个以点开头的临时小文件，马上删掉）。
"""
import os
import re

from . import places as PL
from . import record as R
from . import settings as S
from . import sizes as Z
from . import styles as ST

CANDIDATES = "封面候选"
SELECTED = "封面-选定"
NOTES_DIR = "批注"  # 第一版工作台存的批注图：只用来认哪些编号用过了
COVER_FILE = re.compile(r"^封面-(\d{2,})\.(png|jpe?g|webp)$", re.I)
PROMPT_FILE = re.compile(r"^生图描述-(\d{2,})\.md$")
NUMBER_IN_TEXT = re.compile(r"封面-(\d{2,})")


def number_text(n):
    """编号两位起，满 99 用三位：3 → 03，100 → 100。"""
    return "%02d" % n


def plan_name(batch):
    return "生成计划.md" if batch == 1 else "生成计划-第%d批.md" % batch


def candidates(draft, cid, cover_assets):
    """一条内容的封面候选：有哪些图、哪些只有提示词、用过的编号、下一张的编号、第几批、上一批用的尺寸。
    taken 是不能再存图的编号（已经有图、登记过、或者在「## 记录」里出现过：删掉的也算；第一版工作台的收藏、批注图里出现过的也算）；
    只写了生图描述、图还没存的编号不在 taken 里（先写提示词、再生成、再存图），但下一张的编号会跳过它。
    登记成「只出了提示词」、图还没放进来的编号（fillable）也不在 taken 里：Claude Code 只出提示词，用户在别处生成好图交回来时，
    存成同一个编号（照这份提示词出的就是这一张，不算复用）；删掉过的（「## 记录」里写着删除）除外。"""
    folder = os.path.join(draft, CANDIDATES)
    images, prompts, taken = {}, {}, set()
    try:
        names = os.listdir(folder)
    except OSError:
        names = []
    for name in names:
        m = COVER_FILE.match(name)
        if m:
            images[int(m.group(1))] = name
            continue
        m = PROMPT_FILE.match(name)
        if m:
            prompts[int(m.group(1))] = name
    taken.update(images)
    try:
        for name in os.listdir(os.path.join(folder, NOTES_DIR)):
            taken.update(int(x) for x in NUMBER_IN_TEXT.findall(name))
    except OSError:
        pass
    doc = R.load(folder, cid)
    deleted, others = set(), set(taken)
    for line in doc.text().splitlines():
        if line.startswith("- ") or line.startswith("|"):  # 「## 记录」里的一行、表格里的一行
            found = [int(x) for x in NUMBER_IN_TEXT.findall(line)]
            taken.update(found)
            if line.startswith("- ") and "删除" in line:
                deleted.update(found)
    prompt_rows = set()
    for _batch, no, _change, _check, file in doc.all_rows():
        if no.isdigit():
            taken.add(int(no))
            if PROMPT_FILE.match(file):
                prompt_rows.add(int(no))
            else:
                others.add(int(no))
    try:  # 第一版工作台收藏的封面：T002_封面-03.png，删掉候选以后编号也不再用
        for name in os.listdir(os.path.join(cover_assets, S.FAV_DIR)):
            if name.startswith(cid + "_"):
                found = [int(x) for x in NUMBER_IN_TEXT.findall(name)]
                taken.update(found)
                others.update(found)
    except OSError:
        pass
    fillable = prompt_rows - others - deleted
    taken -= fillable
    used = taken | set(prompts) | fillable
    batches = doc.batches()
    current = max(batches) if batches else None
    if current is None:
        next_batch = 1
    else:
        next_batch = current[0] if current[1] == 0 else current[0] + 1
    selected = [n for n in sorted(names) if os.path.splitext(n)[0] == SELECTED]
    selected += [n for n in sorted(os.listdir(draft)) if os.path.splitext(n)[0] == SELECTED] if os.path.isdir(draft) else []
    size_batch, size = doc.last_size()
    return {
        "folder": folder,
        "exists": os.path.isdir(folder),
        "images": [images[n] for n in sorted(images)],
        "prompt_only": [prompts[n] for n in sorted(prompts) if n not in images],
        "taken": sorted(taken),
        "fillable": sorted(fillable),
        "used": sorted(used),
        "next": (max(used) + 1) if used else 1,
        "record": R.path(folder),
        "record_exists": os.path.isfile(R.path(folder)),
        "batches": batches,
        "current_batch": current[0] if current else None,
        "current_rows": current[1] if current else 0,
        "next_batch": next_batch,
        "plan": os.path.join(folder, plan_name(next_batch)),
        "selected": selected[0] if selected else None,
        "last_size": size,
        "last_size_batch": size_batch,
    }


def style_info(style, default_id=None):
    """where 里一个风格的那几样：风格名（没拆是 None）、几张原图、默认构图、是不是默认风格。"""
    return {"id": style.id, "kind": style.kind, "folder": style.folder, "done": style.done(), "name": style.name(),
            "done_date": style.done_date() if style.done() else None, "images": len(style.images()),
            "compositions": ST.read_compositions(style), "default": bool(default_id) and style.id == default_id}


def collect(content=None, here=None, env=None):
    try:
        p = PL.settings(env)
        problem = ""
    except PL.SettingsError as e:
        p, problem = None, str(e)
    out = {"repo": PL.repo_dir(), "settings_problem": problem}
    if p is None:
        return out
    out["places"] = p
    out["work_folder_exists"] = os.path.isdir(p["work_folder"])
    if here is None:
        try:
            here = os.getcwd()
        except OSError:  # 所在的文件夹已经被删了
            here = ""
    out["here"] = {"path": here, "relation": PL.folder_relation(here, p["work_folder"]) if here else "unknown"}
    problems = []
    if out["work_folder_exists"]:
        found = PL.access_problem(p["work_folder"])
        if found:
            problems.append("工作文件夹" + found)
        # 封面素材、对标账号、调研报告、内容草稿在设置里改到了工作文件夹外面时，它们也查
        for key, label in (("cover_assets", "封面素材"), ("accounts", "对标账号"), ("reports", "调研报告"), ("drafts", "内容草稿")):
            if os.path.isdir(p[key]) and not PL.is_under(p[key], p["work_folder"]):
                found = PL.access_problem(p[key])
                if found:
                    problems.append(label + found)
    out["access"] = {"checked": out["work_folder_exists"], "problems": problems}
    out["workbench"] = PL.workbench(p)
    try:
        cs = S.read(p)
        cs_problem = ""
    except Exception as e:  # 封面设置写坏了：照样往下说别的
        cs, cs_problem = None, str(e)
    out["cover"] = {"settings": cs, "problem": cs_problem}
    out["cover"]["photos"] = S.photo_set(p, cs) if cs else {"all": S.photos(p), "used": S.photos(p)[:S.MAX_PHOTOS], "primary": None,
                                                           "primary_abs": None, "primary_ok": False, "primary_missing": False}
    default_id = cs["benchmark"] if cs else None
    styles = [style_info(st, default_id) for st in ST.all_styles(p)]
    out["styles"] = styles
    if default_id:
        try:
            st = ST.resolve(p, default_id)
            out["cover"]["default_style"] = {"id": st.id, "found": True, "done": st.done(), "name": st.name(), "vi_file": st.vi_file}
        except Exception:
            out["cover"]["default_style"] = {"id": default_id, "found": False}
    if content:
        cid = PL.content_id(content)
        dirs = PL.draft_dirs(cid, p["drafts"])
        title, title_from = PL.topic_title(cid, p)
        kind = PL.topic_type(cid, p)
        item = {"id": cid, "title": title, "title_from": title_from, "type": kind, "draft_dirs": dirs,
                "link": PL.detail_link(out["workbench"]["origin"], cid)}
        last = None
        if len(dirs) == 1:
            item["candidates"] = candidates(dirs[0], cid, p["cover_assets"])
            item["creation_page"] = os.path.isfile(os.path.join(dirs[0], "%s_创作页.html" % cid))
            last = item["candidates"]["last_size"]
        else:
            item["new_draft"] = os.path.join(p["drafts"], "%s_%s" % (cid, PL.folder_title(title)) if title else cid)
        size, why = Z.default(last, kind)
        item["default_size"] = {"size": size, "why": why}
        out["content"] = item
    return out


def _range(names):
    return names[0] if len(names) == 1 else "%s 到 %s" % (os.path.splitext(names[0])[0], os.path.splitext(names[-1])[0])


def style_line(s):
    """「风格」下面的一行：编号（来源）：风格名或者还没拆，几张原图，默认构图，是不是默认风格。"""
    source = "对标账号" if s["kind"] == ST.KIND_ACCOUNT else "放进来的图"
    bits = []
    if s["done"]:
        bits.append("风格名「%s」（%s 拆的）" % (s["name"] or "没写", s["done_date"] or "不知道哪天"))
    else:
        bits.append("还没拆")
    bits.append("原图 %d 张" % s["images"])
    bits.append("默认构图：%s" % ST.describe_compositions(s["compositions"]))
    if s["default"]:
        bits.append("默认风格")
    return "  - %s（%s）：%s" % (s["id"], source, "，".join(bits))


def show(info):
    L = ["工作台仓库：%s" % (info["repo"] or "找不到（这个脚本不在工作台仓库里）")]
    if info.get("settings_problem"):
        L.append("设置：%s" % info["settings_problem"])
        return "\n".join(L)
    p = info["places"]
    L.append("设置文件：%s%s" % (p["settings_file"], "" if p["settings_exists"] else "（还没有：工作台还没运行过，下面按默认值）"))
    L.append("工作文件夹：%s%s" % (p["work_folder"], "" if info["work_folder_exists"] else "（还没有：在后台启动一次工作台就会建好，%s）" % PL.start_hint()))
    here = info.get("here") or {}
    relation = here.get("relation")
    if relation == "same":
        L.append("当前打开的文件夹：%s（就是工作文件夹）" % here["path"])
    elif relation == "inside":
        L.append("当前打开的文件夹：%s（在工作文件夹里面）" % here["path"])
    elif relation == "outside":
        L.append("当前打开的文件夹：%s（不是工作文件夹。封面、VI 拆解都按这里打印的完整路径写进工作文件夹，不写进当前打开的文件夹）" % here["path"])
    else:
        L.append("当前打开的文件夹：读不到（所在的文件夹可能已经被删了）")
    access = info.get("access") or {}
    if access.get("checked"):
        problems = access["problems"]
        said = "；".join(problems)
        if not problems:
            L.append("读写：工作文件夹能读能写")
        elif relation == "outside":
            L.append("读写：%s。这个对话开在别的文件夹，还没被允许写工作文件夹：先别写任何文件。先用你这个 AI 工具自己的办法申请写工作文件夹的权限（告诉用户等会儿点允许）；申请不了，再请用户新开一个对话，打开工作文件夹" % said)
        elif any("读不了" in x for x in problems):
            L.append("读写：%s。多半是这台 Mac 没允许这个 AI 工具访问这个文件夹：先别动手，请用户在「系统设置 → 隐私与安全性 → 文件与文件夹」里允许" % said)
        else:
            L.append("读写：%s。这个对话打开的就是工作文件夹，但现在只能读文件（Codex 里，没用 Git 管的文件夹默认只读）：先别写任何文件，用你这个 AI 工具自己的办法申请改文件的权限（告诉用户等会儿点允许）" % said)
    wb = info["workbench"]
    if wb["running"]:
        L.append("工作台：正在运行，%s（「封面」页：%s）" % (wb["origin"], PL.covers_link(wb["origin"])))
    elif wb.get("blocked"):
        L.append("工作台：查不了。这个终端不让连本机端口（多半是 AI 工具的沙箱），不代表没在运行：用能连本机端口的权限再跑一次 where（Codex 里让这条命令申请提权）")
    else:
        L.append("工作台：没在运行。交付前直接在后台启动它：%s（设置里界面的端口是 %d）" % (PL.start_hint(), p["ui_port"]))
    L.append("封面素材：%s%s" % (p["cover_assets"], "" if os.path.isdir(p["cover_assets"]) else "（还没有：第一次放照片或者设默认风格时会建好）"))
    cover = info["cover"]
    cs = cover["settings"]
    ps = cover["photos"]
    if cover["problem"]:
        L.append("  封面设置：%s" % cover["problem"])
    else:
        L.append("  封面设置：%s%s" % (cs["file"], "" if cs["exists"] else "（还没有：主照片、默认风格都没设，一批 %d 张）" % S.DEFAULT_BATCH))
        for problem in cs["problems"]:
            L.append("    写得不对：%s" % problem)
    folder = os.path.join(p["cover_assets"], S.PHOTO_DIR)
    if ps["all"]:
        L.append("  人物参考图片：%d 张，出封面默认都用（主照片在前，再按放进来的先后；一张封面最多 %d 张当长相参考），这次用前 %d 张："
                 % (len(ps["all"]), S.MAX_PHOTOS, len(ps["used"])))
        for i, path in enumerate(ps["used"], 1):
            L.append("    %d. %s%s" % (i, path, "（主照片）" if ps["primary_ok"] and i == 1 else ""))
        if len(ps["all"]) > len(ps["used"]):
            L.append("    另外 %d 张这次不用：%s" % (len(ps["all"]) - len(ps["used"]), "、".join(os.path.basename(x) for x in ps["all"][len(ps["used"]):])))
        if ps["primary_missing"]:
            L.append("    封面设置里的主照片找不到了：%s。先用上面这几张；要换主照片用 settings set-photo" % ps["primary_abs"])
    elif ps["primary_missing"]:
        L.append("  人物参考图片：封面设置里的主照片找不到了（%s），人物参考图片 里也没有别的。出封面前停下，请用户放几张自己的照片（工作台「封面」页角上的「人物参考图片」，或者把照片拖进对话）" % ps["primary_abs"])
    else:
        L.append("  人物参考图片：还没有（%s）。出封面前停下，请用户放一张或几张自己的照片（工作台「封面」页角上的「人物参考图片」，或者把照片拖进对话）" % folder)
    styles = info["styles"]
    done = [s for s in styles if s["done"]]
    if not cover["problem"]:
        d = cover.get("default_style")
        if d and not d["found"]:
            L.append("  默认风格：%s，但找不到这个风格的文件夹了" % d["id"])
        elif d and not d["done"]:
            L.append("  默认风格：%s，但还没有 VI拆解.md：先拆它的封面 VI" % d["id"])
        elif d:
            L.append("  默认风格：%s（风格名：%s）；VI拆解：%s" % (d["id"], d["name"] or "没写", d["vi_file"]))
        elif done:
            L.append("  默认风格：没设。拆过的有：%s（用 settings set-default 设一个）" % "、".join("%s（%s）" % (s["id"], s["name"] or "没写风格名") for s in done))
        else:
            L.append("  默认风格：没设，也还没有拆过封面 VI 的风格。出封面前停下，说清要先拆一个风格")
        L.append("  一批几张：%d" % cs["batch_size"])
    L.append("风格：%d 个（拆过 %d 个，还没拆 %d 个）%s" % (len(styles), len(done), len(styles) - len(done), "：" if styles else ""))
    for s in styles:
        L.append(style_line(s))
    L.append("对标账号：%s" % p["accounts"])
    L.append("放进来的图：%s" % ST.styles_root(p))
    L.append("调研报告：%s" % p["reports"])
    L.append("内容草稿：%s" % p["drafts"])
    L.append("回收站：%s" % p["trash"])
    c = info.get("content")
    if c:
        cid = c["id"]
        if c["title"]:
            L.append("%s 的选题名：%s（%s）" % (cid, c["title"], c["title_from"]))
        else:
            L.append("%s 的选题名：选题卡和选题总览里都没找到" % cid)
        L.append("%s 的内容类型：%s" % (cid, c["type"] or "没找到"))
        if not c["draft_dirs"]:
            L.append("%s 的草稿文件夹：还没有。开一批时（record batch）会建好：%s" % (cid, c["new_draft"]))
        elif len(c["draft_dirs"]) > 1:
            L.append("%s 的草稿文件夹：有 %d 个，要先问用户用哪个：%s" % (cid, len(c["draft_dirs"]), "、".join(c["draft_dirs"])))
        else:
            k = c["candidates"]
            L.append("%s 的草稿文件夹：%s" % (cid, c["draft_dirs"][0]))
            if k["images"] or k["prompt_only"]:
                bits = []
                if k["images"]:
                    bits.append("%d 张图：%s" % (len(k["images"]), _range(k["images"])))
                if k["prompt_only"]:
                    bits.append("%d 份只有提示词：%s" % (len(k["prompt_only"]), _range(k["prompt_only"])))
                L.append("  封面候选：%s（%s）" % (k["folder"], "；".join(bits)))
            else:
                L.append("  封面候选：%s（%s）" % (k["folder"], "还没有候选" if k["exists"] else "这个文件夹还没有，开一批时会建好"))
            L.append("  下一张的编号：%s（封面-%s）" % (number_text(k["next"]), number_text(k["next"])))
            if k["current_batch"] is None:
                L.append("  批次：还没出过；开一批就是第 1 批，生成计划写进 %s" % k["plan"])
            else:
                now = "现在是第 %d 批（登记了 %d 张）" % (k["current_batch"], k["current_rows"])
                if k["next_batch"] == k["current_batch"]:
                    L.append("  批次：%s；这一批还一张都没登记，再开一批会接着用它，生成计划写进 %s" % (now, k["plan"]))
                else:
                    L.append("  批次：%s；再开一批是第 %d 批，生成计划写进 %s" % (now, k["next_batch"], k["plan"]))
            L.append("  生成记录：%s%s" % (k["record"], "" if k["record_exists"] else "（还没有，开一批时会建好）"))
            L.append("  选定的封面：%s" % (k["selected"] or "还没选"))
            if c.get("creation_page"):
                L.append("  创作页：有。定了的封面文字用写稿 Skill 的 brain_page.py read %s 看「标题、封面文字、简介」" % cid)
        k = c.get("candidates")
        if k and k["last_size"] is not None:
            L.append("  尺寸：上一批用的是 %s（第 %d 批）" % (k["last_size"].text, k["last_size_batch"]))
        else:
            d = c["default_size"]
            L.append("  尺寸：还没有哪一批写过尺寸；没说的话默认 %s（%s）" % (d["size"].text, d["why"]))
        L.append("  工作台里这条选题的页面：%s（出一批的设置和这条选题出过的封面，只看）%s" % (c["link"], "" if wb["running"] else "；工作台没在运行时打不开，交付前先启动"))
    return "\n".join(L)


def as_json(info):
    """--json：路径和状态，给程序读。"""
    out = {k: v for k, v in info.items() if k != "places"}
    if "places" in info:
        out["places"] = info["places"]
    cover = out.get("cover")
    if cover and cover.get("settings"):
        cs = dict(cover["settings"])
        cs.pop("raw", None)
        out["cover"] = dict(cover, settings=cs)
    c = out.get("content")
    if c:
        c = dict(c)
        if c.get("candidates"):
            k = dict(c["candidates"])
            k["last_size"] = k["last_size"].text if k["last_size"] is not None else None
            c["candidates"] = k
        c["default_size"] = {"size": c["default_size"]["size"].text, "why": c["default_size"]["why"]}
        out["content"] = c
    return out
