"""对标账号：档案.json 的格式、更新时保留备注、图片、社媒助手的博主作品表、账号研究的算法。"""
import json
import os
import tempfile
import unittest

from support import FakeTikHub, load_fixture, write_xlsx

from research_kit import UserError
from research_kit import accounts as A
from research_kit import platforms as P

URL = "https://www.douyin.com/user/MS4wLjABAAAAfakeuser01"


class ProfileTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="research-accounts-")

    def read(self, folder):
        with open(os.path.join(folder, "档案.json"), encoding="utf-8") as f:
            return json.load(f)

    def test_手动建档_格式和约定一致(self):
        folder, created = A.save_profile(self.dir, "抖音", "示例博主/小林", URL + "?from=share", note="讲 AI 办公", tags="AI办公, 教程、#效率",
                                         followers="1.2万", bio="每天一个小技巧", source="manual")
        self.assertTrue(created)
        self.assertEqual(os.path.basename(folder), "抖音-示例博主 小林")  # 斜杠不能进文件夹名
        data = self.read(folder)
        self.assertEqual(list(data), ["platform", "account_name", "url", "note", "tags", "updated_at", "followers", "bio", "source"])
        self.assertEqual(A.check_profile(data), [])
        self.assertEqual(data["tags"], ["AI办公", "教程", "效率"])
        self.assertEqual(data["followers"], 12000)
        self.assertEqual(data["source"], "manual")

    def test_没有粉丝数和简介时_可选的键不写(self):
        folder, _ = A.save_profile(self.dir, "视频号", "某个视频号", "", source="manual")
        data = self.read(folder)
        self.assertNotIn("followers", data)
        self.assertNotIn("bio", data)
        self.assertEqual(data["tags"], [])
        self.assertEqual(A.check_profile(data), [])

    def test_再拉一次_备注和标签留着(self):
        folder, _ = A.save_profile(self.dir, "抖音", "示例博主小林", URL, note="他的开头很好", tags=["开头"], source="manual")
        again, created = A.save_profile(self.dir, "抖音", "示例博主小林（改了名）", URL + "?x=1", followers=13000, source="tikhub")
        self.assertFalse(created)
        self.assertEqual(again, folder)  # 同一个链接就是同一个人，改名也不新建
        data = self.read(folder)
        self.assertEqual((data["note"], data["tags"], data["followers"], data["source"]), ("他的开头很好", ["开头"], 13000, "tikhub"))
        self.assertEqual(data["account_name"], "示例博主小林（改了名）")

    def test_同名不同人_不覆盖(self):
        a, _ = A.save_profile(self.dir, "抖音", "小林", "https://www.douyin.com/user/MS4wLjABAAAAaaaa01", source="manual")
        b, created = A.save_profile(self.dir, "抖音", "小林", "https://www.douyin.com/user/MS4wLjABAAAAbbbb02", source="manual")
        self.assertTrue(created)
        self.assertNotEqual(a, b)

    def test_核对档案_挑出不合约定的(self):
        problems = A.check_profile({"platform": "抖音", "account_name": "", "url": 3, "note": "", "tags": "a", "updated_at": "昨天",
                                    "followers": -1, "source": "web", "extra": 1})
        text = "；".join(problems)
        for words in ("account_name", "url 要是文字", "tags 要是文字数组", "updated_at", "followers", "source 只能是", "多了约定以外的键 extra"):
            self.assertIn(words, text)

    def test_截图复制进来_按顺序编号(self):
        folder, _ = A.save_profile(self.dir, "小红书", "阿青", "", source="manual")
        shot = os.path.join(self.dir, "截图.PNG")
        with open(shot, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\nfake")
        saved = A.copy_images([shot, shot], folder, "主页截图")
        self.assertEqual([os.path.basename(s) for s in saved], ["主页截图-1.png", "主页截图-2.png"])
        with self.assertRaises(UserError):
            A.copy_images([os.path.join(self.dir, "没有这个.png")], folder, "主页截图")

    def test_下载头像和代表作封面(self):
        server = FakeTikHub()
        try:
            folder, _ = A.save_profile(self.dir, "抖音", "示例博主小林", URL, source="tikhub")
            profile = P.douyin_profile(load_fixture("dy_profile.json", server.base))
            works, _c, _m = P.douyin_works(load_fixture("dy_posts_1.json", server.base))
            saved = A.save_tikhub_images(folder, profile, works)
            names = sorted(os.path.basename(s) for s in saved)
            self.assertEqual(names, ["代表作封面-1.png", "代表作封面-2.png", "代表作封面-3.png", "头像.png"])
            self.assertEqual(works[10]["cover"], "代表作封面-1.png")  # 互动最多的那条（第 11 条）
            A.save_works(folder, profile, works, "tikhub")
            with open(os.path.join(folder, "作品.json"), encoding="utf-8") as f:
                text = f.read()
            self.assertNotIn("cover_url", text)  # 带签名的图片链接不存
            self.assertNotIn(server.base, text)
        finally:
            server.close()

    def test_按名字或链接找到对标账号(self):
        folder, _ = A.save_profile(self.dir, "抖音", "示例博主小林", URL, source="manual")
        target, found = A.resolve_account(self.dir, "示例博主小林")
        self.assertEqual(found, folder)
        self.assertEqual(target["user_id"], "MS4wLjABAAAAfakeuser01")
        _t, found2 = A.resolve_account(self.dir, URL + "?vid=1")
        self.assertEqual(found2, folder)
        with self.assertRaises(UserError):
            A.resolve_account(self.dir, "不认识的人")


class WorksTest(unittest.TestCase):
    def test_社媒助手的博主作品表(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "达人作品.xlsx")
        headers = ["视频ID", "视频链接", "视频类型", "视频描述", "点赞量", "收藏量", "评论量", "分享量", "推荐量", "发布时间", "视频时长",
                   "达人UID", "达人链接", "达人昵称", "粉丝数", "自定义一列"]
        rows = [["7400000000000000201", "https://www.douyin.com/video/7400000000000000201", "视频", "虚构：AI 写周报 #效率", 1200, 300, 40, 25, 0,
                 45929.5, "00:52", "x", URL, "示例博主小林", "1.3万", "随便"],
                ["7400000000000000202", "https://www.douyin.com/video/7400000000000000202", "图文", "虚构：AI 改简历", "2.1万", 900, 300, 100, 0,
                 45920.25, 61, "x", URL, "示例博主小林", "1.3万", ""]]
        write_xlsx(path, headers, rows, str_cells=("视频ID",))
        info, works, unknown = A.works_from_file(path)
        self.assertEqual(info, {"name": "示例博主小林", "followers": 13000, "url": URL})
        self.assertEqual(works[0]["duration_seconds"], 52)
        self.assertEqual(works[1]["likes"], 21000)
        self.assertEqual(works[0]["published_at"], "2025-09-29 12:00")
        self.assertIn("自定义一列", unknown)


class ResearchTest(unittest.TestCase):
    def works(self):
        a, _c, _m = P.douyin_works(load_fixture("dy_posts_1.json"))
        b, _c, _m = P.douyin_works(load_fixture("dy_posts_2.json"))
        return a + b

    def test_明显比平时火的(self):
        result = A.analyze_works(self.works(), "2026-09-30T20:00:00+08:00")
        self.assertEqual(result["count"], 32)
        self.assertEqual(result["fresh"], 3)  # 第 1、2、3 条发布不到 3 天
        self.assertTrue(result["enough"])
        rows = {r["id"]: r for r in result["rows"]}
        self.assertEqual(rows["7400000000000000103"]["status"], "还在涨")  # 互动很高，但还不到 3 天，不判断
        self.assertIn("7400000000000000111", result["standouts"])
        self.assertIn("7400000000000000120", result["standouts"])
        self.assertTrue(any(s.startswith("收藏是平时的") for s in rows["7400000000000000120"]["spikes"]))
        self.assertEqual(len(result["standouts"]), 2)
        self.assertEqual(result["pinned"], 1)
        self.assertGreater(result["median"], 700)

    def test_作品太少只排序(self):
        result = A.analyze_works(self.works()[10:15], "2026-09-30T20:00:00+08:00")
        self.assertFalse(result["enough"])
        self.assertEqual(result["standouts"], [])
        self.assertEqual(result["rows"][0]["id"], "7400000000000000111")

    def test_缺点赞的算数据不全(self):
        works = self.works()
        works[5]["likes"] = None
        result = A.analyze_works(works, "2026-09-30T20:00:00+08:00")
        self.assertEqual(result["incomplete"], 1)
        self.assertEqual(result["rows"][-1]["status"], "数据不全")


if __name__ == "__main__":
    unittest.main()
