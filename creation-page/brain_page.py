#!/usr/bin/env python3
"""给 AI 用的创作页命令：读页面、回复「写给 AI 的话」、加建议、改锁定字段、改格子、把我的版本抄成底稿、导出数据。

和保存服务用同一把文件锁（<根目录>/.jc-locks/<page_id>.lock）、同一套逐格规则和原子写法（直接 import server/brain_save.py）。
改用户的格子（mine、note、decision、overall_note、approved）默认拒绝，用户明确同意时才加 --user-approved。

<页面> 可以是页面文件路径、page_id，或内容编号（例如 T001，根目录下只有一个这样的页面时）。
<条目> 用身份号；页面信息条目也可以写 info。根目录的找法见 schema/creation-page.md（--root、JC_BRAIN_ROOT、正在运行的保存服务、往上找 .jc-locks）。

  brain_page.py read <页面>
  brain_page.py export <页面> [--out 数据.json]
  brain_page.py reply <页面> --item <段id> --text <回复>
  brain_page.py suggest <页面> --segment <段id> --category 衔接 --original <原句> --proposed <改成> --reason <为什么> --basis-type 'AI 自己的判断' --basis <说明>
  brain_page.py suggest <页面> --segment <段id> --category 表达 --original <整句> --proposed '' --reason <为什么删> --basis-type 'AI 自己的判断'
  brain_page.py set-locked <页面> --item info --key stage --value 审稿
  brain_page.py set-field <页面> --item <id> --field proposed --value <新值> [--before <改前值>] [--user-approved]
  brain_page.py rebase <页面> --item <段id> [--item …] | --all
  brain_page.py publish <页面> --file 发布文字.json
  brain_page.py list
publish：逐字稿内容确认后，一次放进标题、封面文字、简介的候选（只加不删，格式见 schema「发布文字」）。
「改成」写空字符串表示删掉整句（read 里显示「删掉这句」）。改建议的原句（set-locked --key original）要求新原句在所属段我的版本里恰好出现一次。
文字参数写成 - 时从标准输入读，末尾的换行会去掉；一条命令里只能有一个参数写成 -。
"""
import argparse, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import creation_doc as cd  # noqa: E402

bs = cd.bs
ORIGIN = 'brain_page'  # 写进改动记录的来源


class CliError(Exception):
    pass


# ---------- 找页面 ----------
class Page:
    """一个定位好的页面：根目录、索引、身份号、路径。"""
    def __init__(self, root, index, pid, path, how):
        self.root, self.index, self.pid, self.path, self.how = root, index, pid, path, how

    def doc(self):
        return bs.parse_page(bs.read_page(self.index.lookup(self.pid)[0])[0])[1]

    def rel(self):
        return os.path.relpath(self.path, self.root)


def locate(target, root_arg=None):
    if os.path.isfile(target):
        path = os.path.abspath(target)
        try:
            doc = bs.parse_page(bs.read_page(path)[0])[1]
        except (OSError, bs.PageError) as e:
            raise CliError('读不出页面 %s：%s' % (path, e))
        root, how = cd.resolve_root(root_arg, path, doc)
        if not root: raise CliError(how)
        index = cd.index_for(root)
        found = index.lookup(doc['page_id'])[0]
        if not bs.same_file(path, found):
            raise CliError('你给的文件 %s 不是保存服务认的那份（%s），为了不写错文件拒绝操作' % (path, found))
        return Page(root, index, doc['page_id'], found, how)
    root, how = cd.resolve_root(root_arg)
    if not root:
        raise CliError('找不到文件「%s」。用 page_id 或内容编号找页面需要知道工作文件夹：%s' % (target, how))
    index = cd.index_for(root)
    if bs.ID_OK.fullmatch(target):
        try:
            return Page(root, index, target, index.lookup(target)[0], how)
        except bs.PageError as e:
            if e.code != 404: raise
    hits = []
    for p in bs.iter_html(root, index.skip):
        try:
            doc = bs.parse_page(bs.read_page(p)[0])[1]
        except (OSError, bs.PageError):
            continue
        if doc.get('content_id') == target and doc.get('kind') == cd.PAGE_KIND: hits.append((p, doc['page_id']))
    if len(hits) != 1:
        raise CliError('在 %s 下按「%s」找创作页，找到 %d 个%s' % (root, target, len(hits), '：' + '、'.join(h[0] for h in hits) if hits else ''))
    return Page(root, index, hits[0][1], index.lookup(hits[0][1])[0], how)


def find_item(doc, ref, kind=None):
    if ref == 'info':
        it = cd.info_of(doc)
        if it is None: raise CliError('这个页面没有页面信息条目')
    else:
        it = next((x for x in doc['items'] if isinstance(x, dict) and x.get('id') == ref), None)
        if it is None: raise CliError('找不到条目「%s」（用 read 看身份号）' % ref)
    if kind and cd.kind_of(it) not in ((kind,) if isinstance(kind, str) else kind):
        raise CliError('条目 %s 是%s，这个命令要的是%s' % (it.get('id'), cd.kind_label(cd.kind_of(it)),
                                                  '或'.join(cd.kind_label(k) for k in ((kind,) if isinstance(kind, str) else kind))))
    return it


