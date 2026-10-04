#!/usr/bin/env python3
"""创作页生成脚本：输入一份数据 JSON，输出不依赖网络和 CDN 的单文件 HTML。

  python3 build_page.py <数据.json> [--out <页面.html>] [--root <工作文件夹>] [--drop-missing] [--check]

不写 --out 时，页面放在工作台设置里「内容草稿」下这条内容的文件夹（T001_ 开头）里，文件名 T001_创作页.html。

页面 = template/shell.html，把占位换掉：{{TITLE}} 编号和标题，{{DOC}} jc-doc 数据块，
{{STYLE}} template/style.css、{{KIT}} kit/kit.js、{{APP}} template/app.js 这三段各用首尾标记包住
（<!--jc-style:start-->…<!--jc-style:end-->、<!--jc-kit:start-->…、<!--jc-app:start-->…），
保存服务按 /p/ 提供页面时把三段都换成模板目录里的当前版本；直接打开文件时用这里嵌进去的那份。
数据不合格（缺必填字段、段落身份号重复、建议原句在所属段我的版本里不是恰好出现一次等）就拒绝生成，一次列出全部原因。

目标文件已存在时是「重新生成」：在页面锁里读旧 jc-doc，沿用 page_id、token 和页面信息条目的身份号，
按身份号保留用户改过的格子（所有可改字段，包括扩展出来的）和 AI 写的 ai_state；
旧页面有、新数据没有的条目默认拒绝删除（加 --drop-missing 才删）。数据格式详见 schema/creation-page.md。

「只加不删」：段落、建议、页面信息可以另带 locked（额外的锁定键）和 fields（额外的可改字段），参考可以带额外的键，
顶层 items 可以放新种类的条目（例如录屏步骤 step），都原样写进页面。
"""
import argparse, html, json, os, re, secrets, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import creation_doc as cd  # noqa: E402

bs = cd.bs
TEMPLATE_DIR = os.path.join(HERE, 'template')
KIT_FILE = os.path.join(HERE, 'kit', 'kit.js')
KIT_START, KIT_END = '<!--jc-kit:start-->', '<!--jc-kit:end-->'
MARKED = ('style', 'kit', 'app')  # 用首尾标记包住、保存服务会换成当前版本的三段
TOP_KEYS = {'content_id', 'type', 'stage', 'title', 'narrative', 'speech_rate', 'service_origin', 'segments', 'suggestions', 'info', 'items'}
SEG_KEYS = {'id', 'title', 'role', 'refs', 'baseline', 'mine', 'note', 'locked', 'fields'}
SUG_KEYS = {'id', 'segment', 'category', 'source', 'original', 'proposed', 'reason', 'basis', 'verdict', 'locked', 'fields'}
ITEM_KEYS = {'id', 'kind', 'locked', 'fields'}
NARRATIVE_KEYS = ('story', 'audience', 'problem')
NARRATIVE_NAMES = {'story': '讲了个什么故事', 'audience': '给谁看', 'problem': '解决什么问题'}


class BuildError(Exception):
    """数据或模板不合格：problems 是全部原因，一条一句。"""
    def __init__(self, problems, head='数据不合格，拒绝生成'):
        super().__init__(head + '：\n' + '\n'.join('- ' + p for p in problems))
        self.problems = list(problems)


def _s(v):
    return isinstance(v, str)


def _filled(v):
    return isinstance(v, str) and v.strip() != ''


