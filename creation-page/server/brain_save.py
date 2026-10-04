#!/usr/bin/env python3
"""创作页保存服务（只用 Python 标准库，只绑本机回环地址 127.0.0.1 和 ::1）。根目录是工作台的工作文件夹，由 pnpm start 一起拉起。

页面按身份号访问 /p/<page_id>；改动逐格比对后只写回 HTML 里的 jc-doc 数据块，其余字节不动。
服务只做通用的逐格规则，不认识「创作页」的业务含义：新页面类型只改模板，不改服务。
brain_page.py、build_page.py 复用这里的文件锁、逐格规则和写法。

升级内容：端口和根目录由参数给（默认端口 18977）；同一请求里 group 相同的改动全成或全不成；
新接口 GET /p/<page_id>/changes?item=<id> 读改动记录；条目指纹不算 locked.ai_state（AI 写回复不让用户正在改的格子冲突）。

模板只有一份：页面里用首尾标记包住的三段（保存脚本 kit、样式、界面脚本），服务按 /p/ 提供页面时都换成模板目录里的
当前版本（默认 ../kit/kit.js、../template/style.css、../template/app.js，可用 --kit-dir、--template-dir 换）；
某段读不出或被截断时，这一段改用页面文件里自带的那份，并在 /healthz 和日志里说明。直接打开文件（file://）时用的是页面自带的。

约定：一个页面身份号只能对应一份文件。AI 做备份请放进 .jc-versions 这类隐藏目录（服务不扫），
或者给副本换一个新的身份号；同号多份时服务拒绝读写这个页面（返回 409），不按扫描顺序挑一个。

没接入同步的页面（没有 jc-doc）也有固定网址：GET /f/<相对根目录的路径> 只读提供根目录下的文件（网页、图片、
样式、脚本、文字、表格、音视频等），页面里的相对链接照常能用，视频能拖进度条。带 jc-doc 的页面转去 /p/<page_id>。
页面脚本用了浏览器存储、或者有可以输入内容的地方时，在页面顶上加一条黄色横幅，说明改动不会存回文件（文件本身不动）。
--read-only 起的是预览用的只读实例：所有写入请求一律 403，/healthz 报 read_only。

来源隔离：浏览器按「协议 + 主机名 + 端口」分来源，127.0.0.1 和 localhost 是两个来源。/f/ 提供的页面是谁写的都有，
不能让它们的脚本碰到能存回文件的页面，所以两类页面分在两个主机名上：
- http://127.0.0.1:端口：/p/ 页面、/p/…/meta、/p/…/doc、/p/…/changes 和 POST /save 只认这个 Host；
  用它访问 /f/ 会 302 到 localhost 的同一路径。
- http://localhost:端口：只提供 /f/；用它访问 /p/、/save 等一律 403。
- /healthz 两个 Host 都能读；别的 Host（例如把别的域名解析到本机）一律 403。
- POST /save 的 Origin 只认 http://127.0.0.1:端口 和带口令的 null（直接打开的文件），localhost 来源一律 403。
localhost 可能先解析到 IPv6 的 ::1，所以服务在 127.0.0.1 和 ::1 的同一端口上各监听一个；::1 上这个端口被别的程序
占着时不启动（否则 localhost 可能连到别的程序），本机没有 IPv6 回环地址时只听 127.0.0.1（localhost 也只会解析到它）。"""
import argparse, codecs, contextlib, copy, datetime, errno, fcntl, hashlib, html, http.client, json, os, re, signal, socket, stat
import subprocess, sys, tempfile, threading, time, traceback, unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)  # creation-page/
KIT_PATH = os.path.join(APP_DIR, 'kit', 'kit.js')  # 保存脚本的当前版本；--kit-dir 可换
TEMPLATE_DIR = os.path.join(APP_DIR, 'template')  # 样式 style.css 和界面脚本 app.js 的当前版本；--template-dir 可换
# 页面里用首尾标记（<!--jc-kit:start--> … <!--jc-kit:end--> 这种写法）包住的三段模板代码。
# 每段文件的最后一行必须是结束标记，没有这行说明文件写了一半或被截断，服务就改用页面自带的那份。
PARTS = ('kit', 'style', 'app')
PART_FILES = {'kit': 'kit.js', 'style': 'style.css', 'app': 'app.js'}
PART_WHAT = {'kit': ' kit', 'style': '样式', 'app': '界面脚本'}  # 日志里的叫法（「改用文件里自带的 kit」）
PART_EOF = {k: '/* jc-%s:eof */' % k for k in PARTS}
KIT_EOF = PART_EOF['kit']
DOC_RE = re.compile(r'(<script\b[^>]*\bid=["\']jc-doc["\'][^>]*>)(.*?)(</script>)', re.S)
DOC_RE_B = re.compile(DOC_RE.pattern.encode(), re.S)
PART_RE = re.compile(r'<!--jc-(kit|style|app):start-->(.*?)<!--jc-\1:end-->', re.S)
PART_INNER_RE = re.compile(r'(\s*)(<(script|style)\b[^>]*>)(.*)(</\3\s*>)(\s*)', re.S | re.I)  # 标记之间：恰好一个完整的标签
PID_RE = re.compile(rb'"page_id"\s*:\s*"([A-Za-z0-9_-]{4,64})"')
ID_OK = re.compile(r'[A-Za-z0-9_-]{4,64}')
DEFAULT_PORT = 18977
SERVICE_NAME = 'jc-brain-save'
# 页面和工作台据此判断服务支不支持整组提交、改动记录、换上当前模板、只读提供任意文件（/f/）
FEATURES = ['group', 'changes', 'template', 'files']
READ_ONLY_MSG = '预览模式为只读，不会保存到文件'
AI_STATE = 'ai_state'  # locked 里不参与指纹的子对象：AI 写的状态（回复等）
KEEP_VERSIONS = 20
EXIT_PORT_BUSY = 3  # 端口被占时的退出码，启动脚本据此给出中文说明
BEFORE_REPLACE = None  # 测试钩子：替换前调用，用来模拟「有人没拿锁就改了文件」
LOG = None  # 日志去向；None 表示运行时的 sys.stderr，测试可换成 StringIO


class PageError(Exception):
    """读不出页面、jc-doc 坏了、口令不对、同号多份或写入失败；消息原样返回给页面。"""
    def __init__(self, msg, code=422, dups=None):
        super().__init__(msg)
        self.code, self.dups = code, dups


def now_iso(): return datetime.datetime.now().astimezone().isoformat(timespec='seconds')
def sha(data): return hashlib.sha256(data).hexdigest()


def log_line(msg):
    """带时间的一行日志（多行内容如报错堆栈接在后面）。"""
    out = LOG or sys.stderr
    try:
        out.write('%s %s\n' % (now_iso(), msg))
        out.flush()
    except (OSError, ValueError):
        pass


FAIL_REPEAT_S = 60  # 同样的失败（同一状态码、请求、原因）一分钟只记一行，免得开着的标签每 3 秒轮询刷屏
_fail_seen, _fail_lock = {}, threading.Lock()


def log_failure(code, method, path, pid, reason):
    key, now = (code, method, path.split('?')[0], reason), time.monotonic()
    with _fail_lock:
        seen = _fail_seen.get(key)
        if seen and now - seen[0] < FAIL_REPEAT_S:
            seen[1] += 1
            return
        extra = '（上一条之后同样的失败又出现 %d 次，没逐条记）' % seen[1] if seen and seen[1] else ''
        _fail_seen[key] = [now, 0]
    log_line('请求失败 %d %s %s page_id=%s 原因：%s%s' % (code, method, path, pid or '-', reason, extra))


