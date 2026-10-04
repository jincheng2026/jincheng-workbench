"""东西放在哪：工作台的设置文件、工作文件夹、封面素材、对标账号、调研报告、内容草稿；工作台在不在运行。

设置文件和工作台（仓库的 lib/config.mjs）是同一个：~/Library/Application Support/<id>/config.json。
这里只读不写；默认值和路径写法跟 lib/config.mjs 一样：~ 开头接家目录，相对路径接在工作文件夹后面，
某一项写得不对按默认值。tests/cover-skill.test.mjs 会核对这里的默认值和 lib/config.mjs 一致。

没有直接用调研 Skill 的 research_kit/places.py：它不认 coverAssets，报的错也是它自己的类型；
这里照它和创作页 creation_doc.py 的做法另写一份小的，读的是同一个设置文件，默认值由测试对齐。
"""
import errno
import hashlib
import http.client
import json
import os
import re
from collections import OrderedDict

from . import UserError

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(os.path.dirname(HERE))  # skills/<id>-cover
SKILL_SUFFIX = "-cover"
FALLBACK_ID = "jincheng-workbench"

# 和 lib/config.mjs 的 defaultSettings().paths 一样（coverAssets 是封面 1.1 新加的一项）
DEFAULT_PATHS = OrderedDict([
    ("topics", "选题库"),
    ("overview", "选题库/00_选题总览.md"),
    ("drafts", "内容草稿"),
    ("writingMethod", "写稿方法"),
    ("benchmarkAccounts", "市场调研/对标账号"),
    ("researchReports", "市场调研/调研报告"),
    ("commentImports", "市场调研/评论导入"),
    ("trash", "回收站"),
    ("coverAssets", "封面素材"),
])
# 和 lib/ports.mjs 一样
DEFAULT_PORTS = {"api": 18878, "ui": 18879, "save": 18977}
BLOCKED_PORTS = frozenset({8878, 8879, 8888, 8890, 8977, 8978, 8787, 43127})

CONTENT_ID = re.compile(r"^T\d{3,4}$")
_DRAFT_DIR = re.compile(r"^(T\d{3,4})(?:_|$)")


class SettingsError(UserError):
    """工作台的设置文件写坏了。"""


def repo_dir():
    """工作台仓库：这个 Skill 用软链装时，真实位置在仓库的 skills/ 下面，往上两层就是仓库。"""
    real = os.path.realpath(SKILL_DIR)
    repo = os.path.dirname(os.path.dirname(real))
    return repo if os.path.isfile(os.path.join(repo, "brand.json")) else None


def brand_id():
    """工作台的英文名（brand.json 的 id）。找不到仓库时，从 Skill 文件夹名「<id>-cover」推。"""
    repo = repo_dir()
    if repo:
        try:
            with open(os.path.join(repo, "brand.json"), encoding="utf-8") as f:
                value = json.load(f).get("id")
            if isinstance(value, str) and value.strip():
                return value.strip()
        except (OSError, ValueError, AttributeError):
            pass
    name = os.path.basename(os.path.realpath(SKILL_DIR))
    if name.endswith(SKILL_SUFFIX) and len(name) > len(SKILL_SUFFIX):
        return name[: -len(SKILL_SUFFIX)]
    return FALLBACK_ID


def start_hint():
    """在后台启动工作台的命令：找得到仓库就写上仓库位置。"""
    repo = repo_dir()
    return 'pnpm --dir "%s" start --background' % repo if repo else "在工作台仓库文件夹里运行 pnpm start --background"


def _home(env):
    return env.get("HOME") or os.path.expanduser("~")


def _expand(value, home):
    value = str(value).strip()
    if value == "~":
        return home
    return os.path.join(home, value[2:]) if value.startswith("~/") else value


def settings_file(env=None):
    env = os.environ if env is None else env
    home = _home(env)
    custom = (env.get("WORKBENCH_CONFIG_DIR") or "").strip()
    folder = os.path.abspath(_expand(custom, home)) if custom else os.path.join(home, "Library", "Application Support", brand_id())
    return os.path.join(folder, "config.json")