# ---------- 第一步：只看输入数据本身 ----------
def validate(data):
    """检查输入数据本身（不看旧页面），返回 (问题列表, 提醒列表)。"""
    P, W = [], []
    if not isinstance(data, dict):
        return ['数据最外层必须是一个 JSON 对象'], W
    unknown = sorted(set(data) - TOP_KEYS)
    if unknown: W.append('数据里有不认识的键（没用上）：%s' % '、'.join(unknown))
    inf = data.get('info', {})
    if not isinstance(inf, dict): P.append('info（页面信息的额外键）必须是对象 {locked, fields}')
    else:
        extra = sorted(set(inf) - {'locked', 'fields'})
        if extra: W.append('info 里有不认识的键（没用上）：%s' % '、'.join(extra))
        _check_extra(P, '页面信息', inf, cd.INFO)
    if not _filled(data.get('content_id')): P.append('缺少 content_id（内容编号，例如 T001）')
    if data.get('type') not in cd.TYPES: P.append('type 必须是 %s 之一，实际是 %r' % ('、'.join(cd.TYPES), data.get('type')))
    if data.get('stage') not in cd.STAGES: P.append('stage 必须是 %s 之一，实际是 %r' % ('、'.join(cd.STAGES), data.get('stage')))
    if not _filled(data.get('title')): P.append('缺少 title（标题）')
    nar = data.get('narrative')
    if nar is not None and not isinstance(nar, dict): P.append('narrative 必须是对象 {story, audience, problem}')
    else:
        nar = nar or {}
        for k in NARRATIVE_KEYS:
            if k in nar and not _s(nar[k]): P.append('narrative.%s（%s）必须是文字' % (k, NARRATIVE_NAMES[k]))
            elif data.get('type') == '口播' and not _filled(nar.get(k)): P.append('口播的 narrative.%s（%s）不能空' % (k, NARRATIVE_NAMES[k]))
    rate = data.get('speech_rate', cd.DEFAULT_RATE)
    if isinstance(rate, bool) or not isinstance(rate, (int, float)) or not 0 < rate <= 20:
        P.append('speech_rate（每秒字数）必须是 0 到 20 之间的数，实际是 %r' % (rate,))
    if 'service_origin' in data:
        p = cd.origin_problem(data['service_origin'])
        if p: P.append(p)
    segs = data.get('segments')
    if not isinstance(segs, list) or not segs:
        P.append('segments 必须是至少有一段的数组')
        segs = []
    seen = {}
    for n, s in enumerate(segs, 1):
        where = '第 %d 段' % n
        if not isinstance(s, dict):
            P.append('%s必须是对象' % where)
            continue
        if _filled(s.get('title')): where += '「%s」' % s['title']
        extra = sorted(set(s) - SEG_KEYS)
        if extra: W.append('%s有不认识的键（没用上）：%s；额外的锁定键和可改字段请放进 locked、fields' % (where, '、'.join(extra)))
        _check_extra(P, where, s, cd.SEGMENT)
        if 'id' in s:
            p = cd.id_problem(s['id'])
            if p: P.append('%s的 id %r：%s' % (where, s['id'], p))
            elif s['id'].startswith(cd.PREFIX[cd.INFO]): P.append('%s的 id 不能用 info- 开头（留给页面信息）' % where)
            elif s['id'] in seen: P.append('%s的 id %r 和%s重复' % (where, s['id'], seen[s['id']]))
            else: seen[s['id']] = where
        if not _filled(s.get('title')): P.append('%s缺少 title（段标题）' % where)
        if 'mine' not in s or not _s(s.get('mine')): P.append('%s缺少 mine（我的版本，可以是空字符串，但要有）' % where)
        for k in ('role', 'baseline', 'note'):
            if k in s and not _s(s[k]): P.append('%s的 %s 必须是文字' % (where, k))
        refs = s.get('refs', [])
        if not isinstance(refs, list):
            P.append('%s的 refs 必须是数组' % where)
            refs = []
        for m, r in enumerate(refs, 1):
            rw = '%s的第 %d 条参考' % (where, m)
            if not isinstance(r, dict):
                P.append('%s必须是对象' % rw)
                continue
            # 参考里固定键以外的键（例如教程的「画面」visual）原样保留，不提醒
            explain = r.get('source_type') == cd.EXPLAIN
            if not explain and not _filled(r.get('who')): P.append('%s缺少 who（谁说的）' % rw)
            if 'who' in r and not _s(r['who']): P.append('%s的 who 必须是文字' % rw)
            if r.get('source_type') not in cd.SOURCE_TYPES:
                P.append('%s的 source_type 必须是 %s 之一，实际是 %r' % (rw, '、'.join(cd.SOURCE_TYPES), r.get('source_type')))
            if not _filled(r.get('text')): P.append('%s缺少 text（%s）' % (rw, '说明的内容' if explain else '原文'))
            if 'time' in r and not _s(r['time']): P.append('%s的 time 必须是文字' % rw)
            p = cd.url_problem(r.get('url'))
            if p: P.append('%s的 url：%s' % (rw, p))
            if 'role' in r and r['role'] not in cd.REF_ROLES: P.append('%s的 role（角色）必须是 %s 之一，实际是 %r' % (rw, '、'.join(cd.REF_ROLES), r['role']))
            if 'visual' in r and not _s(r['visual']): P.append('%s的 visual（对方画面）必须是文字' % rw)
            if 'video' in r:
                p = video_problem(r['video'])
                if p: P.append('%s的 video（本地原片）：%s' % (rw, p))
            if explain and (_filled(r.get('time')) or _filled(r.get('url'))):
                W.append('%s是「说明」，页面上不显示时间和「看原片」，time、url 可以不写' % rw)
    sugs = data.get('suggestions', [])
    if not isinstance(sugs, list):
        P.append('suggestions 必须是数组')
        sugs = []
    for n, g in enumerate(sugs, 1):
        where = '第 %d 条建议' % n
        if not isinstance(g, dict):
            P.append('%s必须是对象' % where)
            continue
        extra = sorted(set(g) - SUG_KEYS)
        if extra: W.append('%s有不认识的键（没用上）：%s；额外的锁定键和可改字段请放进 locked、fields' % (where, '、'.join(extra)))
        _check_extra(P, where, g, cd.SUGGESTION)
        if 'id' in g:
            p = cd.id_problem(g['id'])
            if p: P.append('%s的 id %r：%s' % (where, g['id'], p))
            elif g['id'].startswith(cd.PREFIX[cd.INFO]): P.append('%s的 id 不能用 info- 开头（留给页面信息）' % where)
            elif g['id'] in seen: P.append('%s的 id %r 和%s重复' % (where, g['id'], seen[g['id']]))
            else: seen[g['id']] = where
        seg = g.get('segment')
        if _seg_index(seg) is not None:
            if not 1 <= _seg_index(seg) <= len(segs): P.append('%s的 segment 写的是第 %s 段，但一共只有 %d 段' % (where, seg, len(segs)))
        elif not _s(seg) or not any(isinstance(s, dict) and s.get('id') == seg for s in segs):
            P.append('%s的 segment %r 找不到对应段落（写段落 id，或从 1 起的段序号）' % (where, seg))
        if g.get('category') not in cd.CATEGORIES:
            P.append('%s的 category 必须是 %s 之一，实际是 %r' % (where, '、'.join(cd.CATEGORIES), g.get('category')))
        if g.get('source', 'AI') not in cd.SOURCES: P.append('%s的 source 必须是 %s 之一' % (where, '、'.join(cd.SOURCES)))
        if not _filled(g.get('original')): P.append('%s缺少 original（原句）' % where)
        if 'proposed' not in g: P.append('%s缺少 proposed（改成，删掉整句时写空字符串）' % where)
        elif cd.proposed_problem(g['proposed']): P.append('%s的 proposed（改成）%s' % (where, cd.proposed_problem(g['proposed'])))
        if not _filled(g.get('reason')): P.append('%s缺少 reason（为什么改）' % where)
        b = g.get('basis')
        if not isinstance(b, dict) or b.get('type') not in cd.BASIS_TYPES:
            P.append('%s的 basis 必须是 {type, text}，type 是 %s 之一' % (where, '、'.join(cd.BASIS_TYPES)))
        elif not _s(b.get('text', '')): P.append('%s的 basis.text 必须是文字' % where)
        if g.get('verdict', '待你定') not in cd.VERDICTS: P.append('%s的 verdict 必须是 %s 之一' % (where, '、'.join(cd.VERDICTS)))
    items = data.get('items', [])
    if not isinstance(items, list):
        P.append('items（新种类的条目）必须是数组')
        items = []
    refnote_segs, skeletons, pub_slots = set(), 0, set()
    sug_ids = {g.get('id') for g in sugs if isinstance(g, dict) and g.get('id')}
    for n, x in enumerate(items, 1):
        where = 'items 里第 %d 条' % n
        if not isinstance(x, dict):
            P.append('%s必须是对象 {id, kind, locked, fields}' % where)
            continue
        extra = sorted(set(x) - ITEM_KEYS)
        if extra: W.append('%s有不认识的键（没用上）：%s' % (where, '、'.join(extra)))
        k = x.get('kind')
        if k in cd.FIELDS:
            P.append('%s的 kind 是 %s：页面信息、段落、建议请写在 info、segments、suggestions 里' % (where, k))
            continue
        if not isinstance(k, str) or not cd.KIND_RE.fullmatch(k):
            P.append('%s的 kind %r 不对：新种类的名字用小写字母开头，只用小写字母、数字、下划线（例如 step）' % (where, k))
            continue
        where += '（%s）' % cd.kind_label(k)
        if 'id' in x:
            p = cd.id_problem(x['id'])
            if p: P.append('%s的 id %r：%s' % (where, x['id'], p))
            elif x['id'].startswith(cd.PREFIX[cd.INFO]): P.append('%s的 id 不能用 info- 开头（留给页面信息）' % where)
            elif x['id'] in seen: P.append('%s的 id %r 和%s重复' % (where, x['id'], seen[x['id']]))
            else: seen[x['id']] = where
        _check_extra(P, where, x, k)
        lk = x.get('locked') if isinstance(x.get('locked'), dict) else {}
        if 'segment' in lk:  # 约定：条目的 locked.segment 一律指所属段落（写段落 id 或从 1 起的序号）
            seg = lk['segment']
            if _seg_index(seg) is not None:
                if not 1 <= _seg_index(seg) <= len(segs): P.append('%s的 locked.segment 写的是第 %s 段，但一共只有 %d 段' % (where, seg, len(segs)))
            elif not _s(seg) or not any(isinstance(s, dict) and s.get('id') == seg for s in segs):
                P.append('%s的 locked.segment %r 找不到对应段落（写段落 id，或从 1 起的段序号）' % (where, seg))
        if k in (cd.PUBSLOT, cd.PUBCAND): _check_pub(P, where, k, lk, x.get('fields') if isinstance(x.get('fields'), dict) else {}, pub_slots)
        if k == cd.REFNOTE: _check_refnote(P, where, lk, segs, refnote_segs, sug_ids)
        elif k == cd.SKELETON:
            skeletons += 1
            if skeletons > 1: P.append('%s：骨架对照全片只能有一条' % where)
            _check_skeleton(P, where, lk, segs)
    W += overlap_warnings(segs, [x for x in items if isinstance(x, dict) and x.get('kind') == cd.REFNOTE])
    cand_slots = {(x.get('locked') or {}).get('slot') for x in items if isinstance(x, dict) and x.get('kind') == cd.PUBCAND and isinstance(x.get('locked'), dict)}
    for sl in sorted(s for s in cand_slots - pub_slots if s in cd.SLOTS):
        W.append('「%s」有候选，但没有这一样的发布文字条目（pubslot），页面上这些候选没处放' % sl)
    return P, W