def norm(v):
    """比较用：统一换行符和 Unicode NFC，None 当空串；写入时仍写原值。"""
    if v is None: return ''
    return unicodedata.normalize('NFC', v.replace('\r\n', '\n').replace('\r', '\n')) if isinstance(v, str) else v


def _canon(v):
    if isinstance(v, str): return norm(v)
    if isinstance(v, dict): return {norm(k): _canon(x) for k, x in v.items()}
    if isinstance(v, list): return [_canon(x) for x in v]
    return int(v) if isinstance(v, float) and v.is_integer() and abs(v) < 1e21 else v  # 对齐 JS 的数字写法


def item_fp(item):
    """条目指纹：locked 去掉 ai_state 后规范化的 sha256 前 12 位（kit.js 里有同一算法）。
    ai_state 是 AI 写的状态（例如对批注的回复），不算进指纹：AI 写回复时，用户正在改的格子不按冲突处理。"""
    locked = item.get('locked') or {}
    if isinstance(locked, dict) and AI_STATE in locked:
        locked = {k: v for k, v in locked.items() if k != AI_STATE}
    s = json.dumps(_canon(locked), ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return sha(s.encode('utf-8'))[:12]


def page_id_of(data):
    m = DOC_RE_B.search(data)
    p = m and PID_RE.search(m.group(2))
    return p.group(1).decode() if p else None


def parse_page(data):
    """返回 (text, doc, match)；读不出就抛 PageError，调用方据此拒写。"""
    try: text = data.decode('utf-8')
    except UnicodeDecodeError as e: raise PageError('文件编码不对（需要 UTF-8）：%s' % e)
    found = list(DOC_RE.finditer(text))
    if len(found) != 1: raise PageError('页面数据应该恰好有 1 份，实际有 %d 份' % len(found))
    try: doc = json.loads(found[0].group(2))
    except ValueError as e: raise PageError('页面数据读不出来：%s' % e)
    if not isinstance(doc, dict) or not isinstance(doc.get('items'), list) or not doc.get('page_id'):
        raise PageError('页面数据不完整：缺少页面标识或条目')
    return text, doc, found[0]


def doc_json(doc):
    """jc-doc 数据块里的 JSON 写法；< > 转义，数据里出现 </script> 也不会截断页面。"""
    return json.dumps(doc, ensure_ascii=False, indent=2).replace('<', '\\u003c').replace('>', '\\u003e')


def rewrite(text, m, doc):
    """只替换 jc-doc 数据块内部。"""
    return (text[:m.start(2)] + '\n' + doc_json(doc) + '\n' + text[m.end(2):]).encode('utf-8')


def read_page(path):
    with open(path, 'rb') as f: return f.read(), os.fstat(f.fileno())


def iter_html(top, skip=()):
    """根目录下所有 .html 文件。跳过以 . 开头的目录（.jc-versions 等），也跳过 skip 里的目录（工作台的回收站：
    挪进去的旧页面不算同号副本）。skip 按消解软链接后的真实路径比。"""
    real_skip = {os.path.realpath(s) for s in skip}
    names = {os.path.basename(s) for s in real_skip}
    for dp, dns, fns in os.walk(top):
        dns[:] = sorted(n for n in dns if not n.startswith('.')  # 跳过 .jc-versions 等隐藏目录
                        and not (n in names and os.path.realpath(os.path.join(dp, n)) in real_skip))
        yield from (os.path.join(dp, fn) for fn in sorted(fns) if fn.endswith('.html') and not fn.startswith('.'))


def same_file(given, path):
    """页面自报的文件路径（file:// 打开时的绝对路径）是不是服务认的那份；按 inode 比，不怕符号链接和中文名的编码差异。"""
    if not isinstance(given, str) or not os.path.isabs(given): return False
    try: return os.path.samefile(given, path)
    except OSError: return False


@contextlib.contextmanager
def page_lock(root, page_id):
    """按页面身份号加锁（fcntl 锁 root/.jc-locks/<page_id>.lock），文件改名挪目录仍是同一把锁。"""
    os.makedirs(os.path.join(root, '.jc-locks'), exist_ok=True)
    with open(os.path.join(root, '.jc-locks', page_id + '.lock'), 'a') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try: yield
        finally: fcntl.flock(f, fcntl.LOCK_UN)


def save_version(root, page_id, data):
    d = os.path.join(root, '.jc-versions', page_id)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.html'), 'wb') as f: f.write(data)
    for n in sorted(n for n in os.listdir(d) if n.endswith('.html'))[:-KEEP_VERSIONS]: os.unlink(os.path.join(d, n))


def commit(root, page_id, path, st0, old, new):
    """临时文件 + fsync + 复制权限；替换前核对原文件没被动过，被动过返回 False 让调用方重新合并。"""
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix='.jc-tmp-', dir=d)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(new); f.flush(); os.fsync(f.fileno())
        os.chmod(tmp, stat.S_IMODE(st0.st_mode))
        if BEFORE_REPLACE: BEFORE_REPLACE(path)
        st1 = os.stat(path)
        if (st1.st_ino, st1.st_size, st1.st_mtime_ns) != (st0.st_ino, st0.st_size, st0.st_mtime_ns): return False
        save_version(root, page_id, old)  # 写前留版本
        os.replace(tmp, path); tmp = None
        dfd = os.open(d, os.O_RDONLY); os.fsync(dfd); os.close(dfd)
    finally:
        if tmp and os.path.exists(tmp): os.unlink(tmp)
    if read_page(path)[0] != new: raise PageError('保存后核对，文件内容和写入的不一致', 500)
    return True


def dup_error(pid, rels):
    return PageError('页面标识 %s 同时出现在 %d 份文件里：%s。为了不写错文件，保存服务已暂停打开和保存这个页面，改动先留在浏览器暂存里。'
                     '请让 AI 处理多余的副本：移进回收站，或者给副本换一个新的页面标识；AI 做备份请放进 .jc-versions 目录。'
                     % (pid, len(rels), '、'.join(rels)), 409, dups=list(rels))


class Index:
    """page_id → 路径。查询前重扫整个 root，但只对文件做 stat：inode、大小、修改时间都没变的文件沿用上次读出的身份号，
    变了才重读（实测：2006 个目录、52 个 HTML 共 66MB，一次重扫约 50 毫秒）。
    保存和打开页面前总是现扫，所以同号副本一出现就拒绝读写；页面每 3 秒的指纹轮询和 healthz 复用 30 秒内的扫描结果，
    免得每个开着的标签每 3 秒都扫一遍整个工作文件夹（副本最迟 30 秒后也会在轮询里报红）。
    缓存说「有重复」时一律现扫确认再报，所以副本删掉后下一次轮询就恢复，不会多红 30 秒。"""
    POLL_MAX_AGE = 30.0

    def __init__(self, root, skip=()):
        self.root, self.map, self.dups, self.cache, self.scanned_at = root, {}, {}, {}, 0.0
        self.skip = tuple(skip)  # 不扫的目录（例如回收站）
        self.lock = threading.Lock()

    def scan(self, max_age=0.0):
        with self.lock:
            if max_age and self.scanned_at and time.monotonic() - self.scanned_at < max_age: return
            found, dups, cache = {}, {}, {}
            for p in iter_html(self.root, self.skip):
                try:
                    st = os.stat(p)
                    sig, old = (st.st_ino, st.st_size, st.st_mtime_ns), self.cache.get(p)
                    pid = old[1] if old and old[0] == sig else page_id_of(read_page(p)[0])
                except OSError:
                    continue
                cache[p] = (sig, pid)
                if pid and pid in found: dups.setdefault(pid, [found[pid]]).append(p)
                elif pid: found[pid] = p
            self.map, self.cache, self.scanned_at = found, cache, time.monotonic()
            self.dups = {k: [os.path.relpath(x, self.root) for x in v] for k, v in dups.items()}

    def lookup(self, pid, max_age=0.0):
        """返回 (路径, 文件字节)。找不到抛 404；同号多份抛 409（附全部路径），绝不按扫描顺序挑一个。"""
        for attempt in (0, 1):
            self.scan(max_age if attempt == 0 else 0.0)  # 第二次一定现扫：缓存可能过时
            if pid in self.dups:
                if attempt == 0 and max_age: continue  # 缓存里的重复可能已经处理掉了：现扫确认再报
                raise dup_error(pid, self.dups[pid])
            p = self.map.get(pid)
            if not p: continue
            try: data = read_page(p)[0]
            except OSError: continue
            if page_id_of(data) == pid: return p, data
        raise PageError('找不到页面（页面标识 %s）' % pid, 404)