def seg_label(doc, sid):
    for n, s in enumerate(cd.segments_of(doc), 1):
        if s['id'] == sid: return '第 %d 段「%s」' % (n, (s.get('locked') or {}).get('title', ''))
    return '段落 %s（已不在页面上）' % sid


STDIN_NOTE = ('文字参数（--text、--original、--proposed、--reason、--basis、--value、--before）写成 - 时从标准输入读，'
              '末尾的换行会去掉（heredoc、echo 都会多带一个；和 "$(cat 文件)" 一样）。标准输入只能读一次，所以一条命令里只能有一个参数写成 -。')
_stdin_used = False  # 这条命令已经读过标准输入了；main 每次开头清零


def arg_text(v):
    """文字参数：写成 - 时从标准输入读，去掉末尾的换行（见 STDIN_NOTE）。第二个写成 - 的参数直接拒绝，免得它悄悄读到空。"""
    global _stdin_used
    if v != '-': return v
    if _stdin_used: raise CliError('一条命令里只能有一个文字参数写成 -（标准输入只能读一次）；别的参数请直接写，或者用 "$(cat 文件)"')
    _stdin_used = True
    return re.sub(r'[\r\n]+\Z', '', sys.stdin.read())


# ---------- read ----------
def fence(s):
    f = '```'
    while f in (s or ''): f += '`'
    return '%stext\n%s\n%s' % (f, s or '', f)


def render_read(page, doc):
    info = cd.info_of(doc) or {'locked': {}, 'fields': {}}
    lk, fi = info.get('locked') or {}, info.get('fields') or {}
    rate = lk.get('speech_rate') or cd.DEFAULT_RATE
    segs, sugs = cd.segments_of(doc), cd.items_of(doc, cd.SUGGESTION)
    L = ['# %s %s（%s）' % (doc.get('content_id', ''), lk.get('title', ''), doc.get('kind', '')), '',
         '- 文件：%s（根目录 %s，%s）' % (page.path, page.root, page.how),
         '- page_id：%s；类型：%s；阶段：%s；每秒 %s 字' % (page.pid, lk.get('type', '?'), lk.get('stage', '?'), rate),
         '- 内容已确认：%s' % ('是（%s）' % fi['approved'] if fi.get('approved') else '还没有')]
    nar = lk.get('narrative') or {}
    if any(nar.get(k) for k in ('story', 'audience', 'problem')):
        L += ['- 叙事：讲了个什么故事：%s；给谁看：%s；解决什么问题：%s' % (nar.get('story', ''), nar.get('audience', ''), nar.get('problem', ''))]
    total = sum(cd.text_len((s.get('fields') or {}).get('mine')) for s in segs)
    L += ['- 全稿：%d 段，%d 字（只数汉字、字母、数字，和页面一致），按每秒 %s 字约 %s' % (len(segs), total, rate, cd.fmt_secs(cd.seconds(total, rate)))]
    if fi.get('approved') and not cd.items_of(doc, cd.PUBCAND):
        L.append('- 下一步：内容已确认，还没出标题、封面文字和简介的候选。按 Skill「标题、封面文字、简介」一节出一版，用 publish 放进页面')
    L.append('')
    L += ['## 整体意见（用户写给 AI）', '']
    if (fi.get('overall_note') or '').strip():
        st = cd.ai_state(info)
        L += [fence(fi['overall_note']), '- %s' % ('待处理' if cd.note_pending(info) else 'AI 已处理，回复：%s' % st.get('reply', ''))]
    else:
        L += ['（没有）']
    pubslots = pub_slots(doc)
    pend = [s for s in segs + pubslots if cd.note_pending(s)]
    L += ['', '## 待处理的写给 AI 的话（%d 条）' % len(pend), '']
    if not pend: L.append('（没有）')
    for s in pend:
        label = seg_label(doc, s['id']) if cd.kind_of(s) == cd.SEGMENT else '发布文字「%s」' % s['locked'].get('slot', '')
        L += ['- %s（%s）：' % (label, s['id']), fence(s['fields'].get('note', ''))]
    L += ['', '## 各段', '']
    for n, s in enumerate(segs, 1):
        sl, sf, st = s.get('locked') or {}, s.get('fields') or {}, cd.ai_state(s)
        mine, base = sf.get('mine', ''), sl.get('baseline', '')
        chars = cd.text_len(mine)
        L += ['### 第 %d 段「%s」 %s' % (n, sl.get('title', ''), s['id'])]
        if sl.get('role'): L.append('- 作用：%s' % sl['role'])
        L.append('- 字数：%d 字，约 %s' % (chars, cd.fmt_secs(cd.seconds(chars, rate))))
        note = (sf.get('note') or '').strip()
        if cd.note_pending(s): L.append('- 写给 AI 的话：待处理（见上）')
        elif note: L.append('- 写给 AI 的话：AI 已处理，回复：%s' % st.get('reply', ''))
        L += ['- 我的版本：', fence(mine)]
        if not base: L.append('- 和底稿比：没有底稿')
        elif bs.norm(base) == bs.norm(mine): L.append('- 和底稿比：没改')
        else: L += ['- 和底稿比的删改（CriticMarkup）：', fence(cd.critic(base, mine))]
        L += extra_lines(s)
        L.append('')
    L += ['## 建议（%d 条）' % len(sugs), '']
    if not sugs: L.append('（没有）')
    seg_by_id = {s['id']: s for s in segs}
    for g in sugs:
        gl, gf = g.get('locked') or {}, g.get('fields') or {}
        seg = seg_by_id.get(gl.get('segment'))
        hits = cd.count_in((seg or {}).get('fields', {}).get('mine', ''), gl.get('original', ''))
        where = '还能找到 1 处' if hits == 1 else ('找不到了' if hits == 0 else '有 %d 处，对不上' % hits)
        L += ['- %s %s [%s，来源 %s] 结论：%s；用户的决定：%s' % (g['id'], seg_label(doc, gl.get('segment')), gl.get('category', ''), gl.get('source', ''),
                                                        gl.get('verdict', ''), gf.get('decision') or '还没定'),
              '  - 原句：%s（在我的版本里%s）' % (gl.get('original', ''), where),
              '  - 改成：%s' % cd.proposed_text(gf.get('proposed', '')),
              '  - 为什么：%s' % gl.get('reason', ''),
              '  - 依据（%s）：%s' % ((gl.get('basis') or {}).get('type', ''), (gl.get('basis') or {}).get('text', ''))]
    L += render_pub(doc, pubslots)
    L += ['', '## 录完的定稿', '']
    L.append(fence(fi['recorded']) if (fi.get('recorded') or '').strip() else '（还没有）')
    known = (cd.INFO, cd.SEGMENT, cd.SUGGESTION, cd.PUBSLOT, cd.PUBCAND)
    others = [it for it in doc['items'] if isinstance(it, dict) and cd.kind_of(it) not in known]
    info_extra = extra_lines(info) if cd.info_of(doc) else []
    if others or info_extra:
        L += ['', '## 其他格子和条目（按原样列出；教程的画面、录屏步骤也在这里）', '']
        if info_extra: L += ['### 页面信息'] + info_extra + ['']
        for it in others:
            lk = it.get('locked') or {}
            where = '，属于%s' % seg_label(doc, lk['segment']) if lk.get('segment') else ''
            L.append('### %s %s%s' % (cd.kind_label(cd.kind_of(it)), it.get('id'), where))
            L += extra_lines(it, show_all=True)
            L.append('')
    return '\n'.join(L) + '\n'