# ---------- 发布文字（标题、封面文字、简介）：每样一条 pubslot，每个候选一条 pubcand ----------
def _check_pub(P, where, kind, lk, fi, pub_slots):
    slot = lk.get('slot')
    if slot not in cd.SLOTS:
        P.append('%s的 locked.slot 必须是 %s 之一，实际是 %r' % (where, '、'.join(cd.SLOTS), slot))
        return
    if kind == cd.PUBSLOT:
        if slot in pub_slots: P.append('%s：「%s」只能有一条发布文字条目' % (where, slot))
        pub_slots.add(slot)
        refs = lk.get('refs', [])
        if not isinstance(refs, list) or not all(isinstance(r, dict) and _filled(r.get('who')) and _filled(r.get('text')) for r in refs):
            P.append('%s的 locked.refs 必须是数组，每项至少有 who（谁）和 text（参考视频的原文）' % where)
        return
    if not _filled(fi.get('text')): P.append('%s缺少 fields.text（候选文字）' % where)
    if fi.get('decision', '') not in cd.PUB_DECISIONS: P.append('%s的 fields.decision 必须是 空、选用、不用 之一' % where)
    if not _filled(lk.get('reason')): P.append('%s缺少 locked.reason（为什么这么写）' % where)
    b = lk.get('basis')
    if b is not None and (not isinstance(b, dict) or b.get('type') not in cd.PUB_BASIS_TYPES or not _s(b.get('text', ''))):
        P.append('%s的 locked.basis 必须是 {type, text}，type 是 %s 之一' % (where, '、'.join(cd.PUB_BASIS_TYPES)))


# ---------- 参考分析（编导的功课）：refnote 每段一条、skeleton 全片一条 ----------
# 规矩都是为了一件事：用户看到的每句分析都能在原片里对上，不编、不估。
def _seg_of(ref, segs):
    i = _seg_index(ref)
    if i is not None: return segs[i - 1] if 1 <= i <= len(segs) and isinstance(segs[i - 1], dict) else None
    return next((s for s in segs if isinstance(s, dict) and s.get('id') == ref), None)


def _families(seg):
    """这一段里的原话类参考，按「谁」分组：{who: [参考, …]}（「说明」不算）。"""
    out = {}
    for r in (seg or {}).get('refs') or []:
        if isinstance(r, dict) and r.get('source_type') != cd.EXPLAIN and _filled(r.get('who')):
            out.setdefault(r['who'], []).append(r)
    return out


def _time_ok(t, refs):
    """时间码要落在这家这一段某条参考的时间段里（前后各放宽 3 秒）；参考没写时间段的不查。"""
    ts = cd.time_secs(t)
    if ts is None: return False
    spans = [cd.time_range(r.get('time')) for r in refs]
    spans = [x for x in spans if x]
    return not spans or any(a - 3 <= ts <= b + 3 for a, b in spans)


def _check_quote(P, where, qd, fam):
    if not isinstance(qd, dict): return P.append('%s必须是 {who, time, text}' % where)
    who, text, t = qd.get('who'), qd.get('text'), qd.get('time')
    if who not in fam: return P.append('%s的 who %r 不是这一段的参考（这一段有：%s）' % (where, who, '、'.join(fam) or '没有'))
    if not _filled(text): return P.append('%s缺少 text（原句）' % where)
    if len(text) > cd.QUOTE_MAX: P.append('%s的原句太长（%d 字），只截关键的一句，%d 字以内' % (where, len(text), cd.QUOTE_MAX))
    if not any(cd.count_in(r.get('text', ''), text) for r in fam[who]):
        P.append('%s的原句「%s」在%s这一段的原文里找不到，必须逐字截取' % (where, text, who))
    if not _filled(t): P.append('%s缺少 time（原句在原片里的时间，例如 1:05）' % where)
    elif not _time_ok(t, fam[who]): P.append('%s的时间 %s 不在%s这一段的时间段里（%s）' % (where, t, who, '、'.join(r.get('time', '') for r in fam[who])))


