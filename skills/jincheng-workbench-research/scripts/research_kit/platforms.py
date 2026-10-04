"""平台链接和 TikHub 返回数据：认链接是哪个平台、哪条作品、哪个博主；把 TikHub 的返回整理成统一的格式。

抖音的字段对着 TikHub 官方免费演示接口（/api/v1/demo/douyin/app/fetch_one_video）的真实返回核对过。
小红书 App V2 接口官方没给返回示例，字段名按 TikHub 接口说明里写的路径（$.data.data.notes、$.data.data.cursor）
和几种常见写法兼容；解析不出来时抛 ShapeError，调用方会把原始返回存下来（不含密钥），不悄悄当成没有数据。
"""
import json
import re
from urllib.parse import parse_qs, urlsplit, urlunsplit

from .text import parse_count, unix_to_text

DOUYIN, XHS = "抖音", "小红书"
PLATFORM_HOSTS = (
    (DOUYIN, ("douyin.com", "iesdouyin.com", "amemv.com")),
    (XHS, ("xiaohongshu.com", "xhslink.com", "xhslink.cn", "xhscdn.com")),
    ("B站", ("bilibili.com", "b23.tv")),
    ("快手", ("kuaishou.com", "chenzhongtech.com", "gifshow.com")),
    ("视频号", ("channels.weixin.qq.com", "weixin.qq.com")),
    ("TikTok", ("tiktok.com",)),
    ("YouTube", ("youtube.com", "youtu.be")),
    ("微博", ("weibo.com", "weibo.cn")),
)
SHORT_HOSTS = ("v.douyin.com", "xhslink.com", "xhslink.cn", "b23.tv")
_URL = re.compile(r"https?://[^\s<>\"'，。！？、）)】]+", re.I)
_XHS_ID = r"[0-9a-f]{24}"


class ShapeError(Exception):
    """TikHub 返回了 200，但数据的样子和预期不一样，没法解析。"""


def extract_url(text):
    """从分享文字里抠出第一个链接（抖音、小红书「复制链接」常带一大段文字）。"""
    m = _URL.search(str(text or ""))
    return m.group(0).rstrip(".,;") if m else None


def _host(url):
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def detect_platform(text):
    url = extract_url(text) or ""
    host = _host(url)
    if not host:
        return None
    for name, hosts in PLATFORM_HOSTS:
        if any(host == h or host.endswith("." + h) for h in hosts):
            return name
    return None


def is_short_link(url):
    return _host(url) in SHORT_HOSTS


def video_id_from_link(text):
    """作品编号：抖音是十几位数字，小红书是 24 位十六进制。认不出返回 None。"""
    raw = str(text or "").strip()
    if re.fullmatch(r"\d{15,21}", raw):
        return raw
    if re.fullmatch(_XHS_ID, raw):
        return raw
    url = extract_url(raw) or raw
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    path, query = parts.path or "", parse_qs(parts.query or "")
    for key in ("modal_id", "aweme_id", "item_id", "vid", "note_id", "noteId"):
        for value in query.get(key, []):
            if re.fullmatch(r"\d{15,21}|" + _XHS_ID, value):
                return value
    m = re.search(r"/(?:video|note|share/video|share/note|slides)/(\d{15,21})", path)
    if m:
        return m.group(1)
    m = re.search(r"/(?:explore|discovery/item|item|note)/(" + _XHS_ID + r")", path)
    if m:
        return m.group(1)
    return None


def user_id_from_link(text):
    """博主编号：抖音主页链接 /user/ 后面那一串（sec_user_id），小红书 /user/profile/ 后面的 24 位。"""
    url = extract_url(text) or str(text or "").strip()
    try:
        path = urlsplit(url).path or ""
    except ValueError:
        return None
    m = re.search(r"/user/profile/(" + _XHS_ID + r")", path)
    if m:
        return m.group(1)
    m = re.search(r"/user/([A-Za-z0-9_\-]{20,})", path)
    if m and m.group(1) != "self":
        return m.group(1)
    return None