def pub_slots(doc):
    """发布文字的几样，按标题、封面文字、简介排。"""
    order = {k: i for i, k in enumerate(cd.SLOTS)}
    return sorted(cd.items_of(doc, cd.PUBSLOT), key=lambda it: order.get((it.get('locked') or {}).get('slot'), 99))


def pub_cands(doc, slot):
    cs = [it for it in cd.items_of(doc, cd.PUBCAND) if (it.get('locked') or {}).get('slot') == slot]
    return sorted(cs, key=lambda it: (_num((it.get('locked') or {}).get('round')), _num((it.get('locked') or {}).get('order'))))


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def render_pub(doc, slots):
    """读回摘要里的发布文字：每样用户定的那版、选了哪个候选、用户在候选基础上改了什么、没选的。定稿后提炼用户对标题、封面、简介的判断就看这里。"""
    if not slots and not cd.items_of(doc, cd.PUBCAND): return []
    L = ['', '## 标题、封面文字、简介（发布文字）', '']
    for sl in slots:
        lk, fi, st = sl.get('locked') or {}, sl.get('fields') or {}, cd.ai_state(sl)
        slot, final = lk.get('slot', ''), fi.get('final', '')
        cands = pub_cands(doc, slot)
        L.append('### %s %s' % (slot, sl['id']))
        L += ['- 用户定的：', fence(final)] if final.strip() else ['- 用户定的：还没定']
        chosen = [c for c in cands if (c.get('fields') or {}).get('decision') == '选用']
        for c in chosen:
            t = (c.get('fields') or {}).get('text', '')
            if final.strip() and bs.norm(t) != bs.norm(final):
                L += ['- 选用的是 %s，用户在它基础上改了（CriticMarkup）：' % c['id'], fence(cd.critic(t, final))]
            elif final.strip():
                L.append('- 选用的是 %s，原样用' % c['id'])
        if final.strip() and not chosen: L.append('- 没选任何候选，是用户自己写的')
        note = (fi.get('note') or '').strip()
        if cd.note_pending(sl): L.append('- 写给 AI 的话：待处理（见上）')
        elif note: L.append('- 写给 AI 的话：AI 已处理，回复：%s' % st.get('reply', ''))
        for c in cands:
            cl, cf = c.get('locked') or {}, c.get('fields') or {}
            b = cl.get('basis') or {}
            L.append('- 候选 %s（第 %s 轮%s）决定：%s；文字：%s' % (c['id'], cl.get('round', 1), '，' + cl['angle'] if cl.get('angle') else '',
                                                    cf.get('decision') or '还没定', (cf.get('text') or '').replace('\n', ' / ')))
            L.append('  - 为什么：%s%s' % (cl.get('reason', ''), '；依据（%s）：%s' % (b.get('type', ''), b.get('text', '')) if b else ''))
        L.append('')
    return L