def _check_refnote(P, where, lk, segs, refnote_segs, sug_ids):
    seg = _seg_of(lk.get('segment'), segs)
    if seg is None: return P.append('%s缺少 locked.segment（属于哪一段）' % where) if 'segment' not in lk else None
    if seg.get('title') in refnote_segs: P.append('%s：第「%s」段已经有一条参考分析了，一段只能有一条' % (where, seg.get('title')))
    refnote_segs.add(seg.get('title'))
    fam = _families(seg)
    if not _filled(lk.get('summary')): P.append('%s缺少 summary（这一段参考怎么讲，两三句结论）' % where)
    elif len(lk['summary']) > 180: P.append('%s的 summary 太长（%d 字），两三句、180 字以内' % (where, len(lk['summary'])))
    pts = lk.get('points')
    if not isinstance(pts, list) or not 1 <= len(pts) <= 4: P.append('%s的 points（讲法点）必须是 1 到 4 条' % where); pts = pts if isinstance(pts, list) else []
    for m, pt in enumerate(pts, 1):
        w = '%s的第 %d 个讲法点' % (where, m)
        if not isinstance(pt, dict): P.append('%s必须是对象' % w); continue
        if pt.get('tag') not in cd.REF_TAGS: P.append('%s的 tag 必须是 %s 之一，实际是 %r' % (w, '、'.join(cd.REF_TAGS), pt.get('tag')))
        if not _filled(pt.get('say')): P.append('%s缺少 say（一句大白话）' % w)
        cov, who = pt.get('cover'), pt.get('who')
        if cov not in cd.COVERS: P.append('%s的 cover 必须是 %s 之一，实际是 %r' % (w, '、'.join(cd.COVERS), cov))
        if not isinstance(who, list) or not who or any(x not in fam for x in who):
            P.append('%s的 who 必须是这一段参考里的名字（数组），这一段有：%s' % (w, '、'.join(fam) or '没有')); who = []
        qs = pt.get('quotes')
        if not isinstance(qs, list) or not qs: P.append('%s缺少 quotes（至少一句原句）' % w); qs = []
        for i, qd in enumerate(qs, 1): _check_quote(P, '%s的第 %d 句原句' % (w, i), qd, fam)
        quoted = {qd.get('who') for qd in qs if isinstance(qd, dict)}
        if cov == '共性':
            if len(who) < 2: P.append('%s是「共性」，who 至少写两家' % w)
            miss = [x for x in who if x not in quoted]
            if miss: P.append('%s写「几家都这么讲」，每一家都要有一句原句，缺：%s' % (w, '、'.join(miss)))
        elif cov == '独有' and len(who) != 1: P.append('%s是「独有」，who 只写一家' % w)
        elif cov == '多做':
            if len(who) != 1: P.append('%s是「多做」，who 只写多做的那一家' % w)
            if pt.get('over') not in fam or pt.get('over') in who: P.append('%s是「多做」，over 写在哪一家的基础上多做（这一段的另一家）' % w)
        if who and cov in ('独有', '多做') and who[0] not in quoted: P.append('%s要有%s的原句' % (w, who[0]))
        v = pt.get('visual')
        if v is not None:
            if not isinstance(v, dict) or v.get('who') not in fam or not _filled(v.get('text')) or not _filled(v.get('time')):
                P.append('%s的 visual（画面）必须是 {who, time, text}，who 是这一段的参考' % w)
            elif not _time_ok(v['time'], fam[v['who']]): P.append('%s的画面时间 %s 不在%s这一段的时间段里' % (w, v['time'], v['who']))
    bw = lk.get('borrow', [])
    if not isinstance(bw, list) or len(bw) > 3: P.append('%s的 borrow（可以借的）最多 3 条' % where); bw = bw if isinstance(bw, list) else []
    for m, b in enumerate(bw, 1):
        w = '%s的第 %d 条可以借的' % (where, m)
        if not isinstance(b, dict) or b.get('type') not in cd.BORROW_TYPES or not _filled(b.get('text')):
            P.append('%s必须是 {type, text}，type 是 %s 之一' % (w, '、'.join(cd.BORROW_TYPES))); continue
        if 'sug' in b and b['sug'] not in sug_ids: P.append('%s的 sug %r 找不到对应的建议（建议要在 suggestions 里写明同样的 id）' % (w, b['sug']))
    for m, g in enumerate(lk.get('merged') or [], 1):
        if not isinstance(g, dict) or g.get('who') not in fam or g.get('base') not in fam or g['who'] == g.get('base'):
            P.append('%s的第 %d 条 merged 必须是 {who, base, ratio}，两家都是这一段的参考' % (where, m))


def _check_skeleton(P, where, lk, segs):
    fams = lk.get('families')
    if not isinstance(fams, list) or not fams or any(not isinstance(f, dict) or not _filled(f.get('who')) for f in fams):
        return P.append('%s的 families 必须是 [{who, role, date, stat}, …]' % where)
    if len(fams) > 4: P.append('%s最多 4 家（中译中的两家可以并成一家写）' % where)
    names = {f['who'] for f in fams}
    rows = lk.get('rows')
    if not isinstance(rows, list) or not 1 <= len(rows) <= 8: return P.append('%s的 rows（骨架的每一步）必须是 1 到 8 行' % where)
    for m, r in enumerate(rows, 1):
        w = '%s第 %d 行' % (where, m)
        if not isinstance(r, dict) or not _filled(r.get('step')) or not isinstance(r.get('cells'), dict): P.append('%s必须是 {step, segment, cells}' % w); continue
        bad = [k for k in r['cells'] if k not in names]
        if bad: P.append('%s的 cells 里有 families 之外的名字：%s' % (w, '、'.join(bad)))
        if r.get('segment') is not None and _seg_of(r['segment'], segs) is None: P.append('%s的 segment %r 找不到对应段落' % (w, r['segment']))


def overlap_warnings(segs, refnotes):
    """同一段里两家逐字相同占到 40% 以上，而参考分析里没标 merged：提醒 AI 按中译中合并显示（只提醒，不拒绝）。"""
    W, marked = [], set()
    for x in refnotes:
        lk = x.get('locked') if isinstance(x.get('locked'), dict) else {}
        seg = _seg_of(lk.get('segment'), segs)
        for g in lk.get('merged') or []:
            if isinstance(g, dict) and seg: marked.add((seg.get('title'), g.get('who'), g.get('base')))
    for n, seg in enumerate(segs, 1):
        fam = _families(seg if isinstance(seg, dict) else {})
        names = list(fam)
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                ta, tb = ''.join(r.get('text', '') for r in fam[a]), ''.join(r.get('text', '') for r in fam[b])
                ra, rb = cd.overlap_ratio(ta, tb), cd.overlap_ratio(tb, ta)
                if max(ra, rb) >= cd.MERGE_RATIO and not ((seg.get('title'), a, b) in marked or (seg.get('title'), b, a) in marked):
                    W.append('第 %d 段%s和%s逐字相同占 %d%%（%s 的原文）/%d%%（%s 的原文），像是照着改写的，建议在这一段的参考分析里写 merged 合并显示'
                             % (n, a, b, round(ra * 100), a, round(rb * 100), b))
    return W


def video_problem(v):
    """本地原片的位置：相对页面文件的路径（可以用 .. 往上走），不能是网址、绝对路径或带反斜杠。"""
    if not _filled(v): return '必须是相对页面文件的路径'
    if re.match(r'[A-Za-z][A-Za-z0-9+.-]*:', v) or v.startswith('/') or '\\' in v: return '必须是相对页面文件的路径，实际是 %r' % v
    return None


