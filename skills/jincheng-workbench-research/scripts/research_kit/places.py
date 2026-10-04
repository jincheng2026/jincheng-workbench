"""东西放在哪：工作台的设置文件、工作文件夹、「市场调研」和它下面的三个文件夹、内容草稿、写稿方法。

设置文件和工作台（仓库的 lib/config.mjs）是同一个：~/Library/Application Support/<id>/config.json。
这里只读不写；默认值和路径写法跟 lib/config.mjs 一样：~ 开头接家目录，相对路径接在工作文件夹后面。
"""
import json
import os
import re

from . import UserError

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(os.path.dirname(HERE))  # skills/<id>-research
FALLBACK_ID = "jincheng-workbench"
SKILL_SUFFIX = "-research"

# 「市场调研」下面的三个文件夹：位置读工作台设置里的 paths.benchmarkAccounts、researchReports、commentImports
# （和工作台 lib/config.mjs 的 RESEARCH_PATH_KEYS 一致），没写就用下面的默认值
ACCOUNTS = "对标账号"
REPORTS = "调研报告"
IMPORTS = "评论导入"
HIDDEN = ".tikhub"  # TikHub 的用量记录、价格、24 小时内的缓存；放在「调研报告」的上一层，以点开头，工作台不显示

DEFAULT_PATHS = {
    "benchmarkAccounts": "市场调研/" + ACCOUNTS,
    "researchReports": "市场调研/" + REPORTS,
    "commentImports": "市场调研/" + IMPORTS,
    "drafts": "内容草稿",
    "writingMethod": "写稿方法",
    "trash": "回收站",
}


def repo_dir():
    """工作台仓库：这个 Skill 用软链装时，真实位置在仓库的 skills/ 下面，往上两层就是仓库。"""
    real = os.path.realpath(SKILL_DIR)
    repo = os.path.dirname(os.path.dirname(real))
    return repo if os.path.isfile(os.path.join(repo, "brand.json")) else None


def brand_id():
    """工作台的英文名（brand.json 的 id）。找不到仓库时，从 Skill 文件夹名「<id>-research」推。"""
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
    """读工作台的设置，返回各个位置（都是绝对路径）。设置文件还没有时按默认值；写坏了直接报错，不悄悄用默认值顶上。"""
    env = os.environ if env is None else env
    home = _home(env)
    file = settings_file(env)
    raw, exists = {}, os.path.isfile(file)
    if exists:
        try:
            with open(file, encoding="utf-8-sig") as f:
                raw = json.load(f)
        except ValueError as e:
            raise UserError("工作台的设置文件写坏了，不是合法的 JSON：%s（%s）。改好它，或者在工作台里重新保存一次设置，再试。" % (file, e))
        except OSError as e:
            raise UserError("读不出工作台的设置文件 %s：%s" % (file, e))
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

    accounts = place("benchmarkAccounts")
    reports = place("researchReports")
    imports = place("commentImports")
    research = os.path.dirname(reports)
    return {
        "settings_file": file,
        "settings_exists": exists,
        "work_folder": work,
        "research": research,
        "accounts": accounts,
        "reports": reports,
        "imports": imports,
        "hidden": os.path.join(research, HIDDEN),
        "drafts": place("drafts"),
        "writing_method": place("writingMethod"),
        "trash": place("trash"),
    }


def ensure(folder):
    """只补缺的文件夹，从不动已有的东西。"""
    os.makedirs(folder, exist_ok=True)
    return folder


_DRAFT_DIR = re.compile(r"^(T\d{3,})(?:_|$)")


def draft_dirs(content_id, drafts):
    """内容草稿里这条内容的文件夹：和工作台一样按编号前缀认（T001_ 开头，或者就叫 T001）。"""
    try:
        names = sorted(n for n in os.listdir(drafts) if not n.startswith(".") and os.path.isdir(os.path.join(drafts, n)))
    except OSError:
        return []
    out = []
    for name in names:
        m = _DRAFT_DIR.match(name)
        if m and m.group(1) == content_id:
            out.append(os.path.join(drafts, name))
    return out


def report_dir(places, name_or_path):
    """报告文件夹：可以写完整路径，也可以只写「调研报告」里的文件夹名。"""
    text = str(name_or_path or "").strip()
    if not text:
        raise UserError("要告诉我是哪个报告文件夹（「调研报告」里的文件夹名，或者完整路径）。")
    candidate = os.path.abspath(_expand(text, os.path.expanduser("~")))
    if os.path.isdir(candidate):
        return candidate
    inside = os.path.join(places["reports"], text)
    if os.path.isdir(inside):
        return inside
    raise UserError("找不到报告文件夹「%s」。「调研报告」在 %s。" % (text, places["reports"]))