def settings(env=None):
    """读工作台的设置，返回各个位置（都是绝对路径）和界面的端口。
    设置文件还没有时按默认值；写坏了直接报错，不悄悄用默认值顶上。"""
    env = os.environ if env is None else env
    home = _home(env)
    file = settings_file(env)
    raw, exists = {}, os.path.isfile(file)
    if exists:
        try:
            with open(file, encoding="utf-8-sig") as f:
                raw = json.load(f)
        except ValueError as e:
            raise SettingsError("工作台的设置文件写坏了，不是合法的 JSON：%s（%s）。改好它，或者在工作台里重新保存一次设置，再试。" % (file, e))
        except OSError as e:
            raise SettingsError("读不出工作台的设置文件 %s：%s" % (file, e))
        if not isinstance(raw, dict):
            raw = {}
    work_text = raw.get("workFolder")
    if not isinstance(work_text, str) or not work_text.strip():
        work_text = "~/Documents/" + brand_id()
    work = os.path.abspath(_expand(work_text, home))
    paths = raw.get("paths") if isinstance(raw.get("paths"), dict) else {}

    def place(key):
        value = paths.get(key)
        value = value if isinstance(value, str) and value.strip() else DEFAULT_PATHS[key]
        value = _expand(value, home)
        return os.path.abspath(value if os.path.isabs(value) else os.path.join(work, value))

    ports = raw.get("ports") if isinstance(raw.get("ports"), dict) else {}

    def port(key):
        value = ports.get(key)
        ok = isinstance(value, int) and not isinstance(value, bool) and 1024 <= value <= 65535 and value not in BLOCKED_PORTS
        return value if ok else DEFAULT_PORTS[key]

    api, ui = port("api"), port("ui")
    if api == ui:  # 和 lib/config.mjs 一样：接口和界面的端口一样时都按默认值
        api, ui = DEFAULT_PORTS["api"], DEFAULT_PORTS["ui"]
    return {
        "settings_file": file,
        "settings_exists": exists,
        "work_folder": work,
        "topics": place("topics"),
        "overview": place("overview"),
        "drafts": place("drafts"),
        "writing_method": place("writingMethod"),
        "accounts": place("benchmarkAccounts"),
        "reports": place("researchReports"),
        "trash": place("trash"),
        "cover_assets": place("coverAssets"),
        "ui_port": ui,
    }


def work_folder_or_die(places):
    if not os.path.isdir(places["work_folder"]):
        raise UserError("工作文件夹还没有：%s。先在后台启动一次工作台，它会建好：%s" % (places["work_folder"], start_hint()))
    return places


def is_under(path, root):
    try:
        p, r = os.path.realpath(path), os.path.realpath(root)
        return os.path.commonpath([p, r]) == r
    except ValueError:
        return False


# ---------- 内容编号和草稿文件夹 ----------

def content_id(text):
    """T002、t002 都认成 T002；不是 T 加三四位数字就报错。"""
    value = str(text or "").strip().upper()
    if not CONTENT_ID.match(value):
        raise UserError("内容编号要写成 T 加三位或四位数字，比如 T002（收到的是「%s」）。" % text)
    return value


def draft_dirs(cid, drafts):
    """内容草稿里这条内容的文件夹：和工作台一样按编号前缀认（T002_ 开头，或者就叫 T002）。"""
    try:
        names = sorted(n for n in os.listdir(drafts) if not n.startswith(".") and os.path.isdir(os.path.join(drafts, n)))
    except OSError:
        return []
    out = []
    for name in names:
        m = _DRAFT_DIR.match(name)
        if m and m.group(1) == cid:
            out.append(os.path.join(drafts, name))
    return out


def one_draft_dir(cid, places):
    """这条内容唯一的草稿文件夹；没有或者有好几个都报错。"""
    dirs = draft_dirs(cid, places["drafts"])
    if not dirs:
        raise UserError("内容草稿里还没有 %s 开头的文件夹（%s）。先开一批（record batch %s）会建好；改一张、定一张的话，先确认编号对不对。" % (cid, places["drafts"], cid))
    if len(dirs) > 1:
        raise UserError("%s 有 %d 个草稿文件夹，先问用户用哪个：%s" % (cid, len(dirs), "、".join(dirs)))
    return dirs[0]