def judge(it, c):
    """逐格判断一条改动；需要写入时顺手改 it。"""
    r, f, fields = {'change_id': c['change_id']}, c['field'], (it or {}).get('fields')
    if it is None: r.update(status='conflict', reason='item_gone')
    elif item_fp(it) != c['item_fp']:
        r.update(status='conflict', reason='item_changed', item_fp=item_fp(it), current=(fields or {}).get(f))
    elif not isinstance(fields, dict) or f not in fields: r.update(status='conflict', reason='field_gone')
    elif norm(fields[f]) == norm(c['after']): r.update(status='ok', reason='already')
    elif norm(fields[f]) == norm(c['before']): fields[f] = c['after']; r.update(status='ok', reason='written')
    else: r.update(status='conflict', reason='changed', current=fields[f])
    return r


def _group(c):
    g = c.get('group')
    return g if isinstance(g, str) and g else None


def judge_all(doc, changes):
    """逐条判断整批改动，返回 (结果列表, 改好的 doc 副本)。原 doc 不动。
    group 相同的改动全成或全不成：组里只要有一条冲突，整组都不写。先在副本上试一遍，
    把出冲突的组排除后重试，直到没有新的组出冲突（排除一组可能让依赖它的另一组也对不上，所以要重试到稳定）。"""
    failed = set()
    while True:
        trial = copy.deepcopy(doc)
        items = {it.get('id'): it for it in trial['items'] if isinstance(it, dict)}
        results = [None if _group(c) in failed else judge(items.get(c['item_id']), c) for c in changes]
        bad = {_group(c) for c, r in zip(changes, results) if r is not None and _group(c) and r['status'] == 'conflict'} - failed
        if not bad: break
        failed |= bad
    for i, c in enumerate(changes):  # 整组不写的改动：自己就冲突的带自己的原因，本来能写的标 group_conflict
        if results[i] is not None: continue
        it = items.get(c['item_id'])
        own = judge(copy.deepcopy(it), c)
        if own['status'] != 'conflict':
            fields = (it or {}).get('fields') or {}
            own = {'change_id': c['change_id'], 'status': 'conflict', 'reason': 'group_conflict', 'item_fp': item_fp(it)}
            if c['field'] in fields: own['current'] = fields[c['field']]
        own['group'] = _group(c)
        results[i] = own
    return results, trial


def append_log(root, pid, written, origin):
    """每写入一格，往 root/.jc-changes/<page_id>.jsonl 追加一行，给「改动痕迹」和 AI 读。"""
    os.makedirs(os.path.join(root, '.jc-changes'), exist_ok=True)
    with open(os.path.join(root, '.jc-changes', pid + '.jsonl'), 'a', encoding='utf-8') as f:
        for c in written:
            rec = {'time': now_iso(), 'change_id': c['change_id'], 'item': c['item_id'], 'field': c['field'],
                   'before': c['before'], 'after': c['after'], 'origin': origin}
            if _group(c): rec['group'] = _group(c)
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')


CHANGE_KEYS = ('time', 'change_id', 'item', 'field', 'before', 'after', 'origin', 'group')


def _ts(s):
    try: return datetime.datetime.fromisoformat(s).timestamp()
    except (TypeError, ValueError): return 0.0


def read_changes(root, pid, item=None):
    """读改动记录，按时间正序（同一秒内按写入顺序）；item 为 None 时返回全部。写了一半的行（崩溃时）跳过。"""
    p = os.path.join(root, '.jc-changes', pid + '.jsonl')
    out = []
    try:
        f = open(p, encoding='utf-8')
    except FileNotFoundError:
        return out
    with f:
        for n, line in enumerate(f):
            try: rec = json.loads(line)
            except ValueError: continue
            if not isinstance(rec, dict) or (item is not None and rec.get('item') != item): continue
            out.append((_ts(rec.get('time')), n, {k: rec[k] for k in CHANGE_KEYS if k in rec}))
    out.sort(key=lambda x: (x[0], x[1]))
    return [x[2] for x in out]


def merge_changes(root, index, pid, changes, origin, check_path=None, check_doc=None):
    """在页面锁里重读文件、逐格判断、写回；保存服务和 brain_page.py 共用。
    check_path(path) 在读文件前核对路径，check_doc(doc) 在解析后核对口令，不通过就抛 PageError。"""
    with page_lock(root, pid):
        for _ in range(5):
            path = index.lookup(pid)[0]  # 现扫：同号多份直接 409
            if check_path: check_path(path)
            try: data, st0 = read_page(path)
            except FileNotFoundError: continue  # 刚被改名或挪走：下一轮 lookup 会现扫重新定位
            except OSError as e: raise PageError('无法读取页面文件：%s' % e)
            text, doc, m = parse_page(data)
            if check_doc: check_doc(doc)
            results, new_doc = judge_all(doc, changes)
            written = [c for c, r in zip(changes, results) if r.get('reason') == 'written']
            out = {'results': results, 'base_fingerprint': sha(data), 'fingerprint': sha(data), 'path': os.path.relpath(path, root)}
            if not written: return out
            new = rewrite(text, m, new_doc)
            try:
                if not commit(root, pid, path, st0, data, new): continue  # 替换前发现文件被改过：重读重新合并
            except FileNotFoundError:
                continue  # 目录刚被改名：重新定位再来
            append_log(root, pid, written, origin)
            out['fingerprint'] = sha(new)
            return out
        raise PageError('文件一直在被修改，重试 5 次后仍未能保存', 409)


def mutate(root, index, pid, fn):
    """AI 命令用：在页面锁里重读、fn(doc) 就地修改并返回说明、原子替换；替换前发现文件被动过就重来。
    fn 返回 None 表示不用写。同号多份时 lookup 抛 409，不按顺序挑一份。返回 (路径, doc, 说明)。"""
    with page_lock(root, pid):
        for _ in range(5):
            path = index.lookup(pid)[0]
            try: data, st0 = read_page(path)
            except FileNotFoundError: continue
            text, doc, m = parse_page(data)
            note = fn(doc)
            if note is None: return path, doc, None
            try:
                if commit(root, pid, path, st0, data, rewrite(text, m, doc)): return path, doc, note
            except FileNotFoundError:
                continue
        raise PageError('文件一直在被修改，重试 5 次后仍未能保存', 409)


def apply_changes(srv, pid, token, changes, origin, self_path=None):
    def check_path(path):
        if self_path is not None and not same_file(self_path, path):
            raise PageError('你打开的文件（%s）不是保存服务使用的那一份（%s），为了不写错文件，已拒绝保存' % (self_path, os.path.relpath(path, srv.root)), 409)

    def check_doc(doc):
        if (origin == 'null' or token is not None) and token != doc.get('token'):
            raise PageError('口令不对：直接打开的文件必须带和文件一致的口令，请改用页面链接打开', 403)
    return merge_changes(srv.root, srv.index, pid, changes, origin, check_path, check_doc)


