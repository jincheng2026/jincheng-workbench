"""生成记录.md：record batch / add / note / summary 写出来的和工作台约定的格式一字不差；
没有小节时建第 1 批、往已有批次加行、「## 记录」追加、不复用编号、工作台同时在写时不丢它的行。"""
import json
import os
import unittest

from support import TempWorkbench, jpeg, png, read, run_cli, write

from cover_kit import record as R
from cover_kit.text import update_text

NOW = "2026-10-05 21:10"

# 和约定（docs/开发记录.md「封面 Skill」、工作台那边）里的样子一字不差
CONVENTION = """# T002 封面生成记录

## 第 1 批

对标：抖音-某某（暖黄手写风）；照片：我的照片/正脸.jpg；日期：2026-10-05；软件：Codex；生图：image_gen

| 编号 | 本张变化 | 自检 | 文件名 |
| --- | --- | --- | --- |
| 01 | K03 讲台：人在右后，前景放大的手机 | 通过 | 封面-01.png |
| 02 | K07 对比：左右两半，人在中间指向右边 | 头发遮住「AI」的 A | 封面-02.png |

生成 2 次，报错 0 次，实际像素 1024×1536

## 记录

- 2026-10-05 21:03 选定 封面-02
- 2026-10-05 21:10 按备注改 封面-03 → 封面-12
"""


