#!/usr/bin/env python3
"""创作页的共用规则：取值表、身份号、条目种类、工作台设置、根目录定位、和底稿比的删改（CriticMarkup）。
build_page.py、brain_page.py、where.py 都从这里取，保存服务 server/brain_save.py 不认识这些业务规则。"""
import difflib, errno, http.client, json, os, re, secrets, sys
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'server'))
import brain_save as bs  # noqa: E402

ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'
PAGE_KIND = '创作页'
SCHEMA = 1
DEFAULT_ORIGIN = 'http://127.0.0.1:%d' % bs.DEFAULT_PORT  # 设置里没写保存服务端口时用；生成页面用 default_origin()
DEFAULT_RATE = 5  # 默认语速：每秒 5 个字（自己的语速写进数据的 speech_rate）；字数只数汉字、字母、数字

TYPES = ('口播', '教程', '科普')
STAGES = ('写稿', '审稿', '定稿', '录制准备')
SOURCE_TYPES = ('口播原话', '简介文案', '发布文字', '说明')
EXPLAIN = '说明'  # 参考里的「说明」：不是谁的原话，是一句交代（例如「她这里没有对应的原话」），页面用灰色说明样式，不显示时间和「看原片」
CATEGORIES = ('表达', '衔接', '拗口', '口径', '事实')
SOURCES = ('AI', '运营')
BASIS_TYPES = ('参考口播', '参考画面', '你之前定的', 'AI 自己的判断', '运营')  # 参考画面：教程里「参考视频就是这么拍的」
VERDICTS = ('已定要改', '待你定', '等录屏再定', '不用改')  # 等录屏再定：教程里要看真实运行结果才能写的句子
REF_ROLES = ('对标', '补充参考', '效果样例')  # 参考的角色（可选键 role）
# 参考分析（编导的功课）：每段一条 refnote 条目、全片一条 skeleton 条目，见 schema/creation-page.md「参考分析」
REFNOTE, SKELETON = 'refnote', 'skeleton'
REF_TAGS = ('引入', '顺序', '操作', '解释', '画面', '定义', '比喻', '例子', '对照', '收句')  # 教程常用前五个，科普常用后五个加引入
COVERS = ('共性', '独有', '多做')  # 这个讲法点：几家都这么讲 / 只有某家 / 某家在另一家基础上多做
BORROW_TYPES = ('照用', '超一步')
QUOTE_MAX = 60  # 代表原句最长字数（按字符数），只截关键的一句
MERGE_RATIO = 0.4  # 同一段里两家逐字相同（连续 8 字以上）占到这个比例，就算一家照着另一家改写（中译中），建议合并显示
DECISIONS = ('', '采纳', '不采纳', '部分采纳')
# 发布文字：标题、封面文字、简介。逐字稿内容确认后 AI 主动出候选，用户在页面上挑、改，最后用哪个由用户定。
# 每样一条 pubslot（参考视频的同类文字、用户定的那版 final、写给 AI 的话 note），每个候选一条 pubcand（候选文字 text、决定 decision）。
# 封面图不在这里做，这里只出封面上的字和一句画面方向。见 schema/creation-page.md「发布文字」。
PUBSLOT, PUBCAND = 'pubslot', 'pubcand'
SLOTS = ('标题', '封面文字', '简介')
PUB_DECISIONS = ('', '选用', '不用')
PUB_BASIS_TYPES = ('参考视频', '以往数据', '你之前定的', 'AI 自己的判断')

INFO, SEGMENT, SUGGESTION = 'info', 'segment', 'suggestion'
PREFIX = {INFO: 'info-', SEGMENT: 'seg-', SUGGESTION: 'sug-'}
# 三种已知条目的固定键。「只加不删」：条目可以另带可选的锁定键和可改字段，也可以有新种类的条目（例如录屏步骤 step），
# 生成、保存、读、导出都原样保留；页面上没有专门模块的，由界面的兜底模块按原样列出。
FIELDS = {INFO: ('overall_note', 'approved', 'recorded'), SEGMENT: ('mine', 'note'), SUGGESTION: ('proposed', 'decision')}
LOCKED_KEYS = {INFO: ('type', 'stage', 'title', 'narrative', 'speech_rate'),
               SEGMENT: ('order', 'title', 'role', 'refs', 'baseline'),
               SUGGESTION: ('segment', 'category', 'source', 'original', 'reason', 'basis', 'verdict')}
