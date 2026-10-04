"""用 TikHub 采数据的几条路：博主资料和作品、评论（只要一级 / 连楼中楼）、作品详情；抖音和小红书。对着本机的假 TikHub。"""
import os
import unittest

from support import (FAKE_KEY, XHS_NOTE, FakeTikHub, TempWorkbench, dy_comment, dy_page, load_fixture, ok, user_info,
                     xhs_comment, xhs_page)

from research_kit import NeedsAgreement, UserError
from research_kit import collect as C
from research_kit import comments as CM
from research_kit import places as PL
from research_kit.platforms import parse_target

DY_USER = "https://www.douyin.com/user/MS4wLjABAAAAfakeuser01?from_tab_name=main"
DY_VIDEO = "https://www.douyin.com/video/7400000000000000103"
XHS_PRICES = {p: (0.01, False) for p in C.XH.values()}


def posts(params):
    page = "dy_posts_1.json" if str(params.get("max_cursor", "0")) == "0" else "dy_posts_2.json"
    return 200, load_fixture(page), 0


def comments(params):
    n = {"0": 1, "20": 2, "40": 3}[str(params.get("cursor", "0"))]
    return 200, load_fixture("dy_comments_%d.json" % n), 0


class CollectTest(unittest.TestCase):
    def setUp(self):
        self.wb = TempWorkbench()

    def tearDown(self):
        self.wb.cleanup()

    def session(self, server, **routes):
        env = self.wb.env(TIKHUB_API_KEY=FAKE_KEY, TIKHUB_BASE_URL=server.base, RESEARCH_PRICE_LOOKUP="1")
        places = PL.settings(env)
        return C.Session(places, env, sleep=lambda s: None), places

    def dy_server(self, **extra):
        routes = {
            "/api/v1/tikhub/user/get_user_info": user_info(),
            "/api/v1/douyin/web/get_sec_user_id": ok({"code": 200, "data": "MS4wLjABAAAAfakeuser01"}),
            "/api/v1/douyin/app/v3/handler_user_profile": ok(load_fixture("dy_profile.json")),
            "/api/v1/douyin/app/v3/fetch_user_post_videos": posts,
            "/api/v1/douyin/app/v3/fetch_one_video": ok(load_fixture("dy_detail.json")),
            "/api/v1/douyin/app/v3/fetch_one_video_by_share_url": ok(load_fixture("dy_detail.json")),
            "/api/v1/douyin/app/v3/fetch_video_comments": comments,
            "/api/v1/douyin/app/v3/fetch_video_comment_replies": ok(load_fixture("dy_replies.json")),
        }
        routes.update(extra)
        return FakeTikHub(routes)

    def test_抖音博主资料和最近30条作品(self):
        server = self.dy_server()
        try:
            session, _ = self.session(server)
            target = parse_target(DY_USER)
            plan = C.account_plan(target, 30)
            self.assertEqual(plan.requests, 3)  # 主页链接里有编号，不用再花钱认
            session.start(plan)
            profile, works = C.fetch_account(session, target, 30)
            self.assertEqual(profile["name"], "示例博主小林")
            self.assertEqual(profile["followers"], 12800)
            self.assertEqual(profile["url"], "https://www.douyin.com/user/MS4wLjABAAAAfakeuser01")
            self.assertEqual(len(works), 30)
            self.assertEqual(works[0]["likes"], 637)
            self.assertEqual(works[0]["url"], "https://www.douyin.com/video/7400000000000000101")
            self.assertEqual([r["path"].rsplit("/", 1)[-1] for r in server.paid()], ["handler_user_profile", "fetch_user_post_videos", "fetch_user_post_videos"])
        finally:
            server.close()

    def test_抖音短链接先认出博主(self):
        server = self.dy_server()
        try:
            session, _ = self.session(server)
            target = parse_target("长按复制此条消息 https://v.douyin.com/AbCdEf1/ 打开抖音")
            plan = C.account_plan(target, 10)
            self.assertEqual(plan.requests, 3)
            session.start(plan)
            profile, works = C.fetch_account(session, target, 10)
            self.assertEqual(server.paid()[0]["params"]["url"], "https://v.douyin.com/AbCdEf1/")
            self.assertEqual(len(works), 10)
        finally:
            server.close()

    def test_抖音评论_默认只要一级(self):
        server = self.dy_server()
        try:
            session, _ = self.session(server)
            target = parse_target(DY_VIDEO)
            plan = C.comments_plan(target, 200)
            self.assertEqual(plan.requests, 11)
            session.start(plan)
            rows, info, notes = C.fetch_comments(session, target, 200)
            self.assertEqual(len(rows), 57)
            self.assertTrue(all(r["level"] == "一级" for r in rows))
            self.assertEqual(info["title"], "AI 一键做会议纪要，三步搞定")
            self.assertEqual(info["comment_count"], 260)
            self.assertEqual(notes, [])
            self.assertEqual(session.client.calls, 4)  # 详情 1 次 + 评论 3 页，用不完计划的 11 次
            self.assertEqual(rows[0]["ip"], "广东")
        finally:
            server.close()

    def test_抖音评论_条数到了就停(self):
        server = self.dy_server()
        try:
            session, _ = self.session(server)
            target = parse_target(DY_VIDEO)
            session.start(C.comments_plan(target, 30))
            rows, _info, notes = C.fetch_comments(session, target, 30)
            self.assertEqual(len(rows), 30)
            self.assertIn("还没取完", notes[0])
        finally:
            server.close()

    def test_抖音评论_连楼中楼(self):
        server = self.dy_server()
        try:
            session, _ = self.session(server)
            target = parse_target(DY_VIDEO)
            plan = C.comments_plan(target, 200, replies=True)
            self.assertEqual(plan.requests, 1 + 56)  # 按每次约 3.6 条估
            with self.assertRaises(NeedsAgreement) as ctx:
                session.start(plan)
            self.assertIn("--agreed-budget 0.057", str(ctx.exception))
            session.start(plan, agreed=0.057)
            rows, _info, notes = C.fetch_comments(session, target, 200, replies=True)
            # 假 TikHub 不管问哪条评论都给同样 3 条回复：重复的照样交出去，整理成评论数据时去重、算进「重复」
            dataset = CM.build_dataset(rows, {"recognized": {}, "unused": [], "unrecognized": []}, "抖音", {"kind": "TikHub"})
            replies = [c for c in dataset["comments"] if c["level"] == "回复"]
            self.assertEqual(len(replies), 3)
            self.assertTrue(all(r["parent"] == "7300000000000000001" for r in replies))
            self.assertTrue(any(r.get("by_author") for r in replies))
            self.assertEqual(dataset["stats"]["duplicates"], len(rows) - len(dataset["comments"]))
            self.assertIn("重复", "".join(notes))
        finally:
            server.close()

    def test_抖音翻页给了重复的_去重后计数_说明写清(self):
        # 真采时第 2 页 20 条里有 13 条是第 1 页给过的：照这个样子虚构
        first = [dy_comment("76%017d" % i, "第一页第 %d 条评论" % i) for i in range(1, 21)]
        second = [first[i] for i in (0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 1, 3, 5)]
        second += [dy_comment("76%017d" % i, "第二页新的第 %d 条" % i) for i in range(21, 28)]

        def pages(params):
            if str(params.get("cursor", "0")) == "0":
                return 200, dy_page(first, cursor=20), 0
            return 200, dy_page(second, cursor=40), 0

        server = self.dy_server(**{"/api/v1/douyin/app/v3/fetch_video_comments": pages})
        try:
            session, _ = self.session(server)
            target = parse_target(DY_VIDEO)
            session.start(C.comments_plan(target, 40))
            rows, _info, notes = C.fetch_comments(session, target, 40)
            self.assertEqual(session.client.calls, 3)  # 详情 1 次 + 评论 2 页，计划就这么多
            self.assertEqual(len(rows), 40)
            dataset = CM.build_dataset(rows, {"recognized": {}, "unused": [], "unrecognized": []}, "抖音", {"kind": "TikHub"})
            self.assertEqual((dataset["stats"]["rows_in"], dataset["stats"]["duplicates"], len(dataset["comments"])), (40, 13, 27))
            text = "".join(notes)
            self.assertIn("请求次数用完了", text)  # 不是「到了条数上限」：只拿到 27 条
            self.assertIn("13 条是重复的", text)
            self.assertIn("一共 27 条", text)
        finally:
            server.close()

    def test_抖音一级评论_条数够了说到了上限(self):
        first = [dy_comment("77%017d" % i, "第 %d 条" % i) for i in range(1, 21)]
        server = self.dy_server(**{"/api/v1/douyin/app/v3/fetch_video_comments": ok(dy_page(first, cursor=20))})
        try:
            session, _ = self.session(server)
            target = parse_target(DY_VIDEO)
            session.start(C.comments_plan(target, 15))
            rows, _info, notes = C.fetch_comments(session, target, 15)
            self.assertEqual(len(rows), 15)
            self.assertEqual(notes, ["评论还没取完：到了这次的条数上限就停了。"])
        finally:
            server.close()

    def test_抖音连楼中楼_附带过全部回复的不再花钱去拉(self):
        answer = dy_comment("7800000000000000102", "手动删了就可以了", parent="7800000000000000101", author=True)
        covered = dy_comment("7800000000000000101", "卸载后删不掉", replies=1, preview=[answer])  # 1 条回复已经附带了
        open_thread = dy_comment("7800000000000000201", "两台电脑怎么同步", replies=2)  # 2 条回复一条都没附带
        top = [covered, open_thread] + [dy_comment("78000000000000%05d" % i, "第 %d 条" % i) for i in range(1, 19)]
        replies = {"code": 200, "data": {"status_code": 0, "cursor": 2, "has_more": 0, "total": 2, "comments": [
            dy_comment("7800000000000000202", "本地数据不同步", parent="7800000000000000201", author=True),
            dy_comment("7800000000000000203", "同问", parent="7800000000000000201")]}}
        server = self.dy_server(**{"/api/v1/douyin/app/v3/fetch_video_comments": ok(dy_page(top, cursor=20, has_more=False)),
                                   "/api/v1/douyin/app/v3/fetch_video_comment_replies": ok(replies)})
        try:
            session, _ = self.session(server)
            target = parse_target(DY_VIDEO)
            session.start(C.comments_plan(target, 40, replies=True))
            rows, _info, _notes = C.fetch_comments(session, target, 40, replies=True)
            asked = [r["params"].get("comment_id") for r in server.paid() if r["path"].endswith("fetch_video_comment_replies")]
            self.assertEqual(asked, ["7800000000000000201"])
            self.assertEqual(sorted(r["cid"] for r in rows if r["level"] == "回复"), ["7800000000000000102", "7800000000000000202", "7800000000000000203"])
        finally:
            server.close()

    def test_小红书只要一级时_附带的回复不占名额(self):
        # 真采时一页是 10 条一级评论、7 条附带的回复；原来按 10 行截断，丢了后面 5 条一级评论
        tops = []
        for i in range(1, 11):
            subs = [xhs_comment("6b5000000000000000%06d" % (100 + i), "作者回复 %d" % i)] if i <= 7 else []
            tops.append(xhs_comment("6b5000000000000000%06d" % i, "一级评论 %d" % i, subs=subs, sub_count=len(subs)))
        server = FakeTikHub({"/api/v1/tikhub/user/get_user_info": user_info(),
                             "/api/v1/xiaohongshu/app_v2/get_note_comments": ok(xhs_page(tops))}, prices=XHS_PRICES)
        try:
            session, _ = self.session(server)
            target = parse_target("https://www.xiaohongshu.com/explore/%s" % XHS_NOTE)
            session.start(C.comments_plan(target, 10), agreed=0.01)
            rows, _info, notes = C.fetch_comments(session, target, 10)
            self.assertEqual(sum(1 for r in rows if r["level"] == "一级"), 10)
            self.assertEqual(sum(1 for r in rows if r["level"] == "回复"), 7)
            self.assertEqual(notes, ["评论还没取完：到了这次的条数上限就停了。"])
            self.assertEqual(len(server.paid()), 1)
        finally:
            server.close()

    def test_作品看不了_说清楚(self):
        server = self.dy_server(**{"/api/v1/douyin/app/v3/fetch_one_video": ok(load_fixture("dy_filtered.json"))})
        try:
            session, _ = self.session(server)
            target = parse_target("https://www.douyin.com/video/7400000000000000999")
            session.start(C.video_plan(target))
            with self.assertRaises(UserError) as ctx:
                C.fetch_video(session, target)
            self.assertIn("已删除", str(ctx.exception))
            self.assertIn("计费", str(ctx.exception))
        finally:
            server.close()

    def test_返回的样子不对_存下原始返回(self):
        server = self.dy_server(**{"/api/v1/douyin/app/v3/fetch_one_video": ok({"code": 200, "data": {"weird": True}})})
        try:
            session, places = self.session(server)
            target = parse_target(DY_VIDEO)
            session.start(C.video_plan(target))
            with self.assertRaises(UserError) as ctx:
                C.fetch_video(session, target)
            self.assertIn("样子和预期的不一样", str(ctx.exception))
            saved = os.listdir(os.path.join(places["hidden"], "原始返回"))
            self.assertEqual(len(saved), 1)
            with open(os.path.join(places["hidden"], "原始返回", saved[0]), encoding="utf-8") as f:
                self.assertNotIn(FAKE_KEY, f.read())
        finally:
            server.close()

    def test_小红书评论_要先同意_一级里带的回复也取出来(self):
        server = FakeTikHub({"/api/v1/tikhub/user/get_user_info": user_info(),
                             "/api/v1/xiaohongshu/app_v2/get_note_comments": ok(load_fixture("xhs_comments.json"))}, prices=XHS_PRICES)
        try:
            session, _ = self.session(server)
            target = parse_target("https://www.xiaohongshu.com/explore/660000000000000000000001?xsec_token=abc")
            plan = C.comments_plan(target, 200)
            with self.assertRaises(NeedsAgreement):
                session.start(plan)
            session.start(plan, agreed=0.2)
            rows, info, _ = C.fetch_comments(session, target, 200)
            self.assertEqual(len(rows), 11)
            sub = [r for r in rows if r["level"] == "回复"]
            self.assertEqual(sub[0]["parent"], "670000000000000000000001")
            self.assertEqual(info["comment_count"], 12)
            self.assertEqual(server.paid()[0]["params"]["note_id"], "660000000000000000000001")
            self.assertEqual(server.paid()[0]["params"]["sort_strategy"], "like_count")
        finally:
            server.close()

    def test_小红书评论翻页_游标里的三样分别带上(self):
        def pages(params):
            if not params.get("cursor"):
                first = [xhs_comment("6b4000000000000000%06d" % i, "第一页第 %d 条" % i) for i in range(1, 11)]
                return 200, xhs_page(first, cursor={"contextId": "fake-context", "cursor": "6b4000000000000000000010", "index": 2, "pageArea": "ALL"}), 0
            second = [xhs_comment("6b4000000000000000%06d" % i, "第二页第 %d 条" % i) for i in range(11, 21)]
            return 200, xhs_page(second, has_more=False), 0

        server = FakeTikHub({"/api/v1/tikhub/user/get_user_info": user_info(),
                             "/api/v1/xiaohongshu/app_v2/get_note_comments": pages}, prices=XHS_PRICES)
        try:
            session, _ = self.session(server)
            target = parse_target("https://www.xiaohongshu.com/explore/%s" % XHS_NOTE)
            session.start(C.comments_plan(target, 20), agreed=0.02)
            rows, _info, _notes = C.fetch_comments(session, target, 20)
            self.assertEqual(len(rows), 20)
            first, second = [r["params"] for r in server.paid()]
            self.assertEqual((first["cursor"], first["index"], first["pageArea"]), ("", "0", "UNFOLDED"))
            self.assertEqual((second["cursor"], second["index"], second["pageArea"]), ("6b4000000000000000000010", "2", "ALL"))
        finally:
            server.close()

    def test_小红书服务异常_照样扣费要说清(self):
        server = FakeTikHub({"/api/v1/tikhub/user/get_user_info": user_info(),
                             "/api/v1/xiaohongshu/app_v2/get_note_comments": ok(load_fixture("xhs_service_error.json"))}, prices=XHS_PRICES)
        try:
            session, _ = self.session(server)
            target = parse_target("https://www.xiaohongshu.com/explore/660000000000000000000001")
            session.start(C.comments_plan(target, 10), agreed=0.01)
            with self.assertRaises(UserError) as ctx:
                C.fetch_comments(session, target, 10)
            self.assertIn("服务异常", str(ctx.exception))
            self.assertIn("计费", str(ctx.exception))
        finally:
            server.close()

    def test_小红书博主和笔记(self):
        server = FakeTikHub({"/api/v1/tikhub/user/get_user_info": user_info(),
                             "/api/v1/xiaohongshu/app_v2/get_user_info": ok(load_fixture("xhs_user.json")),
                             "/api/v1/xiaohongshu/app_v2/get_user_posted_notes": ok(load_fixture("xhs_notes.json"))}, prices=XHS_PRICES)
        try:
            session, _ = self.session(server)
            target = parse_target("https://www.xiaohongshu.com/user/profile/5f0000000000000000000001")
            plan = C.account_plan(target, 30)
            session.start(plan, agreed=1)
            profile, works = C.fetch_account(session, target, 30)
            self.assertEqual(profile["name"], "虚构的小红书博主阿青")
            self.assertEqual(profile["followers"], 32000)
            self.assertEqual(len(works), 8)
            self.assertEqual(works[0]["type"], "视频")
            self.assertEqual(works[0]["likes"], 350)
            self.assertTrue(works[0]["published_at"].startswith("2026-09-28"))
        finally:
            server.close()

    def test_小红书笔记详情(self):
        server = FakeTikHub({"/api/v1/tikhub/user/get_user_info": user_info(),
                             "/api/v1/xiaohongshu/app_v2/get_image_note_detail": ok(load_fixture("xhs_note_detail.json"))}, prices=XHS_PRICES)
        try:
            session, _ = self.session(server)
            target = parse_target("https://www.xiaohongshu.com/discovery/item/660000000000000000000001")
            session.start(C.video_plan(target), agreed=0.01)
            work = C.fetch_video(session, target)
            self.assertEqual(work["title"], "虚构笔记：AI 做会议纪要的三个坑")
            self.assertEqual(work["collects"], 640)
            self.assertEqual(work["author"], "虚构的小红书博主阿青")  # 作者在外面一层，也认得出来
        finally:
            server.close()

    def test_没有密钥_说去数据来源配(self):
        env = self.wb.env()
        with self.assertRaises(UserError) as ctx:
            C.Session(PL.settings(env), env, run=lambda *a, **k: __import__("subprocess").CompletedProcess(a, 44, "", ""))
        self.assertIn("数据来源", str(ctx.exception))

    def test_别的平台_说用社媒助手或手动(self):
        with self.assertRaises(UserError) as ctx:
            C.comments_plan(parse_target("https://www.bilibili.com/video/BV1xx411c7mD"), 200)
        self.assertIn("社媒助手", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