class RecordCliTest(unittest.TestCase):
    def setUp(self):
        self.wb = TempWorkbench()
        self.wb.topic("T002", "用 AI 十分钟写周报")
        account = self.wb.account("抖音-某某")
        write(os.path.join(account, "VI拆解.md"), "# 某某：封面 VI 拆解\n风格名：暖黄手写风\n\n正文\n")
        write(os.path.join(self.wb.assets, "我的照片", "正脸.jpg"), jpeg(30, 40))
        write(os.path.join(self.wb.assets, "封面设置.json"), json.dumps({"photo": "我的照片/正脸.jpg", "benchmark": "抖音-某某", "batchSize": 10}, ensure_ascii=False))
        self.env = self.wb.env(COVER_NOW=NOW)

    def tearDown(self):
        self.wb.cleanup()

    def cli(self, *args):
        return run_cli(list(args), self.env)

    def candidates(self):
        return os.path.join(self.wb.drafts, "T002_用 AI 十分钟写周报", "封面候选")

    def record_text(self):
        return read(os.path.join(self.candidates(), "生成记录.md"))

    def test_照约定的样子写出来_一字不差(self):
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen")
        self.assertEqual(code, 0, out)
        self.assertIn("建好了草稿文件夹", out)  # 草稿文件夹照选题卡的名字建
        self.assertIn("开了第 1 批", out)
        self.assertIn("生成计划写进：%s" % os.path.join(self.candidates(), "生成计划.md"), out)
        self.assertIn("这批从 封面-01 开始编号", out)
        write(os.path.join(self.candidates(), "封面-01.png"), png(1024, 1536))
        write(os.path.join(self.candidates(), "封面-02.png"), png(1024, 1536, (20, 20, 200)))
        code, out = self.cli("record", "add", "T002", "--no", "01", "--change", "K03 讲台：人在右后，前景放大的手机", "--check", "通过", "--file", "封面-01.png")
        self.assertEqual(code, 0, out)
        code, out = self.cli("record", "add", "T002", "--no", "2", "--change", "K07 对比：左右两半，人在中间指向右边", "--check", "头发遮住「AI」的 A", "--file", "封面-02.png")
        self.assertEqual(code, 0, out)
        code, out = self.cli("record", "summary", "T002", "--tries", "2", "--errors", "0")
        self.assertEqual(code, 0, out)
        # 工作台在页面上点「就用这张」：往文件末尾追加「## 记录」和一行
        with open(os.path.join(self.candidates(), "生成记录.md"), "a", encoding="utf-8") as f:
            f.write("\n## 记录\n\n- 2026-10-05 21:03 选定 封面-02\n")
        code, out = self.cli("record", "note", "T002", "按备注改 封面-03 → 封面-12")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.record_text(), CONVENTION)

    def test_第二批插在记录前面_表格格式照旧(self):
        self.cli("record", "batch", "T002", "--tool", "image_gen")
        write(os.path.join(self.candidates(), "封面-01.png"), png(8, 8))
        self.cli("record", "add", "T002", "--no", "01", "--change", "K03 讲台", "--check", "通过", "--file", "封面-01.png")
        self.cli("record", "note", "T002", "收藏 封面-01")
        code, out = self.cli("record", "batch", "T002", "--tool", "只出提示词")
        self.assertEqual(code, 0, out)
        self.assertIn("开了第 2 批", out)
        self.assertIn("生成计划-第2批.md", out)
        self.assertIn("这批从 封面-02 开始编号", out)
        write(os.path.join(self.candidates(), "生图描述-02.md"), "提示词\n")
        code, out = self.cli("record", "add", "T002", "--no", "02", "--change", "K05 桌面：人在左前", "--check", "只出了提示词", "--file", "生图描述-02.md")
        self.assertEqual(code, 0, out)
        self.assertIn("第 2 批", out)
        code, out = self.cli("record", "summary", "T002")
        self.assertEqual(code, 0, out)
        self.assertIn("只出了提示词 1 份", out)
        self.assertEqual(self.record_text(), """# T002 封面生成记录

## 第 1 批

对标：抖音-某某（暖黄手写风）；照片：我的照片/正脸.jpg；日期：2026-10-05；软件：Codex；生图：image_gen

| 编号 | 本张变化 | 自检 | 文件名 |
| --- | --- | --- | --- |
| 01 | K03 讲台 | 通过 | 封面-01.png |

## 第 2 批

对标：抖音-某某（暖黄手写风）；照片：我的照片/正脸.jpg；日期：2026-10-05；软件：Claude Code；生图：只出提示词

| 编号 | 本张变化 | 自检 | 文件名 |
| --- | --- | --- | --- |
| 02 | K05 桌面：人在左前 | 只出了提示词 | 生图描述-02.md |

只出了提示词 1 份，没有生成图片

## 记录

- 2026-10-05 21:10 收藏 封面-01
""")

    def test_没有小节就建第1批和表头(self):
        os.makedirs(self.candidates())
        write(os.path.join(self.candidates(), "封面-01.png"), png(8, 8))
        code, out = self.cli("record", "add", "T002", "--no", "01", "--change", "K02 讲台", "--check", "通过", "--file", "封面-01.png", "--tool", "image_gen")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.record_text(), """# T002 封面生成记录

## 第 1 批

对标：抖音-某某（暖黄手写风）；照片：我的照片/正脸.jpg；日期：2026-10-05；软件：Codex；生图：image_gen

| 编号 | 本张变化 | 自检 | 文件名 |
| --- | --- | --- | --- |
| 01 | K02 讲台 | 通过 | 封面-01.png |
""")

    def test_只有一张表没写小节_算第1批_再开一批时补上标题(self):
        os.makedirs(self.candidates())
        write(os.path.join(self.candidates(), "生成记录.md"), "# T002 封面生成记录\n\n| 编号 | 本张变化 | 自检 | 文件名 |\n| --- | --- | --- | --- |\n| 01 | K01 讲台 | 通过 | 封面-01.png |\n")
        code, out = self.cli("where", "T002")
        self.assertIn("现在是第 1 批（登记了 1 张）；再开一批是第 2 批", out)
        self.assertIn("下一张的编号：02", out)
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen")
        self.assertEqual(code, 0, out)
        self.assertIn("开了第 2 批", out)
        text = self.record_text()
        self.assertTrue(text.startswith("# T002 封面生成记录\n\n## 第 1 批\n\n| 编号 | 本张变化 | 自检 | 文件名 |\n| --- | --- | --- | --- |\n| 01 | K01 讲台 | 通过 | 封面-01.png |\n\n## 第 2 批\n\n对标："), text)

    def test_最新一批一张都没登记_再开一批接着用它(self):
        self.cli("record", "batch", "T002", "--tool", "image_gen")
        code, out = self.cli("record", "batch", "T002", "--tool", "只出提示词")
        self.assertEqual(code, 0, out)
        self.assertIn("接着用还没登记的第 1 批", out)
        text = self.record_text()
        self.assertEqual(text.count("## 第"), 1)
        self.assertIn("软件：Claude Code；生图：只出提示词", text)
        self.assertNotIn("image_gen", text)

    def test_编号不复用_自检太长_文件没存_都拒绝(self):
        self.cli("record", "batch", "T002", "--tool", "image_gen")
        write(os.path.join(self.candidates(), "封面-01.png"), png(8, 8))
        args = ["record", "add", "T002", "--no", "01", "--change", "K03 讲台", "--file", "封面-01.png"]
        code, out = self.cli(*(args + ["--check", "头发遮住了标题里的两个字，而且右手多了一根手指，背景的字也糊成一团看不清"]))
        self.assertEqual(code, 2)
        self.assertIn("30 字以内", out.splitlines()[0])
        code, out = self.cli(*(args + ["--check", "通过"]))
        self.assertEqual(code, 0, out)
        code, out = self.cli(*(args + ["--check", "通过"]))
        self.assertEqual(code, 2)
        self.assertIn("已经登记过了", out)
        code, out = self.cli("record", "add", "T002", "--no", "02", "--change", "K04", "--check", "通过", "--file", "封面-02.png")
        self.assertEqual(code, 2)
        self.assertIn("还没有 封面-02.png", out)
        code, out = self.cli("record", "add", "T002", "--no", "03", "--change", "K04", "--check", "通过", "--file", "封面-01.png")
        self.assertEqual(code, 2)
        self.assertIn("编号对不上", out)
        code, out = self.cli("record", "add", "T002", "--no", "03", "--change", "K04", "--check", "通过", "--file", "../封面-03.png")
        self.assertEqual(code, 2)
        self.assertEqual(self.record_text().count("| 0"), 1)

    def test_最新一批是空的_写下一批的编号也登记进它(self):
        doc = R.Doc("", "T002")
        doc.open_batch("对标：甲")
        n = doc.add_row(2, ["01", "K01", "通过", "封面-01.png"], info_if_new=lambda: "对标：乙")
        self.assertEqual(n, 1)
        self.assertEqual([r[:2] for r in doc.all_rows()], [(1, "01")])
        self.assertEqual(doc.text().count("## 第"), 1)

    def test_按备注改的那张登记进当前这一批(self):
        self.cli("record", "batch", "T002", "--tool", "image_gen")
        for n in (1, 2):
            write(os.path.join(self.candidates(), "封面-%02d.png" % n), png(8, 8, (n, 0, 0)))
            self.cli("record", "add", "T002", "--no", str(n), "--change", "K0%d" % n, "--check", "通过", "--file", "封面-%02d.png" % n)
        self.cli("record", "batch", "T002", "--tool", "image_gen")
        write(os.path.join(self.candidates(), "封面-03.png"), png(8, 8, (3, 0, 0)))
        self.cli("record", "add", "T002", "--no", "3", "--change", "K05", "--check", "通过", "--file", "封面-03.png")
        write(os.path.join(self.candidates(), "封面-04.png"), png(8, 8, (4, 0, 0)))
        code, out = self.cli("record", "add", "T002", "--no", "4", "--change", "改自 封面-01：标题字放大", "--check", "通过", "--file", "封面-04.png")
        self.assertEqual(code, 0, out)
        self.assertIn("第 2 批", out)
        rows = R.load(self.candidates(), "T002").all_rows()
        self.assertEqual([(r[0], r[1]) for r in rows], [(1, "01"), (1, "02"), (2, "03"), (2, "04")])
        code, out = self.cli("record", "add", "T002", "--no", "5", "--change", "K", "--check", "通过", "--file", "封面-05.png", "--batch", "7")
        self.assertEqual(code, 2)

    def test_缺照片或对标就停下_这次换别的照片不改默认(self):
        write(os.path.join(self.wb.assets, "封面设置.json"), json.dumps({"photo": None, "benchmark": "抖音-某某", "batchSize": 10}))
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen")
        self.assertEqual(code, 2)
        self.assertIn("还没有照片", out.splitlines()[0])
        self.assertFalse(os.path.exists(os.path.join(self.wb.drafts, "T002_用 AI 十分钟写周报")))
        other = write(os.path.join(self.wb.home, "下载", "侧脸.png"), png(10, 10))
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen", "--photo", other)
        self.assertEqual(code, 0, out)
        self.assertIn("照片：我的照片/侧脸.png", self.record_text())
        self.assertTrue(os.path.isfile(os.path.join(self.wb.assets, "我的照片", "侧脸.png")))
        with open(os.path.join(self.wb.assets, "封面设置.json"), encoding="utf-8") as f:
            self.assertIsNone(json.load(f)["photo"])
        write(os.path.join(self.wb.assets, "封面设置.json"), json.dumps({"photo": "我的照片/正脸.jpg", "benchmark": None}))
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen")
        self.assertEqual(code, 2)
        self.assertIn("还没有默认对标", out.splitlines()[0])

    def test_这批已经开了_封面设置写坏了也照样登记(self):
        self.cli("record", "batch", "T002", "--tool", "image_gen")
        write(os.path.join(self.wb.assets, "封面设置.json"), "{ 坏了")
        write(os.path.join(self.candidates(), "封面-01.png"), png(8, 8))
        code, out = self.cli("record", "add", "T002", "--no", "01", "--change", "K03 讲台", "--check", "通过", "--file", "封面-01.png")
        self.assertEqual(code, 0, out)
        self.assertIn("| 01 | K03 讲台 | 通过 | 封面-01.png |", self.record_text())

    def test_选题卡和总览里都没有_草稿文件夹先只用编号(self):
        code, out = self.cli("record", "batch", "T005", "--tool", "image_gen")
        self.assertEqual(code, 0, out)
        self.assertIn("先只用编号", out)
        self.assertTrue(os.path.isfile(os.path.join(self.wb.drafts, "T005", "封面候选", "生成记录.md")))

    def test_一张都没登记_不写统计(self):
        self.cli("record", "batch", "T002", "--tool", "image_gen")
        code, out = self.cli("record", "summary", "T002")
        self.assertEqual(code, 2)
        self.assertIn("还一张都没登记", out)
        self.assertNotIn("生成 0 次", self.record_text())

    def test_记录追加_带时间(self):
        os.makedirs(self.candidates())
        code, out = self.cli("record", "note", "T002", "按备注改 封面-03 → 封面-12")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.record_text(), "# T002 封面生成记录\n\n## 记录\n\n- 2026-10-05 21:10 按备注改 封面-03 → 封面-12\n")
        code, out = self.cli("record", "note", "T002", "  ")
        self.assertEqual(code, 2)


