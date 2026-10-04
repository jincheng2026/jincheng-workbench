"""评论：清洗（去重、无效评论、层级）、按视频分组、在「评论导入」里找、核对 AI 写的分析。"""
import os
import tempfile
import unittest

from support import SMA_HEADERS, sma_row, write_xlsx

from research_kit import UserError
from research_kit import comments as CM
from research_kit.platforms import parse_target

VID = "7100000000000000123"
VID2 = "7100000000000000456"


def make_export(path, extra_rows=()):
    rows = [
        sma_row("7300000000000000001", VID, "请问录音怎么导进去？导了半天没反应", 30, ip="浙江", replies=2),
        sma_row("7300000000000000002", VID, "同问，导不进去", 4, ip="广东", parent="7300000000000000001"),
        sma_row("7300000000000000003", VID, "这个要钱吗", 8, ip="四川"),
        sma_row("7300000000000000003", VID, "这个要钱吗", 8, ip="四川"),  # 重复的一行
        sma_row("7300000000000000004", VID, "[赞][赞]", 1),
        sma_row("7300000000000000005", VID, "@小明 ", 0),
        sma_row("7300000000000000006", VID, "", 0, image="https://example.com/p.png"),
        sma_row("7300000000000000007", VID, "牛", 2),
        sma_row("7300000000000000008", VID, "方言能识别吗，我们开会说粤语", 15, ip="广东"),
    ] + list(extra_rows)
    write_xlsx(path, SMA_HEADERS, rows, str_cells=("评论ID", "视频ID", "一级评论ID"))


class CleanTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="research-comments-")
        self.file = os.path.join(self.dir, "导出.xlsx")

    def test_清洗_去重_无效评论_层级(self):
        make_export(self.file)
        ds = CM.dataset_from_file(self.file, parse_target("https://www.douyin.com/video/%s" % VID))
        st = ds["stats"]
        self.assertEqual(st["rows_in"], 9)
        self.assertEqual(st["duplicates"], 1)
        self.assertEqual(st["noise_reasons"], {"只有表情或@": 2, "只有图片": 1, "只有一个字": 1})
        self.assertEqual(st["valid"], 4)
        self.assertEqual((st["top_level"], st["replies"]), (3, 1))
        refs = {c["ref"]: c for c in ds["comments"]}
        self.assertEqual(refs["c2"]["parent_ref"], "c1")  # 回复知道自己挂在哪条下面
        self.assertEqual(ds["platform"], "抖音")
        self.assertEqual(ds["videos"][0]["id"], VID)
        for c in ds["comments"]:  # 评论者昵称、编号不存
            self.assertNotIn("_user", c)
            self.assertNotIn("user", c)
        self.assertNotIn("虚构用户", str(ds))

    def test_一张表里几条视频_按视频分组(self):
        make_export(self.file, [sma_row("7300000000000000101", VID2, "另一条视频的评论", 3)])
        with self.assertRaises(UserError) as ctx:
            CM.dataset_from_file(self.file)
        self.assertIn("2 条视频", str(ctx.exception))
        only = CM.dataset_from_file(self.file, parse_target(VID2))
        self.assertEqual(only["stats"]["valid"], 1)
        both = CM.dataset_from_file(self.file, all_videos=True)
        self.assertEqual(len(both["videos"]), 2)
        with self.assertRaises(UserError) as ctx:
            CM.dataset_from_file(self.file, parse_target("https://www.douyin.com/video/7100000000000000999"))
        self.assertIn("没有这条视频的评论", str(ctx.exception))

    def test_在评论导入里找(self):
        make_export(self.file, [sma_row("7300000000000000101", VID2, "另一条", 3)])
        with open(os.path.join(self.dir, "没有视频列.csv"), "w", encoding="utf-8") as f:
            f.write("评论内容,点赞数\n只有评论,1\n")
        with open(os.path.join(self.dir, "坏的.xlsx"), "wb") as f:
            f.write(b"PK\x03\x04oops")
        with open(os.path.join(self.dir, "~$临时.xlsx"), "wb") as f:
            f.write(b"x")
        found = {e["name"]: e for e in CM.scan_imports(self.dir)}
        self.assertNotIn("~$临时.xlsx", found)
        self.assertIsNotNone(found["坏的.xlsx"]["problem"])
        groups = found["导出.xlsx"]["groups"]
        target = parse_target("https://www.douyin.com/video/%s?modal_id=x" % VID)
        self.assertTrue(any(CM.matches_target(g, target) for g in groups))
        self.assertEqual(found["没有视频列.csv"]["groups"][0]["key"], CM.NO_VIDEO)


