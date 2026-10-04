"""TikHub 客户端：读密钥的顺序、单价、花钱前的上限、出错说人话、24 小时缓存。全部对着本机的假 TikHub，不连外网。"""
import json
import os
import subprocess
import tempfile
import unittest
from decimal import Decimal

from support import FAKE_KEY, TEST_SERVICE, FakeTikHub, load_fixture, ok, user_info

from research_kit import NeedsAgreement, UserError
from research_kit import tikhub as T


class FakeRun(object):
    """代替 /usr/bin/security：记下被怎么调用，按设定返回。"""

    def __init__(self, code=0, out="keychain-key-value\n"):
        self.code, self.out, self.calls = code, out, []

    def __call__(self, command, **kwargs):
        self.calls.append(command)
        return subprocess.CompletedProcess(command, self.code, self.out, "")


class KeyTest(unittest.TestCase):
    def test_先读环境变量(self):
        run = FakeRun()
        key, where = T.read_key({"TIKHUB_API_KEY": "  env-key  ", "WORKBENCH_KEYCHAIN_SERVICE": TEST_SERVICE}, run)
        self.assertEqual((key, where), ("env-key", "环境变量 TIKHUB_API_KEY"))
        self.assertEqual(run.calls, [])  # 有环境变量就不碰钥匙串

    def test_没有环境变量再读钥匙串(self):
        run = FakeRun()
        key, where = T.read_key({"WORKBENCH_KEYCHAIN_SERVICE": TEST_SERVICE}, run)
        self.assertEqual((key, where), ("keychain-key-value", "钥匙串"))
        self.assertEqual(run.calls[0], ["/usr/bin/security", "find-generic-password", "-s", TEST_SERVICE, "-a", "tikhub", "-w"])

    def test_都没有(self):
        key, where = T.read_key({"WORKBENCH_KEYCHAIN_SERVICE": TEST_SERVICE}, FakeRun(code=44, out=""))
        self.assertEqual((key, where), (None, None))
        self.assertIn("数据来源", T.no_key_message())

    def test_默认的钥匙串条目和工作台约定的一样(self):
        self.assertEqual(T.keychain_service({}), "tikhub-api")
        self.assertEqual(T.keychain_command("tikhub-api")[3:7], ["tikhub-api", "-a", "tikhub", "-w"])

    def test_Bearer_前缀去掉(self):
        key, _ = T.read_key({"TIKHUB_API_KEY": "Bearer abc"}, FakeRun())
        self.assertEqual(key, "abc")

    def test_只用_api_tikhub_io(self):
        self.assertEqual(T.base_url({}), "https://api.tikhub.io")
        self.assertEqual(T.base_url({"TIKHUB_BASE_URL": "https://api.tikhub.dev"}), "https://api.tikhub.io")
        self.assertEqual(T.base_url({"TIKHUB_BASE_URL": "https://evil.example.com"}), "https://api.tikhub.io")
        self.assertEqual(T.base_url({"TIKHUB_BASE_URL": "http://127.0.0.1:9/"}), "http://127.0.0.1:9")


