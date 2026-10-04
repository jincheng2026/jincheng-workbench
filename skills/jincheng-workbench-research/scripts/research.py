#!/usr/bin/env python3
"""调研 Skill 的命令：找位置、建对标账号、分析评论区、拆视频、看博主最近什么最火。

  python3 research.py where                      # 东西都放在哪、TikHub 密钥读没读到
  python3 research.py tikhub check               # 密钥能不能用、余额多少（免费接口，不扣钱）
  python3 research.py account add <主页链接>      # 用 TikHub 拉博主资料和最近作品，建对标账号档案
  python3 research.py account add --manual --platform 抖音 --name 名字 ...   # 不用 TikHub，手动建档
  python3 research.py comments find <视频链接>    # 先看「评论导入」里有没有这条的导出
  python3 research.py comments prepare <导出文件> --video <视频链接> --topic 主题
  python3 research.py comments plan|fetch <视频链接>   # 用 TikHub 采：先估算，再采
  python3 research.py comments show <报告文件夹>        # 给 AI 读的评论清单
  python3 research.py comments render <报告文件夹>      # 核对分析.json，出评论洞察报告
  python3 research.py video fetch <视频链接>      # 拉标题、文案和数据（拿不到字幕）
  python3 research.py video render --data 拆解.json [--transcript 逐字稿.txt]
  python3 research.py video save --content T001 --file 拆解.md --link <视频链接>
  python3 research.py account research <主页链接或账号名>   # 最近什么最火

每个命令加 -h 看参数。退出码：0 成功；2 有问题（原因已经说了）；3 要先问用户、用户同意后才能继续。
只用 Python 自带的模块。TikHub 的密钥只在这个程序里用，不打印、不写进任何文件。
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from research_kit import NeedsAgreement, UserError  # noqa: E402
from research_kit import accounts as A  # noqa: E402
from research_kit import collect as C  # noqa: E402
from research_kit import comments as CM  # noqa: E402
from research_kit import places as PL  # noqa: E402
from research_kit import platforms as P  # noqa: E402
from research_kit import reports as R  # noqa: E402
from research_kit import tikhub as T  # noqa: E402
from research_kit.text import money, now_iso, read_json, short, today, write_json, write_text  # noqa: E402

ENV = os.environ


def say(text=""):
    print(text)


def rel(places, path):
    """给人看的路径：在工作文件夹里的写成相对的。"""
    try:
        inner = os.path.relpath(path, places["work_folder"])
        if not inner.startswith(".."):
            return inner
    except ValueError:
        pass
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home + os.sep) else path


def _start_hint():
    """在后台启动工作台的命令：找得到仓库就写上仓库位置。"""
    repo = PL.repo_dir()
    return 'pnpm --dir "%s" start --background' % repo if repo else "在工作台仓库文件夹里运行 pnpm start --background"


def places_or_die():
    p = PL.settings(ENV)
    if not os.path.isdir(p["work_folder"]):
        raise UserError("工作文件夹还没有：%s。先在后台启动一次工作台，它会建好：%s" % (p["work_folder"], _start_hint()))
    return p


# ---------- where / tikhub ----------

def cmd_where(args):
    p = PL.settings(ENV)
    status = T.key_status(ENV)
    info = {k: p[k] for k in ("settings_file", "work_folder", "research", "accounts", "reports", "imports", "drafts", "writing_method")}
    ledger = T.Ledger(os.path.join(p["hidden"], "用量.jsonl"))
    info["tikhub_key"] = "已读到（%s）" % status["where"] if status["found"] else "没读到"
    info["tikhub_spent_today_usd"] = str(ledger.spent_today())
    if args.json:
        say(json.dumps(info, ensure_ascii=False, indent=2))
        return 0
    say("工作文件夹：%s%s" % (p["work_folder"], "" if os.path.isdir(p["work_folder"]) else "（还没有：先在后台启动一次工作台，%s）" % _start_hint()))
    say("市场调研：%s" % p["research"])
    say("  对标账号：%s" % p["accounts"])
    say("  调研报告：%s" % p["reports"])
    say("  评论导入：%s（社媒助手导出的评论表放这里）" % p["imports"])
    say("内容草稿：%s" % p["drafts"])
    say("写稿方法：%s" % p["writing_method"])
    say("TikHub 密钥：%s" % info["tikhub_key"])
    if not status["found"]:
        say("  " + T.no_key_message())
    say("TikHub 今天已用：约 %s（按官方单价算；单次自动上限 %s，当天自动上限 %s）" % (money(info["tikhub_spent_today_usd"]), money(T.AUTO_LIMIT), money(T.DAILY_LIMIT)))
    return 0


def cmd_tikhub(args):
    p = PL.settings(ENV)
    if args.action == "prices":
        prices = T.prices_for(ENV)
        for endpoint in T.FALLBACK_PRICES:
            price, free_ok = prices.get(endpoint)
            say("%s：每次 %s%s" % (endpoint, money(price), "" if free_ok else "（不能用试用额度）"))
        say(prices.source_text() + "。")
        return 0
    key, where = T.read_key(ENV)
    if not key:
        raise UserError(T.no_key_message())
    client = T.Client(key, base=T.base_url(ENV), ledger=T.Ledger(os.path.join(p["hidden"], "用量.jsonl")), prices=T.prices_for(ENV))
    info = client.account()
    say("已读到 TikHub 密钥（%s），能用。" % where)
    if info["balance"] is not None or info["free_credit"] is not None:
        say("账户余额：%s；试用额度：%s。抖音接口每次约 0.001 美元；小红书接口每次 0.01 美元，而且只能用充值的余额。"
            % (money(info["balance"] or 0), money(info["free_credit"] or 0)))
    if info.get("email_verified") is False:
        say("提醒：TikHub 账号的邮箱还没验证，部分接口会被拒绝。去邮箱里点一下验证链接。")
    return 0


# ---------- 对标账号 ----------

def cmd_account_add(args):
    p = places_or_die()
    os.makedirs(p["accounts"], exist_ok=True)
    if args.manual:
        if not args.name:
            raise UserError("手动建档要有账号名（--name）。")
        platform = args.platform or P.detect_platform(args.link or "") or "其他"
        folder, created = A.save_profile(p["accounts"], platform, args.name, args.link or args.url or "", args.note, args.tags,
                                         args.followers, args.bio, "manual")
        shots = A.copy_images(args.image, folder, "主页截图") + A.copy_images(args.cover, folder, "代表作封面")
        say("%s对标账号：%s" % ("新建了" if created else "更新了", rel(p, folder)))
        say("  档案.json：平台 %s，账号 %s，来源 手动%s" % (platform, args.name, "，粉丝 %s" % args.followers if args.followers else ""))
        if shots:
            say("  图片：%s" % "、".join(os.path.basename(s) for s in shots))
        return 0
    if not args.link:
        raise UserError("要给博主的主页链接；不用 TikHub 的话加 --manual 手动建档。")
    target = P.parse_target(args.link)
    if not target["platform"]:
        raise UserError("认不出这是哪个平台的链接：%s。把博主主页的完整链接发我（抖音是 douyin.com/user/…，小红书是 xiaohongshu.com/user/profile/…）。" % short(args.link, 60))
    if target["platform"] not in C.SUPPORTED:
        raise C.unsupported(target["platform"])
    plan = C.account_plan(target, args.max)
    session = C.Session(p, ENV, refresh=args.refresh)
    cost, head = session.start(plan, args.agreed_budget)
    profile, works = C.fetch_account(session, target, args.max)
    folder, created = A.save_profile(p["accounts"], profile["platform"], profile["name"], profile.get("url") or args.link,
                                     args.note, args.tags, profile.get("followers"), profile.get("bio"), "tikhub")
    images = A.save_tikhub_images(folder, profile, works)
    A.save_works(folder, profile, works, "tikhub")
    s = session.summary()
    say("%s对标账号：%s" % ("新建了" if created else "更新了", rel(p, folder)))
    say("  %s，粉丝 %s，拉了最近 %d 条作品；图片 %d 张（头像和互动最多的几条封面）" % (profile["name"], profile.get("followers") or "未知", len(works), len(images)))
    say("  TikHub：实际调了 %d 次，约 %s（24 小时内采过的直接用存下的）" % (s["requests"], money(s["cost_usd"])))
    return 0


def cmd_account_list(args):
    p = places_or_die()
    items = A.list_accounts(p["accounts"])
    if not items:
        say("「对标账号」里还没有账号：%s" % p["accounts"])
        return 0
    for item in items:
        data = item["profile"] or {}
        problems = A.check_profile(data) if data else ["读不出 档案.json"]
        say("%s：%s %s%s" % (item["name"], data.get("platform", ""), data.get("account_name", ""), "（档案有问题：%s）" % "；".join(problems) if problems else ""))
    return 0


def cmd_account_research(args):
    p = places_or_die()
    os.makedirs(p["reports"], exist_ok=True)
    source, works, account, cost_info = None, None, {}, {}
    platform = None
    if args.works_file:
        info, works, unknown = A.works_from_file(os.path.expanduser(args.works_file))
        platform = P.detect_platform(info.get("url") or "") or P.detect_platform((works[0].get("url") if works else "") or "") or args.platform
        account = {"name": args.name or info.get("name"), "url": info.get("url"), "followers": info.get("followers")}
        source = {"kind": "file", "file": os.path.basename(args.works_file), "unrecognized": unknown}
        import datetime
        as_of = datetime.datetime.fromtimestamp(os.path.getmtime(os.path.expanduser(args.works_file))).astimezone().isoformat()  # 导出的时间当数据时间
    else:
        if not args.who:
            raise UserError("告诉我是哪个博主：主页链接，或者「对标账号」里的账号名。")
        target, folder = A.resolve_account(p["accounts"], args.who)
        platform = target.get("platform")
        saved = os.path.join(folder, A.WORKS_FILE) if folder else None
        if saved and os.path.isfile(saved) and not args.refresh:
            data = read_json(saved)
            works = data.get("works") or []
            account = {"name": data.get("account_name"), "url": data.get("url"), "followers": data.get("followers")}
            source = {"kind": "tikhub", "file": rel(p, saved), "requests": 0, "cost_usd": "0"}
            as_of = data.get("fetched_at") or now_iso()
            say("用的是「对标账号」里 %s 拉的作品数据（%d 条）；要最新的加 --refresh 重新拉。" % ((as_of or "")[:10], len(works)))
        else:
            if not target.get("url"):
                raise UserError("「对标账号」里这个博主没有主页链接，也没有作品数据。给我他的主页链接。")
            if platform not in C.SUPPORTED:
                raise C.unsupported(platform)
            plan = C.account_plan(target, args.max)
            session = C.Session(p, ENV, refresh=args.refresh)
            session.start(plan, args.agreed_budget)
            profile, works = C.fetch_account(session, target, args.max)
            account = {"name": profile["name"], "url": profile.get("url"), "followers": profile.get("followers"), "bio": profile.get("bio")}
            s = session.summary()
            source = {"kind": "tikhub", "requests": s["requests"], "cost_usd": s["cost_usd"]}
            as_of = now_iso()
            if folder:  # 已经在对标账号里：顺手把作品数据和粉丝数更新了
                A.save_profile(p["accounts"], profile["platform"], profile["name"], profile.get("url"), None, None,
                               profile.get("followers"), profile.get("bio"), "tikhub", folder=folder)
                A.save_works(folder, profile, works, "tikhub")
    if not works:
        raise UserError("没有拿到作品，出不了账号研究。")
    analysis = A.analyze_works(works, as_of)
    topic = args.topic or "%s-最近什么最火" % (account.get("name") or "博主")
    out_folder = R.new_report_folder(p["reports"], topic)
    data = {"kind": "账号数据", "version": 1, "created_at": now_iso(), "platform": platform, "account": account,
            "source": source, "as_of": as_of, "analysis": analysis}
    write_json(os.path.join(out_folder, "账号数据.json"), data)
    path = R.render_account(data, None, out_folder)
    R.write_meta(out_folder, "「%s」最近什么最火" % (account.get("name") or "博主"), "账号研究", _source_text(source, account), [(os.path.basename(path), "账号研究")])
    say("账号研究报告：%s" % rel(p, path))
    say("  %d 条作品，发布满 %d 天的 %d 条，平时水平（互动中位数）%s；明显更火的 %d 条。"
        % (analysis["count"], analysis["rules"]["fresh_days"], analysis["mature"],
           int(analysis["median"]) if analysis["median"] else "算不出来", len(analysis["standouts"])))
    if not analysis["enough"]:
        say("  作品太少，只排了序、没判断谁明显更火。")
    for wid in analysis["standouts"][:6]:
        r = next(x for x in analysis["rows"] if x["id"] == wid)
        say("  · %s（%s，互动 %s，是平时的 %s 倍%s）" % (short(r.get("title") or r.get("desc"), 30), (r.get("published_at") or "")[:10],
                                                  r["interactions"], r["ratio"], "；" + "、".join(r["spikes"]) if r["spikes"] else ""))
    say("想加上「这几条有什么共同点」：把观察写进 %s，再运行 account render %s" % (rel(p, os.path.join(out_folder, "分析.json")), os.path.basename(out_folder)))
    return 0


def cmd_account_render(args):
    p = places_or_die()
    folder = PL.report_dir(p, args.folder)
    data_path = os.path.join(folder, "账号数据.json")
    if not os.path.isfile(data_path):
        raise UserError("这个文件夹里没有 账号数据.json，不是账号研究的报告文件夹。")
    data = read_json(data_path)
    observations = None
    ana_path = os.path.join(folder, "分析.json")
    if os.path.isfile(ana_path):
        observations, problems = A.check_account_analysis(data, _load(ana_path))
        if problems:
            raise UserError("分析.json 有 %d 处要改：\n- %s" % (len(problems), "\n- ".join(problems)))
    path = R.render_account(data, observations, folder)
    acc = data.get("account") or {}
    R.write_meta(folder, "「%s」最近什么最火" % (acc.get("name") or "博主"), "账号研究", _source_text(data.get("source") or {}, acc), [(os.path.basename(path), "账号研究")])
    say("重新生成了：%s" % rel(p, path))
    return 0


def _source_text(source, account):
    if source.get("kind") == "tikhub":
        return "TikHub 抖音/小红书接口 · %s" % (account.get("url") or account.get("name") or "")
    return "导入的表格：%s" % (source.get("file") or "")


# ---------- 评论 ----------

def _target(link):
    target = P.parse_target(link)
    if not target["platform"] and not target["id"]:
        raise UserError("认不出这个链接：%s。把视频（或笔记）的完整链接发我。" % short(link, 60))
    return target


def cmd_comments_find(args):
    p = places_or_die()
    target = _target(args.link)
    imports = CM.scan_imports(p["imports"])
    hits, unknown, broken = [], [], []
    for entry in imports:
        if entry["problem"]:
            broken.append(entry)
            continue
        matched = [g for g in entry["groups"] if CM.matches_target(g, target)]
        if matched:
            hits.append((entry, matched))
        elif all(g["key"] == CM.NO_VIDEO for g in entry["groups"]):
            unknown.append(entry)
    previous = [r for r in CM.scan_reports(p["reports"]) if any(CM.matches_target({"id": v.get("id"), "url": v.get("url"), "key": v.get("key")}, target) for v in r["videos"])]
    say("找的是：%s%s" % (target.get("url") or target.get("id"), "（短链接，表里多半是长链接，对不上时看下面列的文件）" if target.get("short") and not target.get("id") else ""))
    if hits:
        say("「评论导入」里有这条的评论：")
        for entry, groups in hits:
            for g in groups:
                say("  · %s：%d 条（文件改于 %s）" % (entry["name"], g["rows"], _mtime(entry["mtime"])))
        say("下一步：comments prepare \"%s\" --video \"%s\" --topic 主题" % (hits[0][0]["name"], target.get("url") or target.get("id")))
    if previous:
        say("以前采过（不用再花钱）：")
        for r in previous:
            src = r["source"]
            say("  · %s：%s，%s" % (r["name"], src.get("kind"), (r.get("created_at") or "")[:10]))
    if unknown:
        say("这几个文件里没写是哪条视频，看不出来是不是这条：%s。问用户是不是。" % "、".join(e["name"] for e in unknown))
    if broken:
        for entry in broken:
            say("读不了的文件：%s（%s）" % (entry["name"], entry["problem"]))
    if not hits and not previous:
        say("「评论导入」里没有这条的评论（%s）。" % rel(p, p["imports"]))
        say("两条路：1）用社媒助手导出（免费版就能批量导出评论，量大也不花钱）：装好插件（https://socialext.com/download），"
            "用小号登录平台，在插件的「批量采集」里选采集评论、粘贴这条视频的链接、导出 Excel，放进上面这个文件夹；"
            "2）用 TikHub 采：先运行 comments plan 看要花多少钱（默认最多 200 条一级评论）。")
        return 0
    return 0


def _mtime(ts):
    import datetime
    return datetime.datetime.fromtimestamp(ts).strftime("%m-%d %H:%M")


def cmd_comments_prepare(args):
    p = places_or_die()
    os.makedirs(p["reports"], exist_ok=True)
    path = os.path.expanduser(args.file)
    if not os.path.isabs(path) and not os.path.exists(path):  # 只写了文件名，或者写的是工作文件夹里的相对路径
        for base in (p["imports"], p["work_folder"]):
            if os.path.exists(os.path.join(base, args.file)):
                path = os.path.join(base, args.file)
                break
    target = _target(args.video) if args.video else None
    dataset = CM.dataset_from_file(path, target, args.all_videos, rel(p, os.path.abspath(path)))
    topic = args.topic or _topic_from(dataset)
    folder = R.new_report_folder(p["reports"], topic)
    write_json(os.path.join(folder, "评论数据.json"), dataset)
    _say_dataset(p, folder, dataset)
    return 0


def _topic_from(dataset):
    videos = dataset.get("videos") or []
    if len(videos) == 1 and videos[0].get("title"):
        return "%s-评论区" % short(videos[0]["title"], 20).rstrip("…")
    return "评论洞察"


def _say_dataset(p, folder, dataset):
    st, cols = dataset["stats"], dataset["columns"]
    say("评论整理好了：%s" % rel(p, os.path.join(folder, "评论数据.json")))
    say("  原始 %d 行，重复 %d 行，没法分析的 %d 条（%s），有效 %d 条：一级 %d、回复 %d、层级不明 %d。"
        % (st["rows_in"], st["duplicates"], st["noise"], "、".join("%s %d" % kv for kv in st["noise_reasons"].items()) or "无",
           st["valid"], st["top_level"], st["replies"], st["level_unknown"]))
    if cols.get("unrecognized"):
        say("  认不出的列（没用上，报告里会写）：%s" % "、".join(cols["unrecognized"][:15]))
    if (dataset.get("source") or {}).get("kind") == "导入的表格" and "likes" not in cols.get("recognized", {}):
        say("  没认出点赞数那一列：报告里的点赞都会显示成「—」。")
    say("下一步：comments show \"%s\"，把全部有效评论读完，写 分析.json，再 comments render。" % os.path.basename(folder))


def cmd_comments_plan(args):
    p = places_or_die()
    target = _target(args.link)
    if target["platform"] not in C.SUPPORTED:
        raise C.unsupported(target["platform"])
    plan = C.comments_plan(target, args.max, args.replies)
    prices = T.prices_for(ENV)
    ledger = T.Ledger(os.path.join(p["hidden"], "用量.jsonl"))
    try:
        cost, head = T.check_plan(plan, prices, ledger)
        say(head + "在默认上限以内，可以直接采。")
    except NeedsAgreement as e:
        say(str(e))
        return e.exit_code
    return 0


def cmd_comments_fetch(args):
    p = places_or_die()
    os.makedirs(p["reports"], exist_ok=True)
    target = _target(args.link)
    if target["platform"] not in C.SUPPORTED:
        raise C.unsupported(target["platform"])
    plan = C.comments_plan(target, args.max, args.replies)
    session = C.Session(p, ENV, refresh=args.refresh)
    session.start(plan, args.agreed_budget)
    rows, info, notes = C.fetch_comments(session, target, args.max, args.replies)
    if not rows:
        raise UserError("这条作品一条评论都没采到（评论区可能关了，或者还没人评论）。这次花了约 %s。" % money(session.client.spent))
    source = C.comments_source(session, info, notes, args.replies)
    key = info.get("id") or P.canonical_link(info.get("url") or target.get("url") or "")
    meta = {key: {"title": info.get("title"), "url": info.get("url"), "comment_count": info.get("comment_count")}}
    columns = {"recognized": {}, "unused": [], "unrecognized": []}
    dataset = CM.build_dataset(rows, columns, target["platform"], source, meta)
    topic = args.topic or _topic_from(dataset)
    folder = R.new_report_folder(p["reports"], topic)
    write_json(os.path.join(folder, "评论数据.json"), dataset)
    s = session.summary()
    say("TikHub：实际调了 %d 次，约 %s。%s" % (s["requests"], money(s["cost_usd"]), "".join(notes)))
    _say_dataset(p, folder, dataset)
    return 0


def cmd_comments_show(args):
    p = places_or_die()
    folder = PL.report_dir(p, args.folder)
    dataset = read_json(os.path.join(folder, "评论数据.json"))
    lines, total = CM.listing(dataset, args.start, args.limit)
    st = dataset["stats"]
    say("有效评论 %d 条（一级 %d、回复 %d），这里列第 %d 到 %d 条。格式：短号 赞数 层级 属地 日期 | 原文。"
        % (total, st["top_level"], st["replies"], args.start, min(total, args.start + args.limit - 1)))
    for line in lines:
        say(line)
    if args.start + args.limit - 1 < total:
        say("还有 %d 条没列：加 --start %d 接着看。分类前要全部读完。" % (total - (args.start + args.limit - 1), args.start + args.limit))
    return 0


def cmd_comments_render(args):
    p = places_or_die()
    folder = PL.report_dir(p, args.folder)
    data_path, ana_path = os.path.join(folder, "评论数据.json"), os.path.join(folder, "分析.json")
    if not os.path.isfile(data_path):
        raise UserError("这个文件夹里没有 评论数据.json，先用 comments prepare 或 comments fetch。")
    if not os.path.isfile(ana_path):
        raise UserError("还没有 分析.json：读完评论后，按 references/评论洞察怎么做.md 的格式写进 %s。" % rel(p, ana_path))
    dataset = read_json(data_path)
    analysis, problems, warnings = CM.check_analysis(dataset, _load(ana_path))
    if problems:
        raise UserError("分析.json 有 %d 处要改（改好再运行）：\n- %s" % (len(problems), "\n- ".join(problems)))
    path = R.render_comments(dataset, analysis, folder)
    source = dataset.get("source") or {}
    src_text = ("TikHub 采集" if source.get("kind") == "TikHub" else "导入的表格：%s" % source.get("file"))
    urls = [v.get("url") for v in dataset.get("videos") or [] if v.get("url")]
    if urls:
        src_text += " · " + "、".join(urls[:3])
    R.write_meta(folder, analysis["title"] or "评论洞察", "评论洞察", src_text, [(os.path.basename(path), "评论洞察")])
    say("评论洞察报告：%s" % rel(p, path))
    say("  结论 %d 条、选题 %d 个、分类 %d 类；没归类的 %d 条。" % (len(analysis["takeaways"]), len(analysis["topics"]), len(analysis["categories"]), len(analysis["uncategorized"])))
    for w in warnings:
        say("  提醒：%s" % w)
    return 0


def _load(path):
    try:
        return read_json(path)
    except ValueError as e:
        raise UserError("%s 不是合法的 JSON：%s" % (os.path.basename(path), e))


# ---------- 拆视频 ----------

def cmd_video_fetch(args):
    p = places_or_die()
    target = _target(args.link)
    if target["platform"] not in C.SUPPORTED:
        raise C.unsupported(target["platform"])
    plan = C.video_plan(target)
    session = C.Session(p, ENV, refresh=args.refresh)
    session.start(plan, args.agreed_budget)
    work = C.fetch_video(session, target)
    work["platform"] = target["platform"]
    work["source"] = "tikhub"
    cover = work.pop("cover_url", None)
    work.pop("author_profile", None)
    out = {k: work.get(k) for k in ("platform", "id", "url", "title", "desc", "author", "published_at", "duration_seconds", "type",
                                    "likes", "comments", "collects", "shares", "tags", "source")}
    if args.out:
        write_json(os.path.abspath(os.path.expanduser(args.out)), out)
    s = session.summary()
    say(json.dumps(out, ensure_ascii=False, indent=2))
    say("TikHub：调了 %d 次，约 %s。TikHub 拿不到这条视频的字幕或逐字稿：要拆讲法，请用户把逐字稿贴进来。" % (s["requests"], money(s["cost_usd"])))
    return 0


def cmd_video_render(args):
    p = places_or_die()
    os.makedirs(p["reports"], exist_ok=True)
    raw = _load(os.path.abspath(os.path.expanduser(args.data)))
    transcript = None
    if args.transcript:
        with open(os.path.expanduser(args.transcript), encoding="utf-8-sig") as f:
            transcript = f.read().strip() or None
    data, problems = R.check_video_data(raw, transcript)
    if problems:
        raise UserError("拆解的 JSON 有 %d 处要改：\n- %s" % (len(problems), "\n- ".join(problems)))
    folder = R.new_report_folder(p["reports"], args.topic or data["title"])
    write_json(os.path.join(folder, "拆解.json"), raw)
    if transcript:
        write_text(os.path.join(folder, "逐字稿.txt"), transcript + "\n")
    path = R.render_video(data, folder, transcript)
    video = data.get("video") or {}
    R.write_meta(folder, data["title"], "视频拆解", "%s %s" % (video.get("platform") or "", video.get("url") or ""), [(os.path.basename(path), "视频拆解")])
    say("视频拆解报告：%s" % rel(p, path))
    return 0


def cmd_video_save(args):
    p = places_or_die()
    dirs = PL.draft_dirs(args.content, p["drafts"])
    if not dirs:
        raise UserError("内容草稿里没有 %s 开头的文件夹。先建「%s_选题名」文件夹（工作台详情页点「建草稿文件夹」也行）。" % (args.content, args.content))
    if len(dirs) > 1:
        raise UserError("%s 有 %d 个草稿文件夹，先问用户用哪个：%s" % (args.content, len(dirs), "、".join(rel(p, d) for d in dirs)))
    with open(os.path.expanduser(args.file), encoding="utf-8-sig") as f:
        body = f.read().strip()
    if not body:
        raise UserError("拆解是空的。")
    path = os.path.join(dirs[0], "参考拆解.md")
    old = ""
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            old = f.read()
    target = P.parse_target(args.link) if args.link else {"url": None, "id": None}
    for needle in [x for x in (target.get("id"), target.get("url"), P.canonical_link(target["url"]) if target.get("url") else None) if x]:
        if needle in old:
            line = old[: old.index(needle)].count("\n") + 1
            raise UserError("这条参考已经拆过了（在 %s 第 %d 行）。写稿方法里说每条参考只拆一次：要补充就直接改那一节，不要再追加一份。" % (rel(p, path), line))
    head = "## 参考：%s\n\n" % (args.title or (target.get("url") or "（没写链接）"))
    meta = ["- 链接：%s" % (target.get("url") or "（没写）"), "- 拆的日期：%s" % today(),
            "- 逐字稿：%s" % (args.transcript_note or "用户贴的")]
    block = head + "\n".join(meta) + "\n\n" + body + "\n"
    text = (old.rstrip() + "\n\n" + block) if old.strip() else ("# 参考拆解\n\n" + block)
    write_text(path, text)
    say("写进了：%s（%s）" % (rel(p, path), "追加了一节" if old.strip() else "新建"))
    return 0


# ---------- 入口 ----------

def build_parser():
    ap = argparse.ArgumentParser(prog="research.py", description="调研 Skill 的命令")
    sub = ap.add_subparsers(dest="cmd")

    w = sub.add_parser("where", help="东西都放在哪、TikHub 密钥读没读到")
    w.add_argument("--json", action="store_true")
    w.set_defaults(func=cmd_where)

    t = sub.add_parser("tikhub", help="TikHub：check 看密钥能不能用和余额（免费）；prices 看单价")
    t.add_argument("action", choices=("check", "prices"))
    t.set_defaults(func=cmd_tikhub)

    def money_args(x):
        x.add_argument("--agreed-budget", type=float, help="用户在对话里明确同意的花费上限（美元）。只有用户同意了才加")
        x.add_argument("--refresh", action="store_true", help="不用 24 小时内存下的数据，重新采（要花钱）")

    acc = sub.add_parser("account", help="对标账号和账号研究")
    asub = acc.add_subparsers(dest="action")
    add = asub.add_parser("add", help="建或更新一个对标账号")
    add.add_argument("link", nargs="?", help="博主主页链接")
    add.add_argument("--max", type=int, default=30, help="最多拉几条最近作品，默认 30")
    add.add_argument("--manual", action="store_true", help="不用 TikHub，手动建档")
    add.add_argument("--platform", help="手动建档时的平台：抖音、小红书、视频号、B站……")
    add.add_argument("--name", help="手动建档时的账号名")
    add.add_argument("--url", help="手动建档时的主页链接")
    add.add_argument("--followers", help="手动建档时的粉丝数（比如 12000、1.2万）")
    add.add_argument("--bio", help="简介")
    add.add_argument("--note", help="备注：为什么对标他")
    add.add_argument("--tags", help="标签，用逗号隔开")
    add.add_argument("--image", action="append", help="主页截图（可以给几次）")
    add.add_argument("--cover", action="append", help="代表作封面截图（可以给几次）")
    money_args(add)
    add.set_defaults(func=cmd_account_add)
    ls = asub.add_parser("list", help="列出对标账号，顺便核对 档案.json")
    ls.set_defaults(func=cmd_account_list)
    rs = asub.add_parser("research", help="这个博主最近什么最火")
    rs.add_argument("who", nargs="?", help="主页链接，或者「对标账号」里的账号名")
    rs.add_argument("--max", type=int, default=30, help="看最近几条，默认 30")
    rs.add_argument("--works-file", help="不用 TikHub：社媒助手导出的博主作品表")
    rs.add_argument("--name", help="用作品表时的博主名字")
    rs.add_argument("--platform", help="用作品表时的平台")
    rs.add_argument("--topic", help="报告文件夹的主题")
    money_args(rs)
    rs.set_defaults(func=cmd_account_research)
    ar = asub.add_parser("render", help="写了 分析.json 以后重新生成账号研究报告")
    ar.add_argument("folder")
    ar.set_defaults(func=cmd_account_render)

    cm = sub.add_parser("comments", help="评论区分析")
    csub = cm.add_subparsers(dest="action")
    f = csub.add_parser("find", help="「评论导入」和以前的报告里有没有这条的评论")
    f.add_argument("link")
    f.set_defaults(func=cmd_comments_find)
    pr = csub.add_parser("prepare", help="读导出的评论表，整理成评论数据")
    pr.add_argument("file", help="导出文件（可以只写「评论导入」里的文件名）")
    pr.add_argument("--video", help="只要这条视频（或笔记）的评论：链接或编号")
    pr.add_argument("--all-videos", action="store_true", help="文件里几条视频的评论一起分析")
    pr.add_argument("--topic", help="报告文件夹的主题")
    pr.set_defaults(func=cmd_comments_prepare)
    for name, func in (("plan", cmd_comments_plan), ("fetch", cmd_comments_fetch)):
        x = csub.add_parser(name, help="用 TikHub 采评论：plan 只估算不花钱，fetch 真的采")
        x.add_argument("link")
        x.add_argument("--max", type=int, default=T.COMMENTS_DEFAULT_MAX, help="最多几条评论，默认 200；超过要用户同意。只要一级时数的是一级评论，平台附带的回复另算")
        x.add_argument("--replies", action="store_true", help="连楼中楼（回复）一起采，花得多一些")
        if name == "fetch":
            x.add_argument("--topic", help="报告文件夹的主题")
            money_args(x)
        x.set_defaults(func=func)
    sh = csub.add_parser("show", help="给 AI 读的评论清单")
    sh.add_argument("folder")
    sh.add_argument("--start", type=int, default=1)
    sh.add_argument("--limit", type=int, default=300)
    sh.set_defaults(func=cmd_comments_show)
    rd = csub.add_parser("render", help="核对 分析.json，出评论洞察报告")
    rd.add_argument("folder")
    rd.set_defaults(func=cmd_comments_render)

    vd = sub.add_parser("video", help="拆视频")
    vsub = vd.add_subparsers(dest="action")
    vf = vsub.add_parser("fetch", help="用 TikHub 拉标题、文案和数据（拿不到字幕）")
    vf.add_argument("link")
    vf.add_argument("--out", help="把拉到的信息存成 JSON")
    money_args(vf)
    vf.set_defaults(func=cmd_video_fetch)
    vr = vsub.add_parser("render", help="把拆解做成「视频拆解」报告")
    vr.add_argument("--data", required=True, help="AI 写的拆解 JSON")
    vr.add_argument("--transcript", help="逐字稿文本文件（有就核对引用的原话）")
    vr.add_argument("--topic", help="报告文件夹的主题")
    vr.set_defaults(func=cmd_video_render)
    vs = vsub.add_parser("save", help="把拆解追加进这条内容草稿文件夹的 参考拆解.md")
    vs.add_argument("--content", required=True, help="内容编号，比如 T001")
    vs.add_argument("--file", required=True, help="拆解的 Markdown 文件")
    vs.add_argument("--link", help="参考视频的链接（用来查有没有拆过）")
    vs.add_argument("--title", help="这一节的标题，比如「某某：三分钟学会……」")
    vs.add_argument("--transcript-note", help="逐字稿从哪来，比如「用户贴的」「没有逐字稿」")
    vs.set_defaults(func=cmd_video_save)
    return ap


def main(argv=None):
    ap = build_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "func", None):
        ap.print_help()
        return 2
    if getattr(args, "max", None) is not None and args.max < 1:
        print("--max 至少是 1。")
        return 2
    try:
        return args.func(args) or 0
    except NeedsAgreement as e:
        print(str(e))
        return e.exit_code
    except UserError as e:
        print(str(e))
        return e.exit_code
    except KeyboardInterrupt:
        print("停下了。")
        return 130
    except Exception:  # 程序自己的问题：给 AI 看完整的出错位置（里面没有密钥）
        import traceback
        print("调研脚本出错了，这是程序的问题，不是操作的问题。出错位置：")
        traceback.print_exc(file=sys.stdout)
        return 1


if __name__ == "__main__":
    sys.exit(main())