REF_KEYS = ('who', 'source_type', 'time', 'text', 'url')
KEEP_FIELDS = ('mine', 'note', 'proposed', 'decision', 'overall_note', 'approved', 'recorded')  # 已知的可改字段；重新生成时所有可改字段都按身份号保留
OWNER_FIELDS = ('mine', 'note', 'decision', 'overall_note', 'approved', 'final')  # 用户的格子：AI 改要带 --user-approved（final 是发布文字里用户定的那版）
# 给人看的叫法（和 template/app.js 里的 KIND_LABEL、FIELD_LABEL、LOCKED_LABEL 保持一致）。
# 教程枝干：参考可选键 role、visual、video；段落可改字段 visual_type、our_visual；录屏步骤 step 的锁定键
# segment、order、line、where、expect、caution，可改字段 prompt；页面信息锁定键 spare_refs。详见 schema/creation-page.md。
KIND_LABELS = {INFO: '页面信息', SEGMENT: '段落', SUGGESTION: '建议', 'step': '录屏步骤', REFNOTE: '参考分析', SKELETON: '骨架对照',
               PUBSLOT: '发布文字', PUBCAND: '发布文字候选'}
KEY_LABELS = {'mine': '我的版本', 'note': '写给 AI 的话', 'proposed': '改成', 'decision': '决定', 'overall_note': '整体意见',
              'approved': '内容已确认', 'recorded': '录完的定稿', 'our_visual': '我方画面', 'visual_type': '画面类型', 'todo_me': '你录', 'todo_editor': '剪辑做',
              'prompt': '要发送的内容', 'visual': '画面', 'where': '在哪发', 'line': '对应口播', 'expect': '发完应该看到',
              'caution': '录之前注意', 'spare_refs': '参考里有、这一稿没用上的', 'final': '你定的', 'text': '候选文字'}
KIND_RE = re.compile(r'[a-z][a-z0-9_]{0,31}')  # 新种类的名字：小写字母开头，字母、数字、下划线
ITEM_ID_RE = re.compile(r'[A-Za-z0-9_-]{1,64}')
ORIGIN_RE = re.compile(r'http://127\.0\.0\.1:(\d{1,5})')


def short(n=8):
    return ''.join(secrets.choice(ALPHABET) for _ in range(n))


def new_id(kind, taken):
    """带种类前缀的随机身份号（新种类用「种类名-」做前缀），保证不和 taken 里的重复；生成后加进 taken。"""
    prefix = PREFIX.get(kind) or (kind + '-' if isinstance(kind, str) and KIND_RE.fullmatch(kind) else 'item-')
    while True:
        i = prefix + short(8)
        if i not in taken:
            taken.add(i)
            return i


def id_problem(i):
    """输入数据里给的身份号有问题时返回原因，没问题返回 None。"""
    if not isinstance(i, str) or not ITEM_ID_RE.fullmatch(i):
        return '身份号只能用字母、数字、_、-，1 到 64 位'
    if i.isdigit():
        return '身份号不能是纯数字（那是位置编号，AI 重排后改动会落到别的条目上）；删掉 id 让脚本生成'
    return None


def kind_of(it):
    """条目种类：写了 kind 就按 kind（包括不认识的新种类，原样返回）；老数据没写时按 id 前缀和 locked 里的键推断。"""
    if not isinstance(it, dict): return None
    k = it.get('kind')
    if isinstance(k, str) and k: return k
    i, lk = str(it.get('id') or ''), it.get('locked') or {}
    for kind, p in PREFIX.items():
        if i.startswith(p): return kind
    if 'original' in lk and 'segment' in lk: return SUGGESTION
    if 'type' in lk and 'stage' in lk: return INFO
    if 'order' in lk: return SEGMENT
    return None


def items_of(doc, kind):
    return [it for it in doc.get('items') or [] if kind_of(it) == kind]


def info_of(doc):
    found = items_of(doc, INFO)
    return found[0] if found else None