def video_warnings(data, out):
    """参考里的本地原片找不到时提醒（不拒绝生成：原片可能稍后才放进去）。"""
    W, base = [], os.path.dirname(os.path.abspath(out))
    for n, s in enumerate(data.get('segments') or [], 1):
        for m, r in enumerate((s or {}).get('refs') or [], 1):
            v = r.get('video') if isinstance(r, dict) else None
            if _filled(v) and not video_problem(v) and not os.path.isfile(os.path.join(base, v)):
                W.append('第 %d 段第 %d 条参考的本地原片找不到：%s（「看原片」会打不开）' % (n, m, v))
    return W


def _check_extra(P, where, x, kind):
    """输入里的 locked（额外的锁定键）和 fields（额外的可改字段）：必须是对象，可改字段的值是文字，不能和固定键重名。"""
    std_locked = cd.LOCKED_KEYS.get(kind, ())
    std_fields = cd.FIELDS.get(kind, ())
    lk, fi = x.get('locked', {}), x.get('fields', {})
    if not isinstance(lk, dict): P.append('%s的 locked（额外的锁定键）必须是对象' % where)
    else:
        clash = [k for k in lk if k in std_locked or k in std_fields or k in ('id', 'kind')]
        if clash: P.append('%s的 locked 里 %s 是固定键，请写在外层' % (where, '、'.join(clash)))
        if bs.AI_STATE in lk: P.append('%s的 locked 里不能写 ai_state（AI 的回复用 brain_page.py reply 写）' % where)
    if not isinstance(fi, dict): P.append('%s的 fields（额外的可改字段）必须是对象' % where)
    else:
        clash = [k for k in fi if k in std_fields or k in std_locked or k in ('id', 'kind')]
        if clash: P.append('%s的 fields 里 %s 是固定键，请写在外层' % (where, '、'.join(clash)))
        bad = [k for k, v in fi.items() if not _s(v)]
        if bad: P.append('%s的可改字段 %s 的值必须是文字（空字符串也行）' % (where, '、'.join(bad)))


def _seg_index(v):
    """建议的 segment 写的是序号时返回整数（从 1 起），否则 None。"""
    if isinstance(v, bool): return None
    if isinstance(v, int): return v
    if isinstance(v, str) and v.isdigit(): return int(v)
    return None


# ---------- 第二步：组装 jc-doc（重新生成时接回旧页面的格子） ----------
def assemble(data, old=None, drop_missing=False, page_id=None):
    """返回 (doc, 提醒列表)；不合格抛 BuildError。old 是旧页面的 jc-doc（重新生成时）；page_id 是新建时指定的身份号。"""
    P, W = [], []
    old_items = {it.get('id'): it for it in (old or {}).get('items') or [] if isinstance(it, dict) and it.get('id')}
    taken = set(old_items)
    for x in list(data['segments']) + list(data.get('suggestions') or []) + list(data.get('items') or []):
        if x.get('id'): taken.add(x['id'])

    def keep(kind, iid, fields, locked, label):
        """按身份号接回旧条目的可改格子（所有字段，包括扩展出来的）和 ai_state；输入值和旧值不同时提醒。
        旧条目有、新数据没写的可改字段也接回来（只加不删：用户填过的格子不会因为 AI 漏写而消失）。"""
        o = old_items.get(iid)
        if o is None: return
        if cd.kind_of(o) != kind:
            P.append('%s的 id %s 在旧页面里是另一种条目（%s），不能沿用' % (label, iid, cd.kind_label(cd.kind_of(o))))
            return
        of = o.get('fields') or {}
        for k in fields:
            if k in of:
                if bs.norm(fields[k]) != bs.norm(of[k]) and fields[k] != '':
                    W.append('%s的 %s：数据里的值和页面上的不同，保留页面上的（用户改过的）' % (label, k))
                fields[k] = of[k]
        for k in of:
            if k not in fields:
                fields[k] = of[k]
                W.append('%s的可改字段 %s：新数据里没有，保留页面上的' % (label, k))
        st = cd.ai_state(o)
        if st: locked[bs.AI_STATE] = st

    def extra(x, part):
        return dict(x.get(part) or {})

    old_info = cd.info_of(old) if old else None
    info_id = old_info['id'] if old_info else cd.new_id(cd.INFO, taken)
    nar = data.get('narrative') or {}
    inf = data.get('info') or {}
    info = {'id': info_id, 'kind': cd.INFO,
            'locked': dict({'type': data['type'], 'stage': data['stage'], 'title': data['title'],
                            'narrative': {k: nar.get(k, '') for k in NARRATIVE_KEYS},
                            'speech_rate': data.get('speech_rate', cd.DEFAULT_RATE)}, **extra(inf, 'locked'), **{bs.AI_STATE: {}}),
            'fields': dict({'overall_note': '', 'approved': '', 'recorded': ''}, **extra(inf, 'fields'))}
    keep(cd.INFO, info_id, info['fields'], info['locked'], '页面信息')

    segs, by_pos = [], []
    for n, s in enumerate(data['segments'], 1):
        sid = s.get('id') or cd.new_id(cd.SEGMENT, taken)
        label = '第 %d 段「%s」' % (n, s['title'])
        refs = [dict({'who': r.get('who', ''), 'source_type': r['source_type'], 'time': r.get('time', ''), 'text': r['text'], 'url': r.get('url', '')},
                     **cd.extras(r, cd.REF_KEYS))  # 参考里的额外键（例如「画面」visual）原样保留
                for r in s.get('refs') or []]
        it = {'id': sid, 'kind': cd.SEGMENT,
              'locked': dict({'order': n, 'title': s['title'], 'role': s.get('role', ''), 'refs': refs, 'baseline': s.get('baseline', '')},
                             **extra(s, 'locked'), **{bs.AI_STATE: {}}),
              'fields': dict({'mine': s['mine'], 'note': s.get('note', '')}, **extra(s, 'fields'))}
        keep(cd.SEGMENT, sid, it['fields'], it['locked'], label)
        segs.append(it)
        by_pos.append(it)
    seg_by_id = {it['id']: it for it in segs}

    sugs = []
    for n, g in enumerate(data.get('suggestions') or [], 1):
        gid = g.get('id') or cd.new_id(cd.SUGGESTION, taken)
        idx = _seg_index(g['segment'])
        seg = by_pos[idx - 1] if idx is not None else seg_by_id[g['segment']]
        label = '第 %d 条建议（%s）' % (n, gid)
        it = {'id': gid, 'kind': cd.SUGGESTION,
              'locked': dict({'segment': seg['id'], 'category': g['category'], 'source': g.get('source', 'AI'), 'original': g['original'],
                              'reason': g['reason'], 'basis': {'type': g['basis']['type'], 'text': g['basis'].get('text', '')},
                              'verdict': g.get('verdict', '待你定')}, **extra(g, 'locked')),
              'fields': dict({'proposed': g['proposed'], 'decision': ''}, **extra(g, 'fields'))}
        existed = gid in old_items
        keep(cd.SUGGESTION, gid, it['fields'], it['locked'], label)
        hits = cd.count_in(seg['fields']['mine'], g['original'])
        if hits != 1:
            why = '在第 %d 段「%s」的我的版本里%s' % (seg['locked']['order'], seg['locked']['title'], '找不到' if hits == 0 else '出现了 %d 次' % hits)
            if not existed:
                P.append('%s的原句「%s」%s，必须恰好出现一次' % (label, g['original'], why))
            elif not it['fields'].get('decision'):
                W.append('%s的原句%s（用户可能改过这句），页面上这条的采纳按钮会变灰' % (label, why))
        sugs.append(it)

    others = []  # 新种类的条目（例如录屏步骤）：原样写进页面，locked.segment 写序号时换成段落 id
    for n, x in enumerate(data.get('items') or [], 1):
        kind = x['kind']
        xid = x.get('id') or cd.new_id(kind, taken)
        locked = extra(x, 'locked')
        if 'segment' in locked:
            idx = _seg_index(locked['segment'])
            locked['segment'] = by_pos[idx - 1]['id'] if idx is not None else locked['segment']
        it = {'id': xid, 'kind': kind, 'locked': locked, 'fields': extra(x, 'fields')}
        keep(kind, xid, it['fields'], it['locked'], 'items 里第 %d 条（%s %s）' % (n, cd.kind_label(kind), xid))
        others.append(it)

    new_ids = {info_id} | {it['id'] for it in segs} | {it['id'] for it in sugs} | {it['id'] for it in others}
    gone = [it for i, it in old_items.items() if i not in new_ids]
    if gone:
        desc = '、'.join('%s（%s）' % (it['id'], (it.get('locked') or {}).get('title') or (it.get('locked') or {}).get('original') or cd.kind_of(it))
                        for it in gone)
        if drop_missing:
            W.append('按 --drop-missing 删掉了旧页面里的 %d 条：%s（旧文件已留版本在 .jc-versions）' % (len(gone), desc))
        else:
            P.append('旧页面里有 %d 条在新数据里找不到：%s。重新生成会连同用户在上面改的内容一起删掉。'
                     '想保留就把它们的 id 写回数据（可以用 brain_page.py export 导出带身份号的数据再改）；确认要删就加 --drop-missing' % (len(gone), desc))
    if P: raise BuildError(P)
    doc = {'page_id': old['page_id'] if old else (page_id or cd.short(10)), 'content_id': data['content_id'], 'kind': cd.PAGE_KIND,
           'schema': cd.SCHEMA, 'token': old.get('token') if old and old.get('token') else secrets.token_urlsafe(18),
           'service_origin': data.get('service_origin') or cd.default_origin(), 'items': [info] + segs + sugs + others}
    return doc, W