def valid_body(b):
    return (isinstance(b, dict) and isinstance(b.get('page_id'), str) and ID_OK.fullmatch(b['page_id']) and isinstance(b.get('changes'), list)
            and (b.get('self_path') is None or isinstance(b.get('self_path'), str))
            and all(isinstance(c, dict) and 'before' in c and 'after' in c
                    and all(isinstance(c.get(k), str) for k in ('change_id', 'item_id', 'field', 'item_fp'))
                    and (c.get('group') is None or isinstance(c.get('group'), str)) for c in b['changes']))


def part_path(name):
    """某一段模板代码当前版本的文件路径（按调用时的 KIT_PATH、TEMPLATE_DIR 算，测试和命令行参数可以换）。"""
    return KIT_PATH if name == 'kit' else os.path.join(TEMPLATE_DIR, PART_FILES[name])


def load_part(name):
    """读某一段模板代码的当前版本。读不出、不是 UTF-8，或末尾没有结束标记（写了一半、被截断），
    返回 (None, 原因)，调用方改用页面文件里自带的那份。"""
    fn = PART_FILES[name]
    try:
        with open(part_path(name), encoding='utf-8') as f: text = f.read()
    except (OSError, UnicodeDecodeError) as e:
        return None, '读不出 %s：%s' % (fn, e)
    if not text.rstrip().endswith(PART_EOF[name]):
        return None, '%s 末尾没有结束标记 %s，可能写了一半或被截断' % (fn, PART_EOF[name])
    return text, ''


def load_kit():
    return load_part('kit')


def esc_script(s):
    """放进 <script> 的内容：</script 转成 <\\/script，免得提前结束标签。"""
    return re.sub(r'</(script)', r'<\\/\1', s, flags=re.I)


def esc_style(s):
    return re.sub(r'</(style)', r'<\\/\1', s, flags=re.I)


def serve_page(text, info, pid):
    """把页面里用标记包住的三段换成模板目录里的当前版本，并在 kit 那段前面加一行 window.JC_SERVED。
    某段读不出、被截断，或页面里这一段不是一个完整的标签时，这一段留页面自带的那份，并记日志。
    同一段出现不止一次时只换第一处（生成脚本保证只有一处）。只扫一遍：换进去的内容不会再被当成标记。
    返回 (新页面文字, {段名: 'current' 当前模板 / 'embedded' 页面自带})。"""
    plan, used = {}, {}
    for m in PART_RE.finditer(text):  # 先定每段用哪一份，好把结果写进 JC_SERVED
        name = m.group(1)
        if name in plan: continue
        new, problem = load_part(name)
        inner = PART_INNER_RE.fullmatch(m.group(2))
        if inner and re.search(r'</' + inner.group(3), inner.group(4), re.I): inner = None  # 标记之间不止一个标签：不敢换
        if new is not None and not inner: new, problem = None, '页面里这一段不是恰好一个完整的 <script> 或 <style> 标签'
        plan[name] = (new, inner, problem)
        used[name] = 'current' if new is not None else 'embedded'
        if new is None: log_line('%s 有问题，页面 %s 改用文件里自带的%s：%s' % (PART_FILES[name], pid, PART_WHAT[name], problem))
    served = dict(info, parts=used)
    head = '<script>window.JC_SERVED = %s;</script>' % json.dumps(served, ensure_ascii=False).replace('<', '\\u003c')
    done = set()

    def sub(m):
        name = m.group(1)
        if name in done: return m.group(0)
        done.add(name)
        new, inner, _ = plan[name]
        pre = head if name == 'kit' else ''
        if new is None:
            body = pre + m.group(2)
        else:
            esc = esc_style if inner.group(3).lower() == 'style' else esc_script
            body = inner.group(1) + pre + inner.group(2) + '\n' + esc(new) + '\n' + inner.group(5) + inner.group(6)
        return '<!--jc-%s:start-->%s<!--jc-%s:end-->' % (name, body, name)
    return PART_RE.sub(sub, text), used


# ---------- /f/：只读提供根目录下的任意文件 ----------
# 没接入同步的页面也在固定网址下打开，页面里的相对链接（图片、样式、脚本、视频）照常能用。这条路径只读，不写任何东西。
# 只提供下面这些类型；脚本源码（.py .sh）、配置、密钥这类不在表里的一律不给。
FILE_TYPES = {
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.json': 'application/json', '.md': 'text/plain', '.markdown': 'text/plain', '.txt': 'text/plain', '.csv': 'text/csv',
    '.srt': 'text/plain', '.vtt': 'text/vtt',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
    '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf',
}
HTML_EXT = ('.html', '.htm')
FILE_CHUNK = 256 * 1024
SCRIPT_LIMIT = 5_000_000  # 页面引用的本地脚本最多读这么多字节来判断
BANNER_BROWSER_ONLY = '这页还没接入同步：你在这里的改动只会存在这个浏览器里，不会存回文件。'
BANNER_READ_ONLY = '预览模式为只读：你在这里的改动不会保存到文件，只留在这个浏览器里。'

# 「改动只会留在浏览器里」的迹象。工作台 lib/works.mjs 用同一套规则算内容卡上的「只存在浏览器里」，
# 两边的正则逐字一致（按字节匹配），tests/works-pages.test.mjs 拿同一批页面核对两边结论相同。
STORAGE_RE = re.compile(rb'\b(?:localStorage|sessionStorage|indexedDB)\b')
TEXTAREA_RE = re.compile(rb'<textarea\b', re.I)
EDITABLE_RE = re.compile(rb'\bcontenteditable\b(?!\s*=\s*["\']?false)', re.I)
INPUT_RE = re.compile(rb'<input\b[^>]*>', re.I)
INPUT_NOT_CONTENT_RE = re.compile(rb'\btype\s*=\s*["\']?(?:hidden|submit|button|reset|image|file|search)\b', re.I)
SEARCHY_CN_RE = re.compile('搜索|筛选|查找'.encode('utf-8'))
SEARCHY_EN_RE = re.compile(rb'search|filter', re.I)
SCRIPT_SRC_RE = re.compile(rb'<script\b[^>]*?\bsrc\s*=\s*["\']?([^"\'\s>]+)', re.I)
URL_SCHEME_RE = re.compile(r'^[A-Za-z][A-Za-z0-9+.-]*:')
# 找横幅插在哪：跳过注释和 script/style/template/textarea/title 的内容，免得把脚本字符串里的 <body> 当真
_SKIP = rb'<!--.*?-->|<(script|style|template|textarea|title)\b[^>]*>.*?</\1\s*>'
BODY_OPEN_RE = re.compile(_SKIP + rb'|<body\b[^>]*>', re.S | re.I)
HEAD_CLOSE_RE = re.compile(_SKIP + rb'|</head\s*>', re.S | re.I)
DOCTYPE_RE = re.compile(rb'\s*<!doctype\b[^>]*>', re.I)


def _hidden_part(name):
    return name.startswith('.') or name.lower() == 'node_modules'


