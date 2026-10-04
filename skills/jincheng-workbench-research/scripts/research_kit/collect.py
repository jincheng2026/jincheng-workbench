"""用 TikHub 采数据：博主资料和最近作品、一条作品的评论、一条作品的详情。

每一步都先算计划（最多调几次、最多花多少），过了上限就停下来问用户；跑的时候绝不超过计划的次数。
抖音接 App V3 的接口（每次 0.001 美元）；小红书接 App V2 的接口（每次 0.01 美元，不能用试用额度，每次都先问）。
TikHub 没有抖音、小红书、视频号的字幕接口：拆视频只能拿到标题、文案和数据，逐字稿要用户自己贴。
"""
import math
import os

from . import UserError
from . import platforms as P
from . import tikhub as T
from .text import money, now_iso

DY = {
    "sec": "/api/v1/douyin/web/get_sec_user_id",
    "profile": "/api/v1/douyin/app/v3/handler_user_profile",
    "posts": "/api/v1/douyin/app/v3/fetch_user_post_videos",
    "detail": "/api/v1/douyin/app/v3/fetch_one_video",
    "detail_share": "/api/v1/douyin/app/v3/fetch_one_video_by_share_url",
    "comments": "/api/v1/douyin/app/v3/fetch_video_comments",
    "replies": "/api/v1/douyin/app/v3/fetch_video_comment_replies",
}
XH = {
    "profile": "/api/v1/xiaohongshu/app_v2/get_user_info",
    "notes": "/api/v1/xiaohongshu/app_v2/get_user_posted_notes",
    "detail": "/api/v1/xiaohongshu/app_v2/get_image_note_detail",
    "comments": "/api/v1/xiaohongshu/app_v2/get_note_comments",
    "replies": "/api/v1/xiaohongshu/app_v2/get_note_sub_comments",
}
DY_PAGE = 20  # 抖音评论、作品列表每页 20 条（接口文档要求保持默认）
XHS_NOTES_PAGE = 6  # 小红书笔记列表每页条数官方没写，按至少 6 条估
XHS_COMMENTS_PAGE = 10  # 小红书评论每页条数官方没写，按 10 条估
REPLY_AVG = 3.6  # 连楼中楼一起采时，按经验平均每次请求拿到约 3.6 条
SUPPORTED = (P.DOUYIN, P.XHS)


def unsupported(platform):
    name = platform or "这个链接"
    return UserError("这一版用 TikHub 只能采抖音和小红书。%s的评论请用社媒助手导出后放进「评论导入」；"
                     "博主资料可以直接告诉我，或者发主页截图，我手动建档。" % name)


class Session(object):
    """一次采集用到的东西：客户端、单价、用量记录、存原始返回的地方。"""

    def __init__(self, places, env=None, opener=None, sleep=None, refresh=False, run=None):
        env = os.environ if env is None else env
        key, _where = T.read_key(env, run)
        if not key:
            raise UserError(T.no_key_message())
        base = T.base_url(env)
        self.prices = T.prices_for(env, opener)
        self.ledger = T.Ledger(os.path.join(places["hidden"], "用量.jsonl"))
        kwargs = {"base": base, "ledger": self.ledger, "prices": self.prices, "opener": opener,
                  "cache_dir": os.path.join(places["hidden"], "缓存"), "refresh": refresh}
        if sleep:
            kwargs["sleep"] = sleep
        self.client = T.Client(key, **kwargs)
        self.client.raw_dir = os.path.join(places["hidden"], "原始返回")

    def start(self, plan, agreed=None):
        """核对计划和余额，过了才开始花钱。"""
        cost, head = T.check_plan(plan, self.prices, self.ledger, agreed)
        T.check_balance(self.client, plan, self.prices, cost)
        self.client.limit_calls = plan.requests
        return cost, head

    def call(self, endpoint, params, parse, *extra):
        body = self.client.get(endpoint, params)
        try:
            return parse(body, *extra)
        except P.ShapeError as e:
            path = self.client.save_raw(endpoint, body)
            raise UserError("TikHub 返回了数据，但样子和预期的不一样，没解析出来（%s）。这次请求已经按 %s 计费。"
                            "原始返回存在 %s（只有 TikHub 的返回，不含密钥），可以反馈给工作台作者。"
                            % (e, money(self.prices.get(endpoint)[0]), path or "（没存）"))
        except LookupError as e:
            raise UserError("%s（这次请求照样按 %s 计费）" % (e, money(self.prices.get(endpoint)[0])))

    def can_call(self):
        return self.client.limit_calls is None or self.client.calls < self.client.limit_calls

    def summary(self):
        return {"requests": self.client.calls, "cost_usd": str(self.client.spent)}


