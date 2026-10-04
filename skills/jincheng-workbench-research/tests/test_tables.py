"""读表格：Excel、CSV（UTF-8 和 GB18030）、TSV、JSON、JSON Lines，认列、读时间。"""
import json
import os
import tempfile
import unittest

from support import SMA_HEADERS, sma_row, write_xlsx

from research_kit import UserError
from research_kit.comments import recognize, rows_from_table
from research_kit.tables import read_table
from research_kit.text import parse_count, parse_time


class TablesTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="research-tables-")

    def path(self, name):
        return os.path.join(self.dir, name)

    def test_xlsx_社媒助手导出(self):
        p = self.path("评论.xlsx")
        rows = [sma_row("7300000000000000001", "7100000000000000123", "请问怎么导入录音？", 12, 45930.75, "浙江", 2),
                sma_row("7300000000000000002", "7100000000000000123", "同问", 3, 45930.8, "广东", parent="7300000000000000001")]
        write_xlsx(p, SMA_HEADERS, rows, str_cells=("评论ID", "视频ID", "一级评论ID"))
        table = read_table(p)
        self.assertEqual(table.kind, "xlsx")
        self.assertEqual(table.headers, SMA_HEADERS)
        self.assertEqual(table.rows[0]["评论ID"], "7300000000000000001")  # 长编号保留原文，不变成科学计数法
        got, columns, platform = rows_from_table(table)
        self.assertEqual(platform, "抖音")
        self.assertEqual(got[0]["time"], "2025-09-30 18:00")  # Excel 日期数字 45930.75 = 2025-09-30 18:00
        self.assertEqual(got[0]["level"], "一级")
        self.assertEqual(got[1]["level"], "回复")
        self.assertEqual(got[1]["parent"], "7300000000000000001")
        self.assertEqual(got[0]["likes"], 12)
        self.assertIn("用户UID", columns["unused"])  # 个人信息认得但不用
        self.assertEqual(columns["unrecognized"], [])

    def test_xlsx_行内字符串_1904日期_多张表(self):
        p = self.path("老表.xlsx")
        write_xlsx(p, ["评论内容", "点赞量", "评论时间", "评论图片链接"], [["第一条评论", "1.2万", 0.5, "https://example.com/a.png"]],
                   sheets_extra=[("第二张", ["x"], [["y"]])], date1904=True, inline=True)
        table = read_table(p)
        self.assertTrue(table.date1904)
        self.assertIn("第二张", table.note)
        got, columns, _ = rows_from_table(table)
        self.assertEqual(got[0]["likes"], 12000)
        self.assertTrue(got[0]["has_image"])
        self.assertEqual(columns["recognized"]["likes"], "点赞量")  # 老版本叫「点赞量」
        self.assertEqual(columns["recognized"]["image"], "评论图片链接")

    def test_csv_utf8_bom_和_gb18030(self):
        text = "评论内容,点赞数,IP属地,评论时间\n导入不了怎么办,5,IP属地：四川,2026-09-30 12:30\n"
        p1, p2 = self.path("a.csv"), self.path("b.csv")
        with open(p1, "w", encoding="utf-8-sig") as f:
            f.write(text)
        with open(p2, "wb") as f:
            f.write(text.encode("gb18030"))
        for p in (p1, p2):
            got, _cols, _ = rows_from_table(read_table(p))
            self.assertEqual(got[0]["text"], "导入不了怎么办")
            self.assertEqual(got[0]["ip"], "四川")  # 去掉「IP属地：」
            self.assertEqual(got[0]["time"], "2026-09-30 12:30")

    def test_tsv(self):
        p = self.path("c.tsv")
        with open(p, "w", encoding="utf-8") as f:
            f.write("评论ID\t评论内容\t点赞数\tB站自定义列\nc1\t好用，收藏了\t7\t随便\n")
        table = read_table(p)
        self.assertEqual(table.kind, "tsv")
        got, cols, _ = rows_from_table(table)
        self.assertEqual(got[0]["cid"], "c1")
        self.assertEqual(cols["unrecognized"], ["B站自定义列"])  # 认不出的列要报出来

    def test_json_数组_和_TikHub_原始返回_和_jsonl(self):
        p1 = self.path("a.json")
        with open(p1, "w", encoding="utf-8") as f:
            json.dump([{"comment": "第一条", "likes": 3}, {"comment": "第二条", "likes": "1k"}], f, ensure_ascii=False)
        got, _c, _ = rows_from_table(read_table(p1))
        self.assertEqual([g["likes"] for g in got], [3, 1000])
        p2 = self.path("b.json")
        with open(p2, "w", encoding="utf-8") as f:
            json.dump({"code": 200, "data": {"comments": [{"cid": "1", "text": "原始返回里的评论", "digg_count": 9, "create_time": 1790000000,
                                                          "ip_label": "北京", "reply_id": "0", "aweme_id": "7400000000000000103",
                                                          "user": {"nickname": "某人", "uid": "9"}}]}}, f, ensure_ascii=False)
        got, cols, platform = rows_from_table(read_table(p2))
        self.assertEqual(got[0]["text"], "原始返回里的评论")
        self.assertEqual(got[0]["level"], "一级")
        self.assertEqual(got[0]["video_id"], "7400000000000000103")
        self.assertIn("user.uid", cols["unused"])
        p3 = self.path("c.jsonl")
        with open(p3, "w", encoding="utf-8") as f:
            f.write('{"评论内容": "一行一条", "点赞数": 2}\n{"评论内容": "第二行", "点赞数": 0}\n')
        table = read_table(p3)
        self.assertEqual(table.kind, "jsonl")
        self.assertEqual(len(rows_from_table(table)[0]), 2)

    def test_认不出评论列时说清楚(self):
        p = self.path("d.csv")
        with open(p, "w", encoding="utf-8") as f:
            f.write("甲,乙\n1,2\n")
        with self.assertRaises(UserError) as ctx:
            rows_from_table(read_table(p))
        self.assertIn("认不出哪一列是评论内容", str(ctx.exception))
        self.assertIn("甲、乙", str(ctx.exception))

    def test_读不了的格式说人话(self):
        p = self.path("old.xls")
        with open(p, "wb") as f:
            f.write(b"\xd0\xcf\x11\xe0not really")
        with self.assertRaises(UserError) as ctx:
            read_table(p)
        self.assertIn("另存为", str(ctx.exception))
        p2 = self.path("broken.xlsx")
        with open(p2, "wb") as f:
            f.write(b"PK\x03\x04broken")
        with self.assertRaises(UserError):
            read_table(p2)

    def test_认列_常见叫法(self):
        wanted, unused, unknown = recognize(["评论点赞数", "Comment_Text", "一级评论内容", "评论内容(2)", "时间"])
        self.assertEqual(wanted["likes"], "评论点赞数")
        self.assertEqual(wanted["text"], "Comment_Text")
        self.assertEqual(wanted["time"], "时间")
        self.assertIn("一级评论内容", unused)
        self.assertIn("评论内容(2)", unused)  # 同样意思的第二列不重复用

    def test_读数字和时间(self):
        self.assertEqual(parse_count("1.5万"), 15000)
        self.assertEqual(parse_count("2,345"), 2345)
        self.assertIsNone(parse_count(""))
        self.assertIsNone(parse_count("-3"))
        self.assertEqual(parse_time("2026/9/30 8:05"), "2026-09-30 08:05")
        self.assertEqual(parse_time("2026年9月30日"), "2026-09-30 00:00")
        self.assertEqual(parse_time("09-30 12:00"), "09-30 12:00")  # 没有年份的原样留着
        self.assertIsNone(parse_time(""))
        self.assertTrue(parse_time(1790000000).startswith("2026-"))


if __name__ == "__main__":
    unittest.main()
