"""封面候选/生成记录.md：哪一批用了什么、每张变了什么、自检结果；「## 记录」里一行一件事。格式是和工作台约定好的：

    # T002 封面生成记录

    ## 第 1 批

    对标：抖音-某某（暖黄手写风）；照片：我的照片/正脸.jpg；日期：2026-10-05；软件：Codex；生图：image_gen

    | 编号 | 本张变化 | 自检 | 文件名 |
    | --- | --- | --- | --- |
    | 01 | K03 讲台：人在右后，前景放大的手机 | 通过 | 封面-01.png |

    生成 1 次，报错 0 次，实际像素 1024×1536

    ## 记录

    - 2026-10-05 21:10 按备注改 封面-03 → 封面-12

- 批次小节标题固定「## 第 N 批」；只有一张表、没写小节标题时算第 1 批。小节里第一行是这批的对标、照片、日期、软件、生图方式。
- 「## 记录」由工作台（选定、删除、收藏……）和 AI（按备注改）往后追加；小节的先后不固定，读的时候按标题认。
- 批次小节只由 AI 写，而且只用这里的命令写：AI 不手改表格。
"""
import os
import re

from . import UserError
from .text import one_line, update_text

FILE = "生成记录.md"
HEAD = "| 编号 | 本张变化 | 自检 | 文件名 |"
SEP = "| --- | --- | --- | --- |"
BATCH_RE = re.compile(r"^##\s*第\s*(\d+)\s*批\s*$")
LOG_RE = re.compile(r"^##\s*记录\s*$")
H2_RE = re.compile(r"^##(?!#)")
ROW_RE = re.compile(r"^\|\s*(\d{2,})\s*\|")
SUMMARY_RE = re.compile(r"^生成\s*\d+\s*次")
MAX_CHECK = 30  # 自检一句话、30 字以内（工作台卡片上看的就是它）


def is_table_head(line):
    s = line.strip()
    return s.startswith("|") and "编号" in s and "文件名" in s


def _strip_blank(lines):
    lines = list(lines)
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


class Section(object):
    def __init__(self, head, body):
        self.head = head
        self.body = body

    @property
    def batch(self):
        m = BATCH_RE.match(self.head.strip())
        return int(m.group(1)) if m else None


