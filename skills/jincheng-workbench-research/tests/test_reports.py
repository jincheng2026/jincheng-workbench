"""出报告：写到「调研报告/<日期_主题>/」，meta.json 的字段照约定，HTML 自包含、转义、第一屏是结论。"""
import json
import os
import re
import tempfile
import unittest

from support import SMA_HEADERS, load_fixture, sma_row, write_xlsx

from research_kit import accounts as A
from research_kit import comments as CM
from research_kit import platforms as P
from research_kit import reports as R
from research_kit.text import today

VID = "7100000000000000123"


def dataset(folder):
    path = os.path.join(folder, "导出.xlsx")
    rows = [sma_row("7300000000000000%03d" % i, VID, text, likes) for i, (text, likes) in enumerate([
        ("录音怎么导进去？<script>alert(1)</script>", 30), ("这个要钱吗", 12), ("方言能识别吗", 9), ("求模板", 5), ("学会了", 1)], 1)]
    write_xlsx(path, SMA_HEADERS, rows, str_cells=("评论ID", "视频ID"))
    return CM.dataset_from_file(path, P.parse_target(VID), display_path="评论导入/导出.xlsx")


ANALYSIS = {
    "title": "这条视频的评论区：大家卡在导入",
    "takeaways": [{"text": "最多人卡在导入录音", "evidence": ["c1"]}, {"text": "有人担心收费", "categories": ["price"]}],
    "topics": [{"title": "录音导入的三种办法", "why": "评论里问导入的最多", "audience": "刚装好的人", "categories": ["import"]}],
    "categories": [{"id": "import", "name": "导入卡住", "kind": "痛点", "summary": "不会导入", "comments": ["c1", "c3"]},
                   {"id": "price", "name": "收费", "kind": "疑问", "summary": "问价格", "comments": ["c2"]},
                   {"id": "res", "name": "求资料", "kind": "求资料", "summary": "要模板", "comments": ["c4"]}],
    "persona": {"summary": "要开会做记录的人", "groups": [{"name": "说方言的", "description": "", "comments": ["c3"]}]},
}


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="research-reports-")
        self.reports = os.path.join(self.dir, "调研报告")
        os.makedirs(self.reports)

    def test_评论洞察_写到约定的位置_meta字段对(self):
        ds = dataset(self.dir)
        analysis, problems, _w = CM.check_analysis(ds, ANALYSIS)
        self.assertEqual(problems, [])
        folder = R.new_report_folder(self.reports, "会议纪要/评论区")
        self.assertEqual(os.path.basename(folder), "%s_会议纪要 评论区" % today())
        again = R.new_report_folder(self.reports, "会议纪要/评论区")
        self.assertTrue(again.endswith("-2"))  # 同名不覆盖
        path = R.render_comments(ds, analysis, folder)
        meta = R.write_meta(folder, analysis["title"], "评论洞察", "导入的表格：评论导入/导出.xlsx", [(os.path.basename(path), "评论洞察")])
        with open(os.path.join(folder, "meta.json"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved, meta)
        self.assertEqual(list(saved), ["title", "date", "type", "source", "pages", "workbenchVisible"])
        self.assertEqual(saved["type"], "评论洞察")
        self.assertEqual(saved["date"], today())
        self.assertEqual(saved["pages"], [{"file": "评论洞察.html", "title": "评论洞察"}])
        self.assertTrue(saved["workbenchVisible"])

        with open(path, encoding="utf-8") as f:
            html = f.read()
        self.assertNotIn("<script>alert", html)  # 评论原文要转义
        self.assertIn("&lt;script&gt;", html)
        self.assertNotRegex(html, r"<script|https?://[^\"' ]+\.(js|css)|@import")  # 不带脚本、不引外部文件
        self.assertIn("Content-Security-Policy", html)
        order = [html.index(x) for x in ('id="conclusions"', 'id="topics"', 'id="categories"', 'id="persona"', 'id="sample"', 'id="data"')]
        self.assertEqual(order, sorted(order))  # 第一屏先是结论和选题，后面才是分类、画像、样本、数据
        self.assertIn("样本很少", html)  # 只有 5 条有效评论
        self.assertIn("依据 1 条评论（很少，只是线索）", html)
        self.assertIn("「导入卡住」，共 2 条", html)
        self.assertIn("评论时间都在 9月30日", html)
        self.assertNotIn("虚构用户", html)  # 评论者昵称不进报告

    def test_meta_只认三种类型(self):
        folder = R.new_report_folder(self.reports, "x")
        with self.assertRaises(ValueError):
            R.write_meta(folder, "x", "综合调研", "", [])

    def test_账号研究报告(self):
        a, _c, _m = P.douyin_works(load_fixture("dy_posts_1.json"))
        b, _c, _m = P.douyin_works(load_fixture("dy_posts_2.json"))
        data = {"platform": "抖音", "account": {"name": "示例博主小林", "followers": 12800, "url": "https://www.douyin.com/user/x"},
                "source": {"kind": "tikhub", "requests": 3, "cost_usd": "0.003"}, "as_of": "2026-09-30T20:00:00+08:00",
                "analysis": A.analyze_works(a + b, "2026-09-30T20:00:00+08:00")}
        obs, problems = A.check_account_analysis(data, {"summary": "收藏高的都是清单型", "observations": [
            {"title": "清单型更容易被收藏", "text": "两条都是清单", "works": ["7400000000000000111", "7400000000000000120"]}]})
        self.assertEqual(problems, [])
        _o, bad = A.check_account_analysis(data, {"observations": [{"title": "x", "text": "y", "works": ["123"]}]})
        self.assertTrue(any("不在这次的作品里" in p for p in bad))
        folder = R.new_report_folder(self.reports, "小林-最近什么最火")
        path = R.render_account(data, obs, folder)
        with open(path, encoding="utf-8") as f:
            html = f.read()
        self.assertIn("「示例博主小林」最近什么最火", html)
        self.assertLess(html.index('id="hot"'), html.index('id="rules"'))
        self.assertIn("是平时的", html)
        self.assertIn("中位数", html)
        self.assertEqual(len(re.findall(r'class="row hot"', html)), 2)

    def test_视频拆解_有逐字稿就核对原话(self):
        raw = {"title": "拆解：AI 会议纪要", "summary": "先给结果再讲步骤", "video": {"platform": "抖音", "url": "https://www.douyin.com/video/1", "likes": 5230},
               "sections": [{"title": "开头怎么抓人", "text": "第一句就给结果", "quotes": ["三分钟出纪要"]},
                            {"title": "它没讲什么", "text": "没讲收费"}]}
        transcript = "大家好，今天教你三分钟，出纪要。第一步……"
        data, problems = R.check_video_data(raw, transcript)
        self.assertEqual(problems, [])  # 标点和空格不算差别
        bad = dict(raw, sections=[{"title": "开头", "text": "x", "quotes": ["五分钟出纪要"]}])
        _d, problems = R.check_video_data(bad, transcript)
        self.assertTrue(any("找不到" in p for p in problems))
        folder = R.new_report_folder(self.reports, "拆解")
        path = R.render_video(data, folder, transcript)
        with open(path, encoding="utf-8") as f:
            html = f.read()
        self.assertIn("逐字稿原话", html)
        self.assertNotIn("这次没有逐字稿", html)
        path2 = R.render_video(R.check_video_data(raw, None)[0], folder, None, "无逐字稿.html")
        with open(path2, encoding="utf-8") as f:
            self.assertIn("这次没有逐字稿", f.read())


if __name__ == "__main__":
    unittest.main()