def segments_of(doc):
    """段落按 locked.order 排，order 相同或没有时按数组顺序。"""
    segs = items_of(doc, SEGMENT)
    return [s for _, s in sorted(enumerate(segs), key=lambda p: (_order(p[1]), p[0]))]


def _order(it):
    o = (it.get('locked') or {}).get('order')
    return o if isinstance(o, (int, float)) and not isinstance(o, bool) else float('inf')


def kind_label(kind):
    return KIND_LABELS.get(kind) or ('「%s」条目' % kind if kind else '未知种类的条目')


def key_label(k):
    return KEY_LABELS.get(k, k)


def extras(d, std):
    """d 里固定键以外的键（不含 ai_state），按原顺序。"""
    return {k: v for k, v in (d or {}).items() if k not in std and k != bs.AI_STATE} if isinstance(d, dict) else {}


def ai_state(it):
    s = (it.get('locked') or {}).get(bs.AI_STATE)
    return s if isinstance(s, dict) else {}


def count_in(hay, needle):
    """needle 在 hay 里出现几次（统一换行和 NFC 后比，重叠出现也算）。needle 为空返回 0。"""
    hay, needle = bs.norm(hay or ''), bs.norm(needle or '')
    if not needle: return 0
    n, i = 0, hay.find(needle)
    while i >= 0:
        n += 1
        i = hay.find(needle, i + 1)
    return n


# 建议的「改成」（proposed）为空表示删掉整句：采纳时把原句从我的版本里整句删掉。生成、加建议、改「改成」都允许空字符串；
# 去掉首尾空白后为空就算删句（和页面判断「改成」是不是空的写法一样），read 摘要和生成时的汇报都写成「删掉这句」。
DELETE_SENTENCE = '删掉这句'


def deletes_sentence(proposed):
    """这条建议是不是删掉整句：「改成」是文字，去掉首尾空白后为空。"""
    return isinstance(proposed, str) and not proposed.strip()


def proposed_problem(v):
    """「改成」的取值问题，没问题返回 None。只要求是文字；空字符串合法，表示删掉整句。"""
    return None if isinstance(v, str) else '必须是文字（要删掉整句就写空字符串），实际是 %r' % (v,)


def proposed_text(v):
    """给人读的「改成」：删句写成「删掉这句」，其余原样。"""
    return '%s（「改成」是空的，采纳时整句删掉）' % DELETE_SENTENCE if deletes_sentence(v) else (v or '')


def note_pending(it):
    """「写给 AI 的话」是否待处理：段落看 note，页面信息看 overall_note；不为空且和 ai_state.handled_note 不同。"""
    field = 'overall_note' if kind_of(it) == INFO else 'note'
    note = bs.norm((it.get('fields') or {}).get(field) or '')
    return bool(note.strip()) and note != bs.norm(ai_state(it).get('handled_note') or '')


def time_secs(t):
    """「1:05」「0:01:05」这类时间码的秒数；取字符串里第一个时间码，没有返回 None。"""
    m = re.search(r'(\d+):(\d{1,2})(?::(\d{1,2}))?', t or '')
    if not m: return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) if m.group(3) else int(m.group(1)) * 60 + int(m.group(2))


def time_range(t):
    """参考的时间段「0:22 到 0:31」→ (22, 31)；只写了一个时间或没写，返回 None。"""
    ts = re.findall(r'\d+:\d{1,2}(?::\d{1,2})?', t or '')
    return (time_secs(ts[0]), time_secs(ts[1])) if len(ts) >= 2 else None


def overlap_ratio(a, b, n=8):
    """a 里有多大比例的字落在和 b 连续 n 字以上相同的片段里（只数汉字、字母、数字，不分大小写）。
    用来判断两家参考是不是照着改写（中译中）；和页面上「连续 8 字相同」下划线同一个口径。"""
    A = [c.lower() for c in (a or '') if c.isalnum()]
    B = [c.lower() for c in (b or '') if c.isalnum()]
    if len(A) < n or len(B) < n: return 0.0
    grams = {''.join(B[i:i + n]) for i in range(len(B) - n + 1)}
    cover = [False] * len(A)
    for i in range(len(A) - n + 1):
        if ''.join(A[i:i + n]) in grams:
            for j in range(i, i + n): cover[j] = True
    return sum(cover) / len(A)


