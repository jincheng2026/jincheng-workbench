#!/usr/bin/env python3
"""封面 Skill 的命令：找位置、拆封面 VI 的文件活、分风格、封面设置、存图、登记生成记录。

风格编号两种都认：对标账号的文件夹名（抖音-某某），和你放进工作台「封面」的那组图「风格/<文件夹名>」（风格/2026-10-04_8张）。

  python3 cover.py where [T002]                       # 东西都放在哪、能不能读写、照片、全部风格；给了编号再说这条的封面候选和上一批的尺寸
  python3 cover.py vi prepare <风格编号> [--from 文件夹]  # 补封面（对标账号的作品.json 有封面链接就下载最近 20 张）、改名 K01…、写清单
  python3 cover.py vi inventory <风格编号>              # 查每张能不能打开、有没有重复，写 VI研究/inventory.json
  python3 cover.py vi check <风格编号>                  # 核对 VI研究/study.json（逐图观察、规则、案例）
  python3 cover.py vi build <风格编号>                  # 出能点原图对比的报告：调研报告/<日期>_<名字>封面VI/
  python3 cover.py vi export <风格编号> --style 风格名 [--compositions K03,K07,…]   # VI拆解.md（第二行「风格名：…」）和默认构图.json
  python3 cover.py style split "风格/<文件夹名>" K04 K07   # 放进来的图不是一种风格：把这几张分进新的风格文件夹
  python3 cover.py settings show | set-photo <照片> | set-default <风格编号> | batch <张数>
  python3 cover.py record batch T002 --tool image_gen|只出提示词 [--size 竖版3:4] [--benchmark 风格编号] [--compositions K03,K07] [--photo 照片]
  python3 cover.py record add T002 --no 03 --change "K03 讲台：…" --check 通过 --file 封面-03.png
  python3 cover.py record note T002 "按评论改 封面-03 → 封面-12"   # 往「## 记录」追加一行，带时间
  python3 cover.py record summary T002 [--tries 11] [--errors 1]  # 这批的「生成 N 次，报错 M 次，实际像素 …」
  python3 cover.py save T002 --no 03 [--size 横版2.35:1] [--from 图片]   # 把 Codex 刚生成的图从中间裁好，存成 封面候选/封面-03.png
  python3 cover.py select T002 --no 03                # 你定了用这张：复制成草稿文件夹里的 封面-选定.png

每个命令加 -h 看参数。退出码：0 成功；2 有问题（第一行就说了怎么办）；1 程序自己的问题。
只用 Python 自带的模块和 macOS 自带的 sips（裁图）；装了 Pillow 时拆 VI 多做两项检查，没装照样能跑完。
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from cover_kit import UserError  # noqa: E402
from cover_kit import images as I  # noqa: E402
from cover_kit import places as PL  # noqa: E402
from cover_kit import record as R  # noqa: E402
from cover_kit import settings as S  # noqa: E402
from cover_kit import sizes as Z  # noqa: E402
from cover_kit import styles as ST  # noqa: E402
from cover_kit import vi as V  # noqa: E402
from cover_kit import where as W  # noqa: E402
from cover_kit.text import minute, one_line, read_bytes, today, unique_file  # noqa: E402

ENV = os.environ
TOOLS = ("image_gen", "只出提示词")
APPS = ("Codex", "Claude Code")
FRESH_MINUTES = 15  # save 不写 --from 时，Codex 生图文件夹里最新的一张要是这么多分钟以内的


def say(text=""):
    print(text)


def places():
    return PL.work_folder_or_die(PL.settings(ENV))


def q(text):
    """命令里的参数加上引号（风格编号里可能有空格）。"""
    return '"%s"' % text


# ---------- where ----------

def cmd_where(args):
    info = W.collect(args.content, env=ENV)
    if args.json:
        say(json.dumps(W.as_json(info), ensure_ascii=False, indent=2))
    else:
        say(W.show(info))
    return 1 if info.get("settings_problem") else 0


# ---------- 拆封面 VI ----------

def cmd_vi_prepare(args):
    p = places()
    style = ST.resolve(p, args.target)
    r = V.prepare(style, args.max, args.source)
    covers = style.covers
    network = ("下载封面时连不上网（%s）：多半是 AI 工具的沙箱不让命令联网，用能联网的权限再跑一次 vi prepare（Codex 里让这条命令申请提权）；"
               "不是沙箱的话，请用户检查网络。" % r["network"]) if r["network"] else None
    if not r.get("count"):
        if network:
            raise UserError(network)
        if not style.is_account:
            raise UserError("「%s」还没有能拆的图：%s 里没有图。请用户在工作台「封面」页把这组图重新拖进来，或者把图放进这个文件夹，放好回一句「好了」再跑一次；"
                            "图在别的文件夹里的话，加 --from 那个文件夹。" % (style.id, covers))
        if r["cover_urls"] and r["download_failed"]:
            hint = "作品.json 里的封面链接都下载失败了（多半过期了）"
        elif r["work_json"]:
            hint = "作品.json 里没有封面链接"
        else:
            hint = "这个账号还没有作品数据（作品.json）"
        raise UserError("「%s」还没有能拆的封面：%s 里没有图，%s。抖音、小红书的账号接了 TikHub 的，用调研 Skill 重新拉一次他最近 20 条作品"
                        "（account add 主页链接 --max 20），拉完马上再跑 vi prepare；拉不了的，请用户把这个博主最近的 10 到 20 张封面放进这个文件夹"
                        "（从新到旧排更好），放好回一句「好了」再跑一次；封面在别的文件夹里的话，加 --from 那个文件夹。"
                        % (style.id, covers, hint))
    say("封面整理好了：%s" % covers)
    bits = []
    if r["downloaded"]:
        bits.append("这次下载 %d 张" % r["downloaded"])
    if r["copied"]:
        bits.append("从给的文件夹复制 %d 张" % r["copied"])
    if r["renamed"]:
        bits.append("改名 %d 张" % r["renamed"])
    say("  一共 %d 张：%s 到 %s%s" % (r["count"], r["first"], r["last"], "（%s）" % "、".join(bits) if bits else "（没有新加的）"))
    if network:
        say("  " + network)
    if r["download_failed"]:
        say("  有 %d 张下载失败（封面链接多半过期了）。不够 10 张的话，用调研 Skill 重新拉一次这个账号（account add 主页链接 --max 20）马上再跑；"
            "拉不了的，请用户补几张进 %s 再跑一次。" % (r["download_failed"], covers))
    if style.is_account and r["work_json"] and not r["cover_urls"] and r["count"] < args.max:
        say("  作品.json 里没有封面链接（旧版调研 Skill 拉的），没法自动补；现在的 %d 张是放进来的。要补就用调研 Skill 重新拉一次这个账号再跑。" % r["count"])
    if r["skipped"]:
        say("  没纳入的：%s（报告网页显示不了这种格式。heic 可以用 macOS 自带的 sips 转成 jpg，比如 sips -s format jpeg 图.heic --out 图.jpg，转好放回 封面/ 再跑一次）" % "、".join(r["skipped"]))
    if r["skipped_source"]:
        say("  给的文件夹里没复制的：%s（报告网页显示不了这种格式，转成 jpg 再放进去）" % "、".join(r["skipped_source"]))
    if r["count"] < 10:
        say("  只有 %d 张：照样能拆，结论里会写明张数少、规律可能不稳；只有 1 张就只做单图拆解。" % r["count"])
    say("  改名对照：%s" % os.path.join(covers, V.NAMES_FILE))
    say("  清单：%s（%s）" % (r["records"], "按发布时间取最近的" if r["mode"] == "latest" else "按编号顺序，不说是最近的"))
    say("下一步：vi inventory %s" % q(style.id))
    return 0


def cmd_vi_inventory(args):
    p = places()
    style = ST.resolve(p, args.target)
    try:
        result, out = V.inventory(style)
    except V.StudyError as e:
        raise UserError("封面整理得不对，先处理再从 vi prepare 跑起：%s" % e)
    c = result["counts"]
    say("清单好了：%s" % out)
    say("  研究 %d 张：%s；独立图片 %d 张，导入 %d 条" % (c["research_images"], "、".join(result["selected_ids"]), c["unique_images"], c["imported_records"]))
    for x in result["limitations"]:
        say("  限制：%s" % x)
    say("下一步：逐张打开上面这些图看，照 references/observation.md 写观察，照 references/evidence.md 的格式写进 %s，再 vi check %s"
        % (os.path.join(style.folder, V.STUDY_DIR, V.STUDY), q(style.id)))
    if not style.is_account:
        say("  这是放进来的几张图：看完发现不是一种风格，先用 style split %s <分出去的编号> 分开，两边再各自从 vi prepare 拆起。" % q(style.id))
    return 0


def cmd_vi_check(args):
    p = places()
    style = ST.resolve(p, args.target)
    try:
        r = V.check(style)
    except V.StudyError as e:
        raise UserError("研究数据还要改，改好再跑一次 vi check：%s" % e)
    say("校验通过：%d 张都有逐图观察，%d 条规律，%d 个构图案例。" % (r["checked_images"], r["rules"], r["cases"]))
    say("  只查了文件、结构和引用：不代表看图看对了、网页好用或者好看。")
    say("下一步：vi build %s" % q(style.id))
    return 0


def cmd_vi_build(args):
    p = places()
    style = ST.resolve(p, args.target)
    try:
        r = V.build(style, p["reports"])
    except V.StudyError as e:
        raise UserError("研究数据还要改，改好再跑一次 vi build：%s" % e)
    say("对照网页：%s" % r["index"])
    say("  %d 张原图副本、%d 条规律、%d 个构图案例；工作台「市场调研」的调研报告里能看到「%s」。" % (r["checked_images"], r["rules"], r["cases"], r["title"]))
    say("下一步：vi export %s --style <四到八个字的风格名> --compositions <挑的 5 张原图编号，比如 K03,K07,K12,K01,K05>" % q(style.id))
    return 0


def cmd_vi_export(args):
    p = places()
    style = ST.resolve(p, args.target)
    r = V.export(style, p["reports"], args.style, args.compositions)
    say("VI拆解.md 写好了：%s" % r["path"])
    say("  风格名：%s；%d 张，%d 条规律，%d 个案例%s" % (r["style"], r["count"], r["rules"], r["cases"],
                                            "" if r["report"] else "；还没出对照网页（vi build）"))
    comp = r["compositions"]
    path = os.path.join(style.folder, ST.COMPOSITIONS)
    if r["compositions_written"]:
        say("  默认构图：%s：%s" % (ST.describe_compositions(comp), path))
    elif comp and comp["by"] == ST.BY_USER:
        say("  默认构图是用户在工作台改过的（%s），没覆盖：%s" % ("、".join(comp["ids"]) or "空的", path))
    else:
        say("  没写默认构图：study.json 的案例里没有 封面/ 里真有的原图编号。用 --compositions 写几张（比如 K03,K07,K12）再导出一次。")
    if r["report_renamed"]:
        say("  报告的名字跟着改成了「%s」（%s）" % (r["report_renamed"], os.path.join(r["report"], "meta.json")))
    cs = S.read(p)
    if not cs["benchmark"]:
        say("下一步：用户还没有默认风格，直接设成默认：settings set-default %s" % q(style.id))
    elif cs["benchmark"] == style.id:
        say("  它就是现在的默认风格。")
    else:
        say("  默认风格还是「%s」，不动；用户想换，在工作台「封面」页的风格卡片上设，或者让 AI 跑 settings set-default %s。" % (cs["benchmark"], q(style.id)))
    return 0


# ---------- 分风格 ----------

def cmd_style_split(args):
    p = places()
    style = ST.resolve(p, args.target)
    r = ST.split(p, style, args.ids)
    moved = r["moved"]
    say("分好了：%s 挪进了新的风格 %s（%s），名字改回了原名：%s"
        % ("、".join(m[0] for m in moved), r["new_id"], os.path.join(r["new_folder"], ST.COVERS), "、".join("%s → %s" % (m[1], m[2]) for m in moved)))
    say("  %s 还剩 %d 张：%s" % (style.id, len(r["left"]), "、".join(r["left"])))
    say("  两边的 原文件名.md 都记了一笔；新文件夹写好了 %s" % os.path.join(r["new_folder"], ST.STYLE_JSON))
    for line in r["changed"]:
        say("  %s：%s" % (style.id, line))
    if r["had_vi"]:
        say("  %s 的 VI拆解.md 是分之前导出的：拆完重新导出。" % style.id)
    say("下一步：两边各自从 vi prepare 拆起，各起各的风格名：")
    say("  vi prepare %s" % q(style.id))
    say("  vi prepare %s" % q(r["new_id"]))
    return 0


# ---------- 封面设置 ----------

def cmd_settings(args):
    p = places()
    if args.action == "set-photo":
        if not args.value:
            raise UserError("要给照片的路径：settings set-photo <照片>")
        rel, dest = S.set_photo(p, args.value)
        say("主照片设好了：%s（%s）。出封面时它排第一，「我的照片」里别的照片也会用上（一张封面最多 %d 张）。" % (rel, dest, S.MAX_PHOTOS))
        return 0
    if args.action == "set-default":
        if not args.value:
            raise UserError("要给风格编号：settings set-default <风格编号>（对标账号的文件夹名，或者「风格/<文件夹名>」）")
        sid, name = S.set_benchmark(p, args.value)
        say("默认风格设好了：%s（风格名：%s）。以后出封面没说照哪个风格，就照它的 VI拆解.md。" % (sid, name or "没写"))
        return 0
    if args.action == "batch":
        if not args.value:
            raise UserError("要给张数：settings batch <张数>")
        n = S.set_batch(p, args.value)
        say("一批几张设好了：%d" % n)
        return 0
    cs = S.read(p)
    say("封面设置：%s%s" % (cs["file"], "" if cs["exists"] else "（还没有：主照片、默认风格都没设，一批 %d 张）" % S.DEFAULT_BATCH))
    for problem in cs["problems"]:
        say("  写得不对：%s" % problem)
    ps = S.photo_set(p, cs)
    if cs["photo"]:
        say("  主照片：%s（%s）" % (cs["photo"], ps["primary_abs"] if ps["primary_ok"] else "找不到这个文件了：%s" % ps["primary_abs"]))
    else:
        say("  主照片：没设（「我的照片」里的照片按放进来的先后用）")
    say("  照片：%s" % ("出封面用 %d 张：%s" % (len(ps["used"]), "、".join(ps["used"])) if ps["used"] else "我的照片 里还没有"))
    if cs["benchmark"]:
        try:
            st = ST.resolve(p, cs["benchmark"])
            state = ("风格名：%s" % (st.name() or "没写")) if st.done() else "还没有 VI拆解.md"
        except UserError:
            state = "找不到这个风格的文件夹了"
        say("  默认风格：%s（%s）" % (cs["benchmark"], state))
    else:
        say("  默认风格：没设")
    say("  一批几张：%d" % cs["batch_size"])
    return 0


# ---------- 生成记录 ----------

def _draft(p, cid, create=False):
    dirs = PL.draft_dirs(cid, p["drafts"])
    if len(dirs) > 1:
        raise UserError("%s 有 %d 个草稿文件夹，先问用户用哪个：%s" % (cid, len(dirs), "、".join(dirs)))
    if dirs:
        return dirs[0], False
    if not create:
        return PL.one_draft_dir(cid, p), False
    title, _from = PL.topic_title(cid, p)
    name = "%s_%s" % (cid, PL.folder_title(title)) if title and PL.folder_title(title) else cid
    folder = os.path.join(p["drafts"], name)
    os.makedirs(folder, exist_ok=True)
    return folder, True


def _number(text):
    m = re.fullmatch(r"(?:封面-)?(\d{1,4})", str(text or "").strip())
    if not m or int(m.group(1)) < 1:
        raise UserError("编号写成 03 或者 3（收到的是「%s」）。" % text)
    return int(m.group(1))


def _size_for(p, cid, given):
    """这批用什么尺寸、为什么：说了就用说的；没说照工作台定默认值的顺序（这条内容上一批用的 → 内容类型 → 竖版 3:4）。"""
    if given:
        return Z.parse(given), "用户这次说的"
    last = None
    dirs = PL.draft_dirs(cid, p["drafts"])
    if len(dirs) == 1:
        last = R.load(os.path.join(dirs[0], W.CANDIDATES), cid).last_size()[1]
    size, why = Z.default(last, PL.topic_type(cid, p))
    return size, "没说，%s" % why


def _batch(p, style_id=None, photos=None, app=None, tool=None, size=None, strict=True):
    """一批用什么：风格（和风格名）、照片、软件、生图方式、尺寸。返回 dict，line 是这批小节的第一行。
    strict 时缺风格、风格没拆过、没有照片都停下（出封面前的检查）；不 strict 时缺的写「未记录」。"""
    cs = S.read(p)
    sid = style_id or cs["benchmark"]
    out = {"style": None, "style_id": None, "style_name": None, "photos": [], "notes": []}
    if sid:
        try:
            style = ST.resolve(p, sid)
        except UserError:
            if strict:
                raise
            style = None
        if style:
            if strict and not style.done():
                raise UserError("「%s」还没拆封面 VI（没有 VI拆解.md）：先拆它，再出封面。" % style.id)
            out.update(style=style, style_id=style.id, style_name=style.name())
        else:
            out["style_id"] = sid
    elif strict:
        raise UserError("还没有默认风格：先停下，告诉用户要先拆一个风格的封面 VI（在工作台「封面」页选一个对标账号、贴博主的主页链接，或者拖几张封面图进去，"
                        "把复制的那句话发给 AI；也可以直接把博主的主页链接发过来）。")
    if photos:
        if len(photos) > S.MAX_PHOTOS:
            raise UserError("--photo 最多写 %d 张（一张封面最多给生图 %d 张照片当长相参考）。" % (S.MAX_PHOTOS, S.MAX_PHOTOS))
        chosen = []
        for value in photos:
            try:
                path = S.find_photo(p, value)
            except UserError:
                if strict:
                    raise
                continue
            if path not in chosen:
                chosen.append(path)
        out["photos"] = chosen
        out["photo_from"] = "用户这次说的"
    else:
        ps = S.photo_set(p, cs)
        out["photos"] = ps["used"]
        out["photo_from"] = "「我的照片」里的，主照片在前，再按放进来的先后"
        if ps["primary_missing"]:
            out["notes"].append("封面设置里的主照片找不到了（%s），先用「我的照片」里的" % ps["primary_abs"])
        if len(ps["all"]) > len(ps["used"]):
            out["notes"].append("「我的照片」里有 %d 张，一张封面最多用 %d 张，这批用前 %d 张" % (len(ps["all"]), S.MAX_PHOTOS, len(ps["used"])))
    if strict and not out["photos"]:
        raise UserError("还没有照片：先停下，请用户放一张或几张自己的照片（工作台「封面」页角上的「我的照片」，或者把照片拖进对话，AI 存成文件再跑 settings set-photo <照片>）。")
    if tool and not app:
        app = "Codex" if tool == "image_gen" else "Claude Code"
    photos_text = "%d 张" % len(out["photos"]) if out["photos"] else "未记录"
    out["line"] = R.info_line(out["style_id"] or "未记录", out["style_name"], photos_text, today(), app or "未记录", tool or "未记录", size)
    out["batch_size"] = cs["batch_size"]
    return out


def _compositions(style, given):
    """这批参考哪几张构图：说了就用说的（要是这个风格里有的图）；没说用这个风格的默认构图。返回 ({编号: 完整路径}, 从哪来, 提醒)。"""
    if given:
        ids = ST.parse_ids(given, "参考构图的原图编号")
        found = ST.check_ids(style, ids, "参考构图")
        return dict((k, os.path.join(style.covers, v)) for k, v in found.items()), "用户这次说的", None
    comp = ST.read_compositions(style)
    if not comp or comp["problem"] or not comp["ids"]:
        why = comp["problem"] if comp and comp["problem"] else "这个风格还没有默认构图"
        return {}, None, "%s：照 VI拆解.md 的选图建议挑" % why
    have = style.k_images()
    ok = [i for i in comp["ids"] if i in have]
    gone = [i for i in comp["ids"] if i not in have]
    note = "默认构图里的 %s 不在 封面/ 里了，跳过" % "、".join(gone) if gone else None
    by = {ST.BY_AI: "AI 挑的", ST.BY_USER: "用户在工作台改过的"}.get(comp["by"], "")
    return dict((i, os.path.join(style.covers, have[i])) for i in ok), "这个风格的默认构图%s" % ("，%s" % by if by else ""), note


def cmd_record_batch(args):
    p = places()
    cid = PL.content_id(args.content)
    size, why = _size_for(p, cid, args.size)
    b = _batch(p, args.benchmark, args.photo, args.app, args.tool, size)
    comps, comps_from, comps_note = _compositions(b["style"], args.compositions)
    draft, created = _draft(p, cid, create=True)
    folder = os.path.join(draft, W.CANDIDATES)
    n, reused = R.edit(folder, cid, lambda doc: doc.open_batch(b["line"]))
    k = W.candidates(draft, cid, p["cover_assets"])
    if created:
        say("建好了草稿文件夹：%s%s" % (draft, "" if "_" in os.path.basename(draft) else
                                        "（选题卡和选题总览里都没找到 %s 的选题名，先只用编号；要改名照工作文件夹里的 AGENTS.md）" % cid))
    say("%s第 %d 批：%s" % ("接着用还没登记的" if reused else "开了", n, R.path(folder)))
    say("  %s" % b["line"])
    say("  生成计划写进：%s" % os.path.join(folder, W.plan_name(n)))
    say("  这批从 封面-%s 开始编号；一批默认 %d 张（用户这次说了几张就按他说的）" % (W.number_text(k["next"]), b["batch_size"]))
    say("  尺寸：%s（%s）。%s；每张存图时写 save … --size %s" % (size.text, why, size.plan(), size.arg))
    say("  照片（%d 张，%s；按这个顺序当前几张输入图，都是长相参考）：" % (len(b["photos"]), b["photo_from"]))
    for i, path in enumerate(b["photos"], 1):
        say("    %d. %s%s" % (i, path, "（heic：生图前先用 sips 转成 jpg，转出来的不放进工作文件夹）" if path.lower().endswith(".heic") else ""))
    for note in b["notes"]:
        say("    %s" % note)
    st = b["style"]
    say("  风格：%s（风格名：%s）；原图：%s；VI拆解：%s" % (st.id, b["style_name"] or "没写", st.covers, st.vi_file))
    if comps:
        say("  参考构图（%s，当最后一张输入图）：%s" % (comps_from, "、".join(comps)))
        for kid, path in comps.items():
            say("    %s：%s" % (kid, path))
        say("    张数比构图多，就同一张构图出确有区别的方案；比构图少，就按顺序用前几张。")
    if comps_note:
        say("  参考构图：%s" % comps_note)
    return 0


def cmd_record_add(args):
    p = places()
    cid = PL.content_id(args.content)
    draft, _ = _draft(p, cid)
    folder = os.path.join(draft, W.CANDIDATES)
    no = _number(args.no)
    no_text = W.number_text(no)
    name = os.path.basename(str(args.file or "").strip())
    m = W.COVER_FILE.match(name) or W.PROMPT_FILE.match(name)
    if not m or name != str(args.file).strip():
        raise UserError("--file 写候选的文件名，比如 封面-%s.png；只出提示词时写 生图描述-%s.md（收到的是「%s」）。" % (no_text, no_text, args.file))
    if int(m.group(1)) != no:
        raise UserError("编号对不上：--no 是 %s，文件名是 %s。" % (no_text, name))
    if not os.path.isfile(os.path.join(folder, name)):
        raise UserError("封面候选里还没有 %s（%s）：先把这张存进去（Codex 用 save），再登记。" % (name, folder))
    change = one_line(args.change)
    check = one_line(args.check)
    if not change:
        raise UserError("--change 写这张的变化：原图编号加一句话画面，比如「K03 讲台：人在右后，前景放大的手机」。")
    if not check:
        raise UserError("--check 写自检：全过写「通过」，有问题只写问题；只出提示词写「只出了提示词」。")
    if len(check) > R.MAX_CHECK:
        raise UserError("自检要一句话、%d 字以内（现在 %d 个字）：只写结论，比如「头发遮住「AI」的 A」。" % (R.MAX_CHECK, len(check)))

    def default_info():  # 只有这批还没有小节、要现建的时候才用
        try:
            size = _size_for(p, cid, args.size)[0]
        except UserError:
            size = None
        try:
            return _batch(p, app=args.app, tool=args.tool, size=size, strict=False)["line"]
        except UserError:
            return R.info_line("未记录", None, "未记录", today(), args.app or "未记录", args.tool or "未记录", size)

    filled = []

    def change_doc(doc):
        for batch, number, _c, _k, file in doc.all_rows():
            if number == no_text or (number.isdigit() and int(number) == no):
                if W.PROMPT_FILE.match(file) and W.COVER_FILE.match(name):  # 只出了提示词的那一张，图交回来了：换成图的那一行
                    filled.append(file)
                    return doc.fill_row(number, R.row_cells(number, change, check, name))
                raise UserError("%s 已经登记过了（第 %d 批，%s）：编号不复用，用下一个编号。" % (no_text, batch, file))
        return doc.add_row(args.batch, R.row_cells(no_text, change, check, name), info_if_new=default_info)

    n = R.edit(folder, cid, change_doc)
    if filled:
        say("登记好了：第 %d 批 · %s（原来只出了提示词，照 %s 出的图放进来了，那一行换成这张）· 自检：%s（%s）" % (n, name, filled[0], check, R.path(folder)))
        say("  这一批的图都放进来以后，再跑一次 record summary 更新这批的统计。")
    else:
        say("登记好了：第 %d 批 · %s · 自检：%s（%s）" % (n, name, check, R.path(folder)))
    return 0


def cmd_record_note(args):
    p = places()
    cid = PL.content_id(args.content)
    draft, _ = _draft(p, cid)
    folder = os.path.join(draft, W.CANDIDATES)
    text = one_line(args.text)
    if not text:
        raise UserError("要写这件事，比如「按评论改 封面-03 → 封面-12」。")
    line = "%s %s" % (minute(), text)
    R.edit(folder, cid, lambda doc: doc.add_log(line))
    say("记下了：- %s（%s 的「## 记录」）" % (line, R.path(folder)))
    return 0


def cmd_record_summary(args):
    p = places()
    cid = PL.content_id(args.content)
    draft, _ = _draft(p, cid)
    folder = os.path.join(draft, W.CANDIDATES)
    doc = R.load(folder, cid)
    batches = doc.batches()
    if not batches:
        raise UserError("生成记录里还没有批次：先 record batch %s。" % cid)
    n = args.batch or max(batches)[0]
    rows = [r for r in doc.all_rows() if r[0] == n]
    if not rows:
        raise UserError("第 %d 批还一张都没登记：先 record add，登记完再写这批的统计。" % n)
    images = [r for r in rows if W.COVER_FILE.match(r[4])]
    if args.pixels:
        if not re.fullmatch(r"\d+\s*[x×*]\s*\d+", args.pixels.strip()):
            raise UserError("--pixels 写成 1024x1536。")
        pixels = re.sub(r"\s*[x×*]\s*", "×", args.pixels.strip())
    else:
        sizes = []
        for r in images:
            size = I.image_size(os.path.join(folder, r[4]))
            text = "%d×%d" % size if size else None
            if text and text not in sizes:
                sizes.append(text)
        pixels = "、".join(sizes)
    if images:
        tries = args.tries if args.tries is not None else len(images)
        errors = args.errors or 0
        if tries < len(images):
            raise UserError("--tries 是一共调了几次生图（成功的加报错的），不能比登记的 %d 张少。" % len(images))
        text = "生成 %d 次，报错 %d 次%s" % (tries, errors, "，实际像素 " + pixels if pixels else "")
        if len(rows) > len(images):
            text += "；另有 %d 份只出了提示词" % (len(rows) - len(images))
    else:
        text = "只出了提示词 %d 份，没有生成图片" % len(rows)
    R.edit(folder, cid, lambda d: (d.convert_legacy(), d.set_summary(n, text)))
    say("第 %d 批写好了：%s" % (n, text))
    return 0


# ---------- 选定 ----------

def cmd_select(args):
    """你在对话里定了用哪张：复制成草稿文件夹里的 封面-选定.<扩展名>，「## 记录」记一行。
    原来选定的那份扩展名不一样的，挪进回收站（文件名前加日期）；候选原图不动。工作台照旧按 封面-选定.* 和候选比内容认出选的是哪张。"""
    p = places()
    cid = PL.content_id(args.content)
    draft, _ = _draft(p, cid)
    folder = os.path.join(draft, W.CANDIDATES)
    no = _number(args.no)
    k = W.candidates(draft, cid, p["cover_assets"])
    name = next((n for n in k["images"] if int(W.COVER_FILE.match(n).group(1)) == no), None)
    if not name:
        only_prompt = any(int(W.PROMPT_FILE.match(n).group(1)) == no for n in k["prompt_only"])
        raise UserError("封面候选里没有 封面-%s 的图（%s）%s。" % (
            W.number_text(no), folder, "：这张只出了提示词，图还没放进来" if only_prompt else "：先用 where %s 看有哪几张" % cid))
    ext = os.path.splitext(name)[1].lower()
    ext = ".jpg" if ext == ".jpeg" else ext
    moved = []
    for old in sorted(os.listdir(draft)):
        stem, old_ext = os.path.splitext(old)
        path = os.path.join(draft, old)
        if stem == W.SELECTED and old_ext.lower() != ext and os.path.isfile(path):
            os.makedirs(p["trash"], exist_ok=True)
            target = unique_file(p["trash"], "%s_%s_%s" % (today(), cid, stem), old_ext)
            shutil.move(path, target)
            moved.append(os.path.basename(target))
    target = os.path.join(draft, W.SELECTED + ext)
    shutil.copyfile(os.path.join(folder, name), target)
    line = "%s 选定 封面-%s" % (minute(), W.number_text(no))
    R.edit(folder, cid, lambda doc: doc.add_log(line))
    say("选定了 封面-%s：%s（候选原图不动）" % (W.number_text(no), target))
    if moved:
        say("  原来选定的那份挪进了回收站：%s" % "、".join(moved))
    say("  记下了：- %s" % line)
    return 0


# ---------- 存图 ----------

def codex_images_dir():
    base = (ENV.get("CODEX_HOME") or "").strip()
    base = os.path.abspath(os.path.expanduser(base)) if base else os.path.join(ENV.get("HOME") or os.path.expanduser("~"), ".codex")
    return os.path.join(base, "generated_images")


def newest_image(folder):
    best = None
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if name.startswith(".") or os.path.splitext(name)[1].lower() not in (".png", ".jpg", ".jpeg", ".webp"):
                continue
            path = os.path.join(root, name)
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            if best is None or mtime > best[0]:
                best = (mtime, path)
    return best


def cmd_save(args):
    p = places()
    cid = PL.content_id(args.content)
    draft, _ = _draft(p, cid)
    folder = os.path.join(draft, W.CANDIDATES)
    no = _number(args.no)
    k = W.candidates(draft, cid, p["cover_assets"])
    if no in k["taken"]:
        raise UserError("封面-%s 这个编号已经用过了（已经有图，或者生成记录里有它）：编号不复用，用 封面-%s。" % (W.number_text(no), W.number_text(k["next"])))
    if args.size:
        size, size_from = Z.parse(args.size), "--size 写的"
    else:
        last_batch, size = R.load(folder, cid).last_size()
        size_from = "照第 %d 批写的" % last_batch if size else None
    if args.source:
        source = os.path.abspath(os.path.expanduser(args.source))
        if not os.path.isfile(source):
            raise UserError("找不到这张图：%s" % source)
    else:
        gen = codex_images_dir()
        best = newest_image(gen)
        if not best:
            raise UserError("Codex 的生图文件夹里没有图：%s。先确认这张真的生成出来了；图存在别处的话，用 --from 指定那张图。" % gen)
        age = (time.time() - best[0]) / 60.0
        if age > FRESH_MINUTES:
            raise UserError("Codex 的生图文件夹里最新的一张是 %d 分钟以前的（%s），多半这次没生成出来：先确认生成成功了；确实是这张，用 --from 指定它。" % (int(age), best[1]))
        source = best[1]
    data = read_bytes(source)
    fmt = I.sniff(data)
    if fmt not in ("PNG", "JPEG", "WEBP"):
        raise UserError("这不是 png、jpg 或 webp 图片：%s" % source)
    existing = {}
    for name in k["images"]:
        existing[hashlib.sha256(read_bytes(os.path.join(folder, name))).hexdigest()] = name
    same = existing.get(hashlib.sha256(data).hexdigest())
    if same:
        raise UserError("这张图已经存过了，就是 %s：多半这次没生成出来新图。先确认生成成功了再存。" % same)
    workdir = tempfile.mkdtemp(prefix="cover-save-")  # 裁图用的临时文件夹，不在工作文件夹里
    try:
        if size is not None:
            cut = Z.crop(source, size, workdir)
        else:
            got = I.image_size(source)
            cut = {"path": source, "format": fmt, "before": got, "after": got, "cropped": False}
        out_data = read_bytes(cut["path"])
        same = existing.get(hashlib.sha256(out_data).hexdigest())
        if same:
            raise UserError("这张图已经存过了，就是 %s：多半这次没生成出来新图。先确认生成成功了再存。" % same)
        os.makedirs(folder, exist_ok=True)
        dest = os.path.join(folder, "封面-%s%s" % (W.number_text(no), I.EXT_OF_FORMAT[cut["format"]]))
        if os.path.exists(dest):
            raise UserError("%s 已经有了，不覆盖：用 封面-%s。" % (dest, W.number_text(k["next"])))
        shutil.copyfile(cut["path"], dest)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    size_text = "%d×%d" % cut["after"] if cut["after"] else "读不出宽高"
    say("存好了：%s（%s，从 %s %s）" % (dest, size_text, source, "的中间裁的" if cut["cropped"] else "复制"))
    if no in k["fillable"]:
        say("  封面-%s 原来只出了提示词（生图描述-%s.md），这张就是照它出的：登记时照样写 --no %s --file %s，会把只出了提示词的那一行换成这张。"
            % (W.number_text(no), W.number_text(no), W.number_text(no), os.path.basename(dest)))
    if size is None:
        say("  没写 --size，生成记录里这批也没写尺寸：原样存的，没裁。")
    elif cut["cropped"]:
        say("  尺寸：%s（%s）：从 %d×%d 的中间裁成了 %d×%d；没裁的原图还在原处，没有放进工作文件夹。"
            % (size.text, size_from, cut["before"][0], cut["before"][1], cut["after"][0], cut["after"][1]))
    else:
        say("  尺寸：%s（%s）：已经是这个比例，不用裁。" % (size.text, size_from))
    if size is not None and cut["before"]:
        note = Z.shape_note(size, cut["before"])
        if note:
            say("  " + note)
    return 0


# ---------- 入口 ----------

class Parser(argparse.ArgumentParser):
    """命令写错时（缺参数、选项不对、多了看不懂的）第一行用中文说清怎么改；argparse 自己的报错是英文的。"""

    def error(self, message):
        text = message
        for pattern, chinese in (
            (r"the following arguments are required: (.+)", "缺参数：\\1"),
            (r"argument (\S+): invalid choice: '?([^'(]*)'? \(choose from (.+)\)", "\\1 只能写 \\3（收到的是「\\2」）"),
            (r"argument (\S+): expected one argument", "\\1 后面要写一个值"),
            (r"argument (\S+): invalid int value: '?([^']*)'?", "\\1 要写数字（收到的是「\\2」）"),
            (r"unrecognized arguments: (.+)", "多了看不懂的参数：\\1"),
        ):
            m = re.match(pattern, message)
            if m:
                text = m.expand(chinese)
                break
        sys.stdout.write("命令写得不对：%s。用「%s -h」看这一条怎么写。\n" % (text, self.prog))
        sys.exit(2)


STYLE_HELP = "风格编号：对标账号的文件夹名（比如「抖音-某某」），或者「风格/<文件夹名>」（你放进工作台「封面」的那组图）"
SIZE_HELP = "尺寸：%s（写成「竖版3:4」不用加引号）" % Z.CHOICES_TEXT


def build_parser():
    ap = Parser(prog="cover.py", description="封面 Skill 的命令")
    sub = ap.add_subparsers(dest="cmd", parser_class=Parser)

    w = sub.add_parser("where", help="东西都放在哪、能不能读写、照片、全部风格；给了编号再说这条的封面候选和上一批的尺寸")
    w.add_argument("content", nargs="?", help="内容编号，比如 T002")
    w.add_argument("--json", action="store_true", help="输出 JSON")
    w.set_defaults(func=cmd_where)

    vi = sub.add_parser("vi", help="拆封面 VI 的文件活：prepare、inventory、check、build、export")
    vsub = vi.add_subparsers(dest="action", parser_class=Parser)
    pr = vsub.add_parser("prepare", help="补封面、改名 K01…、写 VI研究/records.json")
    pr.add_argument("target", metavar="风格编号", help=STYLE_HELP)
    pr.add_argument("--from", dest="source", help="封面在别的文件夹里：从这里复制进 封面/（不动原文件夹）")
    pr.add_argument("--max", type=int, default=20, help="最多研究几张，默认 20；对标账号的作品.json 有封面链接时补到这么多张")
    pr.set_defaults(func=cmd_vi_prepare)
    for name, func, text in (("inventory", cmd_vi_inventory, "查每张能不能打开、有没有重复，写 VI研究/inventory.json"),
                             ("check", cmd_vi_check, "核对 VI研究/study.json"),
                             ("build", cmd_vi_build, "出能点原图对比的报告，放进「调研报告」")):
        x = vsub.add_parser(name, help=text)
        x.add_argument("target", metavar="风格编号", help=STYLE_HELP)
        x.set_defaults(func=func)
    ex = vsub.add_parser("export", help="study.json → VI拆解.md，再写默认构图.json")
    ex.add_argument("target", metavar="风格编号", help=STYLE_HELP)
    ex.add_argument("--style", help="风格名：四到八个字，说得出画面特点（AI 自己起，不问用户）；不写就沿用 VI拆解.md 里原来的")
    ex.add_argument("--compositions", help="默认构图：AI 挑的原图编号，比如 K03,K07,K12,K01,K05（默认 5 张）；"
                                           "不写就按 study.json 里案例的顺序取前 5 个；用户在工作台改过的不覆盖")
    ex.set_defaults(func=cmd_vi_export)

    sy = sub.add_parser("style", help="风格：split 把放进来的图里不是一种风格的几张分出去")
    ssub = sy.add_subparsers(dest="action", parser_class=Parser)
    sp = ssub.add_parser("split", help="把这几张挪进新的风格文件夹（风格/<原文件夹名>-2），挪回原文件名；只对你放进来的图")
    sp.add_argument("target", metavar="风格编号", help="「风格/<文件夹名>」")
    sp.add_argument("ids", nargs="+", metavar="原图编号", help="要分出去的原图编号，比如 K04 K07 K09")
    sp.set_defaults(func=cmd_style_split)

    st = sub.add_parser("settings", help="封面设置：show、set-photo <照片>、set-default <风格编号>、batch <张数>")
    st.add_argument("action", nargs="?", default="show", choices=("show", "set-photo", "set-default", "batch"))
    st.add_argument("value", nargs="?")
    st.set_defaults(func=cmd_settings)

    rc = sub.add_parser("record", help="生成记录：batch 开一批、add 登记一张、note 记一件事、summary 写这批的统计")
    rsub = rc.add_subparsers(dest="action", parser_class=Parser)
    rb = rsub.add_parser("batch", help="开一批：生成记录.md 里新开「## 第 N 批」（草稿文件夹还没有就建好）")
    rb.add_argument("content", help="内容编号，比如 T002")
    rb.add_argument("--tool", required=True, choices=TOOLS, help="生图方式：Codex 用 image_gen；Claude Code 只出提示词")
    rb.add_argument("--app", choices=APPS, help="软件：不写就按生图方式认（image_gen 是 Codex，只出提示词是 Claude Code）")
    rb.add_argument("--size", help=SIZE_HELP + "；不写就用这条内容上一批的，没有就按内容类型（文章类横版 2.35:1，其余竖版 3:4）")
    rb.add_argument("--benchmark", help="这批照哪个风格：" + STYLE_HELP + "；不写就用默认风格")
    rb.add_argument("--compositions", help="参考构图：原图编号，比如 K03,K07,K12（不写就用这个风格的默认构图）")
    rb.add_argument("--photo", action="append", help="这批只用这几张照片（可以写几次，最多 3 张；完整路径或者「我的照片」里的文件名）；不写就用「我的照片」里的")
    rb.set_defaults(func=cmd_record_batch)
    ra = rsub.add_parser("add", help="在这批的表里登记一张")
    ra.add_argument("content", help="内容编号，比如 T002")
    ra.add_argument("--no", required=True, help="编号，比如 03")
    ra.add_argument("--change", required=True, help="本张变化：原图编号加一句话画面；改出来的写「改自 封面-03：……」")
    ra.add_argument("--check", required=True, help="自检：全过写「通过」，有问题只写问题，30 字以内")
    ra.add_argument("--file", required=True, help="文件名：封面-03.png；只出提示词时 生图描述-03.md")
    ra.add_argument("--batch", type=int, help="登记进第几批（不写就是最新一批）")
    ra.add_argument("--tool", choices=TOOLS, help="这批还没开时用来写这批的第一行")
    ra.add_argument("--app", choices=APPS, help="这批还没开时用来写这批的第一行")
    ra.add_argument("--size", help="这批还没开时用来写这批的第一行：" + SIZE_HELP)
    ra.set_defaults(func=cmd_record_add)
    rn = rsub.add_parser("note", help="往「## 记录」追加一行，带时间")
    rn.add_argument("content", help="内容编号，比如 T002")
    rn.add_argument("text", help="比如「按评论改 封面-03 → 封面-12」")
    rn.set_defaults(func=cmd_record_note)
    rs = rsub.add_parser("summary", help="这批的「生成 N 次，报错 M 次，实际像素 …」（像素从图上读）")
    rs.add_argument("content", help="内容编号，比如 T002")
    rs.add_argument("--tries", type=int, help="一共调了几次生图（成功的加报错的），不写就是这批登记的张数")
    rs.add_argument("--errors", type=int, help="生图工具报错几次，默认 0")
    rs.add_argument("--pixels", help="实际像素，比如 1024x1365（不写就从图上读）")
    rs.add_argument("--batch", type=int, help="第几批（不写就是最新一批）")
    rs.set_defaults(func=cmd_record_summary)

    sl = sub.add_parser("select", help="你定了用哪张：复制成草稿文件夹里的 封面-选定")
    sl.add_argument("content", help="内容编号，比如 T002")
    sl.add_argument("--no", required=True, help="编号，比如 03")
    sl.set_defaults(func=cmd_select)

    sv = sub.add_parser("save", help="把 Codex 刚生成的图（或者 --from 的图）从中间裁成这批的尺寸，存成 封面候选/封面-NN")
    sv.add_argument("content", help="内容编号，比如 T002")
    sv.add_argument("--no", required=True, help="编号，比如 03")
    sv.add_argument("--size", help=SIZE_HELP + "；不写就照生成记录里最近一批写的尺寸")
    sv.add_argument("--from", dest="source", help="图在哪（不写就用 Codex 生图文件夹里最新的一张）")
    sv.set_defaults(func=cmd_save)
    return ap


def main(argv=None):
    ap = build_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "func", None):
        ap.print_help()
        return 2
    for key in ("max", "tries", "errors"):
        value = getattr(args, key, None)
        if value is not None and value < (1 if key == "max" else 0):
            print("--%s 不能小于 %d。" % (key, 1 if key == "max" else 0))
            return 2
    try:
        return args.func(args) or 0
    except UserError as e:
        print(str(e))
        return e.exit_code
    except KeyboardInterrupt:
        print("停下了。")
        return 130
    except Exception:  # 程序自己的问题：给 AI 看完整的出错位置
        import traceback
        print("封面脚本出错了，这是程序的问题，不是操作的问题。把下面的出错位置原样告诉用户，不要自己改脚本绕过去：")
        traceback.print_exc(file=sys.stdout)
        return 1


if __name__ == "__main__":
    sys.exit(main())