def _platform_or_fail(target):
    platform = target.get("platform")
    if platform not in SUPPORTED:
        raise unsupported(platform)
    return platform


# ---------- 博主资料和最近作品 ----------

def account_plan(target, max_works):
    platform = _platform_or_fail(target)
    plan = T.Plan(platform, "拉%s博主资料和最近 %d 条作品" % (platform, max_works))
    if platform == P.DOUYIN:
        if not target.get("user_id"):
            plan.add(DY["sec"], 1, "从链接认出博主")
        plan.add(DY["profile"], 1, "博主资料")
        plan.add(DY["posts"], math.ceil(max_works / float(DY_PAGE)), "作品列表")
    else:
        plan.add(XH["profile"], 1, "博主资料")
        plan.add(XH["notes"], math.ceil(max_works / float(XHS_NOTES_PAGE)), "笔记列表")
        plan.notes.append("小红书笔记列表每页几条官方没写，按每页至少 6 条估的上限，实际多半用不完。")
    return plan


def fetch_account(session, target, max_works):
    platform = _platform_or_fail(target)
    works = []
    if platform == P.DOUYIN:
        sec = target.get("user_id")
        if not sec:
            sec = session.call(DY["sec"], {"url": target["url"]}, lambda b: P.douyin_string(b))
        profile = session.call(DY["profile"], {"sec_user_id": sec}, P.douyin_profile)
        profile["user_id"] = profile.get("user_id") or sec
        profile["url"] = profile.get("url") or P.user_link(P.DOUYIN, sec)
        cursor, more = 0, True
        while more and len(works) < max_works and session.can_call():
            page, cursor, more = session.call(DY["posts"], {"sec_user_id": sec, "max_cursor": cursor or 0, "count": DY_PAGE}, P.douyin_works)
            works.extend(page)
            if not page:
                break
    else:
        params = {"user_id": target["user_id"]} if target.get("user_id") else {"share_text": target["url"]}
        profile = session.call(XH["profile"], params, P.xhs_profile)
        uid = profile.get("user_id") or target.get("user_id")
        cursor, more = "", True
        while more and len(works) < max_works and session.can_call():
            q = dict({"user_id": uid} if uid else params, cursor=cursor or "")
            page, cursor, more = session.call(XH["notes"], q, P.xhs_notes)
            works.extend(page)
            if not page or not cursor:
                break
    seen, unique = set(), []
    for w in works:
        if w["id"] and w["id"] not in seen:
            seen.add(w["id"])
            unique.append(w)
    return profile, unique[:max_works]


# ---------- 一条作品的评论 ----------

def comments_plan(target, max_comments, replies=False):
    platform = _platform_or_fail(target)
    what = "采%s这条作品的%s评论，最多 %d 条" % (platform, "一级和楼中楼" if replies else "一级", max_comments)
    plan = T.Plan(platform, what)
    plan.comments_over_default = max_comments > T.COMMENTS_DEFAULT_MAX
    if platform == P.DOUYIN:
        plan.add(DY["detail"] if target.get("id") else DY["detail_share"], 1, "作品详情")
        if replies:
            plan.add(DY["comments"], math.ceil(max_comments / float(REPLY_AVG)), "评论和楼中楼")
            plan.notes.append("连楼中楼一起时，按经验平均每次请求约拿到 3.6 条估的上限。")
        else:
            plan.add(DY["comments"], math.ceil(max_comments / float(DY_PAGE)), "一级评论")
    else:
        if replies:
            plan.add(XH["comments"], math.ceil(max_comments / float(REPLY_AVG)), "评论和楼中楼")
            plan.notes.append("连楼中楼一起时，按经验平均每次请求约拿到 3.6 条估的上限。")
        else:
            plan.add(XH["comments"], math.ceil(max_comments / float(XHS_COMMENTS_PAGE)), "一级评论")
            plan.notes.append("小红书评论每页几条官方没写，按每页 10 条估。")
    return plan


