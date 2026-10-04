"""出报告：自包含的 HTML（样式塞在文件里，不连网、不带脚本）和 meta.json，写进「市场调研/调研报告/<日期_主题>/」。

meta.json 的字段照工作台读调研报告的那几个：title、date、type、source、pages、workbenchVisible；
type 是「评论洞察」「视频拆解」「账号研究」之一。第一屏放结论和能直接用的东西，图表和明细往后放。
"""
import html
import os
import re
from collections import OrderedDict

from . import UserError
from .comments import LEVEL_REPLY, LEVEL_TOP, LEVEL_UNKNOWN, ip_ranking, sample_label
from .text import now_iso, safe_name, short, today, unique_dir, write_json, write_text

ASSETS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "assets")
TYPES = ("评论洞察", "视频拆解", "账号研究")
KIND_CLASS = {"需求": "k-need", "痛点": "k-pain", "疑问": "k-ask", "反馈": "k-feedback", "求资料": "k-resource", "其他": "k-other"}
LABEL_CLASS = {"够看出方向": "strong", "有一些，还要再看": "some", "很少，只是线索": "weak"}
CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"


def e(value):
    return html.escape("" if value is None else str(value), quote=True)


def safe_url(url):
    """只把 http、https 的链接做成可点的；别的（比如 javascript:）当没有。"""
    url = str(url or "").strip()
    return url if re.match(r"https?://", url, re.I) else None


def fmt_n(n):
    if n is None:
        return "—"
    if n >= 100000000:
        return ("%.1f" % (n / 100000000.0)).rstrip("0").rstrip(".") + " 亿"
    if n >= 10000:
        return ("%.1f" % (n / 10000.0)).rstrip("0").rstrip(".") + " 万"
    return str(n)


