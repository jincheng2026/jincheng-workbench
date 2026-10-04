"""TikHub 小客户端：读密钥、查单价、花钱前估算和卡上限、记用量、把出错说成人话。只用 Python 自带的模块。

- 密钥：先读环境变量 TIKHUB_API_KEY，没有再读 macOS 钥匙串（service「tikhub-api」、account「tikhub」，
  工作台「市场调研」页的「数据来源」就存在这里）。密钥只放在这个进程的内存里，不打印、不写进任何文件、日志和报告。
- 地址只用 https://api.tikhub.io（官方现在要求用这个，不用 api.tikhub.dev）。测试时可以用环境变量 TIKHUB_BASE_URL
  指到本机的假服务（只认 http://127.0.0.1 和 http://localhost）。
- 单价：每次用 TikHub 公开的单价查询接口 get_endpoint_info 现查（不用密钥、不扣费）；查不到用下面记的兜底单价。
- 上限：单次最多自动花 0.02 美元、当天累计最多自动花 0.20 美元；超过、评论要超过 200 条、或者用小红书接口，
  先停下来问用户，用户在对话里明确同意后带上 --agreed-budget 再跑。报错的请求 TikHub 不扣钱，用量里记 0。
"""
import hashlib
import http.client
import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from decimal import Decimal, ROUND_UP

from . import NeedsAgreement, UserError
from .text import money, now_iso

API_BASE = "https://api.tikhub.io"
KEYCHAIN_SERVICE = "tikhub-api"
KEYCHAIN_ACCOUNT = "tikhub"
ENV_KEY = "TIKHUB_API_KEY"
SITE_KEYS = "https://user.tikhub.io/dashboard/api"
SITE_CREDIT = "https://user.tikhub.io/dashboard/add-credit"

AUTO_LIMIT = Decimal("0.02")  # 单次自动上限：够抖音 200 条一级评论（11 次请求）再加拉一次博主作品
DAILY_LIMIT = Decimal("0.20")  # 当天累计自动上限
COMMENTS_DEFAULT_MAX = 200

# 兜底单价（美元/次）：北京时间 2026-10-03 用 get_endpoint_info 查的官方单价；no_free 表示不能用新账号送的试用额度
PRICE_CHECKED = "2026-10-03"
FALLBACK_PRICES = {
    "/api/v1/tikhub/user/get_user_info": (Decimal("0"), False),
    "/api/v1/douyin/web/get_sec_user_id": (Decimal("0.001"), False),
    "/api/v1/douyin/web/get_aweme_id": (Decimal("0.001"), False),
    "/api/v1/douyin/app/v3/handler_user_profile": (Decimal("0.001"), False),
    "/api/v1/douyin/app/v3/fetch_user_post_videos": (Decimal("0.001"), True),
    "/api/v1/douyin/app/v3/fetch_one_video": (Decimal("0.001"), False),
    "/api/v1/douyin/app/v3/fetch_one_video_by_share_url": (Decimal("0.001"), False),
    "/api/v1/douyin/app/v3/fetch_video_comments": (Decimal("0.001"), False),
    "/api/v1/douyin/app/v3/fetch_video_comment_replies": (Decimal("0.001"), False),
    "/api/v1/xiaohongshu/app_v2/get_user_info": (Decimal("0.01"), True),
    "/api/v1/xiaohongshu/app_v2/get_user_posted_notes": (Decimal("0.01"), True),
    "/api/v1/xiaohongshu/app_v2/get_image_note_detail": (Decimal("0.01"), True),
    "/api/v1/xiaohongshu/app_v2/get_note_comments": (Decimal("0.01"), True),
    "/api/v1/xiaohongshu/app_v2/get_note_sub_comments": (Decimal("0.01"), True),
}
FREE_PATHS = ("/api/v1/tikhub/user/get_endpoint_info", "/api/v1/tikhub/user/get_user_info")


def no_key_message():
    return ("还没读到 TikHub 的密钥。请去工作台「市场调研」页顶部的「数据来源」里把 TikHub 配好（填进去会自动检测），"
            "配好后跟我说一声再继续。不想用 TikHub 也行：评论可以用社媒助手导出，博主资料可以直接告诉我或者发截图。")


# ---------- 密钥 ----------

def keychain_service(env=None):
    """钥匙串里的 service 名。测试用环境变量 WORKBENCH_KEYCHAIN_SERVICE 换成测试专用的名字，不碰真实条目。"""
    env = os.environ if env is None else env
    return (env.get("WORKBENCH_KEYCHAIN_SERVICE") or "").strip() or KEYCHAIN_SERVICE