def extra_lines(it, show_all=False):
    """条目里固定键以外的锁定键和可改字段（扩展出来的，例如「我方画面」「提示词」），给 AI 读。show_all 时列出全部。"""
    kind = cd.kind_of(it)
    lk = cd.extras(it.get('locked'), () if show_all else cd.LOCKED_KEYS.get(kind, ()))
    fi = cd.extras(it.get('fields'), () if show_all else cd.FIELDS.get(kind, ()))
    if show_all: lk.pop('segment', None)  # 所属段落已经写在标题里
    out = []
    for k, v in lk.items():
        out.append('- %s（%s，锁定）：%s' % (cd.key_label(k), k, v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)))
    for k, v in fi.items():
        if isinstance(v, str) and v.strip(): out += ['- %s（%s，可改）：' % (cd.key_label(k), k), fence(v)]
        else: out.append('- %s（%s，可改）：空' % (cd.key_label(k), k))
    return out


def export_data(doc):
    """把页面导出成 build_page.py 的输入数据（带全部身份号）。用户改的格子取当前值；重新生成时这些格子本来也按身份号保留。
    只加不删：扩展出来的锁定键、可改字段（放进各自的 locked、fields）、参考里的额外键和新种类的条目（放进 items）都导出，
    所以导出后原样重新生成，页面一个字节都不变。"""
    info = cd.info_of(doc) or {'locked': {}, 'fields': {}}
    lk = info.get('locked') or {}
    segs = cd.segments_of(doc)
    out = {'content_id': doc.get('content_id'), 'type': lk.get('type'), 'stage': lk.get('stage'), 'title': lk.get('title'),
           'narrative': lk.get('narrative') or {}, 'speech_rate': lk.get('speech_rate', cd.DEFAULT_RATE),
           'service_origin': doc.get('service_origin') or cd.default_origin(), 'segments': [], 'suggestions': []}
    _put_extras(out, info, cd.INFO, wrap='info')
    for s in segs:
        sl, sf = s['locked'], s['fields']
        seg = {'id': s['id'], 'title': sl.get('title', ''), 'role': sl.get('role', ''), 'refs': sl.get('refs') or [],
               'baseline': sl.get('baseline', ''), 'mine': sf.get('mine', ''), 'note': sf.get('note', '')}
        _put_extras(seg, s, cd.SEGMENT)
        out['segments'].append(seg)
    for g in cd.items_of(doc, cd.SUGGESTION):
        gl, gf = g['locked'], g['fields']
        sug = {'id': g['id'], 'segment': gl.get('segment'), 'category': gl.get('category'), 'source': gl.get('source', 'AI'),
               'original': gl.get('original'), 'proposed': gf.get('proposed', ''), 'reason': gl.get('reason'),
               'basis': gl.get('basis') or {}, 'verdict': gl.get('verdict', '待你定')}
        _put_extras(sug, g, cd.SUGGESTION)
        out['suggestions'].append(sug)
    others = [it for it in doc['items'] if isinstance(it, dict) and cd.kind_of(it) not in (cd.INFO, cd.SEGMENT, cd.SUGGESTION)]
    if others:
        out['items'] = [{'id': it.get('id'), 'kind': cd.kind_of(it), 'locked': cd.extras(it.get('locked'), ()), 'fields': dict(it.get('fields') or {})}
                        for it in others]
    return out


def _put_extras(target, it, kind, wrap=None):
    """把条目里固定键以外的锁定键、可改字段放进导出数据的 locked、fields（wrap 给了就放进 target[wrap]）。"""
    lk, fi = cd.extras(it.get('locked'), cd.LOCKED_KEYS[kind]), cd.extras(it.get('fields'), cd.FIELDS[kind])
    box = {}
    if lk: box['locked'] = lk
    if fi: box['fields'] = fi
    if not box: return
    if wrap: target[wrap] = box
    else: target.update(box)


