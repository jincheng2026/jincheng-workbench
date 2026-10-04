"""生成记录.md：record batch / add / note / summary 写出来的和工作台约定的格式一字不差（第二版：每批第一行写风格编号、照片几张、尺寸）；
没有小节时建第 1 批、往已有批次加行、「## 记录」追加、不复用编号、工作台同时在写时不丢它的行；
尺寸说了用说的、没说用上一批的、再没有看内容类型；照片默认用「我的照片」里的、主照片在前、最多 3 张；参考构图。"""
import json
import os
import unittest

from support import TempWorkbench, jpeg, png, read, run_cli, write

from cover_kit import record as R
from cover_kit import sizes as Z
from cover_kit.text import update_text

NOW = "2026-10-05 21:10"

# 和约定（docs/开发记录.md「封面 Skill」第二版、工作台那边）里的样子一字不差
FIRST_LINE = "对标：抖音-某某（暖黄手写风）；照片：1 张；日期：2026-10-05；软件：Codex；生图：image_gen；尺寸：竖版 3:4"
CONVENTION = """# T002 封面生成记录

## 第 1 批

对标：抖音-某某（暖黄手写风）；照片：1 张；日期：2026-10-05；软件：Codex；生图：image_gen；尺寸：竖版 3:4

| 编号 | 本张变化 | 自检 | 文件名 |
| --- | --- | --- | --- |
| 01 | K03 讲台：人在右后，前景放大的手机 | 通过 | 封面-01.png |
| 02 | K07 对比：左右两半，人在中间指向右边 | 头发遮住「AI」的 A | 封面-02.png |

生成 2 次，报错 0 次，实际像素 1024×1536

## 记录

- 2026-10-05 21:10 选定 封面-02
- 2026-10-05 21:10 按评论改 封面-03 → 封面-12
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
        # 第二版起「## 记录」只由 Skill 写：在对话里说「就用 02」、在 Canvas 里评论改 03
        code, out = self.cli("select", "T002", "--no", "02")
        self.assertEqual(code, 0, out)
        code, out = self.cli("record", "note", "T002", "按评论改 封面-03 → 封面-12")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.record_text(), CONVENTION)
        info = R.parse_info(FIRST_LINE)
        self.assertEqual((info["style_id"], info["style_name"], info["photos"], info["size"]), ("抖音-某某", "暖黄手写风", "1 张", Z.PORTRAIT))

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

对标：抖音-某某（暖黄手写风）；照片：1 张；日期：2026-10-05；软件：Codex；生图：image_gen；尺寸：竖版 3:4

| 编号 | 本张变化 | 自检 | 文件名 |
| --- | --- | --- | --- |
| 01 | K03 讲台 | 通过 | 封面-01.png |

## 第 2 批

对标：抖音-某某（暖黄手写风）；照片：1 张；日期：2026-10-05；软件：Claude Code；生图：只出提示词；尺寸：竖版 3:4

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

对标：抖音-某某（暖黄手写风）；照片：1 张；日期：2026-10-05；软件：Codex；生图：image_gen；尺寸：竖版 3:4

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

    def test_缺照片或风格就停下_这次只用说的照片不改设置(self):
        os.remove(os.path.join(self.wb.assets, "我的照片", "正脸.jpg"))
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen")
        self.assertEqual(code, 2)
        self.assertIn("还没有照片", out.splitlines()[0])
        self.assertFalse(os.path.exists(os.path.join(self.wb.drafts, "T002_用 AI 十分钟写周报")))
        other = write(os.path.join(self.wb.home, "下载", "侧脸.png"), png(10, 10))
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen", "--photo", other)
        self.assertEqual(code, 0, out)
        self.assertIn("照片：1 张", self.record_text())
        self.assertIn("    1. %s" % other, out)
        self.assertFalse(os.path.exists(os.path.join(self.wb.assets, "我的照片", "侧脸.png")))  # 这次说的照片不复制进「我的照片」
        with open(os.path.join(self.wb.assets, "封面设置.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["photo"], "我的照片/正脸.jpg")  # 主照片不改
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen", "--photo", os.path.join(self.wb.home, "没有这张.png"))
        self.assertEqual(code, 2)
        self.assertIn("找不到照片", out)
        write(os.path.join(self.wb.assets, "封面设置.json"), json.dumps({"photo": None, "benchmark": None}))
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen", "--photo", other)
        self.assertEqual(code, 2)
        self.assertIn("还没有默认风格", out.splitlines()[0])

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


class BatchChoicesTest(unittest.TestCase):
    """开一批时读话里的尺寸、风格、参考构图，照片默认用「我的照片」里的：第一行照约定的固定写法。"""

    def setUp(self):
        self.wb = TempWorkbench()
        self.wb.topic("T002", "用 AI 十分钟写周报")  # 选题库/口播/待做/：内容类型「口播」
        self.wb.topic("T003", "三个提示词写完周报", kind="公众号文章")
        account = self.wb.account("抖音-某某")
        write(os.path.join(account, "VI拆解.md"), "# 某某：封面 VI 拆解\n风格名：暖黄手写风\n")
        for n in (1, 2, 3, 4, 5):
            write(os.path.join(account, "封面", "K%02d.png" % n), png(6, 8, (n, 0, 0)))
        write(os.path.join(account, "默认构图.json"), json.dumps({"ids": ["K03", "K01"], "by": "AI", "updatedAt": "2026-10-04T21:00:00+08:00"}))
        style = self.wb.style_folder("2026-10-04_3张", {"a.png": png(6, 8, (9, 9, 9))})
        write(os.path.join(style, "VI拆解.md"), "# 放进来的 3 张图：封面 VI 拆解\n风格名：蓝白大字风\n")
        write(os.path.join(style, "封面", "K01.png"), png(6, 8, (8, 8, 8)))
        write(os.path.join(self.wb.assets, "封面设置.json"), json.dumps({"photo": None, "benchmark": "抖音-某某", "batchSize": 5}, ensure_ascii=False))
        self.env = self.wb.env(COVER_NOW=NOW)

    def tearDown(self):
        self.wb.cleanup()

    def cli(self, *args):
        return run_cli(list(args), self.env)

    def record_text(self, cid="T002", name="用 AI 十分钟写周报"):
        return read(os.path.join(self.wb.drafts, "%s_%s" % (cid, name), "封面候选", "生成记录.md"))

    def first_lines(self, text):
        return [line for line in text.splitlines() if line.startswith("对标：")]

    def test_尺寸_说了用说的_没说用上一批的_再没有看内容类型(self):
        self.wb.photo("正脸.jpg", jpeg(30, 40))
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen")
        self.assertEqual(code, 0, out)
        self.assertIn("尺寸：竖版 3:4（没说，内容类型「口播」算视频）", out)
        self.assertIn("生图出 1024×1536，存的时候从中间裁成 1024×1365", out)
        self.assertIn("save … --size 竖版3:4", out)
        write(os.path.join(self.wb.drafts, "T002_用 AI 十分钟写周报", "封面候选", "封面-01.png"), png(8, 8))
        self.cli("record", "add", "T002", "--no", "01", "--change", "K03 讲台", "--check", "通过", "--file", "封面-01.png")
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen", "--size", "横版2.35:1")
        self.assertEqual(code, 0, out)
        self.assertIn("尺寸：横版 2.35:1（用户这次说的）", out)
        self.assertIn("生图出 1536×1024，存的时候从中间裁成 1536×654", out)
        write(os.path.join(self.wb.drafts, "T002_用 AI 十分钟写周报", "封面候选", "封面-02.png"), png(9, 9))
        self.cli("record", "add", "T002", "--no", "02", "--change", "K01 讲台", "--check", "通过", "--file", "封面-02.png")
        code, out = self.cli("record", "batch", "T002", "--tool", "只出提示词")
        self.assertEqual(code, 0, out)
        self.assertIn("尺寸：横版 2.35:1（没说，这条内容上一批用的）", out)
        lines = self.first_lines(self.record_text())
        self.assertEqual([line.rsplit("；", 1)[1] for line in lines], ["尺寸：竖版 3:4", "尺寸：横版 2.35:1", "尺寸：横版 2.35:1"])
        code, out = run_cli(["where", "T002"], self.env, cwd=self.wb.work)
        self.assertIn("尺寸：上一批用的是 横版 2.35:1（第 3 批）", out)
        # 文章类的内容（类型名里带「文章」）：没说就用横版
        code, out = self.cli("record", "batch", "T003", "--tool", "image_gen")
        self.assertEqual(code, 0, out)
        self.assertIn("尺寸：横版 2.35:1（没说，内容类型「公众号文章」算文章）", out)
        self.assertTrue(self.first_lines(self.record_text("T003", "三个提示词写完周报"))[0].endswith("；尺寸：横版 2.35:1"))
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen", "--size", "4:3")
        self.assertEqual(code, 2)
        self.assertIn("尺寸只能写 竖版 3:4、横版 2.35:1、方形 1:1 之一", out.splitlines()[0])

    def test_风格编号两种都认_第一行照固定写法(self):
        self.wb.photo("正脸.jpg", jpeg(30, 40))
        for given in ("风格/2026-10-04_3张", "2026-10-04_3张", os.path.join(self.wb.assets, "风格", "2026-10-04_3张")):
            code, out = self.cli("record", "batch", "T002", "--tool", "image_gen", "--size", "方形1:1", "--benchmark", given)
            self.assertEqual(code, 0, out)
            self.assertIn("风格：风格/2026-10-04_3张（风格名：蓝白大字风）", out)
        self.assertEqual(self.first_lines(self.record_text()),
                         ["对标：风格/2026-10-04_3张（蓝白大字风）；照片：1 张；日期：2026-10-05；软件：Codex；生图：image_gen；尺寸：方形 1:1"])
        info = R.parse_info(self.first_lines(self.record_text())[0])
        self.assertEqual((info["style_id"], info["style_name"], info["size"]), ("风格/2026-10-04_3张", "蓝白大字风", Z.SQUARE))
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen", "--benchmark", "风格/没有这组")
        self.assertEqual(code, 2)
        self.assertIn("认不出风格「风格/没有这组」", out.splitlines()[0])
        self.wb.account("抖音-还没拆")
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen", "--benchmark", "抖音-还没拆")
        self.assertEqual(code, 2)
        self.assertIn("还没拆封面 VI", out.splitlines()[0])

    def test_照片_默认都用_主照片在前_再按放进来的先后_最多3张(self):
        first = self.wb.photo("最早.jpg", jpeg(30, 40), minutes_ago=50)
        second = self.wb.photo("第二.png", png(10, 10), minutes_ago=40)
        main = self.wb.photo("主照片.jpg", jpeg(32, 40), minutes_ago=30)
        self.wb.photo("最晚.webp", b"RIFF\x00\x00\x00\x00WEBPVP8 ", minutes_ago=1)
        write(os.path.join(self.wb.assets, "封面设置.json"), json.dumps({"photo": "我的照片/主照片.jpg", "benchmark": "抖音-某某"}, ensure_ascii=False))
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen")
        self.assertEqual(code, 0, out)
        self.assertIn("照片（3 张，「我的照片」里的，主照片在前，再按放进来的先后", out)
        lines = out.splitlines()
        at = next(i for i, line in enumerate(lines) if line.startswith("  照片（"))
        self.assertEqual(lines[at + 1:at + 4], ["    1. %s" % main, "    2. %s" % first, "    3. %s" % second])
        self.assertIn("「我的照片」里有 4 张，一张封面最多用 3 张，这批用前 3 张", out)
        self.assertIn("；照片：3 张；", self.record_text())
        code, out = run_cli(["where"], self.env, cwd=self.wb.work)
        self.assertIn("照片：4 张，出封面默认都用（主照片在前，再按放进来的先后；一张封面最多 3 张当长相参考），这次用前 3 张：", out)
        self.assertIn("    1. %s（主照片）" % main, out)
        self.assertIn("另外 1 张这次不用：最晚.webp", out)
        # 主照片找不到了：用剩下的，照样能出
        os.remove(main)
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen")
        self.assertEqual(code, 0, out)
        self.assertIn("封面设置里的主照片找不到了", out)
        self.assertIn("    1. %s" % first, out)
        # 这次只用说的几张：写文件名就行，最多 3 张
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen", "--photo", "第二.png", "--photo", "最早.jpg")
        self.assertEqual(code, 0, out)
        self.assertIn("照片（2 张，用户这次说的", out)
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen", *sum((["--photo", "第二.png"] for _ in range(4)), []))
        self.assertEqual(code, 2)
        self.assertIn("最多写 3 张", out)

    def test_参考构图_默认用风格的默认构图_说了的要是有的图(self):
        self.wb.photo("正脸.jpg", jpeg(30, 40))
        account = os.path.join(self.wb.accounts, "抖音-某某")
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen")
        self.assertEqual(code, 0, out)
        self.assertIn("参考构图（这个风格的默认构图，AI 挑的，当最后一张输入图）：K03、K01", out)
        self.assertIn("    K03：%s" % os.path.join(account, "封面", "K03.png"), out)
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen", "--compositions", "K5、k2")
        self.assertEqual(code, 0, out)
        self.assertIn("参考构图（用户这次说的，当最后一张输入图）：K05、K02", out)
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen", "--compositions", "K09")
        self.assertEqual(code, 2)
        self.assertIn("没有 K09（有 K01 到 K05）", out.splitlines()[0])
        os.remove(os.path.join(account, "默认构图.json"))
        code, out = self.cli("record", "batch", "T002", "--tool", "image_gen")
        self.assertEqual(code, 0, out)
        self.assertIn("参考构图：这个风格还没有默认构图：照 VI拆解.md 的选图建议挑", out)


class PromptOnlyFillTest(unittest.TestCase):
    """Claude Code 只出了提示词：用户在别处生成好图交回来，save 存成同一个编号（照尺寸裁好），record add 把那一行换成图。"""

    def setUp(self):
        self.wb = TempWorkbench()
        self.wb.topic("T002", "用 AI 十分钟写周报")
        account = self.wb.account("抖音-某某")
        write(os.path.join(account, "VI拆解.md"), "# 某某：封面 VI 拆解\n风格名：暖黄手写风\n")
        self.wb.photo("正脸.jpg", jpeg(30, 40))
        write(os.path.join(self.wb.assets, "封面设置.json"), json.dumps({"benchmark": "抖音-某某"}, ensure_ascii=False))
        self.env = self.wb.env(COVER_NOW=NOW)
        self.cand = os.path.join(self.wb.drafts, "T002_用 AI 十分钟写周报", "封面候选")

    def tearDown(self):
        self.wb.cleanup()

    def cli(self, *args):
        return run_cli(list(args), self.env)

    def test_图交回来_存成同一个编号_那一行换成图(self):
        self.cli("record", "batch", "T002", "--tool", "只出提示词", "--size", "竖版3:4")
        for n in (1, 2):
            write(os.path.join(self.cand, "生图描述-%02d.md" % n), "提示词\n")
            code, out = self.cli("record", "add", "T002", "--no", str(n), "--change", "K0%d 讲台" % n, "--check", "只出了提示词", "--file", "生图描述-%02d.md" % n)
            self.assertEqual(code, 0, out)
        self.cli("record", "summary", "T002")
        given = write(os.path.join(self.wb.home, "下载", "生成好的.png"), png(30, 40))  # 已经是 3:4，不用 sips
        code, out = self.cli("save", "T002", "--no", "01", "--from", given)
        self.assertEqual(code, 0, out)
        self.assertIn("尺寸：竖版 3:4（照第 1 批写的）", out)
        self.assertIn("封面-01 原来只出了提示词", out)
        code, out = self.cli("record", "add", "T002", "--no", "01", "--change", "K01 讲台", "--check", "通过", "--file", "封面-01.png")
        self.assertEqual(code, 0, out)
        self.assertIn("那一行换成这张", out)
        code, out = self.cli("record", "summary", "T002")
        self.assertEqual(code, 0, out)
        text = read(os.path.join(self.cand, "生成记录.md"))
        self.assertIn("| 01 | K01 讲台 | 通过 | 封面-01.png |\n| 02 | K02 讲台 | 只出了提示词 | 生图描述-02.md |", text)
        self.assertIn("生成 1 次，报错 0 次，实际像素 30×40；另有 1 份只出了提示词", text)
        self.assertNotIn("只出了提示词 2 份", text)
        # 再存一次 01：已经有图了，不复用
        code, out = self.cli("save", "T002", "--no", "01", "--from", write(os.path.join(self.wb.home, "下载", "又一张.png"), png(33, 44)))
        self.assertEqual(code, 2)
        self.assertIn("编号已经用过了", out)
        code, out = run_cli(["where", "T002"], self.env, cwd=self.wb.work)
        self.assertIn("下一张的编号：03", out)
        # 删掉过的（「## 记录」里写着删除）不能再存
        self.cli("record", "note", "T002", "删除 封面-02（挪进回收站）")
        code, out = self.cli("save", "T002", "--no", "02", "--from", write(os.path.join(self.wb.home, "下载", "第三张.png"), png(36, 48)))
        self.assertEqual(code, 2)
        self.assertIn("编号已经用过了", out)


class DocTest(unittest.TestCase):
    def test_读出上一批的尺寸_老的第一行没写尺寸也能读(self):
        doc = R.Doc("# T002 封面生成记录\n\n## 第 1 批\n\n对标：甲；照片：我的照片/正脸.jpg；日期：2026-10-04；软件：Codex；生图：image_gen\n\n" + R.HEAD + "\n" + R.SEP
                    + "\n| 01 | K01 | 通过 | 封面-01.png |\n\n## 第 2 批\n\n" + R.info_line("风格/x", None, "2 张", "2026-10-05", "Codex", "image_gen", Z.WIDE)
                    + "\n\n## 第 3 批\n\n对标：甲；照片：1 张；日期：2026-10-05；软件：Codex；生图：image_gen\n", "T002")
        self.assertEqual(doc.last_size(), (2, Z.WIDE))
        self.assertEqual(R.parse_info("对标：甲；照片：我的照片/正脸.jpg")["size"], None)
        self.assertEqual(R.Doc("", "T002").last_size(), (None, None))
        self.assertEqual(R.info_line("风格/x", "名字", "2 张", "2026-10-05", "Codex", "image_gen", Z.PORTRAIT),
                         "对标：风格/x（名字）；照片：2 张；日期：2026-10-05；软件：Codex；生图：image_gen；尺寸：竖版 3:4")

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