class AnalysisTest(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp(prefix="research-analysis-")
        path = os.path.join(d, "导出.xlsx")
        make_export(path)
        self.ds = CM.dataset_from_file(path, parse_target(VID))

    def good(self):
        return {
            "title": "录音导入是最大的坎",
            "takeaways": [{"text": "导入录音卡住的人最多", "evidence": ["c1", "c2"]}],
            "topics": [{"title": "三种办法把录音导进去", "why": "评论里在问怎么导入", "audience": "第一次用的人", "categories": ["import"]}],
            "categories": [
                {"id": "import", "name": "导入卡住", "kind": "痛点", "summary": "装好了不知道怎么导入", "comments": ["c1", "c2"],
                 "quotes": ["c1", {"ref": "c2", "excerpt": "导不进去"}]},
                {"id": "price", "name": "收费", "kind": "疑问", "summary": "问要不要钱", "comments": ["c3"]},
            ],
            "persona": {"summary": "开会要做记录的人", "groups": [{"name": "说方言的", "description": "开会说方言", "comments": ["c8"]}]},
            "caveats": ["只有一条视频的评论"],
        }

    def test_合格的分析_条数由程序算(self):
        result, problems, warnings = CM.check_analysis(self.ds, self.good())
        self.assertEqual(problems, [])
        self.assertEqual(result["takeaways"][0]["count"], 2)
        self.assertEqual(result["topics"][0]["count"], 2)
        self.assertEqual(result["topics"][0]["quote"], "c1")
        self.assertEqual(result["uncategorized"], ["c8"])
        self.assertTrue(any("只有 1 条" in w for w in warnings))

    def test_引用不存在或无效的评论_拦下来(self):
        bad = self.good()
        bad["takeaways"][0]["evidence"] = ["c99", "c4"]  # c4 是「[赞][赞]」
        bad["categories"][0]["quotes"] = [{"ref": "c1", "excerpt": "改过的原话"}]
        bad["topics"][0]["categories"] = ["nope"]
        bad["categories"][1]["kind"] = "情绪"
        _r, problems, _w = CM.check_analysis(self.ds, bad)
        text = "\n".join(problems)
        self.assertIn("c99 在评论数据里找不到", text)
        self.assertIn("c4 是无效评论", text)
        self.assertIn("一字不差", text)
        self.assertIn("分类「nope」", text)
        self.assertIn("kind 只能是", text)

    def test_没有依据的结论_拦下来(self):
        bad = self.good()
        bad["takeaways"] = [{"text": "大家都很喜欢"}]
        _r, problems, _w = CM.check_analysis(self.ds, bad)
        self.assertTrue(any("没有依据" in p for p in problems))

    def test_给AI读的清单(self):
        lines, total = CM.listing(self.ds)
        self.assertEqual(total, 4)
        self.assertTrue(lines[0].startswith("c1 赞30 一级 浙江"))
        self.assertIn("回复c1", lines[1])
        self.assertTrue(all("[赞]" not in line for line in lines))

    def test_样本多少的说法(self):
        self.assertEqual(CM.sample_label(12), "够看出方向")
        self.assertEqual(CM.sample_label(5), "有一些，还要再看")
        self.assertEqual(CM.sample_label(2), "很少，只是线索")


if __name__ == "__main__":
    unittest.main()