# ---------- 第三步：套模板 ----------
# 占位：{{DOC}} 写在 <script id="jc-doc"> 里或单独写；{{STYLE}}、{{KIT}}、{{APP}} 写在对应标签里、单独写，或连首尾标记一起写，
# 生成出来一律是「开始标记 + 标签 + 内容 + 结束标记」；{{TITLE}} 可以出现多次。
PH_RE = re.compile(
    r'(?:<!--jc-(?P<mk>kit|style|app):start-->\s*)?'
    r'(?:(?P<open><(?P<tag>script|style)\b[^>]*>)\s*)?'
    r'\{\{(?P<name>KIT|APP|STYLE|DOC)\}\}'
    r'(?(open)\s*</(?P=tag)\s*>)'
    r'(?(mk)\s*<!--jc-(?P=mk):end-->)'
    r'|\{\{TITLE\}\}')
PH_TAG = {'DOC': 'script', 'KIT': 'script', 'APP': 'script', 'STYLE': 'style'}
EXTERNAL_RES = [
    (re.compile(r'\b(?:src|href|action|poster|data|srcset)\s*=\s*["\']?\s*(?:https?:)?//', re.I), '外部链接或资源'),
    (re.compile(r'url\(\s*["\']?\s*(?:https?:)?//', re.I), '样式里的外部资源 url()'),
    (re.compile(r'@import\b', re.I), '样式里的 @import'),
    (re.compile(r'<link\b[^>]*\bstylesheet\b', re.I), '外部样式表 <link>'),
    (re.compile(r'<script\b[^>]*\bsrc\s*=', re.I), '外部脚本 <script src>'),
]
esc_script, esc_style = bs.esc_script, bs.esc_style


def read_text(path, what):
    try:
        with open(path, encoding='utf-8') as f:
            return f.read()
    except (OSError, UnicodeDecodeError) as e:
        raise BuildError(['读不出%s %s：%s' % (what, path, e)], '模板不完整，拒绝生成')


def load_parts(template_dir=None, kit_path=None):
    """读模板三件套和 kit，返回 dict；缺文件、kit.js / app.js / style.css 末尾没有结束标记都拒绝
    （保存服务靠结束标记判断文件没写一半，没有它服务会一直改用页面自带的旧版本）。"""
    t = template_dir or TEMPLATE_DIR
    parts = {'shell': read_text(os.path.join(t, 'shell.html'), '模板'), 'app': read_text(os.path.join(t, 'app.js'), '界面脚本'),
             'style': read_text(os.path.join(t, 'style.css'), '样式'), 'kit': read_text(kit_path or KIT_FILE, '保存脚本')}
    P = ['%s %s 末尾没有结束标记 %s，可能写了一半' % ({'kit': '保存脚本', 'app': '界面脚本', 'style': '样式'}[k], bs.PART_FILES[k], bs.PART_EOF[k])
         for k in ('kit', 'app', 'style') if not parts[k].rstrip().endswith(bs.PART_EOF[k])]
    if P: raise BuildError(P, '模板不完整，拒绝生成')
    return parts