# ---------- 改页面 ----------
def cmd_reply(page, item, text):
    def fn(doc):
        it = find_item(doc, item, (cd.SEGMENT, cd.INFO, cd.PUBSLOT))
        field = 'overall_note' if cd.kind_of(it) == cd.INFO else 'note'
        note = (it.get('fields') or {}).get(field, '')
        lk = it.setdefault('locked', {})
        st = dict(lk.get(bs.AI_STATE) or {})
        st.update(handled_note=note, reply=text, replied_at=bs.now_iso())
        lk[bs.AI_STATE] = st
        return '已回复 %s：抄下当前的写给 AI 的话「%s」，回复「%s」（不改条目指纹，用户正在改的格子不受影响）' % (
            it['id'], note, text)
    return bs.mutate(page.root, page.index, page.pid, fn)[2]


def check_choice(name, v, choices):
    if v not in choices: raise CliError('%s 必须是 %s 之一，实际是 %r' % (name, '、'.join(c or '空' for c in choices), v))


def cmd_suggest(page, a):
    check_choice('--category', a.category, cd.CATEGORIES)
    check_choice('--source', a.source, cd.SOURCES)
    check_choice('--basis-type', a.basis_type, cd.BASIS_TYPES)
    check_choice('--verdict', a.verdict, cd.VERDICTS)
    # 先把文字都读好：下面的 fn 在文件被别人改过时会重跑，不能在里面读标准输入
    original, proposed, reason, basis = arg_text(a.original), arg_text(a.proposed), arg_text(a.reason), arg_text(a.basis)
    if not original.strip(): raise CliError('--original（原句）不能空')
    if not reason.strip(): raise CliError('--reason（为什么改）不能空')
    if a.id:
        p = cd.id_problem(a.id)
        if p: raise CliError('--id %r：%s' % (a.id, p))

    def fn(doc):
        seg = find_item(doc, a.segment, cd.SEGMENT)
        hits = cd.count_in(seg['fields'].get('mine', ''), original)
        if hits != 1:
            raise CliError('原句「%s」在%s的我的版本里%s，必须恰好出现一次（用户可能刚改过，先 read 看当前稿）' % (
                original, seg_label(doc, seg['id']), '找不到' if hits == 0 else '出现了 %d 次' % hits))
        taken = {it.get('id') for it in doc['items'] if isinstance(it, dict)}
        if a.id and a.id in taken: raise CliError('身份号 %s 已经有了' % a.id)
        gid = a.id or cd.new_id(cd.SUGGESTION, taken)
        doc['items'].append({'id': gid, 'kind': cd.SUGGESTION,
                             'locked': {'segment': seg['id'], 'category': a.category, 'source': a.source, 'original': original,
                                        'reason': reason, 'basis': {'type': a.basis_type, 'text': basis}, 'verdict': a.verdict},
                             'fields': {'proposed': proposed, 'decision': ''}})
        return '已新增建议 %s（%s，%s%s）' % (gid, seg_label(doc, seg['id']), a.category,
                                         '，' + cd.DELETE_SENTENCE if cd.deletes_sentence(proposed) else '')
    return bs.mutate(page.root, page.index, page.pid, fn)[2]


LOCKED_RULES = {
    'type': lambda v: v in cd.TYPES or '必须是 %s 之一' % '、'.join(cd.TYPES),
    'stage': lambda v: v in cd.STAGES or '必须是 %s 之一' % '、'.join(cd.STAGES),
    'speech_rate': lambda v: (isinstance(v, (int, float)) and not isinstance(v, bool) and 0 < v <= 20) or '必须是 0 到 20 之间的数（加 --json）',
    'narrative': lambda v: (isinstance(v, dict) and all(isinstance(v.get(k, ''), str) for k in ('story', 'audience', 'problem')))
    or '必须是 {"story":…, "audience":…, "problem":…}（加 --json）',
    'order': lambda v: (isinstance(v, int) and not isinstance(v, bool) and v >= 1) or '必须是从 1 起的整数（加 --json）',
    'refs': lambda v: (isinstance(v, list) and all(isinstance(r, dict) and r.get('source_type') in cd.SOURCE_TYPES for r in v))
    or '必须是参考数组，每项的 source_type 是 %s 之一（加 --json）' % '、'.join(cd.SOURCE_TYPES),
    'category': lambda v: v in cd.CATEGORIES or '必须是 %s 之一' % '、'.join(cd.CATEGORIES),
    'source': lambda v: v in cd.SOURCES or '必须是 %s 之一' % '、'.join(cd.SOURCES),
    'verdict': lambda v: v in cd.VERDICTS or '必须是 %s 之一' % '、'.join(cd.VERDICTS),
    'basis': lambda v: (isinstance(v, dict) and v.get('type') in cd.BASIS_TYPES) or '必须是 {"type":…, "text":…}，type 是 %s 之一（加 --json）' % '、'.join(cd.BASIS_TYPES),
}


