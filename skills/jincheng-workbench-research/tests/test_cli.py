"""像 AI 那样在终端里跑命令：评论区分析、建对标账号、账号研究、拆视频存进参考拆解；查密钥从不露出来。"""
import json
import os
import re
import unittest

from support import FAKE_KEY, SMA_HEADERS, FakeTikHub, TempWorkbench, load_fixture, ok, run_cli, sma_row, user_info, write_xlsx

VID = "7100000000000000123"
LINK = "https://www.douyin.com/video/%s" % VID


def posts(params):
    page = "dy_posts_1.json" if str(params.get("max_cursor", "0")) == "0" else "dy_posts_2.json"
    return 200, load_fixture(page), 0


def comments(params):
    n = {"0": 1, "20": 2, "40": 3}[str(params.get("cursor", "0"))]
    return 200, load_fixture("dy_comments_%d.json" % n), 0


class CliTest(unittest.TestCase):
    def setUp(self):
        self.wb = TempWorkbench()

    def tearDown(self):
        self.wb.cleanup()

    def server(self):
        s = FakeTikHub({
            "/api/v1/tikhub/user/get_user_info": user_info(),
            "/api/v1/douyin/app/v3/handler_user_profile": lambda p: (200, load_fixture("dy_profile.json", s.base), 0),
            "/api/v1/douyin/app/v3/fetch_user_post_videos": lambda p: (200, load_fixture("dy_posts_1.json" if str(p.get("max_cursor", "0")) == "0" else "dy_posts_2.json", s.base), 0),
            "/api/v1/douyin/app/v3/fetch_one_video": ok(load_fixture("dy_detail.json")),
            "/api/v1/douyin/app/v3/fetch_video_comments": comments,
        })
        return s

    def test_评论区分析_从导出表到报告(self):
        rows = [sma_row("7300000000000000%03d" % i, VID, text, likes, ip=ip) for i, (text, likes, ip) in enumerate([
            ("录音怎么导进去？", 30, "浙江"), ("导不进去+1", 6, "广东"), ("这个要钱吗", 12, "四川"), ("免费能用多久", 8, "北京"),
            ("方言能识别吗", 9, "广东"), ("求纪要模板", 5, "上海"), ("[赞]", 1, "浙江")], 1)]
        write_xlsx(os.path.join(self.wb.imports, "社媒助手评论导出.xlsx"), SMA_HEADERS, rows, str_cells=("评论ID", "视频ID"))
        env = self.wb.env()
        code, out = run_cli(["comments", "find", LINK + "?previous_page=app_code_link"], env)
        self.assertEqual(code, 0, out)
        self.assertIn("社媒助手评论导出.xlsx：7 条", out)
        code, out = run_cli(["comments", "prepare", "社媒助手评论导出.xlsx", "--video", LINK, "--topic", "会议纪要教程评论区"], env)
        self.assertEqual(code, 0, out)
        folders = os.listdir(self.wb.reports)
        self.assertEqual(len(folders), 1)
        self.assertRegex(folders[0], r"^\d{4}-\d{2}-\d{2}_会议纪要教程评论区$")
        folder = os.path.join(self.wb.reports, folders[0])
        self.assertIn("有效 6 条", out)
        code, out = run_cli(["comments", "show", folders[0]], env)
        self.assertEqual(code, 0, out)
        self.assertIn("c1 赞30 一级 浙江", out)
        self.assertNotIn("[赞]", out)

        code, out = run_cli(["comments", "render", folders[0]], env)
        self.assertEqual(code, 2)
        self.assertIn("还没有 分析.json", out)
        with open(os.path.join(folder, "分析.json"), "w", encoding="utf-8") as f:
            json.dump({"title": "错的分析", "takeaways": [{"text": "x", "evidence": ["c42"]}], "topics": [], "categories": []}, f, ensure_ascii=False)
        code, out = run_cli(["comments", "render", folders[0]], env)
        self.assertEqual(code, 2)
        self.assertIn("c42 在评论数据里找不到", out)
        self.assertFalse(os.path.exists(os.path.join(folder, "评论洞察.html")))
        analysis = {
            "title": "会议纪要教程的评论区：导入和收费最让人卡住",
            "takeaways": [{"text": "导入录音是第一道坎", "categories": ["import"]}, {"text": "一半人关心要不要钱", "categories": ["price"]}],
            "topics": [{"title": "手机录音导进去的三种办法", "why": "问导入的最多", "audience": "刚装好的人", "categories": ["import"]}],
            "categories": [{"id": "import", "name": "导入卡住", "kind": "痛点", "summary": "不会导入", "comments": ["c1", "c2"]},
                           {"id": "price", "name": "收费", "kind": "疑问", "summary": "问价格", "comments": ["c3", "c4"]},
                           {"id": "dialect", "name": "方言", "kind": "疑问", "summary": "方言识别", "comments": ["c5"]},
                           {"id": "tpl", "name": "要模板", "kind": "求资料", "summary": "要纪要模板", "comments": ["c6"]}],
        }
        with open(os.path.join(folder, "分析.json"), "w", encoding="utf-8") as f:
            json.dump(analysis, f, ensure_ascii=False)
        code, out = run_cli(["comments", "render", folders[0]], env)
        self.assertEqual(code, 0, out)
        self.assertTrue(os.path.isfile(os.path.join(folder, "评论洞察.html")))
        with open(os.path.join(folder, "meta.json"), encoding="utf-8") as f:
            meta = json.load(f)
        self.assertEqual(meta["type"], "评论洞察")
        self.assertEqual(meta["title"], analysis["title"])
        self.assertEqual(meta["pages"], [{"file": "评论洞察.html", "title": "评论洞察"}])
        self.assertIn("社媒助手评论导出.xlsx", meta["source"])
        self.assertEqual(sorted(os.listdir(folder)), ["meta.json", "分析.json", "评论数据.json", "评论洞察.html"])

    def test_TikHub_建对标账号_再看最近什么最火(self):
        server = self.server()
        try:
            env = self.wb.env(TIKHUB_API_KEY=FAKE_KEY, TIKHUB_BASE_URL=server.base)
            code, out = run_cli(["account", "add", "https://www.douyin.com/user/MS4wLjABAAAAfakeuser01", "--note", "开头抓人", "--tags", "AI,教程"], env)
            self.assertEqual(code, 0, out)
            folder = os.path.join(self.wb.accounts, "抖音-示例博主小林")
            self.assertEqual(set(os.listdir(folder)), {"头像.png", "代表作封面-1.png", "代表作封面-2.png", "代表作封面-3.png", "作品.json", "档案.json"})
            with open(os.path.join(folder, "档案.json"), encoding="utf-8") as f:
                profile = json.load(f)
            self.assertEqual(profile["source"], "tikhub")
            self.assertEqual(profile["followers"], 12800)
            self.assertEqual(profile["tags"], ["AI", "教程"])
            self.assertIn("实际调了 3 次", out)

            code, out = run_cli(["account", "research", "示例博主小林"], env)
            self.assertEqual(code, 0, out)
            self.assertIn("用的是「对标账号」里", out)  # 刚拉过的作品数据直接用，不再花钱
            reports = os.listdir(self.wb.reports)
            self.assertEqual(len(reports), 1)
            with open(os.path.join(self.wb.reports, reports[0], "meta.json"), encoding="utf-8") as f:
                meta = json.load(f)
            self.assertEqual((meta["type"], meta["pages"][0]["file"]), ("账号研究", "账号研究.html"))
            self.assertEqual(len([r for r in server.paid() if "post_videos" in r["path"]]), 2)

            self.assertNotIn(FAKE_KEY, out)
            self.assertNotIn(FAKE_KEY, self.wb.all_text())  # 密钥没写进任何文件
        finally:
            server.close()

    def test_评论超过200条_先要用户同意(self):
        server = self.server()
        try:
            env = self.wb.env(TIKHUB_API_KEY=FAKE_KEY, TIKHUB_BASE_URL=server.base)
            code, out = run_cli(["comments", "fetch", "https://www.douyin.com/video/7400000000000000103", "--max", "300"], env)
            self.assertEqual(code, 3, out)
            self.assertIn("需要用户同意", out)
            self.assertIn("--agreed-budget 0.016", out)
            self.assertEqual(server.paid(), [])  # 一分钱没花
            code, out = run_cli(["comments", "fetch", "https://www.douyin.com/video/7400000000000000103", "--max", "300", "--agreed-budget", "0.016", "--topic", "测试"], env)
            self.assertEqual(code, 0, out)
            self.assertIn("有效 56 条", out)  # 57 条里有一条只有表情
            self.assertNotIn("没认出点赞数", out)
            folder = os.path.join(self.wb.reports, os.listdir(self.wb.reports)[0])
            with open(os.path.join(folder, "评论数据.json"), encoding="utf-8") as f:
                data = json.load(f)
            self.assertEqual(data["source"]["kind"], "TikHub")
            self.assertEqual(data["videos"][0]["title"], "AI 一键做会议纪要，三步搞定")
            self.assertNotIn("虚构用户", json.dumps(data, ensure_ascii=False))
            code, out = run_cli(["comments", "plan", "https://www.douyin.com/video/7400000000000000103"], env)
            self.assertEqual(code, 0, out)
            self.assertIn("可以直接采", out)
        finally:
            server.close()

    def test_没有密钥_只说去数据来源配(self):
        env = self.wb.env()
        code, out = run_cli(["comments", "fetch", LINK], env)
        self.assertEqual(code, 2)
        self.assertIn("数据来源", out)
        self.assertNotIn("Traceback", out)
        self.assertLess(len(out.splitlines()), 4)
        code, out = run_cli(["where"], env)
        self.assertIn("TikHub 密钥：没读到", out)

    def test_密钥只说读到了_不露出来(self):
        server = self.server()
        try:
            env = self.wb.env(TIKHUB_API_KEY=FAKE_KEY, TIKHUB_BASE_URL=server.base)
            code, out = run_cli(["where"], env)
            self.assertIn("已读到（环境变量 TIKHUB_API_KEY）", out)
            code2, out2 = run_cli(["tikhub", "check"], env)
            self.assertEqual(code2, 0, out2)
            self.assertIn("余额：5 美元", out2)
            for text in (out, out2):
                self.assertNotIn(FAKE_KEY, text)
                self.assertNotIn(FAKE_KEY[:12], text)
        finally:
            server.close()

    def test_手动建档(self):
        shot = os.path.join(self.wb.home, "主页.png")
        with open(shot, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\nfake")
        code, out = run_cli(["account", "add", "--manual", "--platform", "视频号", "--name", "某个虚构视频号", "--followers", "8千",
                             "--bio", "讲 AI 工具", "--image", shot], self.wb.env())
        self.assertEqual(code, 0, out)
        folder = os.path.join(self.wb.accounts, "视频号-某个虚构视频号")
        with open(os.path.join(folder, "档案.json"), encoding="utf-8") as f:
            profile = json.load(f)
        self.assertEqual(profile["source"], "manual")
        self.assertNotIn("followers", profile)  # 「8千」读不出来就不写，不瞎猜
        self.assertTrue(os.path.isfile(os.path.join(folder, "主页截图-1.png")))
        code, out = run_cli(["account", "list"], self.wb.env())
        self.assertIn("视频号-某个虚构视频号", out)
        self.assertNotIn("档案有问题", out)

    def test_拆解存进参考拆解_同一条只拆一次(self):
        os.makedirs(os.path.join(self.wb.work, "内容草稿", "T001_AI写周报"))
        md = os.path.join(self.wb.home, "拆解.md")
        with open(md, "w", encoding="utf-8") as f:
            f.write("1. 开头怎么抓人：第一句就给结果。\n")
        env = self.wb.env()
        code, out = run_cli(["video", "save", "--content", "T001", "--file", md, "--link", LINK + "?share=1", "--title", "某博主：三分钟写周报"], env)
        self.assertEqual(code, 0, out)
        path = os.path.join(self.wb.work, "内容草稿", "T001_AI写周报", "参考拆解.md")
        with open(path, encoding="utf-8") as f:
            text = f.read()
        self.assertTrue(text.startswith("# 参考拆解"))
        self.assertIn("## 参考：某博主：三分钟写周报", text)
        code, out = run_cli(["video", "save", "--content", "T001", "--file", md, "--link", "https://www.douyin.com/video/%s" % VID], env)
        self.assertEqual(code, 2)
        self.assertIn("已经拆过了", out)
        code, out = run_cli(["video", "save", "--content", "T009", "--file", md], env)
        self.assertEqual(code, 2)
        self.assertIn("建草稿文件夹", out)

    def test_视频拆解报告(self):
        data = os.path.join(self.wb.home, "拆解.json")
        with open(data, "w", encoding="utf-8") as f:
            json.dump({"title": "拆解：三分钟写周报", "summary": "先给结果", "video": {"platform": "抖音", "url": LINK},
                       "sections": [{"title": "开头怎么抓人", "text": "第一句给结果", "quotes": ["三分钟写完周报"]}]}, f, ensure_ascii=False)
        tr = os.path.join(self.wb.home, "逐字稿.txt")
        with open(tr, "w", encoding="utf-8") as f:
            f.write("今天教你三分钟写完周报。")
        code, out = run_cli(["video", "render", "--data", data, "--transcript", tr], self.wb.env())
        self.assertEqual(code, 0, out)
        folder = os.path.join(self.wb.reports, os.listdir(self.wb.reports)[0])
        self.assertEqual(sorted(os.listdir(folder)), ["meta.json", "拆解.json", "视频拆解.html", "逐字稿.txt"])
        with open(os.path.join(folder, "meta.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["type"], "视频拆解")


if __name__ == "__main__":
    unittest.main()