def keychain_command(service):
    return ["/usr/bin/security", "find-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT, "-w"]


def read_key(env=None, run=None):
    """返回 (密钥, 从哪读到的)；都没有返回 (None, None)。密钥不打印、不落盘。"""
    env = os.environ if env is None else env
    value = (env.get(ENV_KEY) or "").strip()
    if value:
        return _clean_key(value), "环境变量 %s" % ENV_KEY
    run = run or subprocess.run
    command = keychain_command(keychain_service(env))
    if not os.path.exists(command[0]) and run is subprocess.run:
        return None, None
    try:
        done = run(command, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None, None
    if done.returncode != 0:
        return None, None
    value = (done.stdout or "").strip()
    return (_clean_key(value), "钥匙串") if value else (None, None)


def _clean_key(value):
    value = value.strip()
    return value[7:].strip() if value.lower().startswith("bearer ") else value


def key_status(env=None, run=None):
    """只说读没读到、从哪读到，不带密钥本身。"""
    key, where = read_key(env, run)
    return {"found": bool(key), "where": where}


# ---------- 地址 ----------

def base_url(env=None):
    env = os.environ if env is None else env
    custom = (env.get("TIKHUB_BASE_URL") or "").strip().rstrip("/")
    if custom:
        host = urllib.parse.urlsplit(custom).hostname or ""
        if custom.startswith("http://") and host in ("127.0.0.1", "localhost"):
            return custom
    return API_BASE


def prices_for(env=None, opener=None):
    """按环境变量建单价表：RESEARCH_PRICE_LOOKUP=0 时不现查（测试用），只用兜底单价。"""
    env = os.environ if env is None else env
    return Prices(base_url(env), opener=opener, live=env.get("RESEARCH_PRICE_LOOKUP", "1") != "0")


# ---------- 出错说人话 ----------

class TikHubError(UserError):
    def __init__(self, message, kind, charged="none", status=None):
        UserError.__init__(self, message)
        self.kind = kind
        self.charged = charged  # none：没扣钱；unknown：不确定扣没扣；charged：扣了
        self.status = status


def explain_status(status, path, detail=""):
    xhs = "/xiaohongshu/" in path
    tail = "（TikHub 原话：%s）" % detail[:120] if detail else ""
    if status == 401:
        return TikHubError("TikHub 说这个密钥不对，或者已经停用了。请去工作台「市场调研」页顶部的「数据来源」里重新填一次；"
                           "新的密钥在 TikHub 网站的密钥页面创建（%s）。这次没有扣钱。%s" % (SITE_KEYS, tail), "auth", status=status)
    if status == 402:
        extra = "小红书的接口不能用新账号送的试用额度，要先充值。" if xhs else ""
        return TikHubError("TikHub 账户余额不够了。%s去 TikHub 网站充值（%s，最低 5 美元，按次扣费，没有月费），充好再试。"
                           "这次没有扣钱。%s" % (extra, SITE_CREDIT, tail), "balance", status=status)
    if status == 403:
        return TikHubError("TikHub 拒绝了这次请求：多半是账号邮箱还没验证，或者创建密钥时没勾这个接口的权限。"
                           "到 TikHub 网站检查邮箱验证和密钥的权限范围（建议全选），再去「数据来源」里重新检测一次。这次没有扣钱。%s" % tail,
                           "forbidden", status=status)
    if status == 404:
        return TikHubError("TikHub 找不到这条内容：链接可能失效了，作品被删了或者设成了私密。换个链接试试。%s" % tail, "not_found", status=status)
    if status == 429:
        return TikHubError("请求太快，被 TikHub 限流了。等一分钟再试。这次没有扣钱。", "rate_limit", status=status)
    if status in (400, 422):
        return TikHubError("TikHub 说参数不对，多半是链接它认不出来。把作品或主页的完整链接（浏览器地址栏里的那个）发我再试。"
                           "这次没有扣钱。%s" % tail, "bad_request", status=status)
    if status and status >= 500:
        return TikHubError("TikHub 那边出错了（%s），过几分钟再试。出错的请求不扣钱。" % status, "server", status=status)
    return TikHubError("TikHub 返回了没见过的状态（%s）。%s" % (status, tail), "other", status=status)


NETWORK_MESSAGE = ("连不上 TikHub（api.tikhub.io）。检查一下网络；平时上网要开代理的，开着代理再试。这次没有扣钱。")
TIMEOUT_MESSAGE = ("等 TikHub 回复超时了。这次请求可能已经扣了钱，也可能没有，我先停下、不自动重试。"
                   "可以去 TikHub 网站看一眼用量记录，再决定要不要重试。")


# ---------- 用量记录 ----------

class Ledger(object):
    """用量记录：一行一次请求（时间、接口、状态、按官方单价算的花费）。不记密钥、不记参数、不记返回内容。"""

    def __init__(self, path):
        self.path = path

    def add(self, endpoint, status, cost):
        if not self.path:
            return
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        entry = {"at": now_iso(), "endpoint": endpoint, "status": status, "cost_usd": str(cost)}
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def spent_today(self):
        if not self.path or not os.path.isfile(self.path):
            return Decimal("0")
        day = datetime.now().strftime("%Y-%m-%d")
        total = Decimal("0")
        with open(self.path, encoding="utf-8") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    at = datetime.fromisoformat(entry["at"]).astimezone().strftime("%Y-%m-%d")
                    if at == day:
                        total += Decimal(str(entry.get("cost_usd") or "0"))
                except (ValueError, KeyError, TypeError, ArithmeticError):
                    continue
        return total


# ---------- 单价 ----------

class Prices(object):
    """接口单价：先用 get_endpoint_info 现查（不用密钥、不扣费），查不到用兜底单价。"""

    def __init__(self, base=None, opener=None, live=True, timeout=8):
        self.base = base or API_BASE
        self.opener = opener or urllib.request.build_opener()
        self.live = live
        self.timeout = timeout
        self.cache = {}
        self.sources = set()

    def get(self, endpoint):
        """返回 (单价, 能不能用试用额度)。"""
        if endpoint in self.cache:
            return self.cache[endpoint]
        result = None
        if self.live:
            result = self._lookup(endpoint)
        if result is None:
            price, no_free = FALLBACK_PRICES.get(endpoint, (Decimal("0.01"), True))
            result = (price, not no_free)
            self.sources.add("fallback")
        else:
            self.sources.add("live")
        self.cache[endpoint] = result
        return result

    def _lookup(self, endpoint):
        url = "%s/api/v1/tikhub/user/get_endpoint_info?%s" % (self.base, urllib.parse.urlencode({"endpoint": endpoint}))
        request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "workbench-research/1"})
        try:
            with self.opener.open(request, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            data = body.get("data") or {}
            cost = data.get("endpoint_cost")
            if cost is None:
                return None
            return Decimal(str(cost)), bool(data.get("allow_free_credit", True))
        except (OSError, ValueError, urllib.error.URLError, socket.timeout, ArithmeticError, AttributeError):
            return None

    def source_text(self):
        if self.sources == {"live"}:
            return "单价是刚从 TikHub 官方价格查询接口查的"
        if "live" in self.sources:
            return "单价大部分是刚从 TikHub 官方查的，查不到的用 %s 记下的官方单价" % PRICE_CHECKED
        return "没查到实时单价，用的是 %s 记下的官方单价" % PRICE_CHECKED


# ---------- 花钱前的计划 ----------

class Plan(object):
    """这一步最多要调哪些接口、各几次。估算按官方原价（每天 1000 次以上的阶梯折扣不算），所以是上限。"""

    def __init__(self, platform, what):
        self.platform = platform
        self.what = what  # 给人看的一句话：这次要采什么
        self.items = []  # [(接口, 次数, 说明)]
        self.notes = []
        self.comments_over_default = False

    def add(self, endpoint, times, label):
        if times > 0:
            self.items.append((endpoint, int(times), label))
        return self

    @property
    def requests(self):
        return sum(t for _e, t, _l in self.items)

    def cost(self, prices):
        total = Decimal("0")
        for endpoint, times, _label in self.items:
            total += prices.get(endpoint)[0] * times
        return total

    def no_free_endpoints(self, prices):
        return [e for e, _t, _l in self.items if not prices.get(e)[1]]

    def describe(self, prices):
        parts = []
        for endpoint, times, label in self.items:
            price = prices.get(endpoint)[0]
            parts.append("%s %d 次、每次 %s" % (label, times, money(price)))
        return "；".join(parts)


def check_plan(plan, prices, ledger, agreed=None):
    """花钱前核对：默认上限以内直接跑；超过就抛 NeedsAgreement，把要问用户的话写清楚。返回这次最多花多少。"""
    cost = plan.cost(prices).quantize(Decimal("0.0001"), rounding=ROUND_UP)
    spent = ledger.spent_today() if ledger else Decimal("0")
    reasons = []
    if plan.platform == "小红书":
        reasons.append("小红书接口每次 0.01 美元，比抖音贵 10 倍，而且不能用新账号送的试用额度，每次都要先问")
    if plan.comments_over_default:
        reasons.append("要的评论超过默认的 %d 条" % COMMENTS_DEFAULT_MAX)
    if cost > AUTO_LIMIT:
        reasons.append("超过了单次自动花费上限 %s" % money(AUTO_LIMIT))
    if spent + cost > DAILY_LIMIT:
        reasons.append("今天已经用了约 %s，加上这次会超过当天自动上限 %s" % (money(spent), money(DAILY_LIMIT)))
    head = "%s：要调 TikHub 约 %d 次，按官方单价最多 %s。明细：%s。%s。" % (plan.what, plan.requests, money(cost), plan.describe(prices), prices.source_text())
    if plan.notes:
        head += "".join(plan.notes)
    if agreed is not None:
        agreed = Decimal(str(agreed))
        if agreed < cost:
            raise NeedsAgreement("需要用户同意：%s用户同意的上限 %s 比这次最多要花的 %s 少。要么请用户同意 %s，要么把条数调小。"
                                 % (head, money(agreed), money(cost), money(cost)))
        return cost, head
    if reasons:
        raise NeedsAgreement("需要用户同意：%s%s。先把这些告诉用户，用户在对话里明确同意后，加上 --agreed-budget %s 再运行。"
                             % (head, "；".join(reasons), _plain(cost)))
    return cost, head


def _plain(value):
    return format(Decimal(value).normalize(), "f")


# ---------- 发请求 ----------

class Client(object):
    def __init__(self, key, base=None, ledger=None, prices=None, opener=None, timeout=45, sleep=time.sleep, cache_dir=None, refresh=False):
        if not key:
            raise UserError(no_key_message())
        self._key = key
        self.base = base or API_BASE
        self.ledger = ledger
        self.prices = prices or Prices(self.base)
        self.opener = opener or urllib.request.build_opener()
        self.timeout = timeout
        self.sleep = sleep
        self.cache_dir = cache_dir
        self.refresh = refresh
        self.calls = 0  # 这次实际发出去（没走缓存）的付费请求
        self.spent = Decimal("0")
        self.limit_calls = None  # 计划里写的最多请求数，到了就停
        self.raw_dir = None  # 解析不出来时，原始返回存这里（不含密钥）

    def __repr__(self):  # 打印对象时不带密钥
        return "<TikHub 客户端 %s>" % self.base

    def account(self):
        """免费接口 get_user_info：密钥能不能用、余额多少。"""
        body = self._request("/api/v1/tikhub/user/get_user_info", {}, paid=False)
        user = body.get("user_data") or (body.get("data") or {}).get("user_data") or {}
        key_data = body.get("api_key_data") or (body.get("data") or {}).get("api_key_data") or {}
        return {
            "balance": _dec(user.get("balance")),
            "free_credit": _dec(user.get("free_credit")),
            "email_verified": user.get("email_verified"),
            "key_active": key_data.get("api_key_status") in (1, None),
        }

    def get(self, endpoint, params):
        """付费接口：先看 24 小时内有没有同样的请求存着，有就直接用、不花钱。"""
        cached = self._cache_get(endpoint, params)
        if cached is not None:
            if self.ledger:
                self.ledger.add(endpoint, "缓存", Decimal("0"))
            return cached
        if self.limit_calls is not None and self.calls >= self.limit_calls:
            raise UserError("已经用完这次计划的 %d 次请求，先停下（没有多花钱）。" % self.limit_calls)
        body = self._request(endpoint, params, paid=True)
        self._cache_put(endpoint, params, body)
        return body

    def _request(self, endpoint, params, paid):
        query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        url = "%s%s%s" % (self.base, endpoint, "?" + query if query else "")
        headers = {"Accept": "application/json", "User-Agent": "workbench-research/1", "Authorization": "Bearer " + self._key}
        price = self.prices.get(endpoint)[0] if paid else Decimal("0")
        attempt, waits = 0, (2, 5)
        while True:
            attempt += 1
            request = urllib.request.Request(url, headers=headers)
            try:
                resp = self.opener.open(request, timeout=self.timeout)
            except urllib.error.HTTPError as e:
                status = e.code
                detail = _error_detail(e)
                e.close()
                self._log(endpoint, status, Decimal("0"))
                if status in (429, 500, 502, 503, 504) and attempt <= len(waits):
                    self.sleep(waits[attempt - 1])
                    continue
                raise explain_status(status, endpoint, detail)
            except urllib.error.URLError as e:  # 还没发出去：连不上、域名解析失败、证书握手失败
                self._log(endpoint, "连不上", Decimal("0"))
                if attempt == 1 and not isinstance(getattr(e, "reason", None), socket.timeout):
                    self.sleep(2)
                    continue
                raise TikHubError(NETWORK_MESSAGE, "network")
            except (socket.timeout, TimeoutError):
                self._log(endpoint, "超时", price)
                raise TikHubError(TIMEOUT_MESSAGE, "timeout", charged="unknown")
            except (ConnectionError, OSError, http.client.HTTPException):  # 发出去以后连接断了：不确定扣没扣
                self._log(endpoint, "中断", price)
                raise TikHubError(TIMEOUT_MESSAGE, "timeout", charged="unknown")
            try:
                with resp:
                    raw = resp.read()
                    status = resp.status
            except (socket.timeout, TimeoutError, OSError, http.client.HTTPException):
                self._log(endpoint, "超时", price)
                raise TikHubError(TIMEOUT_MESSAGE, "timeout", charged="unknown")
            try:
                body = json.loads(raw.decode("utf-8"))
            except ValueError:
                self._log(endpoint, status, price)
                raise TikHubError("TikHub 返回的内容不是 JSON，读不出来。这次可能已经扣了钱。过一会儿再试。", "bad_body", charged="unknown")
            if paid:
                self.calls += 1
                self.spent += price
            self._log(endpoint, status, price)
            return body

    def _log(self, endpoint, status, cost):
        if self.ledger:
            self.ledger.add(endpoint, status, cost)

    # 24 小时内同样的请求不重复花钱
    def _cache_path(self, endpoint, params):
        if not self.cache_dir:
            return None
        key = json.dumps([endpoint, sorted((k, str(v)) for k, v in params.items() if v is not None)], ensure_ascii=False)
        return os.path.join(self.cache_dir, hashlib.sha1(key.encode("utf-8")).hexdigest()[:20] + ".json")

    def _cache_get(self, endpoint, params):
        path = self._cache_path(endpoint, params)
        if self.refresh or not path or not os.path.isfile(path):
            return None
        if time.time() - os.path.getmtime(path) > 24 * 3600:
            return None
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _cache_put(self, endpoint, params, body):
        path = self._cache_path(endpoint, params)
        if not path:
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False)
        os.replace(tmp, path)

    def save_raw(self, endpoint, body):
        """解析不出来的返回存一份，方便排查（只有 TikHub 的返回，不含密钥）。返回存的位置。"""
        if not self.raw_dir:
            return None
        os.makedirs(self.raw_dir, exist_ok=True)
        name = "%s_%s.json" % (datetime.now().strftime("%Y%m%d-%H%M%S"), endpoint.strip("/").replace("/", "_"))
        path = os.path.join(self.raw_dir, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False, indent=1)
        return path