def resolve_file(root, rel):
    """/f/ 后面的相对路径（已解码）换成根目录下的真实文件路径；不合格抛 PageError，消息给人看。
    拒绝：空路径、绝对路径、反斜杠、空段、. 和 ..、以 . 开头的段（.trash、.jc-versions、.obsidian 等）、node_modules；
    消解符号链接后跑到根目录外、或落进隐藏目录的；目录；不在 FILE_TYPES 里的文件类型。"""
    if not rel or '\x00' in rel or '\\' in rel or rel.startswith('/'):
        raise PageError('地址不对：/f/ 后面只能是工作文件夹里的相对路径', 400)
    parts = rel.split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise PageError('地址不对：路径里不能有空段、「.」或「..」', 400)
    if any(_hidden_part(p) for p in parts):
        raise PageError('隐藏目录（以 . 开头，例如回收站、版本备份）和 node_modules 里的文件不提供', 403)
    base = os.path.realpath(root)
    target = os.path.realpath(os.path.join(base, *parts))
    inner = os.path.relpath(target, base)
    if inner == '.' or inner == '..' or inner.startswith('..' + os.sep) or os.path.isabs(inner):
        raise PageError('这个文件实际在工作文件夹之外（可能是指向外面的快捷方式），不提供', 403)
    if any(_hidden_part(p) for p in inner.split(os.sep)):
        raise PageError('这个文件实际在隐藏目录里（可能是快捷方式指过去的），不提供', 403)
    if not os.path.exists(target):
        raise PageError('找不到这个文件，可能已经移动或删除', 404)
    if not os.path.isfile(target):
        raise PageError('这是一个文件夹，不是文件', 404)
    if os.path.splitext(target)[1].lower() not in FILE_TYPES:
        raise PageError('这种文件不在只读提供的范围里（只提供网页、图片、样式、脚本、文字、表格、音视频、字体和 PDF）', 403)
    return target


def edit_signals(data):
    """一段页面或脚本（字节）里「改动会留在浏览器里」的迹象，返回 (用了浏览器存储, 有能输入内容的地方)。
    能输入内容：多行文本框、可编辑区域、内容输入框（文字框、勾选框、单选等）。搜索框和筛选框（type=search，
    或者标签里写着搜索、筛选、查找、search、filter）、隐藏字段、按钮、选文件不算；下拉框也不算，它多半是筛选和切换视图。"""
    storage = bool(STORAGE_RE.search(data))
    editable = bool(TEXTAREA_RE.search(data) or EDITABLE_RE.search(data)) or any(
        not INPUT_NOT_CONTENT_RE.search(tag) and not SEARCHY_CN_RE.search(tag) and not SEARCHY_EN_RE.search(tag)
        for tag in (m.group(0) for m in INPUT_RE.finditer(data)))
    return storage, editable


def local_scripts(data, html_path, base):
    """页面用相对地址引用的本地脚本（<script src="app.js">）：只认根目录里、不在隐藏目录里的文件，按出现顺序。"""
    out, seen = [], set()
    for m in SCRIPT_SRC_RE.finditer(data):
        src = unquote(m.group(1).decode('utf-8', 'replace').split('#')[0].split('?')[0])
        if not src or URL_SCHEME_RE.match(src) or src.startswith('/') or '\\' in src:
            continue
        p = os.path.realpath(os.path.join(os.path.dirname(html_path), src))
        inner = os.path.relpath(p, base)
        if inner == '..' or inner.startswith('..' + os.sep) or os.path.isabs(inner) or any(_hidden_part(x) for x in inner.split(os.sep)):
            continue
        if p not in seen and os.path.isfile(p):
            seen.add(p)
            out.append(p)
    return out


def page_signals(data, html_path, base):
    """整页的 (用了浏览器存储, 有能输入内容的地方)：页面本身加上它引用的本地脚本。"""
    storage, editable = edit_signals(data)
    for p in local_scripts(data, html_path, base)[:20]:
        if storage and editable:
            break
        try:
            with open(p, 'rb') as f:
                s, e = edit_signals(f.read(SCRIPT_LIMIT))
        except OSError:
            continue
        storage, editable = storage or s, editable or e
    return storage, editable


def _ascii_html(text):
    return ''.join(c if ord(c) < 128 else '&#x%X;' % ord(c) for c in html.escape(text, quote=True))


def banner_html(text):
    """页面顶上的细横幅。只用 ASCII（中文写成字符引用），不管页面是什么编码都不会乱码；
    样式写在元素上并先 all:initial，页面自己的样式改不动它；页面主体是网格或弹性布局时也独占一整行。"""
    style = ('all:initial;display:block;box-sizing:border-box;width:100%;margin:0;padding:6px 14px;'
             'background:#fff4cc;border-bottom:1px solid #edd38a;color:#5b4500;'
             "font:13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB',sans-serif;"
             'grid-column:1/-1;flex:0 0 100%;order:-1')
    return ('<div id="jc-file-banner" role="note" style="%s">%s</div>' % (style, _ascii_html(text))).encode('ascii')


def _first_tag_end(data, tag_re):
    for m in tag_re.finditer(data):
        if m.group(1) or m.group(0)[:4] == b'<!--':
            continue  # 注释、脚本、样式等的内容：跳过
        return m.end()
    return None


def with_banner(data, text):
    """在 <body> 开始标签后面插一条横幅；没有 <body> 就插在 </head> 后面，再没有就插在 doctype 后面（或最前面）。"""
    pos = _first_tag_end(data, BODY_OPEN_RE)
    if pos is None:
        pos = _first_tag_end(data, HEAD_CLOSE_RE)
    if pos is None:
        m = DOCTYPE_RE.match(data, 3 if data.startswith(codecs.BOM_UTF8) else 0)
        pos = m.end() if m else (3 if data.startswith(codecs.BOM_UTF8) else 0)
    return data[:pos] + banner_html(text) + data[pos:]


def text_charset(head):
    """文字类文件的开头（最多 64KB）能按 UTF-8 读通就标 charset=utf-8；读不通不标，让浏览器按页面自己写的编码读。"""
    try:
        codecs.getincrementaldecoder('utf-8')().decode(head, final=False)
        return '; charset=utf-8'
    except UnicodeDecodeError:
        return ''


def parse_range(header, size):
    """只认单段的 bytes=起-止、bytes=起-、bytes=-末尾长度。返回 (起, 止)；写法不对或多段返回 'ignore'（整份给）；
    起点超出文件或末尾长度为 0 返回 None（416）。"""
    m = re.fullmatch(r'\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*', header or '')
    if not m or not (m.group(1) or m.group(2)):
        return 'ignore'
    a, b = m.group(1), m.group(2)
    if a:
        start = int(a)
        if b and int(b) < start:
            return 'ignore'
        if start >= size:
            return None
        return start, min(int(b), size - 1) if b else size - 1
    n = int(b)
    if n == 0 or size == 0:
        return None
    return max(0, size - n), size - 1


PAGE_STYLE = ('<!doctype html><meta charset="utf-8"><title>%s</title><body style="font:16px/1.7 -apple-system,sans-serif;'
              'max-width:640px;margin:60px auto;padding:0 16px">')
NOT_FOUND = (PAGE_STYLE % '找不到页面' + '<h1>找不到这个页面</h1><p>保存服务在工作文件夹里没有找到页面标识为 '
             '<code>%s</code> 的页面。</p><p>可能是页面文件已被删除或移出了工作文件夹，文件里的页面数据被改坏，或者地址有误。</p>'
             '<p>你在浏览器里暂存的改动还在：回到原来的页面点「复制未保存的改动」可以取出来。</p>')
DUP_PAGE = (PAGE_STYLE % '同一个页面有多份文件' + '<h1>这个页面有 %d 份文件，保存服务已暂停打开和保存</h1>'
            '<p>页面标识 <code>%s</code> 同时出现在：</p><ul>%s</ul><p>为了不把改动写进错的那一份，保存服务不会替你挑选。'
            '请让 AI 处理多余的副本（移进回收站，或者给副本换一个新的页面标识），然后刷新本页。AI 做备份请放进 .jc-versions 目录。</p>'
            '<p>你在浏览器里暂存的改动还在，处理完后重新打开页面，会自动保存到文件。</p>')