def _plain(text):
    """去掉 Markdown 和双中括号链接的写法、✅ 和括号里的说明，只留标题主干（和工作台 lib/works.mjs 的读法一样）。"""
    value = str(text or "").replace("\\|", "|")
    value = re.sub(r"\[\[([^\]|]+)\|([^\]]+)\]\]", r"\2", value)
    value = re.sub(r"\[\[([^\]]+)\]\]", r"\1", value)
    value = re.sub(r"\[([^\]\n]*)\]\(<[^>\n]*>\)", r"\1", value)
    value = re.sub(r"\[([^\]\n]*)\]\([^)\s]*\)", r"\1", value)
    value = re.sub(r"\*\*([^*]+)\*\*", r"\1", value)
    value = re.sub(r"`([^`]*)`", r"\1", value)
    value = value.replace("✅", "")
    return re.sub(r"\s+", " ", value).strip()


def _without_brackets(text):
    previous = None
    while previous != text:
        previous = text
        text = re.sub(r"\s*[（(][^（）()]*[）)]", "", text)
    return text.strip()


def _cells(line):
    parts = line.strip().replace("\\|", "\x00").split("|")
    if parts and not parts[0].strip():
        parts = parts[1:]
    if parts and not parts[-1].strip():
        parts = parts[:-1]
    return [p.replace("\x00", "|").strip() for p in parts]


def topic_title(cid, places):
    """这条选题叫什么：先看选题卡的标题，再看选题总览里这一行的「选题」。找不到返回 (None, None)。"""
    pattern = re.compile(r"^%s(?!\d)" % cid)
    base = places["topics"]
    if os.path.isdir(base):
        depth0 = base.rstrip(os.sep).count(os.sep)
        for root, dirs, files in os.walk(base):
            dirs[:] = sorted(d for d in dirs if not d.startswith(".") and root.count(os.sep) - depth0 < 2)
            for name in sorted(files):
                if not name.endswith(".md") or not pattern.match(name):
                    continue
                try:
                    with open(os.path.join(root, name), encoding="utf-8-sig") as f:
                        for line in f:
                            if re.match(r"^#\s", line):
                                title = _plain(re.sub(r"^#\s+", "", line).strip())
                                title = re.sub(r"^%s(?!\d)\s*" % cid, "", title).strip()
                                if title:
                                    return title, "选题卡"
                                break
                except OSError:
                    continue
    try:
        with open(places["overview"], encoding="utf-8-sig") as f:
            lines = f.read().splitlines()
    except OSError:
        lines = []
    header = None
    for line in lines:
        if not line.strip().startswith("|"):
            header = None
            continue
        cells = _cells(line)
        if cells and all(re.match(r"^:?-+:?$", c) for c in cells):
            continue
        if header is None:
            header = cells
            continue
        if "编号" in header and "选题" in header:
            number = cells[header.index("编号")] if header.index("编号") < len(cells) else ""
            if re.search(r"%s(?!\d)" % cid, number):
                summary = cells[header.index("选题")] if header.index("选题") < len(cells) else ""
                title = _without_brackets(_plain(summary))
                if title:
                    return title, "选题总览"
    return None, None


def topic_type(cid, places):
    """这条内容是哪一类（工作台的「内容类型」，比如「口播」「公众号文章」）：和工作台一样，先看选题总览「## 选题总表」里
    它在哪个「### 类型」下面，再看选题卡放在 选题库/<类型>/ 的哪一类里。找不到返回 None。出一批没说尺寸时用它定默认尺寸。"""
    try:
        with open(places["overview"], encoding="utf-8-sig") as f:
            lines = f.read().splitlines()
    except OSError:
        lines = []
    section, kind, header = "", None, None
    for line in lines:
        s = line.strip()
        if s.startswith("## "):
            section, kind, header = s[3:].strip(), None, None
            continue
        if s.startswith("### "):
            kind, header = s[4:].strip(), None
            continue
        if not s.startswith("|"):
            header = None
            continue
        cells = _cells(s)
        if cells and all(re.match(r"^:?-+:?$", c) for c in cells):
            continue
        if header is None:
            header = cells
            continue
        if section.startswith("选题总表") and kind and "编号" in header:
            number = cells[header.index("编号")] if header.index("编号") < len(cells) else ""
            if re.search(r"%s(?!\d)" % cid, number):
                return kind
    base = places["topics"]
    pattern = re.compile(r"^%s(?!\d)" % cid)
    if os.path.isdir(base):
        for name in sorted(os.listdir(base)):
            folder = os.path.join(base, name)
            if name.startswith(".") or not os.path.isdir(folder):
                continue
            for root, dirs, files in os.walk(folder):  # 选题库/<类型>/T002_….md 或者 选题库/<类型>/<待做|已做>/T002_….md
                depth = root.count(os.sep) - folder.count(os.sep)
                dirs[:] = [] if depth >= 1 else sorted(d for d in dirs if not d.startswith("."))
                if any(f.endswith(".md") and pattern.match(f) for f in files):
                    return name
    return None


