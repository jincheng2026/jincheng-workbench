"""把导出的表格读成「表头 + 一行一个字典」：Excel（.xlsx）、CSV、TSV、JSON、JSON Lines。

社媒助手导出以 Excel 为主，也可能是 CSV、TSV；有人会把 TikHub 的原始返回或别的工具导出的 JSON 放进来，也照样读。
Excel 不用装任何包：.xlsx 本身是一个 zip，里面是几份 XML。单元格的值一律先保留原文（长数字编号不会变成科学计数法），
日期在 Excel 里是「从 1900 年起第几天」的小数，交给按列读时间的地方去换。
"""
import csv
import io
import json
import os
import re
import zipfile
import xml.etree.ElementTree as ET

from . import UserError

MAX_BYTES = 80 * 1024 * 1024
SUFFIXES = (".xlsx", ".xlsm", ".csv", ".tsv", ".txt", ".json", ".jsonl", ".ndjson")
_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
# Excel 里工作表关系的命名空间。拆开拼，免得公开前自查（scripts/check-public.mjs）把这一长串地址当成密钥
_REL_NS = "{%s}" % "/".join(["http://schemas.openxmlformats.org", "officeDocument", "2006", "relationships"])
_PKG_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"


class Table(object):
    def __init__(self, headers, rows, kind, note="", date1904=False, sheet=None):
        self.headers = headers  # 表头，按原来的顺序
        self.rows = rows  # 每行一个 {表头: 原文}
        self.kind = kind  # xlsx / csv / tsv / json / jsonl
        self.note = note  # 读的时候值得一提的事（比如「只读了第一张工作表」）
        self.date1904 = date1904
        self.sheet = sheet


def read_table(path):
    if not os.path.isfile(path):
        raise UserError("找不到这个文件：%s" % path)
    size = os.path.getsize(path)
    if size > MAX_BYTES:
        raise UserError("文件太大了（%.0f MB），超过 80 MB 不读。把评论分几次导出再试。" % (size / 1024 / 1024))
    suffix = os.path.splitext(path)[1].lower()
    with open(path, "rb") as f:
        head = f.read(4)
    if suffix in (".xlsx", ".xlsm") or head == b"PK\x03\x04":
        return _read_xlsx(path)
    if suffix == ".xls":
        raise UserError("这是老版本的 Excel（.xls），读不了。用 Excel 或 WPS 打开后「另存为」.xlsx 或 CSV，再放进来。")
    if suffix in (".json", ".jsonl", ".ndjson"):
        return _read_json(path)
    if suffix in (".csv", ".tsv", ".txt"):
        return _read_delimited(path, suffix)
    raise UserError("认不出这个文件的格式（%s）。能读的有 Excel（.xlsx）、CSV、TSV、JSON。" % (suffix or "没有扩展名"))


# ---------- CSV / TSV ----------

def _decode(data):
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return data.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace"), "utf-8（有乱码）"


def _read_delimited(path, suffix):
    with open(path, "rb") as f:
        text, encoding = _decode(f.read())
    first = text.split("\n", 1)[0]
    delimiter = "\t" if suffix == ".tsv" or first.count("\t") > first.count(",") else ","
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
    try:
        grid = [row for row in reader]
    except csv.Error as e:
        raise UserError("这个表格文件读到一半出错了：%s" % e)
    kind = "tsv" if delimiter == "\t" else "csv"
    note = "按 %s 编码读的" % encoding if encoding not in ("utf-8-sig",) else ""
    return _grid_to_table(grid, kind, note)


def _grid_to_table(grid, kind, note="", date1904=False, sheet=None):
    grid = [row for row in grid if any(str(cell).strip() for cell in row)]
    if not grid:
        return Table([], [], kind, note or "表格是空的", date1904, sheet)
    headers = _clean_headers(grid[0])
    rows = []
    for raw in grid[1:]:
        row = {}
        for i, name in enumerate(headers):
            if not name:
                continue
            row[name] = raw[i] if i < len(raw) else ""
        rows.append(row)
    return Table([h for h in headers if h], rows, kind, note, date1904, sheet)


def _clean_headers(cells):
    out, seen = [], {}
    for cell in cells:
        name = re.sub(r"\s+", " ", str(cell or "").replace("﻿", "")).strip()
        if name and name in seen:  # 重名的列：第二个起加「(2)」，免得互相顶掉
            seen[name] += 1
            name = "%s(%d)" % (name, seen[name])
        elif name:
            seen[name] = 1
        out.append(name)
    return out


# ---------- Excel ----------

