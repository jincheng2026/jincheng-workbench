"""零碎的通用小工具：读数字、读时间、起安全的文件名、原子写 JSON。"""
import json
import math
import os
import re
import tempfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

_UNITS = (("亿", 100000000), ("万", 10000), ("w", 10000), ("k", 1000))


def parse_count(value):
    """把「1234」「1,234」「1.2万」「3k」「10w」这类写法读成整数；读不出、负数返回 None（不当成 0）。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float):
        return int(value) if math.isfinite(value) and value >= 0 else None
    raw = str(value).strip().lower().replace(",", "").replace("，", "").replace(" ", "")
    if not raw or raw in ("none", "null", "nan", "-", "--", "—"):
        return None
    factor = 1
    for unit, times in _UNITS:
        if raw.endswith(unit):
            raw, factor = raw[: -len(unit)], times
            break
    raw = raw.rstrip("+")
    try:
        number = Decimal(raw) * factor
    except InvalidOperation:
        return None
    if not number.is_finite() or number < 0:
        return None
    return int(number)


_EXCEL_EPOCH = datetime(1899, 12, 30)
_EXCEL_EPOCH_1904 = datetime(1904, 1, 1)


def excel_serial_to_datetime(serial, date1904=False):
    """Excel 里日期存成「从 1900 年起第几天」的小数，换成不带时区的本地时间。"""
    base = _EXCEL_EPOCH_1904 if date1904 else _EXCEL_EPOCH
    return base + timedelta(days=float(serial))


_DATE_PATTERNS = (
    (re.compile(r"^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2})[:：时](\d{1,2})(?:[:：分](\d{1,2})(?:\.\d+)?)?秒?)?"), True),
    (re.compile(r"^(\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2})[:：](\d{1,2})(?::(\d{1,2}))?)?$"), False),
)


def parse_time(value, date1904=False):
    """把评论时间读成「YYYY-MM-DD HH:MM」。认得 Excel 日期数字、10 位或 13 位时间戳、常见日期写法。
    读不出返回 None；只有月日没有年的，原样保留文字。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return _from_number(float(value), date1904)
    text = str(value).strip()
    if not text:
        return None
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        return _from_number(float(text), date1904)
    iso = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(iso)
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone().replace(tzinfo=None)
        return parsed.strftime("%Y-%m-%d %H:%M")
    except ValueError:
        pass
    for pattern, has_year in _DATE_PATTERNS:
        m = pattern.match(text)
        if not m:
            continue
        if has_year:
            y, mo, d, h, mi, _s = m.groups()
            try:
                return datetime(int(y), int(mo), int(d), int(h or 0), int(mi or 0)).strftime("%Y-%m-%d %H:%M")
            except ValueError:
                return text
        return text
    return text


def _from_number(number, date1904):
    if not math.isfinite(number) or number <= 0:
        return None
    if 20000 <= number <= 80000:  # Excel 日期数字：1954 年到 2119 年之间
        return excel_serial_to_datetime(number, date1904).strftime("%Y-%m-%d %H:%M")
    if number > 1e11:  # 13 位：毫秒时间戳
        number /= 1000.0
    if 1e9 <= number < 1e11:  # 10 位：秒时间戳
        return datetime.fromtimestamp(number).strftime("%Y-%m-%d %H:%M")
    return None


def unix_to_text(value):
    """秒或毫秒时间戳 → 「YYYY-MM-DD HH:MM」（本机时区）。"""
    n = parse_count(value)
    if not n:
        return None
    if n > 1e11:
        n = n / 1000.0
    try:
        return datetime.fromtimestamp(n).strftime("%Y-%m-%d %H:%M")
    except (OverflowError, OSError, ValueError):
        return None


def text_to_datetime(text):
    """「YYYY-MM-DD HH:MM」→ datetime；别的写法返回 None。"""
    if not text:
        return None
    try:
        return datetime.strptime(str(text)[:16], "%Y-%m-%d %H:%M")
    except ValueError:
        try:
            return datetime.strptime(str(text)[:10], "%Y-%m-%d")
        except ValueError:
            return None


def now_iso():
    """本机时间，带时区，精确到秒，比如 2026-10-03T15:04:05+08:00。"""
    return datetime.now(timezone.utc).astimezone().replace(microsecond=0).isoformat()


def today():
    return datetime.now().strftime("%Y-%m-%d")


_BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]+')


def safe_name(text, limit=40, fallback="未命名"):
    """能放进文件夹名的文字：去掉 / \\ : * ? " < > | 和控制字符，空白并成一个空格，不以点开头，最多 limit 个字。"""
    name = _BAD_NAME.sub(" ", str(text or ""))
    name = re.sub(r"\s+", " ", name).strip().lstrip(".").strip()
    if len(name) > limit:
        name = name[:limit].rstrip()
    return name or fallback


def unique_dir(parent, name):
    """parent 里还没有的文件夹名：name、name-2、name-3……（只算名字，不建）。"""
    candidate, n = name, 2
    while os.path.exists(os.path.join(parent, candidate)):
        candidate = "%s-%d" % (name, n)
        n += 1
    return os.path.join(parent, candidate)


def _umask_mode():
    mask = os.umask(0)
    os.umask(mask)
    return 0o666 & ~mask


def write_json(path, value):
    """先写临时文件再换名，写一半断电也不会留下坏文件。权限和普通新建的文件一样（临时文件默认只有自己能读）。"""
    folder = os.path.dirname(path) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=folder)
    os.chmod(tmp, _umask_mode())
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def write_text(path, text):
    folder = os.path.dirname(path) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=folder)
    os.chmod(tmp, _umask_mode())
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def read_json(path):
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def money(value):
    """美元金额给人看：0.011 → 0.011 美元；去掉多余的 0。"""
    d = Decimal(str(value))
    if d == 0:
        return "0 美元"
    text = format(d.quantize(Decimal("0.0001")).normalize(), "f")
    return "%s 美元" % text


def short(text, limit=40):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"