def fmt_day(text):
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", text or "")
    if not m:
        return text or ""
    return "%d年%d月%d日" % (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def fmt_md(text):
    m = re.match(r"\d{4}-(\d{2})-(\d{2})", text or "")
    return "%d月%d日" % (int(m.group(1)), int(m.group(2))) if m else (text or "")


def pct(n, total):
    return "%.0f%%" % (100.0 * n / total) if total else "—"


def _css():
    with open(os.path.join(ASSETS, "report.css"), encoding="utf-8") as f:
        return f.read()


def page(title, body):
    return ("<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
            "<meta http-equiv=\"Content-Security-Policy\" content=\"%s\">\n"
            "<meta name=\"generator\" content=\"workbench-research\">\n"
            "<title>%s</title>\n<style>\n%s</style>\n</head>\n<body>\n<main class=\"page\">\n%s\n</main>\n</body>\n</html>\n"
            % (CSP, e(title), _css(), body))


def new_report_folder(reports_dir, topic, date=None):
    """「调研报告」里新建一个「日期_主题」文件夹；同名的往后加 -2、-3，不覆盖以前的报告。"""
    name = "%s_%s" % (date or today(), safe_name(topic, 40, "调研"))
    folder = unique_dir(reports_dir, name)
    os.makedirs(folder)
    return folder


def folder_date(folder):
    m = re.match(r"(\d{4}-\d{2}-\d{2})_", os.path.basename(folder))
    return m.group(1) if m else today()


def write_meta(folder, title, kind, source, pages):
    if kind not in TYPES:
        raise ValueError("报告类型只能是 %s" % "、".join(TYPES))
    meta = OrderedDict([
        ("title", title),
        ("date", folder_date(folder)),
        ("type", kind),
        ("source", source),
        ("pages", [OrderedDict([("file", f), ("title", t)]) for f, t in pages]),
        ("workbenchVisible", True),
    ])
    write_json(os.path.join(folder, "meta.json"), meta)
    return meta


def _hero(kind, platform, title, scope, banner=None):
    pills = ['<span class="pill type">%s</span>' % e(kind)]
    if platform:
        pills.append('<span class="pill">%s</span>' % e(platform))
    pills.append('<span class="pill">%s</span>' % e(fmt_day(today())))
    out = ['<header class="hero">', '<div class="kicker">%s</div>' % "".join(pills), "<h1>%s</h1>" % e(title),
           '<p class="scope">%s</p>' % scope]
    if banner:
        out.append('<p class="banner">%s</p>' % banner)
    out.append("</header>")
    return "\n".join(out)


def _foot(text):
    return '<p class="foot">%s生成时间：%s。</p>' % (text, e(now_iso().replace("T", " ")[:16]))


# ---------- 评论洞察 ----------

def _comment_meta(c):
    bits = ["赞 %s" % ("—" if c["likes"] is None else fmt_n(c["likes"]))]
    if c.get("by_author"):
        bits.append("作者本人")
    bits.append("回复" if c["level"] == LEVEL_REPLY else ("一级评论" if c["level"] == LEVEL_TOP else "层级不明"))
    if c.get("ip"):
        bits.append(c["ip"])
    if c.get("time"):
        bits.append(fmt_md(c["time"]))
    return " · ".join(e(b) for b in bits)


def _quote(c, excerpt=None, limit=160):
    text = excerpt or c["text"]
    cut = ""
    if excerpt:
        text = "…%s…" % excerpt if excerpt != c["text"] else excerpt
    elif len(text) > limit:
        text, cut = text[: limit - 10] + "…", "（太长，截了前一段）"
    return '<blockquote><p>%s</p><footer>%s%s</footer></blockquote>' % (e(text), _comment_meta(c), e(cut))


def _scope_line(dataset):
    st = dataset["stats"]
    videos = dataset.get("videos") or []
    src = dataset.get("source") or {}
    where = "社媒助手等工具导出的表格" if src.get("kind") == "导入的表格" else ("TikHub 采集" if src.get("kind") == "TikHub" else "导入的数据")
    head = "来自 %d 条作品的评论" % len(videos) if videos else "来自评论数据"
    if len(videos) == 1:
        head = "来自「%s」的评论" % short(videos[0]["title"], 30) if videos[0].get("title") else "来自 1 条作品的评论"
    parts = ["%s（%s）" % (head, where), "共 %d 条，有效 %d 条" % (st["rows_in"] - st["duplicates"], st["valid"])]
    if st.get("time_from") and st.get("time_to"):
        a, b = fmt_md(st["time_from"]), fmt_md(st["time_to"])
        parts.append("评论时间都在 %s" % a if a == b else "评论时间 %s 到 %s" % (a, b))
    return e("，".join(parts) + "。")


def render_comments(dataset, analysis, folder, file_name="评论洞察.html"):
    comments = {c["ref"]: c for c in dataset["comments"]}
    valid_n = dataset["stats"]["valid"]
    if valid_n == 0:
        raise UserError("没有有效评论，出不了报告。")
    banner = None
    if valid_n < 30:
        banner = "样本很少（有效评论不到 30 条），下面的结论只当方向参考，别当成定论。"
    elif valid_n < 100:
        banner = "样本不大（有效评论不到 100 条），条数少的分类只当线索。"
    platform = dataset.get("platform")
    out = [_hero("评论洞察", platform, analysis["title"] or "评论区里大家在说什么", _scope_line(dataset), banner and e(banner))]

    # 第一屏：结论
    out.append('<section class="card lead" id="conclusions"><h2>先说结论</h2>'
               '<p class="lede">对写视频有用的几件事。每条后面是依据：几条评论这么说，挑一句原话。</p><ol class="takeaways">')
    for t in analysis["takeaways"]:
        q = comments.get(t["quote"]) if t["quote"] else None
        ev = "依据 %d 条评论（%s）" % (t["count"], sample_label(t["count"]))
        if q:
            ev += " · 比如 <q>%s</q>" % e(short(q["text"], 46))
        out.append('<li><p class="say">%s</p><p class="ev">%s</p></li>' % (e(t["text"]), ev))
    out.append("</ol></section>")

    # 可以直接拍的选题
    out.append('<section class="card" id="topics"><h2>可以直接拍的选题</h2>'
               '<p class="lede">从评论里长出来的选题方向，后面写着拍给谁、依据有多少。</p><div class="topics">')
    cats = {c["id"]: c for c in analysis["categories"]}
    for tp in analysis["topics"]:
        label = sample_label(tp["count"])
        bits = []
        if tp["audience"]:
            bits.append("<span>拍给：<b>%s</b></span>" % e(tp["audience"]))
        basis = "、".join("「%s」" % cats[c]["name"] for c in tp["categories"]) or "下面这条评论"
        bits.append("<span>依据：%s，共 %d 条</span>" % (e(basis), tp["count"]))
        bits.append('<span class="tag %s">%s</span>' % (LABEL_CLASS[label], e(label)))
        q = comments.get(tp["quote"]) if tp["quote"] else None
        out.append('<article class="topic"><h3>%s</h3><p>%s</p><div class="meta">%s</div>%s</article>'
                   % (e(tp["title"]), e(tp["why"]), "".join(bits), _quote(q) if q else ""))
    out.append("</div></section>")
    out.append('<nav class="toc"><span>下面是依据：</span><a href="#categories">大家在说什么</a><a href="#persona">评论的都是谁</a>'
               '<a href="#sample">样本够不够</a><a href="#data">数据说明</a></nav>')

    # 分类
    biggest = max([len(c["comments"]) for c in analysis["categories"]] or [1])
    out.append('<section class="card" id="categories"><h2>大家在说什么</h2>'
               '<p class="lede">按需求、痛点、疑问、反馈归类。一条评论可以同时属于几类，所以各类加起来会比总数多。条长按条数画。</p>')
    for cat in sorted(analysis["categories"], key=lambda c: -len(c["comments"])):
        members = [comments[r] for r in cat["comments"]]
        n, likes = len(members), sum(c["likes"] or 0 for c in members)
        replies = sum(1 for c in members if c["level"] == LEVEL_REPLY)
        label = sample_label(n)
        out.append('<div class="cat"><div class="cat-head"><h3>%s</h3><span class="tag %s">%s</span><span class="tag %s">%s</span></div>'
                   % (e(cat["name"]), KIND_CLASS.get(cat["kind"], "k-other"), e(cat["kind"]), LABEL_CLASS[label], e(label)))
        out.append('<div class="bar"><div class="track"><div class="fill" style="width:%.1f%%"></div></div>'
                   '<div class="num"><b>%d</b> 条 · 占 %s · 共 %s 赞%s</div></div>'
                   % (100.0 * n / biggest, n, pct(n, valid_n), fmt_n(likes), "（其中回复 %d 条）" % replies if replies else ""))
        if cat["summary"]:
            out.append('<p class="sum">%s</p>' % e(cat["summary"]))
        for q in cat["quotes"]:
            out.append(_quote(comments[q["ref"]], q.get("excerpt")))
        ranked = sorted(members, key=lambda c: -(c["likes"] or 0))
        shown = ranked[:200]
        items = "".join("<li>%s<small>%s</small></li>" % (e(c["text"]), _comment_meta(c)) for c in shown)
        more = "（只列点赞最多的 200 条）" if len(ranked) > 200 else ""
        out.append('<details><summary>看这一类的全部 %d 条原话%s</summary><ul class="all">%s</ul></details></div>' % (n, more, items))
    left = analysis.get("uncategorized") or []
    if left:
        items = "".join("<li>%s<small>%s</small></li>" % (e(comments[r]["text"]), _comment_meta(comments[r]))
                        for r in sorted(left, key=lambda r: -(comments[r]["likes"] or 0))[:200])
        out.append('<div class="cat"><div class="cat-head"><h3>没归进任何一类的</h3><span class="tag k-other">%d 条</span></div>'
                   '<p class="sum">多半是闲聊、夸一句、跟别人互动，和写视频关系不大。</p>'
                   '<details><summary>看这 %d 条</summary><ul class="all">%s</ul></details></div>' % (len(left), len(left), items))
    out.append("</section>")

    # 人群画像
    persona = analysis.get("persona") or {}
    out.append('<section class="card" id="persona"><h2>评论的都是谁</h2>'
               '<p class="lede">只写评论里自己说出来的身份和处境，不猜年龄、收入这些没说的。</p>')
    if persona.get("summary"):
        out.append('<p class="sum">%s</p>' % e(persona["summary"]))
    if persona.get("groups"):
        out.append('<div class="groups">')
        for g in persona["groups"]:
            n = len(g["comments"])
            first = comments[g["comments"][0]] if g["comments"] else None
            out.append('<div class="group"><div class="cat-head"><h3>%s</h3><span class="tag %s">%d 条 · %s</span></div>%s%s</div>'
                       % (e(g["name"]), LABEL_CLASS[sample_label(n)], n, e(sample_label(n)),
                          '<p>%s</p>' % e(g["description"]) if g["description"] else "", _quote(first) if first else ""))
        out.append("</div>")
    ranking = ip_ranking(dataset)
    st = dataset["stats"]
    if ranking:
        top = ranking[0][1]
        out.append('<h3 style="margin-top:18px">IP 属地前几名</h3><div class="rank">')
        for place, n in ranking:
            out.append('<span class="label">%s</span><div class="track"><div class="fill" style="width:%.1f%%"></div></div><span class="count">%d 条</span>'
                       % (e(place), 100.0 * n / top, n))
        out.append("</div>")
        out.append('<p class="note">有属地的评论 %d 条（共 %d 条有效）。属地只说明评论时人在哪个省，不代表户籍或常住地。</p>' % (st["ip_known"], valid_n))
    else:
        out.append('<p class="note">这批数据里没有 IP 属地。</p>')
    out.append("</section>")

    # 样本够不够
    out.append('<section class="card" id="sample"><h2>样本够不够</h2><ul class="rules">'
               "<li>一类有 10 条以上评论：够看出方向。</li><li>4 到 9 条：有一些，还要再看。</li>"
               "<li>3 条以下：很少，只是线索，别单靠它定选题。</li>"
               "<li>有效评论不到 30 条，整份报告只当方向参考；不到 100 条，条数少的分类只当线索。</li>"
               "<li>评论是愿意开口的那部分人，不代表所有看过视频的人；点赞数说明有多少人认同这句话，不等于人数。</li></ul>")
    out.append('<table><thead><tr><th>分类</th><th class="opt">类型</th><th>条数</th><th class="opt">占比</th><th>点赞</th><th>样本</th></tr></thead><tbody>')
    for cat in sorted(analysis["categories"], key=lambda c: -len(c["comments"])):
        n = len(cat["comments"])
        likes = sum(comments[r]["likes"] or 0 for r in cat["comments"])
        out.append('<tr><td>%s</td><td class="opt">%s</td><td class="n">%d</td><td class="n opt">%s</td><td class="n">%s</td><td>%s</td></tr>'
                   % (e(cat["name"]), e(cat["kind"]), n, pct(n, valid_n), fmt_n(likes), e(sample_label(n))))
    out.append("</tbody></table>")
    for caveat in analysis.get("caveats") or []:
        out.append('<p class="note">%s</p>' % e(caveat))
    out.append("</section>")

    out.append(_data_section(dataset))
    out.append(_foot("这份报告由调研 Skill 生成：条数、点赞、属地都是程序从评论原文算的；分类、结论和选题是 AI 读完全部有效评论后的判断；引用的原话一字未改。"))
    title = analysis["title"] or "评论洞察"
    path = os.path.join(folder, file_name)
    write_text(path, page(title, "\n".join(out)))
    return path


def _data_section(dataset):
    st, src, cols = dataset["stats"], dataset.get("source") or {}, dataset.get("columns") or {}
    rows = []
    if src.get("kind") == "TikHub":
        rows.append(("数据来源", "TikHub 采集（%s），%s" % (src.get("what") or "评论", fmt_day((src.get("collected_at") or "")[:10]))))
        rows.append(("花费", "调了 %s 次，按官方单价约 %s 美元" % (src.get("requests"), src.get("cost_usd"))))
    else:
        rows.append(("数据来源", "导入的表格：%s（%s）" % (src.get("file") or "", (src.get("format") or "").upper())))
    if src.get("note"):
        rows.append(("说明", src["note"]))
    for v in dataset.get("videos") or []:
        bits = []
        if v.get("title"):
            bits.append("「%s」" % short(v["title"], 30))
        bits.append("这次 %d 条（有效 %d 条）" % (v["rows"], v["valid"]))
        if v.get("comment_count_reported"):
            bits.append("平台显示一共 %s 条（含回复）" % fmt_n(v["comment_count_reported"]))
        rows.append(("作品", " ".join(bits) + (" · %s" % v["url"] if v.get("url") else "")))
    rows.append(("清洗", "原始 %d 行；重复 %d 行；没法分析的 %d 条（%s）；有效 %d 条"
                 % (st["rows_in"], st["duplicates"], st["noise"], "、".join("%s %d" % kv for kv in (st.get("noise_reasons") or {}).items()) or "无", st["valid"])))
    rows.append(("层级", "一级评论 %d 条，回复 %d 条，层级不明 %d 条" % (st["top_level"], st["replies"], st["level_unknown"])))
    if st.get("likes_missing"):
        rows.append(("点赞", "有 %d 条没有点赞数，按缺失处理，没当成 0" % st["likes_missing"]))
    if cols.get("recognized"):
        from .comments import FIELD_LABELS
        rows.append(("认出的列", "；".join("%s ←「%s」" % (FIELD_LABELS.get(k, k), v) for k, v in cols["recognized"].items())))
    if cols.get("unused"):
        rows.append(("没用的列", "、".join(cols["unused"][:20]) + "（评论者的编号、主页这些个人信息不进报告）"))
    if cols.get("unrecognized"):
        more = "等 %d 列" % len(cols["unrecognized"]) if len(cols["unrecognized"]) > 15 else ""
        rows.append(("认不出的列", "、".join(cols["unrecognized"][:15]) + more + "（没用上）"))
    body = "".join("<dt>%s</dt><dd>%s</dd>" % (e(k), e(v)) for k, v in rows)
    return '<section class="card" id="data"><h2>数据说明</h2><dl class="facts">%s</dl></section>' % body


# ---------- 账号研究 ----------

def render_account(data, observations, folder, file_name="账号研究.html"):
    acc, an = data["account"], data["analysis"]
    rows = {r["id"]: r for r in an["rows"]}
    name = acc.get("name") or "这个博主"
    scope_bits = ["看了最近 %d 条作品" % an["count"]]
    if an.get("time_from") and an.get("time_to"):
        scope_bits.append("发布时间 %s 到 %s" % (fmt_md(an["time_from"]), fmt_md(an["time_to"])))
    if acc.get("followers"):
        scope_bits.append("粉丝 %s" % fmt_n(acc["followers"]))
    scope_bits.append("数据是 %s 拉的" % fmt_md((data.get("as_of") or "")[:10]))
    banner = None
    if not an["enough"]:
        banner = "发布满 %d 天、数据齐的作品只有 %d 条（少于 %d 条），只按互动排了序，不判断谁明显更火。" % (an["rules"]["fresh_days"], an["mature"], an["rules"]["min_sample"])
    out = [_hero("账号研究", data.get("platform"), "「%s」最近什么最火" % name, e("，".join(scope_bits) + "。"), banner and e(banner))]
    standouts = [rows[i] for i in an["standouts"]]
    out.append('<section class="card lead" id="hot"><h2>明显比平时火的</h2>')
    if observations and observations.get("summary"):
        out.append('<p class="lede" style="font-size:15px;color:var(--ink)">%s</p>' % e(observations["summary"]))
    if standouts:
        out.append('<p class="lede">平时水平是每条约 %s 次互动（点赞+评论+收藏+分享的中位数）；下面这几条达到了平时的 %g 倍以上。</p>'
                   % (fmt_n(int(an["median"])), an["rules"]["factor"]))
        for r in standouts:
            out.append(_work_card(r))
    elif an["enough"]:
        out.append('<p class="lede">这 %d 条里没有哪条达到平时的 %g 倍：这段时间他发挥比较平均。最高的几条在下面的排行里。</p>' % (an["count"], an["rules"]["factor"]))
    else:
        out.append('<p class="lede">样本太少，先不判断。互动最高的几条：</p>')
        for r in an["rows"][:3]:
            out.append(_work_card(r))
    out.append("</section>")
    if observations and observations.get("observations"):
        out.append('<section class="card" id="notes"><h2>这几条有什么共同点</h2><p class="lede">AI 看了标题、文案和数据后的观察，是推测，不是定论。</p>')
        for ob in observations["observations"]:
            links = "、".join(('<a href="%s">%s</a>' % (e(safe_url(rows[w].get("url"))), e(short(rows[w].get("title") or w, 24))))
                              if safe_url(rows[w].get("url")) else e(short(rows[w].get("title") or w, 24)) for w in ob["works"])
            out.append('<div class="section"><h3>%s</h3><p>%s</p><p class="note">看的是：%s</p></div>' % (e(ob["title"]), e(ob["text"]), links))
        out.append("</section>")
    out.append('<section class="card" id="rules"><h2>怎么判断的</h2><ul class="rules">'
               "<li>互动数 = 点赞 + 评论 + 收藏 + 分享。抖音接口不给播放量（总是 0），所以不用播放量比。</li>"
               "<li>平时水平 = 发布满 %d 天的作品互动数的中位数（把作品按互动数排好，取正中间那条），这次是 %s。</li>"
               "<li>明显更火 = 互动数达到平时水平的 %g 倍以上。</li>"
               "<li>发布不到 %d 天的还在涨，只列出来，不参与判断；发布满 %d 天、数据齐的作品少于 %d 条时只排序、不判断。</li>"
               "<li>点赞、评论、收藏、分享里涨得最多的那一项，如果是这一项平时的 2 倍以上、又比整条的倍数高，会单独写出来：收藏特别高多半说明内容值得存，评论特别高多半说明有争议或有问题要问。</li>"
               "<li>只看了最近 %d 条，不代表这个号的全部历史；当前数据也不等于发布那几天的数据。</li></ul></section>"
               % (an["rules"]["fresh_days"], fmt_n(int(an["median"])) if an["median"] else "算不出来", an["rules"]["factor"],
                  an["rules"]["fresh_days"], an["rules"]["fresh_days"], an["rules"]["min_sample"], an["count"]))
    top = max([r["interactions"] or 0 for r in an["rows"]] or [1]) or 1
    out.append('<section class="card list" id="all"><h2>全部作品，按互动排</h2>'
               '<p class="lede">绿色是明显更火，灰色是还在涨，橙色竖线是平时水平。</p>')
    for i, r in enumerate(an["rows"], 1):
        cls = "row hot" if r["status"] == "明显更火" else ("row fresh" if r["status"] == "还在涨" else "row")
        width = 100.0 * (r["interactions"] or 0) / top
        median_mark = ('<span class="median" style="left:%.1f%%"></span>' % min(100.0, 100.0 * an["median"] / top)) if an["median"] else ""
        title = e(short(r.get("title") or r.get("desc") or r["id"], 40))
        link = '<a href="%s">%s</a>' % (e(safe_url(r.get("url"))), title) if safe_url(r.get("url")) else title
        sub = " · ".join(x for x in [fmt_md(r.get("published_at")), r["status"], "置顶" if r.get("pinned") else ""] if x)
        value = "<b>%s</b>" % fmt_n(r["interactions"]) if r["interactions"] is not None else "—"
        if r.get("ratio") is not None:
            value += " · %g 倍" % r["ratio"]
        out.append('<div class="%s"><span class="note">%d</span><div class="t">%s<small>%s</small><div class="mini"><i style="width:%.1f%%"></i>%s</div></div>'
                   '<span class="v">%s</span></div>' % (cls, i, link, e(sub), width, median_mark, value))
    out.append("</section>")
    src = data.get("source") or {}
    facts = [("数据来源", "TikHub 采集" if src.get("kind") == "tikhub" else "导入的表格：%s" % (src.get("file") or ""))]
    if src.get("requests") is not None:
        facts.append(("花费", "这次调了 %s 次，按官方单价约 %s 美元（24 小时内采过的直接用存下的，不重复花钱）" % (src.get("requests"), src.get("cost_usd"))))
    if acc.get("url"):
        facts.append(("主页", acc["url"]))
    if acc.get("bio"):
        facts.append(("简介", acc["bio"]))
    if an["pinned"]:
        facts.append(("置顶", "有 %d 条是置顶作品，可能发得比较早，排行里标了「置顶」" % an["pinned"]))
    if an["incomplete"]:
        facts.append(("数据不全", "有 %d 条没有点赞数，没参与判断" % an["incomplete"]))
    out.append('<section class="card" id="data"><h2>数据说明</h2><dl class="facts">%s</dl></section>'
               % "".join("<dt>%s</dt><dd>%s</dd>" % (e(k), e(v)) for k, v in facts))
    out.append(_foot("这份报告由调研 Skill 生成：排序、中位数、倍数都是程序按上面的规则算的；「共同点」是 AI 的观察。"))
    path = os.path.join(folder, file_name)
    write_text(path, page("「%s」最近什么最火" % name, "\n".join(out)))
    return path


def _work_card(r):
    title = e(r.get("title") or short(r.get("desc"), 40) or r["id"])
    link = '<a href="%s">%s</a>' % (e(safe_url(r.get("url"))), title) if safe_url(r.get("url")) else title
    stats = ['<span>%s</span>' % e(fmt_md(r.get("published_at")))] if r.get("published_at") else []
    stats.append("<span>互动 <b>%s</b></span>" % fmt_n(r["interactions"]))
    if r.get("ratio") is not None:
        stats.append('<span class="ratio">是平时的 %g 倍</span>' % r["ratio"])
    detail = " · ".join("%s %s" % (label, fmt_n(r.get(k))) for k, label in (("likes", "赞"), ("comments", "评"), ("collects", "藏"), ("shares", "转")))
    stats.append("<span>%s</span>" % e(detail))
    spikes = "".join('<span class="tag strong">%s</span> ' % e(s) for s in r.get("spikes") or [])
    return '<article class="work"><h3>%s</h3><div class="stats">%s</div>%s</article>' % (link, "".join(stats), '<div class="meta">%s</div>' % spikes if spikes else "")


# ---------- 视频拆解 ----------

def render_video(data, folder, transcript=None, file_name="视频拆解.html"):
    video = data.get("video") or {}
    scope = []
    for key, label in (("author", "作者"), ("published_at", "发布"), ("duration_seconds", "时长")):
        if video.get(key):
            value = fmt_md(video[key]) if key == "published_at" else ("%s 秒" % video[key] if key == "duration_seconds" else video[key])
            scope.append("%s：%s" % (label, value))
    numbers = " · ".join("%s %s" % (label, fmt_n(video.get(k))) for k, label in (("likes", "赞"), ("comments", "评"), ("collects", "藏"), ("shares", "转")) if video.get(k) is not None)
    if numbers:
        scope.append(numbers)
    scope_html = e("，".join(scope)) + (' · <a href="%s">原视频</a>' % e(safe_url(video.get("url"))) if safe_url(video.get("url")) else "")
    banner = None
    if not transcript:
        banner = "这次没有逐字稿，只看了标题、文案和数据；讲了什么、怎么讲的那几条是推测。有逐字稿可以贴给 AI 重拆一次。"
    out = [_hero("视频拆解", video.get("platform"), data["title"], scope_html, banner and e(banner))]
    out.append('<section class="card lead" id="summary"><h2>一句话</h2><p class="say" style="font-size:16.5px;font-weight:600;margin:8px 0 0">%s</p></section>' % e(data["summary"]))
    out.append('<section class="card" id="sections">')
    for sec in data["sections"]:
        quotes = "".join('<blockquote><p>%s</p><footer>%s</footer></blockquote>' % (e(q["text"]), "逐字稿原话" if q["checked"] else "引用（没有逐字稿可核对）")
                         for q in sec["quotes"])
        out.append('<div class="section"><h3>%s</h3><p>%s</p>%s</div>' % (e(sec["title"]), e(sec["text"]), quotes))
    out.append("</section>")
    if video.get("desc"):
        out.append('<section class="card" id="caption"><h2>作品文案（原文）</h2><p class="transcript">%s</p></section>' % e(video["desc"]))
    if transcript:
        out.append('<section class="card" id="transcript"><h2>逐字稿</h2><p class="lede">%s</p><details><summary>展开全文（%d 字）</summary><p class="transcript">%s</p></details></section>'
                   % (e(data.get("transcript_source") or "用户提供"), len(transcript), e(transcript)))
    out.append(_foot("这份报告由调研 Skill 生成：作品数据来自%s；拆解是 AI 按「写稿方法」里拆参考的写法做的判断。"
                     % ("TikHub" if video.get("source") == "tikhub" else "用户提供的信息")))
    path = os.path.join(folder, file_name)
    write_text(path, page(data["title"], "\n".join(out)))
    return path


def check_video_data(data, transcript=None):
    """AI 写的拆解：标题、一句话、几段拆解；有逐字稿时，引号里的原话必须在逐字稿里一字不差。"""
    problems = []
    if not isinstance(data, dict):
        return None, ["拆解的 JSON 最外层应该是 { … }"]
    title = data.get("title")
    summary = data.get("summary")
    if not isinstance(title, str) or not title.strip():
        problems.append("要有 title（报告标题，比如「拆解：某某的 AI 写周报教程」）")
    if not isinstance(summary, str) or not summary.strip():
        problems.append("要有 summary（一句话：这条最值得学什么）")
    sections = []
    for i, sec in enumerate(data.get("sections") or [], 1):
        if not isinstance(sec, dict) or not str(sec.get("title") or "").strip() or not str(sec.get("text") or "").strip():
            problems.append("第 %d 段拆解要有 title 和 text" % i)
            continue
        quotes = []
        for q in sec.get("quotes") or []:
            text = str(q or "").strip()
            if not text:
                continue
            checked = bool(transcript)
            if transcript and _squash(text) not in _squash(transcript):
                problems.append("第 %d 段「%s」引的「%s」在逐字稿里找不到（原话要一字不差）" % (i, sec["title"], short(text, 20)))
                continue
            quotes.append({"text": text, "checked": checked})
        sections.append({"title": sec["title"].strip(), "text": sec["text"].strip(), "quotes": quotes})
    if not sections:
        problems.append("sections（几段拆解）至少要有一段，按「写稿方法」里拆参考的那几件事写")
    video = data.get("video") if isinstance(data.get("video"), dict) else {}
    return {"title": (title or "").strip(), "summary": (summary or "").strip(), "sections": sections, "video": video,
            "transcript_source": data.get("transcript_source")}, problems


def _squash(text):
    return re.sub(r"[\s，。、！？：；,.!?:;“”\"'「」…—-]+", "", text)