FILE_ERROR = (PAGE_STYLE % '打不开这个文件' + '<h1>打不开这个文件</h1><p>%s。</p><p>请求的路径：<code>%s</code></p>')
WRONG_HOST_PAGE = (PAGE_STYLE % '请换 127.0.0.1 打开' + '<h1>这个页面要用 127.0.0.1 打开</h1>'
                   '<p>请打开 <a href="%s">%s</a>。</p><p>localhost 这个地址只用来查看不能保存的文件（/f/ 开头的地址）；'
                   '能保存到文件的页面用 127.0.0.1 打开，两者分开，那些文件里的程序就改不到你的稿子。</p>')
LOOPBACK_ORIGIN_RE = re.compile(r'http://(?:127\.0\.0\.1|localhost)(?::\d{1,5})?')
LOOPBACK6 = '::1'


class Handler(BaseHTTPRequestHandler):
    server_version = 'jc-brain-save/1'
    _pid, _sent = None, False

    def log_message(self, fmt, *args):
        log_line('%s %s' % (self.address_string(), fmt % args))

    def log_request(self, code='-', size='-'):
        p = self.path.split('?')[0]
        # 轮询、浏览器自己要的网页图标和 /f/ 的文件请求（一页里的每张图、视频拖动时的每一段）不记访问日志；失败由 log_failure 记
        if not (p.endswith(('/meta', '/healthz', '/changes')) or p.startswith('/f/') or p == '/favicon.ico'):
            super().log_request(code, size)

    def _origin(self):
        return self.headers.get('Origin') if self.headers.get('Origin') in ('null', self.server.origin) else None

    def _send(self, code, body, ctype='application/json; charset=utf-8', cors=False, extra=(), reason=None):
        if code >= 400:  # 失败要能事后查：时间、请求、页面身份号、原因
            if reason is None: reason = body.get('error') if isinstance(body, dict) else '-'
            log_failure(code, self.command, self.path, self._pid, reason)
        body = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode('utf-8')
        self._sent = True
        self.send_response(code)
        hdrs = [('Content-Type', ctype), ('Content-Length', str(len(body))), ('Cache-Control', 'no-store')] + list(extra)
        if cors and self._origin(): hdrs += [('Access-Control-Allow-Origin', self._origin()), ('Vary', 'Origin')]
        for k, v in hdrs: self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _guard(self, fn):
        """未处理的异常：带时间和请求路径记日志，尽量回 500 和中文原因，而不是直接断开连接。"""
        try:
            fn()
        except (BrokenPipeError, ConnectionResetError) as e:
            log_line('页面提前断开了连接 %s %s page_id=%s：%r' % (self.command, self.path, self._pid or '-', e))
        except Exception as e:  # noqa: BLE001
            log_line('服务内部出错 %s %s page_id=%s：%r\n%s' % (self.command, self.path, self._pid or '-', e, traceback.format_exc().rstrip()))
            if not self._sent:
                try: self._send(500, {'error': '保存服务内部出错：%s（详情见服务日志）' % e}, cors=True, reason='内部出错，堆栈见上一条')
                except OSError: pass

    def _host(self):
        """这次请求用的主机名：'ip'（127.0.0.1:端口，能存回文件的页面和接口）、'name'（localhost:端口，只读的 /f/），
        别的一律 None（例如有人把别的域名解析到本机）。见文件开头「来源隔离」。"""
        h, srv = self.headers.get('Host'), self.server
        return 'ip' if h == srv.ip_host else 'name' if h == srv.name_host else None

    def _ip_host_only(self, host):
        """页面、数据、改动记录和保存只认 127.0.0.1:端口；不是就回 403，返回 False。"""
        if host == 'ip': return True
        srv, u = self.server, urlsplit(self.path)
        if host is None:
            self._send(403, {'error': 'Host 必须恰好是 127.0.0.1:%d 或 localhost:%d' % (srv.port, srv.port)})
            return False
        m = re.fullmatch(r'/p/([A-Za-z0-9_-]{4,64})/?', u.path)
        if self.command == 'GET' and m:  # 在浏览器里打开的页面：说清楚换哪个地址
            url = html.escape('%s/p/%s' % (srv.origin, m.group(1)))
            self._send(403, (WRONG_HOST_PAGE % (url, url)).encode('utf-8'), 'text/html; charset=utf-8', reason='localhost 不提供 /p/')
        else:
            self._send(403, {'error': 'localhost:%d 只提供只读文件（/f/）和 /healthz；页面、数据、改动记录和保存请用 %s' % (srv.port, srv.origin)})
        return False

    def do_OPTIONS(self):
        if not self._ip_host_only(self._host()): return
        if not self._origin(): return self._send(403, {'error': '这个来源不能访问保存服务'})
        self._send(204, b'', cors=True, extra=[('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'), ('Access-Control-Max-Age', '600'),
                                               ('Access-Control-Allow-Headers', 'Content-Type'), ('Access-Control-Allow-Private-Network', 'true')])

    def do_GET(self): self._guard(self._get)
    def do_POST(self): self._guard(self._post)

    def _get(self):
        host, srv, u = self._host(), self.server, urlsplit(self.path)
        if host is None: return self._ip_host_only(host)
        if u.path == '/favicon.ico':  # 浏览器打开页面时自己来要网页图标：回「没有内容」，免得控制台里多一条 404
            return self._send(204, b'', 'image/x-icon')
        if u.path == '/healthz':  # 两个主机名都能读
            srv.index.scan(Index.POLL_MAX_AGE)  # duplicates 反映最近 30 秒内的磁盘，而不是启动时
            if srv.index.dups: srv.index.scan()  # 报重复之前现扫确认
            # writable：这个服务会不会写文件（只读实例是 false）；read_only：是不是用 --read-only 起的预览实例
            # origin：/p/ 页面和保存的地址；files_origin：/f/ 只读文件的地址；listen：实际在听的回环地址
            h = {'service': SERVICE_NAME, 'protocol': 1, 'features': FEATURES, 'pid': os.getpid(),
                 'started_at': srv.started_at, 'root': srv.root, 'root_ok': os.path.isdir(srv.root), 'skip': srv.skip,
                 'writable': not srv.read_only and os.access(srv.root, os.W_OK), 'read_only': srv.read_only,
                 'duplicates': srv.index.dups, 'kit_path': KIT_PATH, 'template_dir': TEMPLATE_DIR,
                 'origin': srv.origin, 'files_origin': srv.files_origin, 'listen': srv.listen, 'listen_problem': srv.listen_problem}
            for name in PARTS:  # kit_ok / style_ok / app_ok：当前模板这一段能不能用；不能用时页面改用自带的，原因写在 *_problem
                text, problem = load_part(name)
                h[name + '_ok'], h[name + '_problem'] = bool(text), problem
            # 本机别的端口上的页面（例如工作台界面）打开页面前要先问一句服务在不在，所以本机来源都能读 healthz
            o = self.headers.get('Origin') or ''
            extra = [('Access-Control-Allow-Origin', o), ('Vary', 'Origin')] if o != srv.origin and LOOPBACK_ORIGIN_RE.fullmatch(o) else []
            return self._send(200, h, cors=True, extra=extra)
        if u.path.startswith('/f/'):
            if host == 'ip':  # 没接入同步的文件只在 localhost 这个来源提供：换到同一路径（原样保留编码和查询串）
                return self._send(302, b'', 'text/plain; charset=utf-8', extra=[('Location', srv.files_origin + u.path + ('?' + u.query if u.query else ''))])
            return self._file(u.path[3:])
        if not self._ip_host_only(host): return
        m = re.fullmatch(r'/p/([A-Za-z0-9_-]{4,64})(/meta|/doc|/changes)?/?', u.path)
        if not m: return self._send(404, (NOT_FOUND % html.escape(u.path)).encode('utf-8'), 'text/html; charset=utf-8', reason='没有这个地址')
        self._pid, sub = m.group(1), m.group(2)
        try:
            loc, data = srv.index.lookup(self._pid, Index.POLL_MAX_AGE if sub else 0.0)  # 打开页面总是现扫
        except PageError as e:
            if sub: return self._send(e.code, {'error': str(e), 'duplicates': e.dups}, cors=True)
            if e.dups:
                page = DUP_PAGE % (len(e.dups), html.escape(self._pid), ''.join('<li><code>%s</code></li>' % html.escape(x) for x in e.dups))
            else:
                page = NOT_FOUND % html.escape(self._pid)
            return self._send(e.code, page.encode('utf-8'), 'text/html; charset=utf-8', reason=str(e))
        info = {'fingerprint': sha(data), 'path': os.path.relpath(loc, srv.root)}
        if sub == '/meta':  # file:// 页面也要能读，用来决定是否补写、是否跳转
            given = parse_qs(u.query).get('file')
            if given: info['same_file'] = same_file(given[0], loc)
            return self._send(200, info, cors=True)
        if sub == '/changes':  # 改动记录：给「改动痕迹」用，file:// 页面也能读（不含口令）
            item = parse_qs(u.query).get('item')
            return self._send(200, {'changes': read_changes(srv.root, self._pid, item[0] if item else None)}, cors=True)
        if sub == '/doc':
            try: info['doc'] = parse_page(data)[1]
            except PageError as e: return self._send(422, {'error': str(e)})
            return self._send(200, info)  # 含 token，不给 file:// 来源跨域读
        # 换上当前模板（kit、样式、界面脚本）；哪段坏了就用页面自带的那份，页面照样能打开能存
        body = serve_page(data.decode('utf-8', 'replace'), info, self._pid)[0].encode('utf-8')
        if srv.read_only: body = with_banner(body, BANNER_READ_ONLY)  # 预览实例不写文件：先说清楚，免得改了半天才看到红字
        self._send(200, body, 'text/html; charset=utf-8')

    def _file(self, raw):
        """GET /f/<相对路径>：只读提供根目录下的文件。带 jc-doc 的页面 302 到 /p/<page_id>；
        会把改动留在浏览器里的页面加一条黄色横幅；其余文件原样给，支持单段 Range（视频能拖进度条）。"""
        srv = self.server
        try:
            rel = unquote(raw, errors='strict')
        except UnicodeDecodeError:
            rel = None
        try:
            if rel is None: raise PageError('地址不对：路径里有读不懂的编码', 400)
            path = resolve_file(srv.root, rel)
        except PageError as e:
            page = FILE_ERROR % (html.escape(str(e)), html.escape(rel if rel is not None else raw))
            return self._send(e.code, page.encode('utf-8'), 'text/html; charset=utf-8', reason=str(e))
        ext = os.path.splitext(path)[1].lower()
        ctype = FILE_TYPES[ext]
        if ext in HTML_EXT:
            with open(path, 'rb') as f: data = f.read()
            pid = page_id_of(data)
            if pid:  # 接入同步的页面走能存回文件的那条路：固定网址在 127.0.0.1 上，所以写完整地址
                return self._send(302, b'', 'text/plain; charset=utf-8', extra=[('Location', '%s/p/%s' % (srv.origin, pid))])
            if any(page_signals(data, path, os.path.realpath(srv.root))):
                data = with_banner(data, BANNER_BROWSER_ONLY)
            return self._send(200, data, ctype + text_charset(data[:65536]), extra=[('X-Content-Type-Options', 'nosniff')])
        self._send_file(path, ctype)

    def _send_file(self, path, ctype):
        """原样发文件，边读边发（大视频不整份读进内存）；带 Range 时只发那一段（206）。"""
        with open(path, 'rb') as f:
            size = os.fstat(f.fileno()).st_size
            if ctype.startswith('text/') or ctype in ('application/json', 'image/svg+xml'):
                ctype += text_charset(f.read(65536))
            r = parse_range(self.headers.get('Range'), size) if self.headers.get('Range') else 'ignore'
            if r is None:
                return self._send(416, {'error': '请求的范围超出文件大小（%d 字节）' % size},
                                  extra=[('Content-Range', 'bytes */%d' % size)])
            start, end = (0, size - 1) if r == 'ignore' else r
            length = max(0, end - start + 1)
            self._sent = True
            self.send_response(200 if r == 'ignore' else 206)
            hdrs = [('Content-Type', ctype), ('Content-Length', str(length)), ('Accept-Ranges', 'bytes'),
                    ('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff')]
            if r != 'ignore': hdrs.append(('Content-Range', 'bytes %d-%d/%d' % (start, end, size)))
            for k, v in hdrs: self.send_header(k, v)
            self.end_headers()
            f.seek(start)
            left = length
            try:
                while left > 0:
                    chunk = f.read(min(FILE_CHUNK, left))
                    if not chunk: break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass  # 拖动视频进度条时浏览器会主动断开上一段，属于正常情况，不记日志

    def _post(self):
        if not self._ip_host_only(self._host()): return
        if self.server.read_only: return self._send(403, {'error': READ_ONLY_MSG}, cors=True)  # 预览实例：任何写入都拒绝
        if not self._origin(): return self._send(403, {'error': '来源不被允许：%s' % self.headers.get('Origin')})
        if urlsplit(self.path).path != '/save': return self._send(404, {'error': '只有 /save 接受 POST'}, cors=True)
        if (self.headers.get('Content-Type') or '').split(';')[0].strip().lower() != 'application/json':
            return self._send(415, {'error': 'Content-Type 必须是 application/json'}, cors=True)
        try:
            n = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(n).decode('utf-8')) if 0 < n <= 5_000_000 else None
        except ValueError: body = None
        if isinstance(body, dict) and isinstance(body.get('page_id'), str): self._pid = body['page_id'][:64]
        if not valid_body(body):
            return self._send(400, {'error': '请求格式不对：需要 page_id、token、changes[change_id,item_id,field,before,after,item_fp,可选 group]'}, cors=True)
        try: out = apply_changes(self.server, body['page_id'], body.get('token'), body['changes'], self._origin(), body.get('self_path'))
        except PageError as e: return self._send(e.code, {'error': str(e), 'duplicates': e.dups}, cors=True)
        except OSError as e: return self._send(500, {'error': '写文件失败：%s' % e}, cors=True)
        self._send(200, out, cors=True)