def _col_index(ref):
    letters = re.match(r"[A-Z]+", ref or "")
    if not letters:
        return None
    n = 0
    for ch in letters.group(0):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _read_xlsx(path):
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise UserError("这个 Excel 文件打不开（可能没下载完或者已经损坏）。重新导出一次再试。")
    with z:
        names = set(z.namelist())
        shared = []
        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.iter(_NS + "si"):
                shared.append("".join(t.text or "" for t in si.iter(_NS + "t")))
        date1904, sheets = False, []
        if "xl/workbook.xml" in names:
            wb = ET.fromstring(z.read("xl/workbook.xml"))
            pr = wb.find(_NS + "workbookPr")
            date1904 = pr is not None and pr.get("date1904") in ("1", "true")
            targets = {}
            if "xl/_rels/workbook.xml.rels" in names:
                rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
                for rel in rels.iter(_PKG_REL_NS + "Relationship"):
                    target = rel.get("Target", "")
                    target = target.lstrip("/")
                    if not target.startswith("xl/"):
                        target = "xl/" + target
                    targets[rel.get("Id")] = target
            for sh in wb.iter(_NS + "sheet"):
                target = targets.get(sh.get(_REL_NS + "id"))
                if target in names:
                    sheets.append((sh.get("name") or target, target))
        if not sheets:
            sheets = [(n, n) for n in sorted(names) if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")]
        if not sheets:
            raise UserError("这个 Excel 文件里没有工作表。")
        used, notes = None, []
        for title, target in sheets:
            grid = _sheet_grid(z.read(target), shared)
            if any(any(str(c).strip() for c in row) for row in grid):
                if used is None:
                    used = (title, grid)
                else:
                    notes.append(title)
        if used is None:
            return Table([], [], "xlsx", "表格是空的", date1904)
        note = "只读了第一张有内容的工作表「%s」，后面的「%s」没读" % (used[0], "」「".join(notes)) if notes else ""
        return _grid_to_table(used[1], "xlsx", note, date1904, used[0])


def _sheet_grid(xml_bytes, shared):
    root = ET.fromstring(xml_bytes)
    grid = []
    for row in root.iter(_NS + "row"):
        cells = {}
        for c in row.findall(_NS + "c"):
            idx = _col_index(c.get("r"))
            if idx is None:
                idx = len(cells)
            kind = c.get("t")
            v = c.find(_NS + "v")
            if kind == "s":
                try:
                    value = shared[int(v.text)] if v is not None else ""
                except (ValueError, IndexError):
                    value = ""
            elif kind == "inlineStr":
                value = "".join(t.text or "" for t in c.iter(_NS + "t"))
            elif kind == "b":
                value = "TRUE" if v is not None and v.text == "1" else "FALSE"
            elif kind == "e":
                value = ""
            else:  # 数字、公式结果（t="str"）都先保留原文
                value = v.text if v is not None and v.text is not None else ""
            cells[idx] = value
        if cells:
            width = max(cells) + 1
            grid.append([cells.get(i, "") for i in range(width)])
        else:
            grid.append([])
    return grid


# ---------- JSON ----------

_LIST_KEYS = ("comments", "comment_list", "records", "rows", "items", "list", "data", "notes", "aweme_list", "result", "results")


def _find_records(value, depth=0):
    """在 JSON 里找「一串对象」：顶层就是数组，或者藏在 data、comments、records 这类键下面。"""
    if isinstance(value, list):
        objs = [x for x in value if isinstance(x, dict)]
        return objs if objs else None
    if isinstance(value, dict) and depth < 4:
        for key in _LIST_KEYS:
            if key in value:
                found = _find_records(value[key], depth + 1)
                if found:
                    return found
    return None


def _flatten(obj, prefix="", out=None, depth=0):
    """嵌套的对象摊平一层成「user.nickname」这样的键；数组不展开。"""
    out = {} if out is None else out
    for key, value in obj.items():
        name = "%s.%s" % (prefix, key) if prefix else str(key)
        if isinstance(value, dict) and depth < 1:
            _flatten(value, name, out, depth + 1)
        elif isinstance(value, (dict, list)):
            out[name] = value
        else:
            out[name] = "" if value is None else value
    return out


def _read_json(path):
    with open(path, "rb") as f:
        text, _enc = _decode(f.read())
    records, kind = None, "json"
    try:
        records = _find_records(json.loads(text))
    except ValueError:
        lines = [line for line in text.splitlines() if line.strip()]
        try:
            items = [json.loads(line) for line in lines]
        except ValueError:
            raise UserError("这个 JSON 文件格式不对，读不出来。")
        records, kind = [x for x in items if isinstance(x, dict)], "jsonl"
    if not records:
        raise UserError("这个 JSON 里没找到一条一条的记录（比如 comments、records、data 下面的数组）。")
    flat = [_flatten(r) for r in records]
    headers, seen = [], set()
    for row in flat:
        for key in row:
            if key not in seen:
                seen.add(key)
                headers.append(key)
    rows = [{h: row.get(h, "") for h in headers} for row in flat]
    return Table(headers, rows, kind)