class Doc(object):
    """生成记录.md 拆成：开头（标题那几行）和一个个「## 」小节。只动要改的那一小节，别的原样。"""

    def __init__(self, text, cid):
        self.cid = cid
        lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        self.prelude, self.sections = [], []
        current = None
        for line in lines:
            if H2_RE.match(line):
                current = Section(line.strip(), [])
                self.sections.append(current)
            elif current is None:
                self.prelude.append(line)
            else:
                current.body.append(line)
        self.prelude = _strip_blank(self.prelude)

    # ---- 读 ----

    def batch_sections(self):
        return [s for s in self.sections if s.batch is not None]

    def legacy(self):
        """只有一张表、没写小节标题：算第 1 批（表在开头那几行里）。"""
        return not self.batch_sections() and any(is_table_head(l) for l in self.prelude)

    def batches(self):
        """[(第几批, 这批登记了几行)]"""
        if self.legacy():
            return [(1, len([l for l in self.prelude if ROW_RE.match(l.strip())]))]
        return [(s.batch, len(self.rows_of(s.body))) for s in self.batch_sections()]

    @staticmethod
    def rows_of(lines):
        return [l for l in lines if ROW_RE.match(l.strip())]

    def all_rows(self):
        """所有登记过的行：[(第几批, 编号, 本张变化, 自检, 文件名)]"""
        out = []
        groups = [(1, self.prelude)] if self.legacy() else [(s.batch, s.body) for s in self.batch_sections()]
        for n, lines in groups:
            for line in self.rows_of(lines):
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                cells += [""] * (4 - len(cells))
                out.append((n, cells[0], cells[1], cells[2], cells[3]))
        return out

    def find_batch(self, n):
        for s in self.batch_sections():
            if s.batch == n:
                return s
        return None

    def latest(self):
        sections = self.batch_sections()
        return max(sections, key=lambda s: s.batch) if sections else None

    # ---- 改 ----

    def ensure_title(self):
        if not any(l.startswith("# ") for l in self.prelude):
            self.prelude.insert(0, "# %s 封面生成记录" % self.cid)

    def convert_legacy(self):
        """没写小节标题的那张表补上「## 第 1 批」（约定：只有一张表时算第 1 批）。"""
        if not self.legacy():
            return
        title_at = next((i for i, l in enumerate(self.prelude) if l.startswith("# ")), None)
        keep = self.prelude[: title_at + 1] if title_at is not None else []
        rest = self.prelude[title_at + 1:] if title_at is not None else self.prelude
        self.prelude = keep
        self.sections.insert(0, Section("## 第 1 批", _strip_blank(rest)))
        self.ensure_title()

    def open_batch(self, info):
        """开一批：最新一批一行都还没登记，就接着用它（换成这次的第一行）；不然新开「## 第 N+1 批」。返回 (N, 是不是接着用的)。"""
        self.ensure_title()
        self.convert_legacy()
        last = self.latest()
        if last is not None and not self.rows_of(last.body):
            body = _strip_blank(last.body)
            at = next((i for i, l in enumerate(body) if l.strip() and not l.strip().startswith("|")), None)
            if at is None:
                body.insert(0, info)
            else:
                body[at] = info
            if not any(is_table_head(l) for l in body):
                body += ["", HEAD, SEP]
            last.body = body
            return last.batch, True
        n = (last.batch if last else 0) + 1
        section = Section("## 第 %d 批" % n, [info, "", HEAD, SEP])
        batches = self.batch_sections()
        if batches:
            at = self.sections.index(batches[-1]) + 1
        else:
            log = next((i for i, s in enumerate(self.sections) if LOG_RE.match(s.head)), None)
            at = log if log is not None else len(self.sections)
        self.sections.insert(at, section)
        return n, False

    def add_row(self, n, cells, info_if_new=None):
        """在第 n 批的表里加一行（n 是 None 时加在最新一批）。这批还没有小节：按约定建「## 第 N 批」和表头。"""
        self.ensure_title()
        self.convert_legacy()
        if n is None:
            last = self.latest()
            n = last.batch if last else 1
        section = self.find_batch(n)
        if section is None:
            last = self.latest()
            want = (last.batch if last else 0) + 1
            if n != want:
                raise UserError("生成记录里还没有第 %d 批（现在最新的是第 %d 批）：不写 --batch 就登记进最新一批；要新开一批先 record batch。" % (n, want - 1))
            n, _reused = self.open_batch(info_if_new() if callable(info_if_new) else info_if_new)  # 最新一批是空的就接着用它
            section = self.find_batch(n)
        body = _strip_blank(section.body)
        head_at = next((i for i, l in enumerate(body) if is_table_head(l)), None)
        if head_at is None:
            first = next((i for i, l in enumerate(body) if l.strip()), None)
            at = (first + 1) if first is not None else 0
            body[at:at] = ([""] if at else []) + [HEAD, SEP]
            head_at = at + (1 if at else 0)
        end = head_at + 1
        while end + 1 < len(body) and body[end + 1].strip().startswith("|"):
            end += 1
        body.insert(end + 1, "| " + " | ".join(cells) + " |")
        section.body = body
        return n

    def set_summary(self, n, text):
        section = self.find_batch(n)
        if section is None:
            raise UserError("生成记录里没有第 %d 批。" % n)
        body = _strip_blank(section.body)
        for i, line in enumerate(body):
            if SUMMARY_RE.match(line.strip()):
                body[i] = text
                section.body = body
                return
        head_at = next((i for i, l in enumerate(body) if is_table_head(l)), None)
        if head_at is None:
            body += ["", text]
        else:
            end = head_at + 1
            while end + 1 < len(body) and body[end + 1].strip().startswith("|"):
                end += 1
            body[end + 1:end + 1] = ["", text]
        section.body = _strip_blank(body)

    def add_log(self, line):
        self.ensure_title()
        section = next((s for s in self.sections if LOG_RE.match(s.head)), None)
        if section is None:
            section = Section("## 记录", [])
            self.sections.append(section)
        body = _strip_blank(section.body)
        body.append("- " + line)
        section.body = body

    def text(self):
        out = list(self.prelude)
        for section in self.sections:
            if out:
                out.append("")
            out.append(section.head)
            body = _strip_blank(section.body)
            if body:
                out.append("")
                out.extend(body)
        return "\n".join(out).rstrip("\n") + "\n"


def path(candidates_dir):
    return os.path.join(candidates_dir, FILE)


def load(candidates_dir, cid):
    try:
        with open(path(candidates_dir), encoding="utf-8-sig") as f:
            text = f.read()
    except FileNotFoundError:
        text = ""
    return Doc(text, cid)


def edit(candidates_dir, cid, change):
    """读、改、写回生成记录.md（写之前被工作台改过就重来）。change(doc) 改 doc，返回值原样带回来。"""
    result = {}

    def apply(old):
        doc = Doc(old, cid)
        result["value"] = change(doc)
        return doc.text()

    os.makedirs(candidates_dir, exist_ok=True)
    update_text(path(candidates_dir), apply)
    return result.get("value")


def info_line(benchmark, style, photo, date, app, tool):
    head = "对标：%s（%s）" % (benchmark, style) if style else "对标：%s" % benchmark
    return "%s；照片：%s；日期：%s；软件：%s；生图：%s" % (head, photo, date, app, tool)


def row_cells(no, change, check, file):
    return [no, one_line(change), one_line(check), one_line(file)]