def folder_title(title):
    """草稿文件夹名里的选题名：和工作台「建草稿文件夹」一样，去掉访达不认的字符，最多 40 个字。"""
    clean = re.sub(r'[\x00-\x1f\\/:*?"<>|]', " ", str(title or ""))
    clean = re.sub(r"\s+", " ", clean)
    clean = re.sub(r"^[.\s]+", "", clean).strip()
    return clean[:40].strip()


# ---------- 这个对话打开的文件夹、能不能读写 ----------

def folder_relation(here, work):
    """这个对话打开的文件夹和工作文件夹是什么关系：'same' 就是它，'inside' 在它里面，'outside' 别处（包括它的上一层）。"""
    if os.path.realpath(here) == os.path.realpath(work):
        return "same"
    return "inside" if is_under(here, work) else "outside"


def access_problem(folder):
    """这个对话能不能读写这个文件夹：先列一下里面的东西，再建一个以点开头的临时小文件、马上删掉。
    能读能写返回空字符串，不然返回「读不了（原因）」或「写不了（原因）」。和创作页 where.py 的查法一样。"""
    import tempfile
    try:
        os.listdir(folder)
    except OSError as e:
        return "读不了（%s）" % (e.strerror or e)
    try:
        fd, probe = tempfile.mkstemp(prefix=".jc-write-check-", dir=folder)
        os.close(fd)
        os.remove(probe)
    except OSError as e:
        return "写不了（%s）" % (e.strerror or e)
    return ""


# ---------- 工作台在不在运行 ----------

def instance_id(file):
    """这一份工作台的记号：和 lib/config.mjs 的 instanceId 一样，由设置文件的位置算出来。"""
    return hashlib.sha256(os.path.abspath(file).encode("utf-8")).hexdigest()[:16]


def workbench(places, tries=20, timeout=0.4):
    """问界面端口上的 /api/health（被占时工作台会往后挪，所以往后问 tries 个）。
    返回 {"running": True, "origin": "http://127.0.0.1:端口"}；没找到返回 {"running": False, "blocked": 是不是连本机端口被拒绝了}。"""
    want_app, want_instance = brand_id(), instance_id(places["settings_file"])
    start = places["ui_port"]
    blocked = False
    for port in range(start, min(start + tries, 65536)):
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
            conn.request("GET", "/api/health", headers={"Host": "127.0.0.1:%d" % port})
            resp = conn.getresponse()
            body = resp.read()
            conn.close()
            health = json.loads(body.decode("utf-8"))
        except OSError as e:
            if e.errno in (errno.EPERM, errno.EACCES):
                blocked = True
            continue
        except (ValueError, http.client.HTTPException):
            continue
        if isinstance(health, dict) and health.get("app") == want_app and health.get("instance") == want_instance:
            ui = health.get("ui")
            ui = ui if isinstance(ui, int) and not isinstance(ui, bool) else port
            return {"running": True, "blocked": False, "origin": "http://127.0.0.1:%d" % ui}
    return {"running": False, "blocked": blocked, "origin": "http://127.0.0.1:%d" % start}


def detail_link(origin, cid):
    """工作台里这条选题的页面：出一批的设置、这条选题出过的封面（只看，选定的排第一）。"""
    return "%s/content/%s" % (origin, cid)


def covers_link(origin):
    """工作台「内容」栏的「封面」页：风格、拆一个新风格、我的封面、人物参考图片。"""
    return "%s/content?tab=covers" % origin