def cmd_set_locked(page, item, key, value):
    if key == bs.AI_STATE: raise CliError('ai_state 用 reply 命令写')
    rule = LOCKED_RULES.get(key)
    if rule:
        ok = rule(value)
        if ok is not True: raise CliError('%s %s' % (key, ok))

    def fn(doc):
        it = find_item(doc, item)
        if key == 'segment':  # 约定：条目的 locked.segment 一律指所属段落
            seg = find_item(doc, value, cd.SEGMENT)
            if cd.kind_of(it) == cd.SUGGESTION and cd.count_in(seg['fields'].get('mine', ''), it['locked'].get('original', '')) != 1:
                raise CliError('原句在%s的我的版本里不是恰好一处，不能挪过去' % seg_label(doc, value))
        if key == 'original' and cd.kind_of(it) == cd.SUGGESTION:  # 和 suggest 同一条规矩：新原句在所属段我的版本里恰好一处
            if not isinstance(value, str) or not value.strip(): raise CliError('建议的原句不能空')
            sid = (it.get('locked') or {}).get('segment')
            seg = find_item(doc, sid, cd.SEGMENT) if sid else None
            if seg is None: raise CliError('建议 %s 没写所属段落，没法核对新原句' % it['id'])
            hits = cd.count_in(seg['fields'].get('mine', ''), value)
            if hits != 1:
                raise CliError('新原句「%s」在%s的我的版本里%s，必须恰好出现一次（用户可能刚改过，先 read 看当前稿）' % (
                    value, seg_label(doc, sid), '找不到' if hits == 0 else '出现了 %d 次' % hits))
        lk = it.setdefault('locked', {})
        old = lk.get(key)
        if old == value: return None
        lk[key] = value
        return '已改条目 %s 的锁定字段 %s：%s → %s（条目指纹变了，用户这时正在改这一条的格子会按冲突处理）' % (
            it['id'], key, json.dumps(old, ensure_ascii=False), json.dumps(value, ensure_ascii=False))
    note = bs.mutate(page.root, page.index, page.pid, fn)[2]
    return note or '没有变化：%s 本来就是这个值' % key


def cmd_set_field(page, item, field, value, before=None, approved=False):
    if field in cd.OWNER_FIELDS and not approved:
        raise CliError('「%s」是用户的格子，AI 默认不能改。用户明确同意时才加 --user-approved；'
                       '想提修改意见请用 suggest 加一条建议，或用 reply 回复用户写给 AI 的话' % field)
    doc = page.doc()
    it = find_item(doc, item)
    if field == 'decision': check_choice('decision', value, cd.PUB_DECISIONS if cd.kind_of(it) == cd.PUBCAND else cd.DECISIONS)
    if field not in (it.get('fields') or {}):
        raise CliError('条目 %s 没有可改字段「%s」（有：%s）' % (it['id'], field, '、'.join(it.get('fields') or {})))
    ch = {'change_id': cd.short(12), 'item_id': it['id'], 'field': field,
          'before': it['fields'][field] if before is None else before, 'after': value, 'item_fp': bs.item_fp(it)}
    out = bs.merge_changes(page.root, page.index, page.pid, [ch], ORIGIN)
    r = out['results'][0]
    if r['status'] == 'ok':
        return '已写入条目 %s 的「%s」' % (it['id'], field) if r['reason'] == 'written' else '文件里本来就是这个值，没有改'
    why = {'changed': '这一格在你读之后被改过了（多半是用户刚改），文件里现在是：%r' % r.get('current'),
           'item_changed': '这一条的锁定字段在你读之后变了', 'item_gone': '这一条已经不在了', 'field_gone': '这一条已经没有这个字段了'}
    raise CliError('没写：%s。先 read 看最新内容再决定' % why.get(r['reason'], r['reason']))


def cmd_rebase(page, items, all_segments):
    def fn(doc):
        segs = cd.segments_of(doc) if all_segments else [find_item(doc, i, cd.SEGMENT) for i in items]
        done = []
        for s in segs:
            mine = s['fields'].get('mine', '')
            if s['locked'].get('baseline') != mine:
                s['locked']['baseline'] = mine
                done.append(s['id'])
        return ('已把 %d 段的我的版本抄成底稿：%s' % (len(done), '、'.join(done))) if done else None
    note = bs.mutate(page.root, page.index, page.pid, fn)[2]
    return note or '没有变化：底稿本来就和我的版本一样'