def canonical_link(url):
    """比较用的链接：能认出作品就写成固定的样子，认不出就去掉问号后面的参数和末尾的斜杠。"""
    url = extract_url(url) or str(url or "").strip()
    platform = detect_platform(url)
    vid = video_id_from_link(url)
    if platform == DOUYIN and vid:
        return "https://www.douyin.com/video/%s" % vid
    if platform == XHS and vid:
        return "https://www.xiaohongshu.com/explore/%s" % vid
    try:
        p = urlsplit(url)
    except ValueError:
        return url
    host = (p.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return urlunsplit(("https", host, (p.path or "").rstrip("/"), "", ""))


def user_link(platform, user_id):
    if platform == DOUYIN and user_id:
        return "https://www.douyin.com/user/%s" % user_id
    if platform == XHS and user_id:
        return "https://www.xiaohongshu.com/user/profile/%s" % user_id
    return None


def work_link(platform, work_id):
    if platform == DOUYIN and work_id:
        return "https://www.douyin.com/video/%s" % work_id
    if platform == XHS and work_id:
        return "https://www.xiaohongshu.com/explore/%s" % work_id
    return None


def parse_target(text):
    """用户给的一段话或链接 → {platform, url, id（作品编号）, user_id, short}。"""
    url = extract_url(text)
    raw = str(text or "").strip()
    if not url and re.fullmatch(r"\d{15,21}", raw):
        return {"platform": DOUYIN, "url": work_link(DOUYIN, raw), "id": raw, "user_id": None, "short": False}
    if not url and re.fullmatch(_XHS_ID, raw):
        return {"platform": XHS, "url": work_link(XHS, raw), "id": raw, "user_id": None, "short": False}
    if not url:
        return {"platform": None, "url": None, "id": None, "user_id": None, "short": False}
    return {"platform": detect_platform(url), "url": url, "id": video_id_from_link(url),
            "user_id": user_id_from_link(url), "short": is_short_link(url)}


# ---------- 取值的小工具 ----------

def pick(obj, *paths):
    """按「a.b.c」的路径取值，取到第一个不是空的就返回。路径里的数字表示数组下标。"""
    for path in paths:
        cur = obj
        for part in path.split("."):
            if isinstance(cur, dict):
                cur = cur.get(part)
            elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
                cur = cur[int(part)]
            else:
                cur = None
                break
        if cur not in (None, "", [], {}):
            return cur
    return None


def _first_url(value):
    """头像、封面：可能是 {url_list: [...]}、[{url: ...}]、直接一个链接。优先 jpeg/jpg/png，少拿 webp。"""
    urls = []
    if isinstance(value, str):
        urls = [value]
    elif isinstance(value, dict):
        urls = list(value.get("url_list") or []) or [value.get("url") or value.get("url_default") or value.get("url_size_large") or ""]
    elif isinstance(value, list):
        for item in value:
            u = _first_url(item)
            if u:
                urls.append(u)
    urls = [u for u in urls if isinstance(u, str) and u.startswith(("http://", "https://"))]
    for u in urls:
        if re.search(r"\.(jpe?g|png)(\?|$)", u, re.I) or "jpeg" in u:
            return u
    return urls[0] if urls else None


def _data(resp):
    """TikHub 的外壳是 {code, data: …}；抖音 data 里就是平台原样的返回，小红书多包一层 data。"""
    return resp.get("data") if isinstance(resp, dict) else None


def _clean_title(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


# IP 属地：小红书 App V2 的返回里常用英文写（Sichuan、United Kingdom），同一页里也有直接写中文的（韩国）。
# 换成平台上显示的中文，和抖音、社媒助手导出的表一致，属地排行才不会把「Zhejiang」和「浙江」算成两处。认不出的原样留着，不猜。
_PLACE_ZH = {
    "beijing": "北京", "tianjin": "天津", "hebei": "河北", "shanxi": "山西", "innermongolia": "内蒙古", "neimenggu": "内蒙古",
    "liaoning": "辽宁", "jilin": "吉林", "heilongjiang": "黑龙江", "shanghai": "上海", "jiangsu": "江苏", "zhejiang": "浙江",
    "anhui": "安徽", "fujian": "福建", "jiangxi": "江西", "shandong": "山东", "henan": "河南", "hubei": "湖北", "hunan": "湖南",
    "guangdong": "广东", "guangxi": "广西", "hainan": "海南", "chongqing": "重庆", "sichuan": "四川", "guizhou": "贵州",
    "yunnan": "云南", "tibet": "西藏", "xizang": "西藏", "shaanxi": "陕西", "gansu": "甘肃", "qinghai": "青海", "ningxia": "宁夏",
    "xinjiang": "新疆", "hongkong": "香港", "hongkongsar": "香港", "macau": "澳门", "macao": "澳门", "macausar": "澳门",
    "macaosar": "澳门", "taiwan": "台湾",
    "unitedstates": "美国", "unitedstatesofamerica": "美国", "usa": "美国", "us": "美国", "unitedkingdom": "英国", "uk": "英国",
    "britain": "英国", "greatbritain": "英国", "england": "英国", "japan": "日本", "southkorea": "韩国", "korea": "韩国",
    "northkorea": "朝鲜", "singapore": "新加坡", "malaysia": "马来西亚", "thailand": "泰国", "vietnam": "越南", "philippines": "菲律宾",
    "indonesia": "印度尼西亚", "cambodia": "柬埔寨", "laos": "老挝", "myanmar": "缅甸", "mongolia": "蒙古", "india": "印度",
    "pakistan": "巴基斯坦", "nepal": "尼泊尔", "srilanka": "斯里兰卡", "bangladesh": "孟加拉国", "kazakhstan": "哈萨克斯坦",
    "unitedarabemirates": "阿联酋", "uae": "阿联酋", "saudiarabia": "沙特阿拉伯", "qatar": "卡塔尔", "israel": "以色列",
    "turkey": "土耳其", "turkiye": "土耳其", "egypt": "埃及", "southafrica": "南非", "nigeria": "尼日利亚", "kenya": "肯尼亚",
    "australia": "澳大利亚", "newzealand": "新西兰", "canada": "加拿大", "mexico": "墨西哥", "brazil": "巴西", "argentina": "阿根廷",
    "chile": "智利", "peru": "秘鲁", "colombia": "哥伦比亚", "germany": "德国", "france": "法国", "italy": "意大利", "spain": "西班牙",
    "portugal": "葡萄牙", "netherlands": "荷兰", "belgium": "比利时", "switzerland": "瑞士", "austria": "奥地利", "sweden": "瑞典",
    "norway": "挪威", "denmark": "丹麦", "finland": "芬兰", "iceland": "冰岛", "ireland": "爱尔兰", "poland": "波兰",
    "czechia": "捷克", "czechrepublic": "捷克", "hungary": "匈牙利", "greece": "希腊", "russia": "俄罗斯", "ukraine": "乌克兰",
    "luxembourg": "卢森堡", "monaco": "摩纳哥", "maldives": "马尔代夫", "brunei": "文莱",
}


def place_zh(text):
    """IP 属地写成中文：去掉「IP属地：」，英文的省份、国家换成中文；中文的、认不出的原样返回。"""
    raw = re.sub(r"^IP属地[:：]\s*", "", str(text or "")).strip()
    if not raw or not re.fullmatch(r"[A-Za-z][A-Za-z .,'()\-]*", raw):
        return raw
    key = re.sub(r"[^a-z]", "", raw.lower())
    return _PLACE_ZH.get(key) or _PLACE_ZH.get(re.sub(r"^the", "", key)) or raw


# ---------- 抖音 ----------

def douyin_string(resp):
    """get_sec_user_id、get_aweme_id 的返回：data 就是那串编号。"""
    value = _data(resp)
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, dict):
        for key in ("sec_user_id", "sec_uid", "aweme_id"):
            if isinstance(value.get(key), str) and value[key].strip():
                return value[key].strip()
    raise ShapeError("没从返回里读到编号")


def douyin_profile(resp):
    data = _data(resp) or {}
    user = pick(data, "user", "data.user", "user_info") or {}
    if not isinstance(user, dict) or not (user.get("nickname") or user.get("sec_uid")):
        raise ShapeError("没从返回里读到博主资料（data.user）")
    followers = parse_count(user.get("follower_count")) or parse_count(user.get("mplatform_followers_count"))
    sec_uid = user.get("sec_uid") or None
    return {
        "platform": DOUYIN,
        "name": _clean_title(user.get("nickname")),
        "user_id": sec_uid,
        "url": user_link(DOUYIN, sec_uid),
        "handle": user.get("unique_id") or user.get("short_id") or None,
        "bio": str(user.get("signature") or "").strip(),
        "followers": followers or None,
        "following": parse_count(user.get("following_count")),
        "likes_total": parse_count(user.get("total_favorited")),
        "works_total": parse_count(user.get("aweme_count")),
        "avatar_url": _first_url(pick(user, "avatar_larger", "avatar_300x300", "avatar_medium", "avatar_thumb")),
        "ip_location": re.sub(r"^IP属地[:：]\s*", "", str(user.get("ip_location") or "")).strip() or None,
    }


def douyin_work(aweme):
    """一条抖音作品（视频或图文）→ 统一格式。"""
    stats = aweme.get("statistics") or {}
    video = aweme.get("video") or {}
    duration = parse_count(aweme.get("duration")) or parse_count(video.get("duration"))
    wid = str(aweme.get("aweme_id") or aweme.get("group_id") or "").strip()
    desc = str(aweme.get("desc") or aweme.get("caption") or "").strip()
    title = _clean_title(aweme.get("item_title") or aweme.get("preview_title") or "") or _clean_title(desc.split("#")[0]) or _clean_title(desc)
    is_images = bool(aweme.get("images")) or aweme.get("aweme_type") in (68, 150)
    tags = [t.get("hashtag_name") for t in aweme.get("text_extra") or [] if isinstance(t, dict) and t.get("hashtag_name")]
    return {
        "id": wid,
        "url": work_link(DOUYIN, wid),
        "title": title[:80],
        "desc": desc,
        "published_at": unix_to_text(aweme.get("create_time")),
        "duration_seconds": round(duration / 1000.0, 1) if duration else None,
        "type": "图文" if is_images else "视频",
        "likes": parse_count(stats.get("digg_count")),
        "comments": parse_count(stats.get("comment_count")),
        "collects": parse_count(stats.get("collect_count")),
        "shares": parse_count(stats.get("share_count")),
        "cover_url": _first_url(pick(video, "origin_cover", "cover", "dynamic_cover")) or _first_url(pick(aweme, "images.0")),
        "pinned": bool(aweme.get("is_top")),
        "tags": tags,
        "author": _clean_title(pick(aweme, "author.nickname")),
        "author_id": pick(aweme, "author.sec_uid"),
    }


def douyin_works(resp):
    data = _data(resp) or {}
    items = pick(data, "aweme_list", "data.aweme_list")
    if items is None and isinstance(data, dict) and "aweme_list" in data:
        items = []
    if not isinstance(items, list):
        raise ShapeError("没从返回里读到作品列表（data.aweme_list）")
    works = [douyin_work(a) for a in items if isinstance(a, dict)]
    has_more = bool(pick(data, "has_more", "data.has_more"))
    cursor = pick(data, "max_cursor", "data.max_cursor")
    return works, cursor, has_more


_FILTER_REASONS = {"5": "作者设成了私密", "8": "作品不存在、已删除，或因版权限制看不了", "10": "作者设成了部分人可见"}


def douyin_detail(resp):
    data = _data(resp) or {}
    aweme = pick(data, "aweme_detail", "aweme_details.0", "data.aweme_detail")
    if not isinstance(aweme, dict):
        reason = str(pick(data, "filter_list.0.reason") or "")
        if reason:
            raise LookupError("这条作品看不了：%s。" % _FILTER_REASONS.get(reason, "平台不给看（原因代码 %s）" % reason))
        raise ShapeError("没从返回里读到作品详情（data.aweme_detail）")
    work = douyin_work(aweme)
    author = aweme.get("author") or {}
    work["author_profile"] = {"name": _clean_title(author.get("nickname")), "user_id": author.get("sec_uid"),
                              "url": user_link(DOUYIN, author.get("sec_uid"))}
    return work


def douyin_comment_row(c, video_id, parent=None):
    reply_to = str(c.get("reply_id") or "").strip()
    parent = parent or (reply_to if reply_to and reply_to != "0" else None)
    images = c.get("image_list") or c.get("images")
    return {
        "cid": str(c.get("cid") or "").strip(),
        "video_id": str(c.get("aweme_id") or video_id or ""),
        "video_url": work_link(DOUYIN, c.get("aweme_id") or video_id),
        "video_title": "",
        "text": str(c.get("text") or "").strip(),
        "likes": parse_count(c.get("digg_count")),
        "time": unix_to_text(c.get("create_time")),
        "ip": str(c.get("ip_label") or "").strip(),
        "level": "回复" if parent else "一级",
        "parent": parent,
        "replies": None if parent else parse_count(c.get("reply_comment_total")),
        "has_image": bool(images),
        "by_author": str(c.get("label_text") or "") == "作者",
        "_user": str(pick(c, "user.uid", "user.nickname") or ""),
    }


def douyin_comments(resp, video_id, parent=None):
    data = _data(resp) or {}
    items = pick(data, "comments", "data.comments")
    if items is None and isinstance(data, dict) and ("comments" in data or "has_more" in data):
        items = []  # 评论关了或者没有评论：抖音返回 comments: null
    if not isinstance(items, list):
        raise ShapeError("没从返回里读到评论列表（data.comments）")
    rows = []
    for c in items:
        if not isinstance(c, dict):
            continue
        row = douyin_comment_row(c, video_id, parent)
        rows.append(row)
        if parent is None:  # 一级评论里平台附带的回复（reply_comment），真采时多是作者的回答：已经花过钱，一起取出来
            for sub in c.get("reply_comment") or []:
                if isinstance(sub, dict):
                    rows.append(douyin_comment_row(sub, video_id, row["cid"] or None))
    return rows, pick(data, "cursor", "data.cursor"), bool(pick(data, "has_more", "data.has_more")), parse_count(pick(data, "total", "data.total"))


# ---------- 小红书（App V2） ----------

def _xhs_inner(resp):
    data = _data(resp)
    if isinstance(data, dict):
        if data.get("success") is False and not data.get("data"):
            raise LookupError("小红书那边说「%s」：多半是链接或编号不对、笔记被删了。（这次请求照样扣了费）"
                              % (data.get("msg") or "服务异常"))
        inner = data.get("data")
        return inner if inner is not None else data
    return data


def xhs_profile(resp):
    inner = _xhs_inner(resp) or {}
    user = inner if isinstance(inner, dict) else {}
    user = pick(user, "user", "basic_info", "basicInfo") or user
    name = pick(user, "nickname", "nick_name", "name")
    if not name:
        raise ShapeError("没从返回里读到小红书博主的昵称")
    followers = parse_count(pick(user, "fans", "fans_count", "fansCount", "follower_count"))
    likes = parse_count(pick(user, "liked", "liked_count"))
    for item in pick(inner, "interactions") or []:
        if isinstance(item, dict) and item.get("type") == "fans" and followers is None:
            followers = parse_count(item.get("count"))
    uid = pick(user, "userid", "user_id", "id")
    return {
        "platform": XHS,
        "name": _clean_title(name),
        "user_id": uid,
        "url": user_link(XHS, uid) or pick(user, "share_link"),
        "handle": pick(user, "red_id", "redId"),
        "bio": str(pick(user, "desc", "description", "signature") or "").strip(),
        "followers": followers,
        "following": parse_count(pick(user, "follows", "follow_count")),
        "likes_total": (likes or 0) + (parse_count(pick(user, "collected", "collected_count")) or 0) or None,
        "works_total": parse_count(pick(user, "ndiscovery", "notes_count", "note_count")),
        "avatar_url": _first_url(pick(user, "images", "imageb", "image", "avatar")),
        "ip_location": place_zh(pick(user, "ip_location", "ipLocation")) or None,
    }


def xhs_note(item):
    nc = pick(item, "note_card", "noteCard", "note") or item
    interact = pick(nc, "interact_info", "interactInfo") or {}
    nid = str(pick(item, "note_id", "noteId", "id") or pick(nc, "note_id", "noteId", "id") or "").strip()
    desc = str(pick(nc, "desc", "content") or "").strip()
    title = _clean_title(pick(nc, "display_title", "displayTitle", "title") or "") or _clean_title(desc)[:40]
    ntype = str(pick(nc, "type", "note_type") or "")
    when = pick(nc, "create_time", "timestamp", "time", "publish_time", "last_update_time")
    duration = parse_count(pick(nc, "video_info_v2.capa.duration"))  # 视频笔记的时长（秒），真实返回在这里
    return {
        "id": nid,
        "url": work_link(XHS, nid),
        "title": title[:80],
        "desc": desc,
        "published_at": unix_to_text(when) if when is not None else None,
        "duration_seconds": duration or None,
        "type": "视频" if ntype == "video" else ("图文" if ntype else None),
        "likes": parse_count(pick(nc, "likes", "liked_count", "like_count") or pick(interact, "liked_count", "likedCount", "likes")),
        "comments": parse_count(pick(nc, "comments_count", "comment_count") or pick(interact, "comment_count", "commentCount")),
        "collects": parse_count(pick(nc, "collected_count", "collects", "fav_count") or pick(interact, "collected_count", "collectedCount")),
        "shares": parse_count(pick(nc, "share_count", "shared_count", "shares") or pick(interact, "share_count", "shared_count", "shareCount")),
        "cover_url": _first_url(pick(nc, "images_list", "image_list", "cover", "images")),
        "pinned": bool(pick(nc, "sticky", "is_top")),
        "tags": _xhs_tags(nc, desc),
        "author": _clean_title(pick(nc, "user.nickname", "user.nick_name")),
        "author_id": pick(nc, "user.userid", "user.user_id", "user.id"),
    }


def _xhs_tags(note, desc):
    """话题：笔记详情里在 hash_tag（[{"name": "生日礼物", "type": "topic"}…]）；没有就从文案里的「#生日礼物[话题]#」认。"""
    names = [str(t.get("name") or "").strip() for t in note.get("hash_tag") or [] if isinstance(t, dict)]
    if not any(names):
        names = re.findall(r"#([^#\[\]\n]+?)\[话题\]#", desc or "")
    out = []
    for name in names:
        if name and name not in out:
            out.append(name)
    return out


def xhs_notes(resp):
    inner = _xhs_inner(resp) or {}
    items = pick(inner, "notes", "items", "data.notes")
    if items is None and isinstance(inner, dict) and "notes" in inner:
        items = []
    if not isinstance(items, list):
        raise ShapeError("没从返回里读到小红书笔记列表（data.data.notes）")
    notes = [xhs_note(n) for n in items if isinstance(n, dict)]
    cursor = pick(inner, "cursor")
    if not cursor and items and isinstance(items[-1], dict):
        cursor = items[-1].get("cursor") or items[-1].get("note_id") or items[-1].get("id")
    return notes, cursor, bool(pick(inner, "has_more", "hasMore"))


def xhs_note_detail(resp):
    inner = _xhs_inner(resp)
    note = None
    if isinstance(inner, list) and inner:
        first = inner[0] if isinstance(inner[0], dict) else {}
        note = pick(first, "note_list.0") or first
        if isinstance(note, dict) and not note.get("user") and isinstance(first.get("user"), dict):
            note = dict(note, user=first["user"])
    elif isinstance(inner, dict):
        note = pick(inner, "note_list.0", "note", "items.0") or inner
    if not isinstance(note, dict) or not (note.get("id") or note.get("note_id") or note.get("title") or note.get("desc")):
        raise ShapeError("没从返回里读到小红书笔记详情")
    work = xhs_note(note)
    work["author_profile"] = {"name": work["author"], "user_id": work["author_id"], "url": user_link(XHS, work["author_id"])}
    return work


def xhs_comment_row(c, note_id, parent=None):
    target = pick(c, "target_comment.id")
    parent = parent or (str(target) if target else None)
    return {
        "cid": str(pick(c, "id", "comment_id") or "").strip(),
        "video_id": str(pick(c, "note_id") or note_id or ""),
        "video_url": work_link(XHS, pick(c, "note_id") or note_id),
        "video_title": "",
        "text": str(pick(c, "content", "text") or "").strip(),
        "likes": parse_count(pick(c, "like_count", "liked_count", "likes")),
        "time": unix_to_text(pick(c, "create_time", "time")),
        "ip": place_zh(pick(c, "ip_location", "ip_label")),
        "level": "回复" if parent else "一级",
        "parent": parent,
        "replies": None if parent else parse_count(pick(c, "sub_comment_count", "reply_count")),
        "has_image": bool(pick(c, "pictures", "images", "image_list")),
        "by_author": _xhs_by_author(c),
        "_user": str(pick(c, "user.userid", "user.user_id", "user.nickname") or ""),
    }


def _xhs_by_author(c):
    """笔记作者本人的评论：真实返回里标记在 show_tags_v2（{"type": "is_author", "text": "Author"}），show_tags 常是空的。"""
    for tag in list(c.get("show_tags") or []) + list(c.get("show_tags_v2") or []):
        kind = tag.get("type") if isinstance(tag, dict) else tag
        if str(kind or "").strip() == "is_author":
            return True
    return bool(pick(c, "is_author"))


def xhs_comments(resp, note_id, parent=None):
    """一页小红书评论 → (行, 下一页要带的参数, 还有没有)。一级评论里自带的几条回复也一起取出来。"""
    inner = _xhs_inner(resp) or {}
    items = pick(inner, "comments", "comment_list", "list")
    if items is None and isinstance(inner, dict) and ("comments" in inner or "has_more" in inner):
        items = []
    if not isinstance(items, list):
        raise ShapeError("没从返回里读到小红书评论列表（data.data.comments）")
    rows = []
    for c in items:
        if not isinstance(c, dict):
            continue
        row = xhs_comment_row(c, note_id, parent)
        rows.append(row)
        for sub in c.get("sub_comments") or []:
            if isinstance(sub, dict):
                rows.append(xhs_comment_row(sub, note_id, row["cid"]))
    cursor = pick(inner, "cursor")
    index = pick(inner, "index")
    area = pick(inner, "pageArea", "page_area")
    if isinstance(cursor, str) and cursor.strip().startswith("{"):
        # 真实返回里 cursor 是一段 JSON 文字：一级评论是 {"contextId":…,"cursor":"…","index":2,"pageArea":"ALL"}，
        # 楼中楼是 {"cursor":"…","index":3}。按官方说明拆开，cursor、index、pageArea 分别带到下一页
        try:
            cursor = json.loads(cursor)
        except ValueError:
            pass
    if isinstance(cursor, dict):
        index = cursor.get("index", index)
        area = cursor.get("pageArea") or area
        cursor = cursor.get("cursor")
    nxt = {"cursor": cursor or "", "index": index, "pageArea": area}
    total = parse_count(pick(inner, "comment_count", "comment_count_l1"))
    return rows, nxt, bool(pick(inner, "has_more", "hasMore")), total