def _dec(value):
    try:
        return Decimal(str(value)) if value is not None else None
    except ArithmeticError:
        return None


def _error_detail(e):
    try:
        body = json.loads(e.read().decode("utf-8", "replace"))
    except (ValueError, OSError, AttributeError):
        return ""
    detail = body.get("detail") if isinstance(body, dict) else None
    if isinstance(detail, dict):
        return str(detail.get("message_zh") or detail.get("message") or "")
    if isinstance(body, dict):
        return str(body.get("message_zh") or body.get("message") or detail or "")
    return ""


def check_balance(client, plan, prices, cost):
    """花钱前用免费接口看一眼余额。不能用试用额度的接口，要有充值余额才行。"""
    info = client.account()
    balance, free = info["balance"], info["free_credit"]
    if balance is None and free is None:
        return info
    balance, free = balance or Decimal("0"), free or Decimal("0")
    no_free = plan.no_free_endpoints(prices)
    if no_free and balance < cost:
        raise TikHubError("这次要用的接口（%s）不能用新账号送的试用额度，要账户里有充值的余额；现在充值余额是 %s，这次最多要 %s。"
                          "去 TikHub 网站充值（%s，最低 5 美元，按次扣费），充好再试。还没有花钱。"
                          % ("、".join(sorted(set(_short(e) for e in no_free))), money(balance), money(cost), SITE_CREDIT), "balance")
    if balance + free < cost:
        raise TikHubError("TikHub 余额不够：现在余额 %s、试用额度 %s，这次最多要 %s。去 TikHub 网站充值（%s）后再试。还没有花钱。"
                          % (money(balance), money(free), money(cost), SITE_CREDIT), "balance")
    return info


def _short(endpoint):
    names = {
        "fetch_user_post_videos": "抖音作品列表",
        "get_user_info": "小红书博主资料",
        "get_user_posted_notes": "小红书笔记列表",
        "get_image_note_detail": "小红书笔记详情",
        "get_note_comments": "小红书评论",
        "get_note_sub_comments": "小红书楼中楼",
    }
    return names.get(endpoint.rsplit("/", 1)[-1], endpoint)