class Server(ThreadingHTTPServer):
    """127.0.0.1 上的监听。twin 是同一端口在 ::1 上的监听（localhost 可能先解析到 ::1），
    和它共用根目录、索引等全部状态；serve_forever、shutdown、server_close 连它一起管，调用方只管这一个对象。"""
    daemon_threads = True
    twin = None
    running = False  # 作为 twin 时：它的 serve_forever 线程起了没有

    def serve_forever(self, poll_interval=0.5):
        t = self.twin
        if t is not None and not t.running:
            t.running = True
            threading.Thread(target=t.serve_forever, args=(poll_interval,), daemon=True, name='jc-brain-save-ipv6').start()
        super().serve_forever(poll_interval)

    def shutdown(self):
        t = self.twin
        if t is not None and t.running:
            t.shutdown()
            t.running = False
        super().shutdown()

    def server_close(self):
        if self.twin is not None: self.twin.server_close()
        super().server_close()

    def handle_error(self, request, client_address):
        """Handler 之外的异常（例如读请求头时出错）也带上时间再打印堆栈。"""
        log_line('处理 %s 的请求时出错：\n%s' % (client_address[0] if client_address else '?', traceback.format_exc().rstrip()))


class Server6(Server):
    address_family = socket.AF_INET6


def _addr_busy(host, port):
    e = OSError(errno.EADDRINUSE, '%s 端口 %d 已被别的进程占用' % (host, port))
    e.host = host
    return e