def load_publish(path):
    """读 publish 的输入文件并校验：{"slots": [{"slot", "refs"?, "candidates": [{"text", "angle"?, "reason", "basis"?}]}]}。"""
    try:
        with open(path, encoding='utf-8') as f: data = json.load(f)
    except (OSError, ValueError) as e:
        raise CliError('读不出 %s：%s' % (path, e))
    slots = data.get('slots') if isinstance(data, dict) else None
    if not isinstance(slots, list) or not slots: raise CliError('文件里要有 slots 数组（标题、封面文字、简介各一项）')
    P, seen = [], set()
    for n, s in enumerate(slots, 1):
        w = 'slots 第 %d 项' % n
        if not isinstance(s, dict) or s.get('slot') not in cd.SLOTS:
            P.append('%s的 slot 必须是 %s 之一' % (w, '、'.join(cd.SLOTS))); continue
        if s['slot'] in seen: P.append('%s：「%s」写了两次' % (w, s['slot']))
        seen.add(s['slot'])
        refs = s.get('refs')
        if refs is not None and (not isinstance(refs, list) or not all(isinstance(r, dict) and r.get('who') and r.get('text') for r in refs)):
            P.append('%s的 refs 必须是数组，每项至少有 who 和 text' % w)
        cands = s.get('candidates', [])
        if not isinstance(cands, list): P.append('%s的 candidates 必须是数组' % w); continue
        for m, c in enumerate(cands, 1):
            cw = '%s候选 %d' % (w, m)
            if not isinstance(c, dict) or not isinstance(c.get('text'), str) or not c['text'].strip(): P.append('%s缺 text' % cw); continue
            if not isinstance(c.get('reason'), str) or not c['reason'].strip(): P.append('%s缺 reason（为什么这么写）' % cw)
            b = c.get('basis')
            if b is not None and (not isinstance(b, dict) or b.get('type') not in cd.PUB_BASIS_TYPES):
                P.append('%s的 basis 必须是 {type, text}，type 是 %s 之一' % (cw, '、'.join(cd.PUB_BASIS_TYPES)))
    if P: raise CliError('文件不合格：\n- ' + '\n- '.join(P))
    return slots


def cmd_publish(page, path):
    """把标题、封面文字、简介的候选一次放进页面：没有这一样就新建，给了 refs 就换成新的参考；候选只加不删，记第几轮。"""
    slots = load_publish(path)

    def fn(doc):
        taken = {it.get('id') for it in doc['items'] if isinstance(it, dict)}
        done = []
        for s in slots:
            slot = s['slot']
            box = next((it for it in cd.items_of(doc, cd.PUBSLOT) if (it.get('locked') or {}).get('slot') == slot), None)
            if box is None:
                box = {'id': cd.new_id(cd.PUBSLOT, taken), 'kind': cd.PUBSLOT, 'locked': {'slot': slot, 'refs': []}, 'fields': {'final': '', 'note': ''}}
                doc['items'].append(box)
            if s.get('refs') is not None: box['locked']['refs'] = s['refs']
            old = pub_cands(doc, slot)
            rnd = max([_num((c.get('locked') or {}).get('round')) for c in old] + [0]) + 1
            for m, c in enumerate(s.get('candidates') or [], 1):
                lk = {'slot': slot, 'round': rnd, 'order': m, 'reason': c['reason']}
                if c.get('angle'): lk['angle'] = c['angle']
                if c.get('basis'): lk['basis'] = {'type': c['basis']['type'], 'text': c['basis'].get('text', '')}
                doc['items'].append({'id': cd.new_id(cd.PUBCAND, taken), 'kind': cd.PUBCAND, 'locked': lk,
                                     'fields': {'text': c['text'], 'decision': ''}})
            done.append('%s %d 个候选（第 %d 轮）' % (slot, len(s.get('candidates') or []), rnd))
        return '已放进页面：' + '；'.join(done) + '。开着的页面等用户停手几秒会自己刷新'
    return bs.mutate(page.root, page.index, page.pid, fn)[2]


def cmd_list(root):
    L = []
    for p in bs.iter_html(root, cd.skip_dirs(root)):
        try:
            doc = bs.parse_page(bs.read_page(p)[0])[1]
        except (OSError, bs.PageError):
            continue
        L.append('%s  %s  page_id=%s  %s' % (doc.get('content_id'), doc.get('kind'), doc['page_id'], os.path.relpath(p, root)))
    return '\n'.join(L) or '（根目录 %s 下没有带 jc-doc 的页面）' % root