def text_len(s):
    """字数：和页面（template/app.js 的 chars）一样，只数汉字、字母、数字，标点和空白不算；秒数也按这个算。"""
    return sum(1 for ch in (s or '') if ch.isalnum())


def seconds(n, rate):
    """字数换成秒数，四舍五入到整秒（和页面的 Math.round 一致，.5 进位）。"""
    return int(n / rate + 0.5) if rate else 0


def fmt_secs(s):
    """和页面一样：不到 60 秒写「N 秒」，否则写「M 分 S 秒」。"""
    return '%d 秒' % s if s < 60 else '%d 分 %d 秒' % (s // 60, s % 60)


# ---------- 和底稿比的删改：CriticMarkup ----------
def critic(base, mine):
    """逐字比对，删掉的写 {--…--}，加上的写 {++…++}，换掉的写 {~~原来~>现在~~}。
    两处改动之间只隔 1 个字时并成一处，免得碎成一串。"""
    base, mine = bs.norm(base or ''), bs.norm(mine or '')
    ops = [[t, base[i1:i2], mine[j1:j2]] for t, i1, i2, j1, j2 in difflib.SequenceMatcher(None, base, mine, autojunk=False).get_opcodes()]
    merged = True
    while merged:
        merged = False
        for k in range(1, len(ops) - 1):
            if ops[k][0] == 'equal' and len(ops[k][1]) <= 1 and ops[k - 1][0] != 'equal' and ops[k + 1][0] != 'equal':
                a, b, c = ops[k - 1], ops[k], ops[k + 1]
                ops[k - 1:k + 2] = [['replace', a[1] + b[1] + c[1], a[2] + b[2] + c[2]]]
                merged = True
                break
    out = []
    for t, a, b in ops:
        if t == 'equal': out.append(a)
        elif t == 'replace' and a and b: out.append('{~~%s~>%s~~}' % (a, b))
        elif a: out.append('{--%s--}' % a)
        elif b: out.append('{++%s++}' % b)
    return ''.join(out)


# ---------- 工作台的设置：工作文件夹、内容草稿、回收站、写稿方法、保存服务端口 ----------
# 设置文件和工作台（lib/config.mjs）是同一个：~/Library/Application Support/<id>/config.json，id 取仓库根目录的 brand.json。
# 这里只读、不写；默认值和路径的写法跟 lib/config.mjs 一致（~ 开头接家目录，相对路径接在工作文件夹后面）。
REPO = os.path.dirname(HERE)
FALLBACK_ID = 'jincheng-workbench'
DEFAULT_PATHS = {'drafts': '内容草稿', 'trash': '回收站', 'writingMethod': '写稿方法'}
DEFAULT_PORTS = {'api': 18878, 'ui': 18879, 'save': bs.DEFAULT_PORT}
BLOCKED_PORTS = frozenset({8878, 8879, 8888, 8890, 8977, 8978, 8787, 43127})  # 和 lib/ports.mjs 的 BLOCKED_PORTS 一致


class SettingsError(Exception):
    """设置文件写坏了（不是合法的 JSON）。"""


def brand_id():
    try:
        with open(os.path.join(REPO, 'brand.json'), encoding='utf-8') as f:
            v = json.load(f).get('id')
        return v.strip() if isinstance(v, str) and v.strip() else FALLBACK_ID
    except (OSError, ValueError, AttributeError):
        return FALLBACK_ID


def _expand(v, home):
    v = str(v).strip()
    if v == '~': return home
    return os.path.join(home, v[2:]) if v.startswith('~/') else v


def settings_file(env=None):
    env = os.environ if env is None else env
    home = os.path.expanduser('~')
    custom = (env.get('WORKBENCH_CONFIG_DIR') or '').strip()
    d = os.path.abspath(_expand(custom, home)) if custom else os.path.join(home, 'Library', 'Application Support', brand_id())
    return os.path.join(d, 'config.json')


def workbench_settings(env=None):
    """读工作台的设置，返回 {file, exists, work_folder, drafts, trash, writing_method, save_port}（路径都是绝对路径）。
    设置文件不存在时按默认值（工作台还没运行过）；写坏了抛 SettingsError；某一项写得不对按默认值。"""
    home = os.path.expanduser('~')
    file = settings_file(env)
    raw, exists = {}, os.path.isfile(file)
    if exists:
        try:
            with open(file, encoding='utf-8-sig') as f:
                raw = json.load(f)
        except ValueError as e:
            raise SettingsError('工作台的设置文件写坏了，不是合法的 JSON：%s（%s）。改好它再试' % (file, e))
        except OSError as e:
            raise SettingsError('读不出工作台的设置文件 %s：%s' % (file, e))
        if not isinstance(raw, dict): raw = {}
    wf = raw.get('workFolder')
    wf = wf if isinstance(wf, str) and wf.strip() else '~/Documents/' + brand_id()
    work = os.path.abspath(_expand(wf, home))
    paths = raw.get('paths') if isinstance(raw.get('paths'), dict) else {}

    def place(key):
        v = paths.get(key)
        v = v if isinstance(v, str) and v.strip() else DEFAULT_PATHS[key]
        v = _expand(v, home)
        return os.path.abspath(v if os.path.isabs(v) else os.path.join(work, v))
    ports = raw.get('ports') if isinstance(raw.get('ports'), dict) else {}

    def port(key):
        v = ports.get(key)
        ok = isinstance(v, int) and not isinstance(v, bool) and 1024 <= v <= 65535 and v not in BLOCKED_PORTS
        return v if ok else DEFAULT_PORTS[key]
    api, ui, save = port('api'), port('ui'), port('save')
    if api == ui: api, ui, save = DEFAULT_PORTS['api'], DEFAULT_PORTS['ui'], DEFAULT_PORTS['save']
    if save in (api, ui): save = DEFAULT_PORTS['save']  # 和 lib/config.mjs 一样：保存服务端口不能和接口、界面的一样
    return {'file': file, 'exists': exists, 'work_folder': work, 'drafts': place('drafts'), 'trash': place('trash'),
            'writing_method': place('writingMethod'), 'save_port': save}


def default_origin():
    """新页面写进 jc-doc 的保存服务地址（直接打开文件时 kit 用它找服务）：设置里保存服务的端口。"""
    try:
        return 'http://127.0.0.1:%d' % workbench_settings()['save_port']
    except SettingsError:
        return DEFAULT_ORIGIN


def skip_dirs(root):
    """扫页面时不进的目录：根目录就是设置里的工作文件夹时，跳过它的回收站（挪进回收站的旧页面不算同号副本）。"""
    try:
        s = workbench_settings()
    except SettingsError:
        return []
    if not root or os.path.realpath(root) != os.path.realpath(s['work_folder']): return []
    return [s['trash']] if is_under(s['trash'], root) else []


def index_for(root):
    """和保存服务同样的页面索引（同样跳过回收站）。"""
    return bs.Index(root, skip_dirs(root))


# 最近一次找保存服务时，连本机端口被拒绝了（errno EPERM / EACCES）：AI 工具的沙箱（比如 Codex 默认）不让命令连本机端口。
# 这时找不到服务不等于服务没开，说「查不了」，不说「没在运行」。
LOCAL_BLOCKED = False


def find_service(root=None, timeout=0.4, tries=21):
    """找正在运行的保存服务：从设置里的端口往后问 /healthz（端口被占时工作台会往后挪），
    root 给了就只认根目录是它的。返回 healthz 的回答（多一个 port），找不到返回 None；
    找不到时 LOCAL_BLOCKED 说明是不是连本机端口被拒绝了。"""
    global LOCAL_BLOCKED
    LOCAL_BLOCKED = False
    try:
        start = workbench_settings()['save_port']
    except SettingsError:
        start = bs.DEFAULT_PORT
    for port in range(start, min(start + tries, 65536)):
        h = _healthz(port, timeout)
        if h and (root is None or (h.get('root') and os.path.realpath(h['root']) == os.path.realpath(root))):
            return dict(h, port=port)
    return None


def _healthz(port, timeout):
    global LOCAL_BLOCKED
    try:
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
        c.request('GET', '/healthz', headers={'Host': '127.0.0.1:%d' % port})
        r = c.getresponse()
        raw = r.read()
        c.close()
        h = json.loads(raw.decode('utf-8'))
    except OSError as e:
        if e.errno in (errno.EPERM, errno.EACCES):
            LOCAL_BLOCKED = True
        return None
    except (ValueError, http.client.HTTPException):
        return None
    return h if isinstance(h, dict) and str(h.get('service', '')).startswith('jc-brain-save') else None


DRAFT_DIR_RE = re.compile(r'^(T\d{3,4})(?:_|$)')


def draft_dirs(content_id, drafts):
    """内容草稿里这条内容的文件夹：和工作台一样按编号前缀认（T001_ 开头，或者就叫 T001）。"""
    try:
        names = sorted(n for n in os.listdir(drafts) if not n.startswith('.') and os.path.isdir(os.path.join(drafts, n)))
    except OSError:
        return []
    return [os.path.join(drafts, n) for n in names if (DRAFT_DIR_RE.match(n) or [None, None])[1] == content_id]


def page_name(content_id):
    return '%s_创作页.html' % content_id


# ---------- 根目录：页面锁、版本、改动记录都放在工作文件夹下 ----------
def is_under(path, root):
    try:
        p, r = os.path.realpath(path), os.path.realpath(root)
        return os.path.commonpath([p, r]) == r
    except ValueError:
        return False


def service_root(origin, timeout=1.5):
    """问 service_origin 上的保存服务它的根目录；不是本机地址、连不上或不是保存服务时返回 None。"""
    m = ORIGIN_RE.fullmatch(origin or '')
    if not m: return None
    port = int(m.group(1))
    try:
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
        c.request('GET', '/healthz', headers={'Host': '127.0.0.1:%d' % port})
        r = c.getresponse()
        raw = r.read()
        c.close()
        h = json.loads(raw.decode('utf-8'))
    except (OSError, ValueError, http.client.HTTPException):
        return None
    if isinstance(h, dict) and str(h.get('service', '')).startswith('jc-brain-save') and h.get('root_ok') and isinstance(h.get('root'), str):
        return h['root']
    return None


def resolve_root(explicit=None, page_path=None, doc=None):
    """找工作文件夹，返回 (根目录, 怎么找到的)；找不到返回 (None, 原因)。
    顺序：--root；环境变量 JC_BRAIN_ROOT；工作台设置里的工作文件夹（页面在它下面时）；
    页面 service_origin 上的保存服务报告的根目录（页面在它下面时）；从页面文件往上找带 .jc-locks 的目录。"""
    if explicit: return os.path.abspath(explicit), '--root'
    env = os.environ.get('JC_BRAIN_ROOT')
    if env: return os.path.abspath(env), '环境变量 JC_BRAIN_ROOT'
    problem = ''
    try:
        s = workbench_settings()
        if s['exists'] and os.path.isdir(s['work_folder']) and (not page_path or is_under(page_path, s['work_folder'])):
            return s['work_folder'], '工作台设置里的工作文件夹'
    except SettingsError as e:
        problem = str(e) + '；'
    if page_path:
        page_path = os.path.abspath(page_path)
        origin = (doc or {}).get('service_origin')
        r = service_root(origin)
        if r and is_under(page_path, r): return r, '保存服务 %s 报告的根目录' % origin
        d = os.path.dirname(page_path)
        while True:
            if os.path.isdir(os.path.join(d, '.jc-locks')): return d, '从页面往上找到的 .jc-locks'
            parent = os.path.dirname(d)
            if parent == d: break
            d = parent
    return None, problem + '找不到工作文件夹：先在后台启动一次工作台（pnpm --dir "%s" start --background），或者加 --root <工作文件夹>' % REPO


def origin_problem(origin):
    m = ORIGIN_RE.fullmatch(origin) if isinstance(origin, str) else None
    if not m or not 1 <= int(m.group(1)) <= 65535:
        return 'service_origin 必须是 http://127.0.0.1:端口，实际是 %r' % (origin,)
    return None


def url_problem(u):
    if u in (None, ''): return None
    if not isinstance(u, str) or urlsplit(u).scheme not in ('http', 'https') or not urlsplit(u).netloc:
        return '链接必须以 http:// 或 https:// 开头，实际是 %r' % (u,)
    return None