def _key(row):
    return row["cid"] or (row["text"], row["time"])


def _count(rows, top_only=False):
    """不重复的评论有几条（抖音翻页常把前面给过的评论再给一遍）。top_only：只数一级评论。"""
    return len(set(_key(r) for r in rows if not top_only or r["level"] == "一级"))


def _trim(rows, limit, replies):
    """按条数上限截断。只要一级评论时只数一级评论，平台附带在一级评论里的回复跟着它留下、不占名额；
    连楼中楼时全部都数。重复的行照样交出去，整理成评论数据时算进「重复」，不悄悄丢掉。"""
    out, seen, n = [], set(), 0
    for r in rows:
        key = _key(r)
        if key in seen:
            out.append(r)
            continue
        counted = replies or r["level"] == "一级"
        if counted and n >= limit:
            break
        seen.add(key)
        out.append(r)
        if counted:
            n += 1
    return out


def fetch_comments(session, target, max_comments, replies=False):
    """返回 (评论行, 作品信息, 采集说明)。评论行的格式和导入表格整理出来的一样。
    只要一级评论时，max_comments 数的是不重复的一级评论，平台附带的回复另算；连楼中楼时数全部。
    TikHub 重复给的行也交出去，整理成评论数据时去重、算进「重复」。"""
    platform = _platform_or_fail(target)
    rows, info, notes = [], {}, []
    if platform == P.DOUYIN:
        if target.get("id"):
            work = session.call(DY["detail"], {"aweme_id": target["id"]}, P.douyin_detail)
        else:
            work = session.call(DY["detail_share"], {"share_url": target["url"]}, P.douyin_detail)
        vid = work["id"]
        info = {"id": vid, "url": work["url"], "title": work["title"], "comment_count": work["comments"], "author": work["author"]}
        top_target = max_comments if not replies else max(DY_PAGE, int(math.ceil(max_comments / 2.0)))
        cursor, more = 0, True
        while more and _count(rows, top_only=True) < top_target and session.can_call():
            page, cursor, more, _total = session.call(DY["comments"], {"aweme_id": vid, "cursor": cursor or 0, "count": DY_PAGE}, P.douyin_comments, vid)
            rows.extend(page)
            if not page:
                break
        if replies:
            threads, seen = [], set()
            for r in rows:
                if r["level"] == "一级" and (r.get("replies") or 0) > 0 and r["cid"] not in seen:
                    seen.add(r["cid"])
                    threads.append(r)
            threads.sort(key=lambda r: -(r["replies"] or 0))
            for thread in threads:
                have = _count([r for r in rows if r.get("parent") == thread["cid"]])
                cur, more_r = 0, have < (thread["replies"] or 0)  # 一级评论里已经附带了全部回复的，不再花钱去拉
                while more_r and _count(rows) < max_comments and session.can_call():
                    page, cur, more_r, _t = session.call(DY["replies"], {"item_id": vid, "comment_id": thread["cid"], "cursor": cur or 0, "count": DY_PAGE},
                                                         P.douyin_comments, vid, thread["cid"])
                    rows.extend(page)
                    if not page:
                        break
                if _count(rows) >= max_comments or not session.can_call():
                    break
            while more and _count(rows) < max_comments and session.can_call():  # 回复不够数，用剩下的次数多拿一级评论
                page, cursor, more, _total = session.call(DY["comments"], {"aweme_id": vid, "cursor": cursor or 0, "count": DY_PAGE}, P.douyin_comments, vid)
                rows.extend(page)
                if not page:
                    break
    else:
        nid = target.get("id")
        params = {"note_id": nid} if nid else {"share_text": target["url"]}
        info = {"id": nid, "url": target.get("url") if not nid else P.work_link(P.XHS, nid), "title": None, "comment_count": None}
        nxt, more = {"cursor": "", "index": 0, "pageArea": "UNFOLDED"}, True
        top_target = max_comments if not replies else int(math.ceil(max_comments / 2.0))
        while more and _count(rows, top_only=True) < top_target and (not replies or _count(rows) < max_comments) and session.can_call():
            q = dict(params, cursor=nxt.get("cursor") or "", index=nxt.get("index") or 0, pageArea=nxt.get("pageArea") or "UNFOLDED", sort_strategy="like_count")
            page, nxt, more, total = session.call(XH["comments"], q, P.xhs_comments, nid)
            rows.extend(page)
            if total and not info.get("comment_count"):
                info["comment_count"] = total
            if page and not nid:
                nid = page[0]["video_id"] or nid
            if not page:
                break
        if replies:
            threads = sorted([r for r in rows if r["level"] == "一级" and (r.get("replies") or 0) > 0], key=lambda r: -(r["replies"] or 0))
            for thread in threads:
                have = sum(1 for r in rows if r.get("parent") == thread["cid"])
                sub = {"cursor": "", "index": 1}
                more_r = have < (thread["replies"] or 0)
                while more_r and _count(rows) < max_comments and session.can_call():
                    q = dict({"note_id": nid} if nid else params, comment_id=thread["cid"], cursor=sub.get("cursor") or "", index=sub.get("index") or 1)
                    page, sub, more_r, _t = session.call(XH["replies"], q, P.xhs_comments, nid, thread["cid"])
                    known = set(r["cid"] for r in rows)
                    rows.extend(r for r in page if r["cid"] not in known)
                    if not page:
                        break
                if _count(rows) >= max_comments or not session.can_call():
                    break
        if nid:
            info["id"], info["url"] = nid, P.work_link(P.XHS, nid)
    out = _trim(rows, max_comments, replies)
    unique = _count(out)
    if more:
        if _count(out, top_only=not replies) >= max_comments:
            notes.append("评论还没取完：到了这次的条数上限就停了。")
        else:
            notes.append("评论还没取完：这次计划的请求次数用完了（要更多就把条数调大再采，24 小时内采过的页不重复花钱）。")
    if len(out) > unique:
        notes.append("TikHub 给的评论里有 %d 条是重复的（翻页时又给了前面给过的，或者楼中楼里又给了一遍附带过的回复），"
                     "整理时去掉了，不重复的一共 %d 条。" % (len(out) - unique, unique))
    return out, info, notes


def comments_source(session, info, notes, replies):
    rows_note = "一级评论和楼中楼" if replies else "一级评论"
    return {
        "kind": "TikHub",
        "collected_at": now_iso(),
        "what": rows_note,
        "requests": session.client.calls,
        "cost_usd": str(session.client.spent),
        "note": "".join(notes) or None,
    }


# ---------- 一条作品的详情（拆视频用） ----------

def video_plan(target):
    platform = _platform_or_fail(target)
    plan = T.Plan(platform, "拉这条%s作品的标题、文案和数据" % platform)
    if platform == P.DOUYIN:
        plan.add(DY["detail"] if target.get("id") else DY["detail_share"], 1, "作品详情")
    else:
        plan.add(XH["detail"], 1, "笔记详情")
    return plan


def fetch_video(session, target):
    platform = _platform_or_fail(target)
    if platform == P.DOUYIN:
        if target.get("id"):
            return session.call(DY["detail"], {"aweme_id": target["id"]}, P.douyin_detail)
        return session.call(DY["detail_share"], {"share_url": target["url"]}, P.douyin_detail)
    params = {"note_id": target["id"]} if target.get("id") else {"share_text": target["url"]}
    return session.call(XH["detail"], params, P.xhs_note_detail)