def main(argv=None):
    global _stdin_used
    _stdin_used = False
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--root', default=argparse.SUPPRESS, help='工作文件夹')
    page_help = '页面：文件路径、page_id 或内容编号（例如 T001）'
    ap = argparse.ArgumentParser(description='给 AI 用的创作页命令（和保存服务同一把锁、同一套逐格规则）', parents=[common], epilog=STDIN_NOTE)
    sub = ap.add_subparsers(dest='cmd', required=True)

    def cmd(name, help_text, text_args=False):
        return sub.add_parser(name, parents=[common], help=help_text, description=help_text, epilog=STDIN_NOTE if text_args else None)
    p = cmd('read', '打印给 AI 读的摘要')
    p.add_argument('page', help=page_help)
    p = cmd('export', '导出成 build_page.py 的输入数据（带身份号）')
    p.add_argument('page', help=page_help)
    p.add_argument('--out', help='写到文件；不给就打印')
    p = cmd('reply', '回复写给 AI 的话（抄下当前批注、写回复，不改指纹）', True)
    p.add_argument('page', help=page_help)
    p.add_argument('--item', required=True, help='段落身份号；回复整体意见写 info')
    p.add_argument('--text', required=True, help='回复；写成 - 时从标准输入读')
    p = cmd('suggest', '新增一条建议（原句必须在这一段的我的版本里恰好出现一次）', True)
    p.add_argument('page', help=page_help)
    p.add_argument('--segment', required=True, help='所属段落的身份号')
    p.add_argument('--category', required=True, help='类别：%s' % '、'.join(cd.CATEGORIES))
    p.add_argument('--original', required=True, help='原句，从当前我的版本里复制；写成 - 时从标准输入读')
    p.add_argument('--proposed', required=True, help="改成；写空字符串（--proposed ''）表示删掉整句；写成 - 时从标准输入读")
    p.add_argument('--reason', required=True, help='为什么改，一句讲清；写成 - 时从标准输入读')
    p.add_argument('--basis-type', required=True, help='依据类型：%s' % '、'.join(cd.BASIS_TYPES))
    p.add_argument('--basis', default='', help='依据说明，一句；写成 - 时从标准输入读')
    p.add_argument('--source', default='AI', help='来源：%s，默认 AI' % '、'.join(cd.SOURCES))
    p.add_argument('--verdict', default='待你定', help='结论：%s，默认待你定' % '、'.join(cd.VERDICTS))
    p.add_argument('--id', help='指定身份号（一般不用）')
    p = cmd('set-locked', '改锁定字段（改建议的原句时，新原句必须在所属段我的版本里恰好出现一次）', True)
    p.add_argument('page', help=page_help)
    p.add_argument('--item', required=True, help='条目身份号；页面信息写 info')
    p.add_argument('--key', required=True, help='锁定键，例如 stage、title、narrative')
    p.add_argument('--value', required=True, help='新值；写成 - 时从标准输入读')
    p.add_argument('--json', action='store_true', help='值按 JSON 解析（对象、数组、数字）')
    p = cmd('set-field', '改可改字段（用户的格子要 --user-approved）', True)
    p.add_argument('page', help=page_help)
    p.add_argument('--item', required=True, help='条目身份号；页面信息写 info')
    p.add_argument('--field', required=True, help='可改字段，例如 proposed、recorded')
    p.add_argument('--value', required=True, help='新值；写成 - 时从标准输入读')
    p.add_argument('--before', help='你读到的改前值，文件里不是这个值就不写；写成 - 时从标准输入读')
    p.add_argument('--user-approved', action='store_true', help='用户明确同意 AI 改用户的格子时才加')
    p = cmd('rebase', '把当前我的版本抄成底稿')
    p.add_argument('page', help=page_help)
    p.add_argument('--item', action='append', default=[], help='段落身份号，可以写多次')
    p.add_argument('--all', action='store_true', help='全部段落')
    p = cmd('publish', '一次放进标题、封面文字、简介的候选（只加不删）')
    p.add_argument('page', help=page_help)
    p.add_argument('--file', required=True, help='JSON 文件：{"slots": [{"slot": "标题", "refs": [{"who", "text", "stat"}], "candidates": [{"text", "angle", "reason", "basis": {"type", "text"}}]}]}')
    cmd('list', '列出根目录下的页面')
    a = ap.parse_args(argv)
    root = getattr(a, 'root', None)
    try:
        if a.cmd == 'list':
            rt, how = cd.resolve_root(root)
            if not rt: raise CliError(how)
            print(cmd_list(rt))
            return 0
        page = locate(a.page, root)
        if a.cmd == 'read':
            sys.stdout.write(render_read(page, page.doc()))
        elif a.cmd == 'export':
            text = json.dumps(export_data(page.doc()), ensure_ascii=False, indent=2) + '\n'
            if a.out:
                with open(a.out, 'w', encoding='utf-8') as f: f.write(text)
                print('已导出到 %s' % a.out)
            else:
                sys.stdout.write(text)
        elif a.cmd == 'reply':
            print(cmd_reply(page, a.item, arg_text(a.text)))
        elif a.cmd == 'suggest':
            print(cmd_suggest(page, a))
        elif a.cmd == 'set-locked':
            v = arg_text(a.value)
            if a.json:
                try: v = json.loads(v)
                except ValueError as e: raise CliError('--value 不是合法 JSON：%s' % e)
            print(cmd_set_locked(page, a.item, a.key, v))
        elif a.cmd == 'set-field':
            print(cmd_set_field(page, a.item, a.field, arg_text(a.value), None if a.before is None else arg_text(a.before), a.user_approved))
        elif a.cmd == 'publish':
            print(cmd_publish(page, a.file))
        elif a.cmd == 'rebase':
            if not a.item and not a.all: raise CliError('rebase 要 --item <段id>（可以写多次）或 --all')
            print(cmd_rebase(page, a.item, a.all))
    except (CliError, bs.PageError) as e:
        print('失败：%s' % e, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