def render(doc, parts):
    """把占位换成内容，返回整页文字。只扫一遍模板：插进去的内容里就算有 {{…}} 也不会再被替换。"""
    shell, P = parts['shell'], []
    counts = {k: 0 for k in PH_TAG}
    for m in PH_RE.finditer(shell):
        name = m.group('name')
        if not name: continue
        counts[name] += 1
        if m.group('mk') and m.group('mk').upper() != name:
            P.append('模板里 <!--jc-%s:start--> 包的是 {{%s}}，对不上' % (m.group('mk'), name))
        if m.group('tag') and m.group('tag').lower() != PH_TAG[name]:
            P.append('模板里 {{%s}} 要写在 <%s> 里，不能写在 <%s> 里' % (name, PH_TAG[name], m.group('tag')))
        if name == 'DOC' and m.group('open') and not re.search(r'\bid\s*=\s*["\']jc-doc["\']', m.group('open')):
            P.append('模板里包 {{DOC}} 的 script 标签必须带 id="jc-doc"')
    for k, n in counts.items():
        if n != 1: P.append('模板 shell.html 里 {{%s}} 应该恰好出现 1 次，实际 %d 次' % (k, n))
    for rx, what in EXTERNAL_RES:
        for src, name in ((shell, 'shell.html'), (parts['style'], 'style.css')):
            if rx.search(src): P.append('%s 里有%s，页面必须是不依赖网络的单文件' % (name, what))
    if P: raise BuildError(P, '模板不合格，拒绝生成')
    info = cd.info_of(doc)
    title = html.escape('%s %s' % (doc['content_id'], (info or {}).get('locked', {}).get('title', '')), quote=True)
    body = bs.doc_json(doc)
    content = {'DOC': body, 'KIT': esc_script(parts['kit']), 'APP': esc_script(parts['app']), 'STYLE': esc_style(parts['style'])}

    def sub(m):
        name = m.group('name')
        if not name: return title
        tag = PH_TAG[name]
        if name == 'DOC':
            return '%s\n%s\n</script>' % (m.group('open') or '<script id="jc-doc" type="application/json">', body)
        mk = name.lower()
        return '<!--jc-%s:start-->%s\n%s\n</%s><!--jc-%s:end-->' % (mk, m.group('open') or '<%s>' % tag, content[name], tag, mk)
    return PH_RE.sub(sub, shell)


def check_page(text, doc):
    """生成后自检：保存服务读得出同一份 jc-doc；kit、样式、界面脚本的首尾标记各恰好一个、顺序对，标记之间恰好一个标签。返回问题列表。"""
    P = []
    try:
        got = bs.parse_page(text.encode('utf-8'))[1]
        if got != doc: P.append('保存服务从生成的页面里读出的 jc-doc 和要写的不一样（模板或界面脚本里可能有另一个 jc-doc）')
    except bs.PageError as e:
        P.append('保存服务读不出生成的页面：%s' % e)
    for k in MARKED:
        st, en = '<!--jc-%s:start-->' % k, '<!--jc-%s:end-->' % k
        a, b = text.count(st), text.count(en)
        if a != 1 or b != 1 or text.index(st) > text.index(en):
            P.append('页面里 %s 和 %s 应该各恰好 1 个且前后顺序对（界面脚本、样式、kit 里都不要写这些标记），实际 %d 个和 %d 个' % (st, en, a, b))
            continue
        inner = text[text.index(st) + len(st):text.index(en)]
        im = bs.PART_INNER_RE.fullmatch(inner)
        if not im or re.search(r'</' + im.group(3), im.group(4), re.I):
            P.append('页面里 %s 和 %s 之间应该恰好是一个完整的标签，保存服务才能换成当前版本' % (st, en))
    return P


def soft_warnings(parts):
    """界面脚本和 kit 里写死的外部网址：不拒绝，只提醒（参考链接应放在数据里）。"""
    W = []
    for name in ('app', 'kit'):
        urls = sorted(set(u for u in re.findall(r'https?://[^\s\'"`)<>]+', parts[name]) if not u.startswith('http://127.0.0.1')))
        if urls: W.append('%s 里写死了外部网址（页面不应主动请求它们）：%s' % ('app.js' if name == 'app' else 'kit.js', '、'.join(urls[:5])))
    return W


# ---------- 第四步：写文件 ----------
def _create(path, data):
    """原子地新建：临时文件写好后硬链接到目标名，目标名已存在就失败，不会盖掉别人刚建的文件。"""
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.jc-tmp-', dir=d)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.chmod(tmp, 0o644)
        try:
            os.link(tmp, path)
        except FileExistsError:
            raise
        except OSError:  # 文件系统不支持硬链接：退回「目标不存在才建」的写法
            with open(path, 'xb') as f:
                f.write(data); f.flush(); os.fsync(f.fileno())
    finally:
        os.unlink(tmp)
    if bs.read_page(path)[0] != data: raise BuildError(['写后回读和写入内容不一致：%s' % path], '写文件失败')


def check_new_page_id(page_id, root, out):
    """新建页面时指定身份号（例如旧页面移走后重建，想让旧地址继续能用）：格式要对，根目录下不能已有这个身份号的文件。"""
    if not isinstance(page_id, str) or not bs.ID_OK.fullmatch(page_id):
        raise BuildError(['--page-id %r 不对：只能用字母、数字、_、-，4 到 64 位' % (page_id,)])
    rt, how = cd.resolve_root(root, out)
    if not rt: raise BuildError(['指定身份号时要先确认根目录下没有同号的页面，%s' % how])
    try:
        found = cd.index_for(rt).lookup(page_id)[0]
    except bs.PageError as e:
        if e.code == 404: return
        raise BuildError(['在根目录 %s 下查身份号 %s 失败：%s' % (rt, page_id, e)])
    raise BuildError(['身份号 %s 已经被 %s 用了；同号两份文件保存服务会拒绝读写。先把旧页面移进回收站，或者不指定身份号' % (page_id, found)])