def bind_loopback(port):
    """在 127.0.0.1 和 ::1 的同一端口上各开一个监听，返回 (IPv4 服务, IPv6 服务或 None, 没开 ::1 的原因)。
    ::1 上这个端口被别的程序占着：port 为 0（系统挑端口，测试用）时换一个再试，固定端口时抛 EADDRINUSE（带 host='::1'），
    免得 localhost 连到别的程序上。本机开不了 ::1（没有 IPv6）时只听 127.0.0.1，localhost 也只会解析到它。"""
    for _ in range(20 if port == 0 else 1):
        v4 = Server(('127.0.0.1', port), Handler)
        try:
            return v4, Server6((LOOPBACK6, v4.server_address[1]), Handler), ''
        except OSError as e:
            if e.errno != errno.EADDRINUSE:
                return v4, None, '本机开不了 IPv6 回环地址 ::1（%s），只听 127.0.0.1' % e
            v4.server_close()
            if port: raise _addr_busy(LOOPBACK6, port)
    raise _addr_busy(LOOPBACK6, 0)


SHARED = ('root', 'skip', 'read_only', 'port', 'origin', 'files_origin', 'ip_host', 'name_host', 'started_at', 'index', 'listen', 'listen_problem')


def make_server(root, port, read_only=False, skip=()):
    """read_only=True 是预览用的只读实例：所有写入请求 403，/p/ 页面顶上说明改动不会存回文件。
    skip：扫页面时不进的目录（工作台的回收站）。
    返回 127.0.0.1 上的服务对象；::1 上的那个挂在它的 twin 上，跟着它一起起停（见 Server）。"""
    srv, twin, problem = bind_loopback(port)
    srv.root = os.path.abspath(root)
    srv.skip = [os.path.abspath(s) for s in skip]
    srv.read_only = bool(read_only)
    srv.port = srv.server_address[1]
    srv.ip_host, srv.name_host = '127.0.0.1:%d' % srv.port, 'localhost:%d' % srv.port
    srv.origin, srv.files_origin = 'http://' + srv.ip_host, 'http://' + srv.name_host
    srv.started_at, srv.index = now_iso(), Index(srv.root, srv.skip)
    srv.listen, srv.listen_problem = ['127.0.0.1'] + ([LOOPBACK6] if twin else []), problem
    if twin is not None:
        for k in SHARED: setattr(twin, k, getattr(srv, k))
        srv.twin = twin
    srv.index.scan()
    return srv


def who_holds(port, host='127.0.0.1'):
    """端口被占时尽量说清是谁：先问它的 /healthz（是保存服务就有 pid 和 root），再用 lsof 查进程。"""
    parts = []
    try:
        c = http.client.HTTPConnection(host, port, timeout=2)
        c.request('GET', '/healthz', headers={'Host': ('127.0.0.1:%d' if host == '127.0.0.1' else 'localhost:%d') % port})
        r = c.getresponse()
        raw = r.read()
        c.close()
        h = json.loads(raw.decode('utf-8'))
        parts.append('占用者是保存服务 %s，pid=%s，root=%s，启动于 %s' % (h.get('service'), h.get('pid'), h.get('root'), h.get('started_at')))
    except (OSError, ValueError, http.client.HTTPException):
        parts.append('占用者没有回答 /healthz，不是保存服务')
    try:
        out = subprocess.run(['/usr/sbin/lsof', '-nP', '-iTCP:%d' % port, '-sTCP:LISTEN', '-Fpc'], capture_output=True, text=True, timeout=5).stdout
        procs = re.findall(r'^p(\d+)\nc(.*)$', out, re.M)
        if procs: parts.append('lsof 查到监听进程：%s' % '、'.join('pid=%s（%s）' % pc for pc in procs))
    except (OSError, subprocess.SubprocessError):
        pass
    return '；'.join(parts)


def main():
    global KIT_PATH, TEMPLATE_DIR
    ap = argparse.ArgumentParser(description='创作页保存服务：页面上的改动逐格写回文件')
    ap.add_argument('--port', type=int, default=DEFAULT_PORT, help='端口，默认 %d' % DEFAULT_PORT)
    ap.add_argument('--root', required=True, help='工作文件夹（页面都在它下面，锁、版本、改动记录也放在它下面的隐藏目录）')
    ap.add_argument('--template-dir', help='样式 style.css 和界面脚本 app.js 所在目录，默认 %s' % TEMPLATE_DIR)
    ap.add_argument('--kit-dir', help='保存脚本 kit.js 所在目录，默认 %s' % os.path.dirname(KIT_PATH))
    ap.add_argument('--read-only', action='store_true', help='预览用的只读实例：所有写入请求一律 403，不写任何文件')
    ap.add_argument('--skip-dir', action='append', default=[], help='扫页面时不进这个目录（工作台的回收站），可以写多次')
    a = ap.parse_args()
    if a.template_dir: TEMPLATE_DIR = os.path.abspath(a.template_dir)
    if a.kit_dir: KIT_PATH = os.path.join(os.path.abspath(a.kit_dir), PART_FILES['kit'])
    try:
        srv = make_server(a.root, a.port, read_only=a.read_only, skip=a.skip_dir)
    except OSError as e:
        if e.errno != errno.EADDRINUSE: raise
        host = getattr(e, 'host', '127.0.0.1')
        shown = '[%s]:%d' % (host, a.port) if ':' in host else '%s:%d' % (host, a.port)
        why = '（localhost 可能先解析到 ::1，会连到那个程序上，所以不启动）' if host == LOOPBACK6 else ''
        log_line('启动失败：%s 端口已被别的进程占用%s，本服务（pid=%d）没有启动，退出码 %d。%s。'
                 '注意：此时 /healthz 是占用者在回答，不代表本服务正常。' % (shown, why, os.getpid(), EXIT_PORT_BUSY, who_holds(a.port, host)))
        sys.exit(EXIT_PORT_BUSY)
    bad = [(n, load_part(n)[1]) for n in PARTS]
    bad = ['；注意：%s，页面会改用文件里自带的%s' % (p, PART_WHAT[n]) for n, p in bad if p]
    log_line('保存服务启动 %s（页面和保存）、%s（只读文件 /f/），监听 %s root=%s（存在：%s）不扫=%s pid=%d 页面数=%d 同号多份=%d kit=%s 模板目录=%s%s%s%s' % (
        srv.origin, srv.files_origin, ' 和 '.join(srv.listen), srv.root, os.path.isdir(srv.root), '、'.join(srv.skip) or '无', os.getpid(), len(srv.index.map),
        len(srv.index.dups), KIT_PATH, TEMPLATE_DIR, '；只读预览：不写任何文件' if srv.read_only else '',
        '；注意：' + srv.listen_problem if srv.listen_problem else '', ''.join(bad)))

    def stop(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)  # 工作台停下时发 SIGTERM，在终端按 Control+C 是 SIGINT：都安静地停，退出码 0
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for s in (signal.SIGTERM, signal.SIGINT):  # 已经在停了：后到的停止信号（Control+C 之后启动脚本还会再发一次）不再打断收尾
            signal.signal(s, signal.SIG_IGN)
        srv.server_close()
    log_line('保存服务已停止')


if __name__ == '__main__':
    main()
