"""零碎的小工具：现在几点、能放进文件夹名的文字、按人的习惯排序、先写临时文件再换过去。"""
import json
import os
import re
import tempfile
from collections import OrderedDict
from datetime import datetime


def now():
    """现在的本机时间。测试用环境变量 COVER_NOW（写成「2026-10-05 21:10」）固定住，别的时候不用它。"""
    fixed = (os.environ.get("COVER_NOW") or "").strip()
    if fixed:
        try:
            return datetime.strptime(fixed, "%Y-%m-%d %H:%M")
        except ValueError:
            pass
    return datetime.now()


def today():
    return now().strftime("%Y-%m-%d")


def minute():
    return now().strftime("%Y-%m-%d %H:%M")


_BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]+')


def safe_name(text, limit=40, fallback="未命名"):
    """能放进文件夹名的文字：去掉 / \\ : * ? " < > | 和控制字符，空白并成一个空格，不以点开头，最多 limit 个字。"""
    name = _BAD_NAME.sub(" ", str(text or ""))
    name = re.sub(r"\s+", " ", name).strip().lstrip(".").strip()
    if len(name) > limit:
        name = name[:limit].rstrip()
    return name or fallback


def natural_key(name):
    """「图2」排在「图10」前面：数字按大小比，别的按文字比。"""
    return [(0, int(part), "") if part.isdigit() else (1, 0, part.lower()) for part in re.split(r"(\d+)", name) if part]


def unique_dir(parent, name):
    """parent 里还没有的文件夹名：name、name-2、name-3……（只算名字，不建）。"""
    candidate, n = name, 2
    while os.path.exists(os.path.join(parent, candidate)):
        candidate = "%s-%d" % (name, n)
        n += 1
    return os.path.join(parent, candidate)


def unique_file(folder, stem, suffix):
    """folder 里还没有的文件名：stem.suffix、stem-2.suffix……"""
    candidate, n = stem + suffix, 2
    while os.path.exists(os.path.join(folder, candidate)):
        candidate = "%s-%d%s" % (stem, n, suffix)
        n += 1
    return os.path.join(folder, candidate)


def _umask_mode():
    mask = os.umask(0)
    os.umask(mask)
    return 0o666 & ~mask


def _atomic(path, data, before=None):
    """先写同一个文件夹里的临时文件，再换过去：写一半断电也不会留下坏文件。
    before 给了（读的时候文件的字节，文件原来没有时是 b""）：换过去之前再读一次，被别人改过就不换，返回 False。"""
    folder = os.path.dirname(path) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=folder)
    os.chmod(tmp, _umask_mode())
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        if before is not None and read_bytes(path) != before:
            os.unlink(tmp)
            return False
        os.replace(tmp, path)
        return True
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def read_bytes(path):
    """文件的字节；文件不存在时是 b""。"""
    try:
        with open(path, "rb") as f:
            return f.read()
    except FileNotFoundError:
        return b""


def write_text(path, text):
    _atomic(path, text.encode("utf-8"))


def write_json(path, value):
    _atomic(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def write_bytes(path, data):
    _atomic(path, data)


def read_json(path):
    """读 JSON，保留键的先后（改一项再写回去时，别的键原样、原来的顺序）。"""
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f, object_pairs_hook=OrderedDict)


def update_text(path, change, tries=5):
    """读出整个文件、改好、写回。写回前文件被别人（比如工作台）改过，就重新读、重新改，最多 tries 次。
    change(旧文字) 返回新文字；文件原来没有时旧文字是空字符串。返回新文字。"""
    for _ in range(tries):
        before = read_bytes(path)
        old = before.decode("utf-8-sig")
        new = change(old)
        if _atomic(path, new.encode("utf-8"), before=before):
            return new
    raise RuntimeError("%s 一直在被别的程序改，没写进去" % path)


def one_line(text):
    """表格里的一格：换行并成空格，竖线换成全角的「／」（不然表格会断开）。"""
    text = re.sub(r"\s*[\r\n]+\s*", " ", str(text or ""))
    return text.replace("|", "／").strip()