def build(data, out, root=None, drop_missing=False, template_dir=None, kit_path=None, check_only=False, page_id=None):
    """生成或重新生成页面。返回 {path, page_id, created, doc, warnings}；不合格抛 BuildError。
    page_id 只在新建时有用：沿用指定的身份号（重新生成本来就沿用旧页面的）。"""
    P, W = validate(data)
    if P: raise BuildError(P)
    parts = load_parts(template_dir, kit_path)
    W += soft_warnings(parts)
    out = os.path.abspath(out)
    W += video_warnings(data, out)
    if not os.path.exists(out):
        if page_id: check_new_page_id(page_id, root, out)
        doc, w = assemble(data, page_id=page_id)
        text = render(doc, parts)
        P = check_page(text, doc)
        if P: raise BuildError(P, '生成的页面自检没通过，拒绝写入')
        if not check_only:
            try:
                _create(out, text.encode('utf-8'))
            except FileExistsError:
                raise BuildError(['目标文件在生成途中被别人建好了：%s。请重跑一次（会按重新生成处理）' % out], '写文件失败')
        return {'path': out, 'page_id': doc['page_id'], 'created': True, 'doc': doc, 'warnings': W + w}
    # 重新生成：先读旧页面找根目录和身份号，再在页面锁里重读、合并、替换
    try:
        old_doc = bs.parse_page(bs.read_page(out)[0])[1]
    except (OSError, bs.PageError) as e:
        raise BuildError(['目标文件已存在，但读不出它的 jc-doc（%s）。为了不盖掉用户的改动，拒绝覆盖；确认不要了请先把它移进回收站' % e])
    if old_doc.get('content_id') != data['content_id']:
        raise BuildError(['目标文件是 %s 的页面，数据是 %s 的，多半是路径写错了' % (old_doc.get('content_id'), data['content_id'])])
    pid = old_doc['page_id']
    if page_id and page_id != pid:
        raise BuildError(['目标文件已存在（身份号 %s），重新生成会沿用它，不能换成 --page-id %s' % (pid, page_id)])
    rt, how = cd.resolve_root(root, out, old_doc)
    if not rt: raise BuildError(['重新生成要和保存服务用同一把页面锁，%s' % how])
    index = cd.index_for(rt)
    with bs.page_lock(rt, pid):
        for _ in range(5):
            try:
                path = index.lookup(pid)[0]
            except bs.PageError as e:
                raise BuildError(['在根目录 %s（%s）下按身份号 %s 找页面失败：%s' % (rt, how, pid, e)])
            if not bs.same_file(out, path):
                raise BuildError(['保存服务认的这个页面是 %s，不是 %s；为了不写错文件拒绝重新生成' % (path, out)])
            try:
                old_bytes, st0 = bs.read_page(path)
            except FileNotFoundError:
                continue
            text0, old_doc, m = bs.parse_page(old_bytes)
            doc, w = assemble(data, old_doc, drop_missing)
            text = render(doc, parts)
            P = check_page(text, doc)
            if P: raise BuildError(P, '生成的页面自检没通过，拒绝写入')
            if check_only or text.encode('utf-8') == old_bytes:
                return {'path': path, 'page_id': pid, 'created': False, 'doc': doc, 'warnings': W + w, 'unchanged': text.encode('utf-8') == old_bytes}
            try:
                if bs.commit(rt, pid, path, st0, old_bytes, text.encode('utf-8')):
                    return {'path': path, 'page_id': pid, 'created': False, 'doc': doc, 'warnings': W + w}
            except FileNotFoundError:
                continue
    raise BuildError(['文件一直在被别人改，重试 5 次仍没写进去：%s' % out], '写文件失败')


def main(argv=None):
    ap = argparse.ArgumentParser(description='生成创作页：数据 JSON → 单文件 HTML（格式见 schema/creation-page.md）')
    ap.add_argument('data', help='输入数据 JSON 文件')
    ap.add_argument('--out', help='输出的页面文件路径；不写就放进内容草稿里这条内容的文件夹，文件名「编号_创作页.html」')
    ap.add_argument('--root', help='工作文件夹（重新生成时拿页面锁用；不给就按 schema 里写的顺序找）')
    ap.add_argument('--drop-missing', action='store_true', help='重新生成时删掉旧页面里有、新数据里没有的条目')
    ap.add_argument('--check', action='store_true', help='只校验、不写文件')
    ap.add_argument('--page-id', help='新建页面时沿用这个身份号（例如旧页面移走后重建，想让旧地址继续能用）；根目录下已有同号页面就拒绝')
    ap.add_argument('--template-dir', help=argparse.SUPPRESS)
    ap.add_argument('--kit', help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    try:
        with open(a.data, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        print('读不出数据文件 %s：%s' % (a.data, e), file=sys.stderr)
        return 1
    try:
        out = a.out or default_out(data)
        r = build(data, out, a.root, a.drop_missing, a.template_dir, a.kit, a.check, a.page_id)
    except BuildError as e:
        print(str(e), file=sys.stderr)
        return 1
    doc = r['doc']
    sugs = cd.items_of(doc, cd.SUGGESTION)
    nseg, ndel = len(cd.items_of(doc, cd.SEGMENT)), sum(1 for g in sugs if cd.deletes_sentence((g.get('fields') or {}).get('proposed')))
    nother = len(doc['items']) - 1 - nseg - len(sugs)
    nsug = '%d 条建议' % len(sugs) + ('（其中 %d 条是%s）' % (ndel, cd.DELETE_SENTENCE) if ndel else '')
    if nother: nsug += '，另有 %d 个其他条目' % nother
    if a.check:
        print('数据合格（只校验，没写文件）：%d 段，%s' % (nseg, nsug))
    elif r.get('unchanged'):
        print('页面内容没有变化，没有重写：%s' % r['path'])
    else:
        print('%s创作页：%s' % ('已生成' if r['created'] else '已重新生成（沿用身份号，用户的改动已保留）', r['path']))
        print('  page_id：%s；%d 段，%s' % (r['page_id'], nseg, nsug))
        rt = cd.resolve_root(a.root, r['path'])[0]
        svc = cd.find_service(rt) if rt else None
        if svc:
            print('  页面链接：%s/p/%s（保存服务正在运行）' % (svc['origin'], r['page_id']))
        else:
            print('  页面链接：%s/p/%s（保存服务现在没在运行：在后台启动工作台以后才能打开，pnpm --dir "%s" start --background）' % (doc['service_origin'], r['page_id'], cd.REPO))
        if not rt:
            print('提醒：这个页面不在工作台的工作文件夹里，保存服务找不到它，页面上的改动存不回文件')
    for w in r['warnings']:
        print('提醒：' + w)
    return 0


def default_out(data):
    """没写 --out：放进工作台设置里「内容草稿」下这条内容的文件夹。文件夹必须已经有了，而且只有一个。"""
    cid = data.get('content_id') if isinstance(data, dict) else None
    if not _filled(cid): raise BuildError(['缺少 content_id（内容编号，例如 T001），没法找这条内容的草稿文件夹'])
    try:
        s = cd.workbench_settings()
    except cd.SettingsError as e:
        raise BuildError([str(e)])
    dirs = cd.draft_dirs(cid, s['drafts'])
    if not dirs:
        raise BuildError(['内容草稿（%s）里没有 %s 开头的文件夹。先建一个「%s_选题名」文件夹（工作台详情页点「建草稿文件夹」，'
                          '或者照工作文件夹里的 AGENTS.md 建），或者用 --out 写明页面放在哪' % (s['drafts'], cid, cid)])
    if len(dirs) > 1:
        raise BuildError(['内容草稿里有 %d 个 %s 开头的文件夹：%s。用 --out 写明页面放进哪一个' % (len(dirs), cid, '、'.join(os.path.basename(d) for d in dirs))])
    return os.path.join(dirs[0], cd.page_name(cid))


if __name__ == '__main__':
    sys.exit(main())
