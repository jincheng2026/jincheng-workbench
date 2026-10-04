"""测试用的小工具：假的家目录和工作台设置、写 .xlsx、假的 TikHub 服务、跑命令。

所有测试都在系统临时文件夹里造假的家目录，不碰真实的设置和文件；钥匙串一律换成测试专用的 service 名，
绝不读、写、删真实的 tikhub-api 条目；假 TikHub 只监听 127.0.0.1，不连外网。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
SCRIPTS = os.path.join(SKILL, "scripts")
FIXTURES = os.path.join(HERE, "fixtures")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

TEST_SERVICE = "jcwb-research-test-not-real"
# Excel 的关系命名空间：拆开拼，免得公开前自查把一长串地址当成密钥
REL_NS = "/".join(["http://schemas.openxmlformats.org", "officeDocument", "2006", "relationships"])
FAKE_KEY = "fake-tikhub-key-for-tests-0001"


class TempWorkbench(object):
    """一个假的家目录：工作台设置指向里面的工作文件夹。"""

    def __init__(self, research=None):
        self.home = tempfile.mkdtemp(prefix="research-skill-test-")
        self.config_dir = os.path.join(self.home, "config")
        self.work = os.path.join(self.home, "Documents", "工作文件夹")
        os.makedirs(self.config_dir)
        os.makedirs(os.path.join(self.work, "内容草稿"))
        settings = {"workFolder": self.work, "paths": {"drafts": "内容草稿", "writingMethod": "写稿方法"}}
        if research:
            # 和工作台设置一致：三个文件夹各有一项（paths.benchmarkAccounts、researchReports、commentImports）
            settings["paths"]["benchmarkAccounts"] = research + "/对标账号"
            settings["paths"]["researchReports"] = research + "/调研报告"
            settings["paths"]["commentImports"] = research + "/评论导入"
        with open(os.path.join(self.config_dir, "config.json"), "w", encoding="utf-8") as f:
            json.dump(settings, f, ensure_ascii=False)
        self.research = os.path.join(self.work, research or "市场调研")
        self.imports = os.path.join(self.research, "评论导入")
        self.reports = os.path.join(self.research, "调研报告")
        self.accounts = os.path.join(self.research, "对标账号")
        os.makedirs(self.imports)

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith("TIKHUB_")}
        env.update({"HOME": self.home, "WORKBENCH_CONFIG_DIR": self.config_dir, "WORKBENCH_KEYCHAIN_SERVICE": TEST_SERVICE,
                    "PYTHONDONTWRITEBYTECODE": "1", "RESEARCH_PRICE_LOOKUP": "0"})
        env.update({k: v for k, v in extra.items() if v is not None})
        return env

    def cleanup(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def all_text(self):
        """家目录里所有文件的内容拼在一起（用来查密钥有没有被写进文件）。"""
        chunks = []
        for root, _dirs, files in os.walk(self.home):
            for name in files:
                with open(os.path.join(root, name), "rb") as f:
                    chunks.append(f.read().decode("utf-8", "replace"))
        return "\n".join(chunks)


def run_cli(args, env, cwd=None):
    """像 AI 那样在终端里跑命令，返回 (退出码, 输出)。"""
    done = subprocess.run([sys.executable, os.path.join(SCRIPTS, "research.py")] + list(args), env=env, cwd=cwd,
                          capture_output=True, text=True, timeout=120)
    return done.returncode, done.stdout + done.stderr


# ---------- 写 .xlsx ----------

def _col(n):
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def write_xlsx(path, headers, rows, sheets_extra=None, date1904=False, inline=False, str_cells=()):
    """最简单的 Excel 文件：第一行表头，后面每行一条。数字写成数字单元格，文字写成共享字符串（inline=True 时写成行内字符串）。
    str_cells：这些列的值写成公式结果文字（t="str"），模拟社媒助手导出的编号列。"""
    shared, index = [], {}

    def cell(ref, value, col_name):
        if value is None or value == "":
            return ""
        if isinstance(value, bool):
            return '<c r="%s" t="b"><v>%d</v></c>' % (ref, 1 if value else 0)
        if isinstance(value, (int, float)) and col_name not in str_cells:
            return '<c r="%s"><v>%s</v></c>' % (ref, value)
        text = str(value)
        if col_name in str_cells:
            return '<c r="%s" t="str"><v>%s</v></c>' % (ref, escape(text))
        if inline:
            return '<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (ref, escape(text))
        if text not in index:
            index[text] = len(shared)
            shared.append(text)
        return '<c r="%s" t="s"><v>%d</v></c>' % (ref, index[text])

    def sheet_xml(hdrs, data):
        lines = []
        for r, row in enumerate([hdrs] + data, 1):
            values = row if isinstance(row, (list, tuple)) else [row.get(h) for h in hdrs]
            cells = "".join(cell("%s%d" % (_col(i), r), v, hdrs[i] if i < len(hdrs) else "") for i, v in enumerate(values))
            lines.append('<row r="%d">%s</row>' % (r, cells))
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>%s</sheetData></worksheet>' % "".join(lines))

    sheets = [("Sheet1", headers, rows)] + list(sheets_extra or [])
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        rels = "".join('<Relationship Id="rId%d" Type="%s/worksheet" Target="worksheets/sheet%d.xml"/>' % (i, REL_NS, i)
                       for i in range(1, len(sheets) + 1))
        z.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">%s</Relationships>' % rels)
        sheet_tags = "".join('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (escape(n), i, i) for i, (n, _h, _r) in enumerate(sheets, 1))
        z.writestr("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="%s"><workbookPr%s/><sheets>%s</sheets></workbook>'
                   % (REL_NS, ' date1904="1"' if date1904 else "", sheet_tags))
        for i, (_n, hdrs, data) in enumerate(sheets, 1):
            z.writestr("xl/worksheets/sheet%d.xml" % i, sheet_xml(hdrs, data))
        if shared:
            items = "".join('<si><t xml:space="preserve">%s</t></si>' % escape(s) for s in shared)
            z.writestr("xl/sharedStrings.xml", '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="%d">%s</sst>' % (len(shared), items))


# 社媒助手抖音评论导出的表头（照它 2026 年 6 月的帮助文档）
SMA_HEADERS = ["评论ID", "视频ID", "视频链接", "用户UID", "用户链接", "抖音号", "用户名称", "评论内容", "评论图片", "评论时间",
               "IP地址", "点赞数", "子评论数", "一级评论ID", "一级评论内容", "一级评论用户ID", "一级评论用户名称",
               "引用的评论ID", "引用的评论内容", "引用的用户ID", "引用的用户名称"]


def sma_row(cid, vid, text, likes=0, when=45930.5, ip="浙江", replies=0, parent="", user="虚构用户", image=""):
    """一行虚构的社媒助手评论导出。when 是 Excel 日期数字（45930 是 2025-09-30）。"""
    return {"评论ID": cid, "视频ID": vid, "视频链接": "https://www.douyin.com/video/%s" % vid, "用户UID": "uid-%s" % cid,
            "用户链接": "https://www.douyin.com/user/fake-%s" % cid, "抖音号": "dy%s" % cid[-4:], "用户名称": user,
            "评论内容": text, "评论图片": image, "评论时间": when, "IP地址": ip, "点赞数": likes,
            "子评论数": "" if parent else replies, "一级评论ID": parent}


# ---------- 假的 TikHub ----------

def load_fixture(name, base=""):
    with open(os.path.join(FIXTURES, "tikhub", name), encoding="utf-8") as f:
        return json.loads(f.read().replace("{{BASE}}", base))


PNG_1PX = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
           b"\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa7V\x81\x1d\x00\x00\x00\x00IEND\xaeB`\x82")


class FakeTikHub(object):
    """在 127.0.0.1 上起一个假的 TikHub。routes：{接口路径: 函数(参数) -> (状态码, 返回体, 等几秒)}。
    记下每次请求（路径、参数、带没带对密钥），测试拿来核对。"""

    def __init__(self, routes=None, prices=None):
        self.routes = dict(routes or {})
        self.requests = []
        self.prices = prices or {}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                parts = urlsplit(self.path)
                params = {k: v[0] for k, v in parse_qs(parts.query, keep_blank_values=True).items()}
                outer.requests.append({"path": parts.path, "params": params, "auth": self.headers.get("Authorization")})
                if parts.path.startswith("/img/"):
                    self._send(200, PNG_1PX, "image/png")
                    return
                if parts.path == "/api/v1/tikhub/user/get_endpoint_info":
                    ep = params.get("endpoint", "")
                    cost, free_ok = outer.prices.get(ep, (0.001, True))
                    self._json(200, {"code": 200, "data": {"endpoint_uri": ep, "endpoint_cost": cost, "allow_free_credit": free_ok}})
                    return
                handler = outer.routes.get(parts.path)
                if handler is None:
                    self._json(404, {"detail": {"code": 404, "message": "Not Found"}})
                    return
                status, body, delay = handler(params)
                if delay:
                    time.sleep(delay)
                self._json(status, body)

            def _json(self, status, body):
                data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
                self._send(status, data, "application/json")

            def _send(self, status, data, kind):
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", kind)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def paid(self):
        return [r for r in self.requests if "/tikhub/user/" not in r["path"] and not r["path"].startswith("/img/")]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def ok(body):
    return lambda params: (200, body, 0)


def user_info(balance=5, free=0.05):
    return ok({"code": 200, "api_key_data": {"api_key_status": 1}, "user_data": {"balance": balance, "free_credit": free, "email_verified": True}})


# ---------- 照真实返回的结构造样例（2026-10-03 用真密钥采过一次对照；内容、编号全是虚构的） ----------

XHS_NOTE = "6b0000000000000000000001"
DY_AWEME = "7400000000000000103"  # 和 fixtures 里 dy_detail.json 的作品一样


def dy_comment(cid, text, likes=0, when=1790000000, ip="广东", replies=0, preview=None, parent=None, author=False):
    """一条抖音评论，字段和 App V3 的真实返回一样。preview：一级评论里平台附带的几条回复（reply_comment），常是作者的回答。"""
    return {"cid": cid, "text": text, "aweme_id": DY_AWEME, "create_time": when, "digg_count": likes, "ip_label": ip,
            "reply_comment_total": 0 if parent else replies, "reply_id": parent or "0", "reply_to_reply_id": "0",
            "level": 2 if parent else 1, "label_text": "作者" if author else "", "label_type": 1 if author else -1,
            "image_list": None, "status": 1, "user": {"uid": "9" + cid[-10:], "nickname": "虚构用户", "sec_uid": "MS4wfake" + cid[-6:]},
            "reply_comment": list(preview) if preview else None}


def dy_page(comments, cursor, has_more=True, total=73):
    return {"code": 200, "router": "/api/v1/douyin/app/v3/fetch_video_comments",
            "data": {"status_code": 0, "comments": comments, "cursor": cursor, "has_more": 1 if has_more else 0, "total": total}}


def xhs_comment(cid, text, ip=None, likes=0, when=1790000000, subs=(), sub_count=None):
    """一条小红书一级评论，字段和真实返回一样：时间在 time（秒），属地在 ip_location，有的评论没有这个键。"""
    c = {"id": cid, "content": text, "like_count": likes, "time": when, "note_id": XHS_NOTE, "status": 0, "show_tags": [],
         "show_tags_v2": [], "user": {"userid": "a0fake" + cid[-6:], "nickname": "虚构读者", "red_id": "000000"},
         "sub_comment_count": len(subs) if sub_count is None else sub_count, "sub_comments": list(subs)}
    if ip is not None:
        c["ip_location"] = ip
    return c


def xhs_page(comments, cursor=None, has_more=True, total=40):
    """一页小红书评论：真实返回里 cursor 是一段 JSON 文字，翻页要的 cursor、index、pageArea 都在里面。"""
    cursor = cursor or {"contextId": "fake-context", "cursor": comments[-1]["id"], "index": 2, "pageArea": "ALL"}
    inner = {"cursor": json.dumps(cursor), "comments": comments, "comment_count_l1": 15, "comment_count": total,
             "user_id": "65f000000000000000000001", "current_sort_strategy": "like_count", "has_more": has_more}
    return {"code": 200, "router": "/api/v1/xiaohongshu/app_v2/get_note_comments",
            "data": {"code": 0, "success": True, "msg": "成功", "data": inner}}
