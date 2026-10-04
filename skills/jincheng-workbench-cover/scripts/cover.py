#!/usr/bin/env python3
"""封面 Skill 的命令：找位置、拆封面 VI 的文件活、封面设置、存图、登记生成记录。

  python3 cover.py where [T002]                      # 东西都放在哪、能不能读写、照片和默认对标；给了编号再说这条的封面候选
  python3 cover.py vi prepare <对标账号> [--from 文件夹]   # 补封面（作品.json 有封面链接就下载最近 20 张）、改名 K01…、写清单
  python3 cover.py vi inventory <对标账号>             # 查每张能不能打开、有没有重复，写 VI研究/inventory.json
  python3 cover.py vi check <对标账号>                 # 核对 VI研究/study.json（逐图观察、规则、案例）
  python3 cover.py vi build <对标账号>                 # 出能点原图对比的报告：调研报告/<日期>_<账号名>封面VI/
  python3 cover.py vi export <对标账号> --style 风格名   # study.json → VI拆解.md（第二行「风格名：…」）
  python3 cover.py settings show | set-photo <照片> | set-default <对标账号> | batch <张数>
  python3 cover.py record batch T002 --tool image_gen|只出提示词   # 开一批：生成记录.md 里新开「## 第 N 批」
  python3 cover.py record add T002 --no 03 --change "K03 讲台：…" --check 通过 --file 封面-03.png
  python3 cover.py record note T002 "按备注改 封面-03 → 封面-12"   # 往「## 记录」追加一行，带时间
  python3 cover.py record summary T002 [--tries 11] [--errors 1]  # 这批的「生成 N 次，报错 M 次，实际像素 …」
  python3 cover.py save T002 --no 03 [--from 图片]     # 把 Codex 刚生成的图存成 封面候选/封面-03.png

每个命令加 -h 看参数。退出码：0 成功；2 有问题（第一行就说了怎么办）；1 程序自己的问题。
只用 Python 自带的模块；装了 Pillow 时拆 VI 多做两项检查，没装照样能跑完。
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from cover_kit import UserError  # noqa: E402
from cover_kit import images as I  # noqa: E402
from cover_kit import places as PL  # noqa: E402
from cover_kit import record as R  # noqa: E402
from cover_kit import settings as S  # noqa: E402
from cover_kit import vi as V  # noqa: E402
from cover_kit import where as W  # noqa: E402
from cover_kit.text import minute, one_line, read_bytes, today  # noqa: E402

ENV = os.environ
TOOLS = ("image_gen", "只出提示词")
APPS = ("Codex", "Claude Code")
FRESH_MINUTES = 15  # save 不写 --from 时，Codex 生图文件夹里最新的一张要是这么多分钟以内的


def say(text=""):
    print(text)


def places():
    return PL.work_folder_or_die(PL.settings(ENV))


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
    account = S.account_folder(p, args.account)
    r = V.prepare(account, args.max, args.source)
    covers = os.path.join(account, V.COVERS)
    network = ("下载封面时连不上网（%s）：多半是 AI 工具的沙箱不让命令联网，用能联网的权限再跑一次 vi prepare（Codex 里让这条命令申请提权）；"
               "不是沙箱的话，请用户检查网络。" % r["network"]) if r["network"] else None
    if not r.get("count"):
        if network:
            raise UserError(network)
        if r["cover_urls"] and r["download_failed"]:
            hint = "作品.json 里的封面链接都下载失败了（多半过期了）"
        elif r["work_json"]:
            hint = "作品.json 里没有封面链接"
        else:
            hint = "这个账号还没有作品数据（作品.json）"
        raise UserError("「%s」还没有能拆的封面：%s 里没有图，%s。抖音、小红书的账号接了 TikHub 的，用调研 Skill 重新拉一次他最近 20 条作品"
                        "（account add 主页链接 --max 20），拉完马上再跑 vi prepare；拉不了的，请用户把这个博主最近的 10 到 20 张封面放进这个文件夹"
                        "（从新到旧排更好），放好回一句「好了」再跑一次；封面在别的文件夹里的话，加 --from 那个文件夹。"
                        % (os.path.basename(account), covers, hint))
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
    if r["work_json"] and not r["cover_urls"] and r["count"] < args.max:
        say("  作品.json 里没有封面链接（旧版调研 Skill 拉的），没法自动补；现在的 %d 张是放进来的。要补就用调研 Skill 重新拉一次这个账号再跑。" % r["count"])
    if r["skipped"]:
        say("  没纳入的：%s（报告网页显示不了这种格式。heic 可以用 macOS 自带的 sips 转成 jpg，比如 sips -s format jpeg 图.heic --out 图.jpg，转好放回 封面/ 再跑一次）" % "、".join(r["skipped"]))
    if r["skipped_source"]:
        say("  给的文件夹里没复制的：%s（报告网页显示不了这种格式，转成 jpg 再放进去）" % "、".join(r["skipped_source"]))
    if r["count"] < 10:
        say("  只有 %d 张：照样能拆，结论里会写明张数少、规律可能不稳；只有 1 张就只做单图拆解。" % r["count"])
    say("  改名对照：%s" % os.path.join(covers, V.NAMES_FILE))
    say("  清单：%s（%s）" % (r["records"], "按发布时间取最近的" if r["mode"] == "latest" else "按编号顺序，不说是最近的"))
    say("下一步：vi inventory %s" % os.path.basename(account))
    return 0


def cmd_vi_inventory(args):
    p = places()
    account = S.account_folder(p, args.account)
    try:
        result, out = V.inventory(account)
    except V.StudyError as e:
        raise UserError("封面整理得不对，先处理再从 vi prepare 跑起：%s" % e)
    c = result["counts"]
    say("清单好了：%s" % out)
    say("  研究 %d 张：%s；独立图片 %d 张，导入 %d 条" % (c["research_images"], "、".join(result["selected_ids"]), c["unique_images"], c["imported_records"]))
    for x in result["limitations"]:
        say("  限制：%s" % x)
    say("下一步：逐张打开上面这些图看，照 references/observation.md 写观察，照 references/evidence.md 的格式写进 %s，再 vi check %s"
        % (os.path.join(account, V.STUDY_DIR, V.STUDY), os.path.basename(account)))
    return 0


def cmd_vi_check(args):
    p = places()
    account = S.account_folder(p, args.account)
    try:
        r = V.check(account)
    except V.StudyError as e:
        raise UserError("研究数据还要改，改好再跑一次 vi check：%s" % e)
    say("校验通过：%d 张都有逐图观察，%d 条规律，%d 个构图案例。" % (r["checked_images"], r["rules"], r["cases"]))
    say("  只查了文件、结构和引用：不代表看图看对了、网页好用或者好看。")
    say("下一步：vi build %s" % os.path.basename(account))
    return 0


def cmd_vi_build(args):
    p = places()
    account = S.account_folder(p, args.account)
    try:
        r = V.build(account, p["reports"])
    except V.StudyError as e:
        raise UserError("研究数据还要改，改好再跑一次 vi build：%s" % e)
    say("对照网页：%s" % r["index"])
    say("  %d 张原图副本、%d 条规律、%d 个构图案例；工作台「市场调研」的调研报告里能看到「%s」。" % (r["checked_images"], r["rules"], r["cases"], r["title"]))
    say("下一步：vi export %s --style <四到八个字的风格名>" % os.path.basename(account))
    return 0


def cmd_vi_export(args):
    p = places()
    account = S.account_folder(p, args.account)
    r = V.export(account, p["reports"], args.style)
    say("VI拆解.md 写好了：%s" % r["path"])
    say("  风格名：%s；%d 张，%d 条规律，%d 个案例%s" % (r["style"], r["count"], r["rules"], r["cases"],
                                            "" if r["report"] else "；还没出对照网页（vi build）"))
    cs = S.read(p)
    name = os.path.basename(account)
    if not cs["benchmark"]:
        say("下一步：用户还没有默认对标，直接设成默认：settings set-default %s" % name)
    elif cs["benchmark"] == name:
        say("  它就是现在的默认对标。")
    else:
        say("  默认对标还是「%s」，不动；用户想换，在工作台对标账号卡片上设，或者让 AI 跑 settings set-default %s。" % (cs["benchmark"], name))
    return 0


# ---------- 封面设置 ----------

def cmd_settings(args):
    p = places()
    if args.action == "set-photo":
        if not args.value:
            raise UserError("要给照片的路径：settings set-photo <照片>")
        rel, dest = S.set_photo(p, args.value)
        say("照片设好了：%s（%s）。以后出封面都用它。" % (rel, dest))
        return 0
    if args.action == "set-default":
        if not args.value:
            raise UserError("要给对标账号的文件夹名：settings set-default <对标账号>")
        name, style = S.set_benchmark(p, args.value)
        say("默认对标设好了：%s（风格名：%s）。以后出封面都照它的 VI拆解.md。" % (name, style or "没写"))
        return 0
    if args.action == "batch":
        if not args.value:
            raise UserError("要给张数：settings batch <张数>")
        n = S.set_batch(p, args.value)
        say("一批几张设好了：%d" % n)
        return 0
    cs = S.read(p)
    say("封面设置：%s%s" % (cs["file"], "" if cs["exists"] else "（还没有：照片、默认对标都没设，一批 %d 张）" % S.DEFAULT_BATCH))
    for problem in cs["problems"]:
        say("  写得不对：%s" % problem)
    if cs["photo"]:
        abs_photo = S.photo_path(p, cs["photo"])
        say("  照片：%s（%s）" % (cs["photo"], abs_photo if os.path.isfile(abs_photo) else "找不到这个文件了：%s" % abs_photo))
    else:
        say("  照片：没设")
    if cs["benchmark"]:
        folder = os.path.join(p["accounts"], cs["benchmark"])
        state = ("风格名：%s" % (S.style_name(folder) or "没写")) if os.path.isfile(os.path.join(folder, S.VI_FILE)) else "还没有 VI拆解.md"
        say("  默认对标：%s（%s）" % (cs["benchmark"], state))
    else:
        say("  默认对标：没设")
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


def _photo_rel(p, value):
    """这批用的照片，写成相对「封面素材」的路径；在「封面素材」外面的先复制进「我的照片」（不改默认照片）。"""
    path = os.path.abspath(os.path.expanduser(value))
    if not os.path.isfile(path):
        inside = os.path.join(p["cover_assets"], value)
        if not os.path.isfile(inside):
            raise UserError("找不到照片：%s。照片放进 %s 再试，或者先 settings set-photo <照片>。" % (value, os.path.join(p["cover_assets"], S.PHOTO_DIR)))
        path = os.path.abspath(inside)
    if PL.is_under(path, p["cover_assets"]):
        return os.path.relpath(os.path.realpath(path), os.path.realpath(p["cover_assets"])).replace(os.sep, "/")
    rel, _dest = S.import_photo(p, path)
    return rel


def _batch(p, benchmark=None, photo=None, app=None, tool=None, strict=True):
    """一批用什么：对标账号（和风格名）、照片、软件、生图方式。返回 dict，line 是这批小节的第一行。
    strict 时缺对标、对标没拆过、缺照片都停下（出封面前的检查）；不 strict 时缺的写「未记录」。"""
    cs = S.read(p)
    benchmark = benchmark or cs["benchmark"]
    given_photo = photo
    photo = photo or cs["photo"]
    out = {"benchmark": None, "style": None, "account": None, "photo": None, "photo_abs": None}
    if benchmark:
        try:
            folder = S.account_folder(p, benchmark)
        except UserError:
            if strict:
                raise
            folder = None
        if folder:
            if strict and not os.path.isfile(os.path.join(folder, S.VI_FILE)):
                raise UserError("「%s」还没有 VI拆解.md：先拆它的封面 VI，再出封面。" % os.path.basename(folder))
            out.update(benchmark=os.path.basename(folder), style=S.style_name(folder), account=folder)
        else:
            out["benchmark"] = benchmark
    elif strict:
        raise UserError("还没有默认对标：先停下，告诉用户要先拆一个对标账号的封面 VI（工作台「市场调研」对标账号卡片上复制那句话发给 AI，或者把博主的主页链接发过来）。")
    if photo:
        rel = photo
        if given_photo:  # 这次说的照片：可以是完整路径，在「封面素材」外面的先复制进「我的照片」
            try:
                rel = _photo_rel(p, given_photo)
            except UserError:
                if strict:
                    raise
        out.update(photo=rel, photo_abs=S.photo_path(p, rel))
        if strict and not os.path.isfile(out["photo_abs"]):
            raise UserError("设的照片找不到了：%s。先停下，请用户重新放一张（工作台详情页「放照片」，或者把照片拖进对话）。" % out["photo_abs"])
    elif strict:
        raise UserError("还没有照片：先停下，请用户放一张自己的正脸照（工作台详情页「放照片」，或者把照片拖进对话，AI 再跑 settings set-photo <照片>）。")
    if tool and not app:
        app = "Codex" if tool == "image_gen" else "Claude Code"
    out["line"] = R.info_line(out["benchmark"] or "未记录", out["style"], out["photo"] or "未记录", today(), app or "未记录", tool or "未记录")
    out["batch_size"] = cs["batch_size"]
    return out


def cmd_record_batch(args):
    p = places()
    cid = PL.content_id(args.content)
    b = _batch(p, args.benchmark, args.photo, args.app, args.tool)
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
    say("  照片：%s" % b["photo_abs"])
    say("  对标原图：%s；VI拆解：%s" % (os.path.join(b["account"], V.COVERS), os.path.join(b["account"], S.VI_FILE)))
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
        raise UserError("--change 写这张的变化：对标图编号加一句话画面，比如「K03 讲台：人在右后，前景放大的手机」。")
    if not check:
        raise UserError("--check 写自检：全过写「通过」，有问题只写问题；只出提示词写「只出了提示词」。")
    if len(check) > R.MAX_CHECK:
        raise UserError("自检要一句话、%d 字以内（现在 %d 个字）：只写结论，比如「头发遮住「AI」的 A」。" % (R.MAX_CHECK, len(check)))
    def default_info():  # 只有这批还没有小节、要现建的时候才用
        try:
            return _batch(p, app=args.app, tool=args.tool, strict=False)["line"]
        except UserError:
            return R.info_line("未记录", None, "未记录", today(), args.app or "未记录", args.tool or "未记录")

    def change_doc(doc):
        for batch, number, _c, _k, file in doc.all_rows():
            if number == no_text or (number.isdigit() and int(number) == no):
                raise UserError("%s 已经登记过了（第 %d 批，%s）：编号不复用，用下一个编号。" % (no_text, batch, file))
        return doc.add_row(args.batch, R.row_cells(no_text, change, check, name), info_if_new=default_info)

    n = R.edit(folder, cid, change_doc)
    say("登记好了：第 %d 批 · %s · 自检：%s（%s）" % (n, name, check, R.path(folder)))
    return 0


def cmd_record_note(args):
    p = places()
    cid = PL.content_id(args.content)
    draft, _ = _draft(p, cid)
    folder = os.path.join(draft, W.CANDIDATES)
    text = one_line(args.text)
    if not text:
        raise UserError("要写这件事，比如「按备注改 封面-03 → 封面-12」。")
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
    else:
        text = "只出了提示词 %d 份，没有生成图片" % len(rows)
    R.edit(folder, cid, lambda d: (d.convert_legacy(), d.set_summary(n, text)))
    say("第 %d 批写好了：%s" % (n, text))
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
        raise UserError("封面-%s 这个编号已经用过了（已经有图，或者生成记录、收藏里有它）：编号不复用，用 封面-%s。" % (W.number_text(no), W.number_text(k["next"])))
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
    digest = hashlib.sha256(data).hexdigest()
    for name in k["images"]:
        if hashlib.sha256(read_bytes(os.path.join(folder, name))).hexdigest() == digest:
            raise UserError("这张图已经存过了，就是 %s：多半这次没生成出来新图。先确认生成成功了再存。" % name)
    os.makedirs(folder, exist_ok=True)
    dest = os.path.join(folder, "封面-%s%s" % (W.number_text(no), I.EXT_OF_FORMAT[fmt]))
    if os.path.exists(dest):
        raise UserError("%s 已经有了，不覆盖：用 封面-%s。" % (dest, W.number_text(k["next"])))
    shutil.copyfile(source, dest)
    size = I.image_size(dest)
    say("存好了：%s（%s，从 %s 复制）" % (dest, "%d×%d" % size if size else "读不出宽高", source))
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


def build_parser():
    ap = Parser(prog="cover.py", description="封面 Skill 的命令")
    sub = ap.add_subparsers(dest="cmd", parser_class=Parser)

    w = sub.add_parser("where", help="东西都放在哪、能不能读写、照片和默认对标；给了编号再说这条的封面候选")
    w.add_argument("content", nargs="?", help="内容编号，比如 T002")
    w.add_argument("--json", action="store_true", help="输出 JSON")
    w.set_defaults(func=cmd_where)

    vi = sub.add_parser("vi", help="拆封面 VI 的文件活：prepare、inventory、check、build、export")
    vsub = vi.add_subparsers(dest="action", parser_class=Parser)
    pr = vsub.add_parser("prepare", help="补封面、改名 K01…、写 VI研究/records.json")
    pr.add_argument("account", help="对标账号文件夹名，比如「抖音-某某」")
    pr.add_argument("--from", dest="source", help="封面在别的文件夹里：从这里复制进 封面/（不动原文件夹）")
    pr.add_argument("--max", type=int, default=20, help="最多研究几张，默认 20；作品.json 有封面链接时补到这么多张")
    pr.set_defaults(func=cmd_vi_prepare)
    for name, func, text in (("inventory", cmd_vi_inventory, "查每张能不能打开、有没有重复，写 VI研究/inventory.json"),
                             ("check", cmd_vi_check, "核对 VI研究/study.json"),
                             ("build", cmd_vi_build, "出能点原图对比的报告，放进「调研报告」")):
        x = vsub.add_parser(name, help=text)
        x.add_argument("account", help="对标账号文件夹名")
        x.set_defaults(func=func)
    ex = vsub.add_parser("export", help="study.json → VI拆解.md")
    ex.add_argument("account", help="对标账号文件夹名")
    ex.add_argument("--style", help="风格名：四到八个字，说得出画面特点（AI 自己起，不问用户）；不写就沿用 VI拆解.md 里原来的")
    ex.set_defaults(func=cmd_vi_export)

    st = sub.add_parser("settings", help="封面设置：show、set-photo <照片>、set-default <对标账号>、batch <张数>")
    st.add_argument("action", nargs="?", default="show", choices=("show", "set-photo", "set-default", "batch"))
    st.add_argument("value", nargs="?")
    st.set_defaults(func=cmd_settings)

    rc = sub.add_parser("record", help="生成记录：batch 开一批、add 登记一张、note 记一件事、summary 写这批的统计")
    rsub = rc.add_subparsers(dest="action", parser_class=Parser)
    rb = rsub.add_parser("batch", help="开一批：生成记录.md 里新开「## 第 N 批」（草稿文件夹还没有就建好）")
    rb.add_argument("content", help="内容编号，比如 T002")
    rb.add_argument("--tool", required=True, choices=TOOLS, help="生图方式：Codex 用 image_gen；Claude Code 只出提示词")
    rb.add_argument("--app", choices=APPS, help="软件：不写就按生图方式认（image_gen 是 Codex，只出提示词是 Claude Code）")
    rb.add_argument("--benchmark", help="这批用的对标账号（不写就用默认对标）")
    rb.add_argument("--photo", help="这批用的照片（不写就用默认照片）")
    rb.set_defaults(func=cmd_record_batch)
    ra = rsub.add_parser("add", help="在这批的表里登记一张")
    ra.add_argument("content", help="内容编号，比如 T002")
    ra.add_argument("--no", required=True, help="编号，比如 03")
    ra.add_argument("--change", required=True, help="本张变化：对标图编号加一句话画面；按备注改的写「改自 封面-03：……」")
    ra.add_argument("--check", required=True, help="自检：全过写「通过」，有问题只写问题，30 字以内")
    ra.add_argument("--file", required=True, help="文件名：封面-03.png；只出提示词时 生图描述-03.md")
    ra.add_argument("--batch", type=int, help="登记进第几批（不写就是最新一批）")
    ra.add_argument("--tool", choices=TOOLS, help="这批还没开时用来写这批的第一行")
    ra.add_argument("--app", choices=APPS, help="这批还没开时用来写这批的第一行")
    ra.set_defaults(func=cmd_record_add)
    rn = rsub.add_parser("note", help="往「## 记录」追加一行，带时间")
    rn.add_argument("content", help="内容编号，比如 T002")
    rn.add_argument("text", help="比如「按备注改 封面-03 → 封面-12」")
    rn.set_defaults(func=cmd_record_note)
    rs = rsub.add_parser("summary", help="这批的「生成 N 次，报错 M 次，实际像素 …」（像素从图上读）")
    rs.add_argument("content", help="内容编号，比如 T002")
    rs.add_argument("--tries", type=int, help="一共调了几次生图（成功的加报错的），不写就是这批登记的张数")
    rs.add_argument("--errors", type=int, help="生图工具报错几次，默认 0")
    rs.add_argument("--pixels", help="实际像素，比如 1024x1536（不写就从图上读）")
    rs.add_argument("--batch", type=int, help="第几批（不写就是最新一批）")
    rs.set_defaults(func=cmd_record_summary)

    sv = sub.add_parser("save", help="把 Codex 刚生成的图（或者 --from 的图）存成 封面候选/封面-NN")
    sv.add_argument("content", help="内容编号，比如 T002")
    sv.add_argument("--no", required=True, help="编号，比如 03")
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