class DocTest(unittest.TestCase):
    def test_记录在前面_新的一批插在已有批次后面(self):
        doc = R.Doc("# T009 封面生成记录\n\n## 记录\n\n- 2026-10-05 20:00 收藏 封面-01\n\n## 第 1 批\n\n对标：甲\n\n" + R.HEAD + "\n" + R.SEP + "\n| 01 | K01 | 通过 | 封面-01.png |\n", "T009")
        n, reused = doc.open_batch("对标：乙")
        self.assertEqual((n, reused), (2, False))
        heads = [s.head for s in doc.sections]
        self.assertEqual(heads, ["## 记录", "## 第 1 批", "## 第 2 批"])

    def test_工作台同时在写_重新读了再改_不丢它的行(self):
        import tempfile
        folder = tempfile.mkdtemp()
        path = os.path.join(folder, "生成记录.md")
        write(path, "# T002 封面生成记录\n")
        calls = []

        def change(old):
            calls.append(old)
            if len(calls) == 1:  # 第一次改的时候，工作台抢先追加了一行
                with open(path, "a", encoding="utf-8") as f:
                    f.write("\n## 记录\n\n- 2026-10-05 21:00 选定 封面-01\n")
            doc = R.Doc(old, "T002")
            doc.add_log("2026-10-05 21:01 按备注改 封面-01 → 封面-02")
            return doc.text()

        update_text(path, change)
        self.assertEqual(len(calls), 2)
        self.assertEqual(read(path), "# T002 封面生成记录\n\n## 记录\n\n- 2026-10-05 21:00 选定 封面-01\n- 2026-10-05 21:01 按备注改 封面-01 → 封面-02\n")


if __name__ == "__main__":
    unittest.main()