class PlanTest(unittest.TestCase):
    def setUp(self):
        self.prices = T.Prices(live=False)
        self.ledger = T.Ledger(os.path.join(tempfile.mkdtemp(), "用量.jsonl"))

    def plan(self, comments=200, platform="抖音"):
        plan = T.Plan(platform, "测试")
        plan.add("/api/v1/douyin/app/v3/fetch_one_video", 1, "详情")
        plan.add("/api/v1/douyin/app/v3/fetch_video_comments", -(-comments // 20), "一级评论")
        plan.comments_over_default = comments > 200
        return plan

    def test_默认200条一级评论在上限以内(self):
        cost, head = T.check_plan(self.plan(), self.prices, self.ledger)
        self.assertEqual(cost, Decimal("0.011"))
        self.assertIn("11 次", head)
        self.assertIn("2026-10-03", head)  # 没现查时说清楚用的是哪天记下的单价

    def test_超过200条要用户同意(self):
        with self.assertRaises(NeedsAgreement) as ctx:
            T.check_plan(self.plan(300), self.prices, self.ledger)
        self.assertIn("超过默认的 200 条", str(ctx.exception))
        self.assertIn("--agreed-budget 0.016", str(ctx.exception))
        cost, _ = T.check_plan(self.plan(300), self.prices, self.ledger, agreed=0.016)
        self.assertEqual(cost, Decimal("0.016"))
        with self.assertRaises(NeedsAgreement) as ctx:
            T.check_plan(self.plan(300), self.prices, self.ledger, agreed=0.01)
        self.assertIn("比这次最多要花的", str(ctx.exception))

    def test_小红书每次都要先问(self):
        plan = T.Plan("小红书", "测试")
        plan.add("/api/v1/xiaohongshu/app_v2/get_note_comments", 1, "评论")
        with self.assertRaises(NeedsAgreement) as ctx:
            T.check_plan(plan, self.prices, self.ledger)
        self.assertIn("不能用新账号送的试用额度", str(ctx.exception))

    def test_单次超过自动上限(self):
        plan = T.Plan("抖音", "测试")
        plan.add("/api/v1/douyin/app/v3/fetch_video_comment_replies", 30, "楼中楼")
        with self.assertRaises(NeedsAgreement) as ctx:
            T.check_plan(plan, self.prices, self.ledger)
        self.assertIn("单次自动花费上限", str(ctx.exception))

    def test_当天累计超过上限(self):
        for _ in range(195):
            self.ledger.add("/api/v1/douyin/app/v3/fetch_video_comments", 200, Decimal("0.001"))
        self.ledger.add("/api/v1/douyin/app/v3/fetch_video_comments", 401, Decimal("0"))  # 报错的不算钱
        self.assertEqual(self.ledger.spent_today(), Decimal("0.195"))
        with self.assertRaises(NeedsAgreement) as ctx:
            T.check_plan(self.plan(), self.prices, self.ledger)
        self.assertIn("今天已经用了约 0.195 美元", str(ctx.exception))


class ClientTest(unittest.TestCase):
    def setUp(self):
        self.hidden = tempfile.mkdtemp(prefix="research-hidden-")
        self.ledger = T.Ledger(os.path.join(self.hidden, "用量.jsonl"))
        self.sleeps = []

    def client(self, server, **kw):
        prices = T.Prices(server.base)
        c = T.Client(FAKE_KEY, base=server.base, ledger=self.ledger, prices=prices, sleep=self.sleeps.append, timeout=kw.pop("timeout", 5), **kw)
        return c

    def test_成功时带上密钥_记用量(self):
        server = FakeTikHub({"/api/v1/douyin/app/v3/fetch_one_video": ok(load_fixture("dy_detail.json"))})
        try:
            body = self.client(server).get("/api/v1/douyin/app/v3/fetch_one_video", {"aweme_id": "7400000000000000103"})
            self.assertEqual(body["data"]["aweme_detail"]["aweme_id"], "7400000000000000103")
            paid = server.paid()[0]
            self.assertEqual(paid["auth"], "Bearer " + FAKE_KEY)
            price_lookups = [r for r in server.requests if r["path"].endswith("get_endpoint_info")]
            self.assertTrue(price_lookups and all(r["auth"] is None for r in price_lookups))  # 查单价不带密钥
            with open(self.ledger.path, encoding="utf-8") as f:
                text = f.read()
            self.assertIn('"cost_usd": "0.001"', text)
            self.assertNotIn(FAKE_KEY, text)
            self.assertNotIn("7400000000000000103", text)  # 用量里不记参数
        finally:
            server.close()

    def test_出错说人话_不重试(self):
        cases = {401: "密钥不对", 402: "余额不够", 403: "邮箱还没验证", 404: "找不到这条内容", 400: "参数不对"}
        for status, words in cases.items():
            server = FakeTikHub({"/api/v1/douyin/app/v3/fetch_video_comments": lambda p, s=status: (s, {"detail": {"code": s, "message": "x"}}, 0)})
            try:
                with self.assertRaises(T.TikHubError) as ctx:
                    self.client(server).get("/api/v1/douyin/app/v3/fetch_video_comments", {"aweme_id": "1"})
                self.assertIn(words, str(ctx.exception))
                self.assertEqual(ctx.exception.charged, "none")
                self.assertNotIn(FAKE_KEY, str(ctx.exception))
                self.assertEqual(len(server.paid()), 1)
            finally:
                server.close()

    def test_小红书余额不够_提醒不能用试用额度(self):
        server = FakeTikHub({"/api/v1/xiaohongshu/app_v2/get_note_comments": lambda p: (402, {"detail": {"message": "Insufficient balance"}}, 0)})
        try:
            with self.assertRaises(T.TikHubError) as ctx:
                self.client(server).get("/api/v1/xiaohongshu/app_v2/get_note_comments", {"note_id": "x"})
            self.assertIn("不能用新账号送的试用额度", str(ctx.exception))
            self.assertIn("add-credit", str(ctx.exception))
        finally:
            server.close()

    def test_限流和服务器出错_等一下重试(self):
        state = {"n": 0}

        def flaky(params):
            state["n"] += 1
            return (429, {"detail": "slow down"}, 0) if state["n"] == 1 else (200, load_fixture("dy_detail.json"), 0)
        server = FakeTikHub({"/api/v1/douyin/app/v3/fetch_one_video": flaky, "/api/v1/douyin/app/v3/fetch_video_comments": lambda p: (502, {}, 0)})
        try:
            c = self.client(server)
            c.get("/api/v1/douyin/app/v3/fetch_one_video", {"aweme_id": "1"})
            self.assertEqual(self.sleeps, [2])
            with self.assertRaises(T.TikHubError) as ctx:
                c.get("/api/v1/douyin/app/v3/fetch_video_comments", {"aweme_id": "1"})
            self.assertIn("出错的请求不扣钱", str(ctx.exception))
            self.assertEqual(len([r for r in server.paid() if r["path"].endswith("fetch_video_comments")]), 3)
        finally:
            server.close()

    def test_超时_说不确定扣没扣钱_不重试(self):
        server = FakeTikHub({"/api/v1/douyin/app/v3/fetch_one_video": lambda p: (200, {"data": {}}, 2)})
        try:
            with self.assertRaises(T.TikHubError) as ctx:
                self.client(server, timeout=0.5).get("/api/v1/douyin/app/v3/fetch_one_video", {"aweme_id": "1"})
            self.assertEqual(ctx.exception.charged, "unknown")
            self.assertIn("可能已经扣了钱", str(ctx.exception))
            self.assertEqual(len(server.paid()), 1)
        finally:
            server.close()

    def test_连不上_说检查网络(self):
        server = FakeTikHub()
        base = server.base
        server.close()
        c = T.Client(FAKE_KEY, base=base, ledger=self.ledger, prices=T.Prices(live=False), sleep=self.sleeps.append, timeout=2)
        with self.assertRaises(T.TikHubError) as ctx:
            c.get("/api/v1/douyin/app/v3/fetch_one_video", {"aweme_id": "1"})
        self.assertIn("连不上 TikHub", str(ctx.exception))
        self.assertIn("没有扣钱", str(ctx.exception))

    def test_24小时内同样的请求不重复花钱(self):
        server = FakeTikHub({"/api/v1/douyin/app/v3/fetch_one_video": ok(load_fixture("dy_detail.json"))})
        try:
            cache = os.path.join(self.hidden, "缓存")
            c1 = self.client(server, cache_dir=cache)
            c1.get("/api/v1/douyin/app/v3/fetch_one_video", {"aweme_id": "1"})
            c2 = self.client(server, cache_dir=cache)
            c2.get("/api/v1/douyin/app/v3/fetch_one_video", {"aweme_id": "1"})
            self.assertEqual(len(server.paid()), 1)
            self.assertEqual(c2.calls, 0)
            c3 = self.client(server, cache_dir=cache, refresh=True)
            c3.get("/api/v1/douyin/app/v3/fetch_one_video", {"aweme_id": "1"})
            self.assertEqual(len(server.paid()), 2)
            for name in os.listdir(cache):
                with open(os.path.join(cache, name), encoding="utf-8") as f:
                    self.assertNotIn(FAKE_KEY, f.read())
        finally:
            server.close()

    def test_到了计划的次数就停(self):
        server = FakeTikHub({"/api/v1/douyin/app/v3/fetch_one_video": ok(load_fixture("dy_detail.json"))})
        try:
            c = self.client(server)
            c.limit_calls = 1
            c.get("/api/v1/douyin/app/v3/fetch_one_video", {"aweme_id": "1"})
            with self.assertRaises(UserError):
                c.get("/api/v1/douyin/app/v3/fetch_one_video", {"aweme_id": "2"})
            self.assertEqual(len(server.paid()), 1)
        finally:
            server.close()

    def test_单价现查_查不到用兜底(self):
        server = FakeTikHub(prices={"/api/v1/douyin/app/v3/fetch_video_comments": (0.002, True)})
        try:
            prices = T.Prices(server.base)
            self.assertEqual(prices.get("/api/v1/douyin/app/v3/fetch_video_comments"), (Decimal("0.002"), True))
            self.assertIn("刚从 TikHub 官方", prices.source_text())
        finally:
            server.close()
        dead = T.Prices("http://127.0.0.1:9", timeout=1)
        self.assertEqual(dead.get("/api/v1/douyin/app/v3/fetch_video_comments"), (Decimal("0.001"), True))
        self.assertEqual(dead.get("/api/v1/douyin/app/v3/fetch_user_post_videos"), (Decimal("0.001"), False))
        self.assertIn("2026-10-03", dead.source_text())

    def test_只有试用额度时_不能用试用额度的接口先拦下(self):
        server = FakeTikHub({"/api/v1/tikhub/user/get_user_info": user_info(balance=0, free=0.05)},
                            prices={"/api/v1/douyin/app/v3/fetch_user_post_videos": (0.001, False)})
        try:
            c = self.client(server)
            plan = T.Plan("抖音", "测试").add("/api/v1/douyin/app/v3/fetch_user_post_videos", 2, "作品列表")
            with self.assertRaises(T.TikHubError) as ctx:
                T.check_balance(c, plan, c.prices, plan.cost(c.prices))
            self.assertIn("不能用新账号送的试用额度", str(ctx.exception))
            self.assertEqual(server.paid(), [])  # 一分钱没花
        finally:
            server.close()

    def test_打印客户端不露密钥(self):
        c = T.Client(FAKE_KEY, base="http://127.0.0.1:9", prices=T.Prices(live=False))
        self.assertNotIn(FAKE_KEY, repr(c))
        self.assertNotIn(FAKE_KEY, json.dumps(c.__dict__, default=str).replace('"_key": "%s"' % FAKE_KEY, ""))


if __name__ == "__main__":
    unittest.main()
