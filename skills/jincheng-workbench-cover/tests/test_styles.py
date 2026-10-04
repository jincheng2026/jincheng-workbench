"""风格（第二版约定）：两种风格编号都认（对标账号文件夹名、「风格/<文件夹名>」），你放进来的图走完拆 VI 全流程；
默认构图.json 写 AI 挑的、不写就按案例顺序取前 5 个、用户改过的不覆盖、编号要是 封面/ 里真有的；
style split 把不是一种风格的几张分进新的风格文件夹。"""
import json
import os
import unittest
from collections import OrderedDict
from datetime import datetime

from support import TempWorkbench, jpeg, png, read, run_cli, write
from test_vi import study_for

NOW = "2026-10-05 21:10"
STAMP = datetime(2026, 10, 5, 21, 10).astimezone().isoformat()  # COVER_NOW 那一刻、带这台电脑的时区
STYLE = "风格/2026-10-04_5张"


def study_with_cases(ids, cases):
    """study_for 的研究数据，换成这几个案例（每个案例的证据是一组原图编号）。"""
    study = study_for(ids)
    study["cases"] = [dict(study["cases"][0], id="C%d" % (i + 1), name="案例%d" % (i + 1), evidence_ids=list(ev)) for i, ev in enumerate(cases)]
    return study


class ImagesStyleFlowTest(unittest.TestCase):
    """工作台在「封面」页建的一组放进来的图：vi prepare → inventory → check → build → export → 设成默认风格 → where。"""

    def setUp(self):
        self.wb = TempWorkbench()
        self.folder = self.wb.style_folder("2026-10-04_5张", OrderedDict([
            ("封面10.png", png(30, 40, (10, 10, 10))), ("封面2.jpg", jpeg(24, 32)), ("b.png", png(30, 40, (0, 0, 200))),
            ("a.png", png(30, 40, (200, 0, 0))), ("手机拍的.heic", b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic"),
            ("封面1.png", png(30, 40, (0, 200, 0))),
        ]))
        self.covers = os.path.join(self.folder, "封面")
        self.env = self.wb.env(COVER_NO_PILLOW="1", COVER_NOW=NOW)

    def tearDown(self):
        self.wb.cleanup()

    def cli(self, *args):
        return run_cli(list(args), self.env)

    def test_全流程_风格编号三种写法都认(self):
        code, out = self.cli("vi", "prepare", STYLE)
        self.assertEqual(code, 0, out)
        self.assertIn("一共 5 张：K01 到 K05（改名 5 张）", out)
        self.assertIn("没纳入的：手机拍的.heic", out)
        self.assertIn('下一步：vi inventory "%s"' % STYLE, out)
        # 不叫 Kxx 的按文件名顺序改名：a、b、封面1、封面2、封面10
        self.assertEqual(sorted(os.listdir(self.covers)), ["K01.png", "K02.png", "K03.png", "K04.jpg", "K05.png", "原文件名.md", "手机拍的.heic"])
        with open(os.path.join(self.covers, "K01.png"), "rb") as f:
            self.assertEqual(f.read(), png(30, 40, (200, 0, 0)))
        names = read(os.path.join(self.covers, "原文件名.md"))
        self.assertIn("| K01.png | a.png |", names)
        self.assertIn("| K05.png | 封面10.png |", names)
        records = json.loads(read(os.path.join(self.folder, "VI研究", "records.json")))
        self.assertEqual(records["selection"]["mode"], "provided")
        self.assertEqual(records["account"]["label"], "放进来的 5 张图")
        self.assertIn(STYLE, records["account"]["verification"])
        self.assertTrue(all(r["work_id"] is None and r["preservation"] == "provided-copy" for r in records["records"]))

        # 只写文件夹名、写完整路径，认的都是同一个
        code, out = self.cli("vi", "inventory", "2026-10-04_5张")
        self.assertEqual(code, 0, out)
        self.assertIn("研究 5 张：K01、K02、K03、K04、K05", out)
        self.assertIn("style split", out)  # 提醒：不是一种风格就先分开
        self.assertIn("限制：研究的是用户放进来的这几张图，可能来自不同的博主", out)
        self.assertNotIn("账号", out)
        write(os.path.join(self.folder, "VI研究", "study.json"),
              json.dumps(study_with_cases(["K01", "K02", "K03", "K04", "K05"], [["K03", "K01"], ["K01", "K05", "K02", "K04"]]), ensure_ascii=False))
        code, out = self.cli("vi", "check", self.folder)
        self.assertEqual(code, 0, out)
        code, out = self.cli("vi", "build", STYLE)
        self.assertEqual(code, 0, out)
        report = os.path.join(self.wb.reports, "2026-10-05_放进来的5张封面VI")
        meta = json.loads(read(os.path.join(report, "meta.json")), object_pairs_hook=OrderedDict)
        self.assertEqual((meta["title"], meta["source"], meta["type"]), ("5 张封面的 VI", STYLE, "封面VI"))  # 还没起名

        # 导出：风格名、默认构图（不写 --compositions 时按案例的顺序取前 5 个不重复的）、报告的名字跟着改
        code, out = self.cli("vi", "export", STYLE, "--style", "蓝白大字风")
        self.assertEqual(code, 0, out)
        lines = read(os.path.join(self.folder, "VI拆解.md")).splitlines()
        self.assertEqual(lines[:2], ["# 放进来的 5 张图：封面 VI 拆解", "风格名：蓝白大字风"])
        self.assertIn("用户放进工作台「封面」的 5 张图（%s" % STYLE, lines[3])
        self.assertIn("「2026-10-05_放进来的5张封面VI」", lines[3])
        self.assertEqual(json.loads(read(os.path.join(self.folder, "默认构图.json")), object_pairs_hook=OrderedDict),
                         OrderedDict([("ids", ["K03", "K01", "K05", "K02", "K04"]), ("by", "AI"), ("updatedAt", STAMP)]))
        self.assertIn("默认构图：K03、K01、K05、K02、K04（AI 挑的）", out)
        self.assertIn("报告的名字跟着改成了「蓝白大字风的封面 VI」", out)
        self.assertEqual(json.loads(read(os.path.join(report, "meta.json")))["title"], "蓝白大字风的封面 VI")
        self.assertIn('下一步：用户还没有默认风格，直接设成默认：settings set-default "%s"' % STYLE, out)

        # 起了名以后再出报告：文件夹和名字都用风格名
        code, out = self.cli("vi", "build", STYLE)
        self.assertEqual(code, 0, out)
        self.assertTrue(os.path.isfile(os.path.join(self.wb.reports, "2026-10-05_蓝白大字风封面VI", "meta.json")))
        self.assertIn("「蓝白大字风的封面 VI」", out)

        code, out = self.cli("settings", "set-default", STYLE)
        self.assertEqual(code, 0, out)
        code, out = run_cli(["where"], self.env, cwd=self.wb.work)
        self.assertIn("默认风格：%s（风格名：蓝白大字风）" % STYLE, out)
        self.assertIn("  - %s（放进来的图）：风格名「蓝白大字风」（" % STYLE, out)
        self.assertIn("原图 5 张，默认构图：K03、K01、K05、K02、K04（AI 挑的），默认风格", out)

    def test_图都没有_说清楚去哪放(self):
        os.makedirs(os.path.join(self.wb.assets, "风格", "空的", "封面"))
        code, out = self.cli("vi", "prepare", "风格/空的")
        self.assertEqual(code, 2)
        self.assertIn("「风格/空的」还没有能拆的图", out.splitlines()[0])
        self.assertIn("工作台「封面」页", out)
        self.assertNotIn("TikHub", out)

    def test_认不出的风格编号(self):
        for bad in ("风格/没有这组", "风格/../外面", "没有这个", "../../外面", "风格/"):
            code, out = self.cli("vi", "prepare", bad)
            self.assertEqual(code, 2, bad)
            self.assertIn("认不出风格", out.splitlines()[0], bad)


class CompositionsTest(unittest.TestCase):
    """vi export 写默认构图：--compositions 指定、不写按案例顺序取前 5 个、by 是「你」的不覆盖、编号要是 封面/ 里有的。"""

    def setUp(self):
        self.wb = TempWorkbench()
        self.account = self.wb.account("抖音-某某")
        self.ids = ["K%02d" % n for n in range(1, 8)]
        for n in range(1, 8):
            write(os.path.join(self.account, "封面", "K%02d.png" % n), png(6, 8, (n, 0, 0)))
        write(os.path.join(self.account, "VI研究", "study.json"),
              json.dumps(study_with_cases(self.ids, [["K06", "K02"], ["K02", "K07", "K01"], ["K05", "K03", "K04"]]), ensure_ascii=False))
        self.file = os.path.join(self.account, "默认构图.json")
        self.env = self.wb.env(COVER_NOW=NOW)

    def tearDown(self):
        self.wb.cleanup()

    def export(self, *extra):
        return run_cli(["vi", "export", "抖音-某某", "--style", "暖黄手写风"] + list(extra), self.env)

    def saved(self):
        return json.loads(read(self.file), object_pairs_hook=OrderedDict)

    def test_不写就按案例顺序取前5个不重复的(self):
        code, out = self.export()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.saved(), OrderedDict([("ids", ["K06", "K02", "K07", "K01", "K05"]), ("by", "AI"), ("updatedAt", STAMP)]))

    def test_写AI挑的_编号要是有的图_用户改过的不覆盖(self):
        code, out = self.export("--compositions", "K3, k7、K01,K03")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.saved()["ids"], ["K03", "K07", "K01"])  # 去重、补零、保留先后
        code, out = self.export("--compositions", "K02,K09")
        self.assertEqual(code, 2)
        self.assertIn("「抖音-某某」的 封面/ 里没有 K09（有 K01 到 K07）", out.splitlines()[0])
        self.assertEqual(self.saved()["ids"], ["K03", "K07", "K01"])  # 报错时不动
        code, out = self.export("--compositions", "第三张")
        self.assertEqual(code, 2)
        self.assertIn("写成 K03 这样", out)
        # 用户在工作台改过（by 是「你」）：AI 再导出也不覆盖
        mine = OrderedDict([("ids", ["K05", "K04"]), ("by", "你"), ("updatedAt", "2026-10-05T09:00:00+08:00")])
        write(self.file, json.dumps(mine, ensure_ascii=False))
        code, out = self.export("--compositions", "K01,K02")
        self.assertEqual(code, 0, out)
        self.assertIn("默认构图是用户在工作台改过的（K05、K04），没覆盖", out)
        self.assertEqual(self.saved(), mine)
        code, out = self.export()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.saved(), mine)
        # 写坏了的照样重写
        write(self.file, "{ 坏了")
        code, out = self.export("--compositions", "K02")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.saved()["ids"], ["K02"])


class SplitTest(unittest.TestCase):
    """style split：放进来的图拆出来不是一种风格，把几张挪进新的风格文件夹；两边各自从 vi prepare 拆起。"""

    def setUp(self):
        self.wb = TempWorkbench()
        self.folder = self.wb.style_folder("2026-10-04_5张", OrderedDict(
            (name, png(10, 10, (n, n, n))) for n, name in enumerate(["a.png", "b.png", "c.png", "d.png", "e.png"], 1)))
        self.covers = os.path.join(self.folder, "封面")
        self.env = self.wb.env(COVER_NOW=NOW)
        code, out = run_cli(["vi", "prepare", STYLE], self.env)
        assert code == 0, out
        write(os.path.join(self.folder, "默认构图.json"), json.dumps({"ids": ["K02", "K04", "K01"], "by": "你", "updatedAt": "2026-10-05T09:00:00+08:00"}, ensure_ascii=False))

    def tearDown(self):
        self.wb.cleanup()

    def cli(self, *args):
        return run_cli(list(args), self.env)

    def test_挪进新文件夹_挪回原名_两边记一笔_各自从prepare拆起(self):
        code, out = self.cli("style", "split", STYLE, "K02", "k4")
        self.assertEqual(code, 0, out)
        new = os.path.join(self.wb.assets, "风格", "2026-10-04_5张-2")
        self.assertIn("分好了：K02、K04 挪进了新的风格 风格/2026-10-04_5张-2", out)
        self.assertIn("K02.png → b.png、K04.png → d.png", out)
        self.assertIn('vi prepare "风格/2026-10-04_5张-2"', out)
        self.assertEqual(sorted(os.listdir(os.path.join(new, "封面"))), ["b.png", "d.png", "原文件名.md"])
        with open(os.path.join(new, "封面", "d.png"), "rb") as f:
            self.assertEqual(f.read(), png(10, 10, (4, 4, 4)))
        self.assertEqual(sorted(os.listdir(self.covers)), ["K01.png", "K03.png", "K05.png", "原文件名.md"])
        style_json = json.loads(read(os.path.join(new, "风格.json")), object_pairs_hook=OrderedDict)
        self.assertEqual(style_json, OrderedDict([("from", "从 %s 分出来" % STYLE), ("createdAt", STAMP), ("count", 2)]))
        self.assertEqual(json.loads(read(os.path.join(self.folder, "风格.json")))["count"], 3)
        comp = json.loads(read(os.path.join(self.folder, "默认构图.json")))
        self.assertEqual((comp["ids"], comp["by"]), (["K01"], "你"))  # 挪走的编号去掉，谁定的不变
        old_names = read(os.path.join(self.covers, "原文件名.md"))
        self.assertNotIn("| K02.png |", old_names)
        self.assertIn("| K03.png | c.png |", old_names)
        self.assertIn("## 挪动记录\n\n- 2026-10-05 21:10 分出去 2 张，挪进了 风格/2026-10-04_5张-2，名字改回原名：K02.png → b.png、K04.png → d.png", old_names)
        new_names = read(os.path.join(new, "封面", "原文件名.md"))
        self.assertIn("- 2026-10-05 21:10 从 %s 分过来 2 张，名字改回原名：b.png（那边的 K02.png）、d.png（那边的 K04.png）" % STYLE, new_names)

        # 两边各自从 vi prepare 拆起：新的那边按文件名重新编号，挪动记录留着
        code, out = self.cli("vi", "prepare", "风格/2026-10-04_5张-2")
        self.assertEqual(code, 0, out)
        self.assertIn("一共 2 张：K01 到 K02", out)
        new_names = read(os.path.join(new, "封面", "原文件名.md"))
        self.assertIn("| K01.png | b.png |", new_names)
        self.assertIn("从 %s 分过来 2 张" % STYLE, new_names)
        code, out = self.cli("vi", "prepare", STYLE)
        self.assertEqual(code, 0, out)
        records = json.loads(read(os.path.join(self.folder, "VI研究", "records.json")))
        self.assertEqual([r["id"] for r in records["records"]], ["K01", "K03", "K05"])
        self.assertIn("分出去 2 张", read(os.path.join(self.covers, "原文件名.md")))

        # 再分一次：新文件夹往后排
        code, out = self.cli("style", "split", STYLE, "K05")
        self.assertEqual(code, 0, out)
        self.assertTrue(os.path.isfile(os.path.join(self.wb.assets, "风格", "2026-10-04_5张-3", "封面", "e.png")))
        code, out = run_cli(["where"], self.env, cwd=self.wb.work)
        self.assertIn("  - 风格/2026-10-04_5张-2（放进来的图）：还没拆，原图 2 张", out)
        self.assertIn("  - 风格/2026-10-04_5张-3（放进来的图）：还没拆，原图 1 张", out)

    def test_不能分的几种情况(self):
        account = self.wb.account("抖音-某某")
        write(os.path.join(account, "封面", "K01.png"), png(4, 4))
        code, out = self.cli("style", "split", "抖音-某某", "K01")
        self.assertEqual(code, 2)
        self.assertIn("对标账号不拆分文件夹", out.splitlines()[0])
        code, out = self.cli("style", "split", STYLE, "K01", "K02", "K03", "K04", "K05")
        self.assertEqual(code, 2)
        self.assertIn("不能全挪走", out.splitlines()[0])
        code, out = self.cli("style", "split", STYLE, "K09")
        self.assertEqual(code, 2)
        self.assertIn("没有 K09（有 K01 到 K05）", out.splitlines()[0])
        code, out = self.cli("style", "split", STYLE)
        self.assertEqual(code, 2)
        self.assertIn("缺参数", out.splitlines()[0])
        raw = self.wb.style_folder("2026-10-05_2张", {"x.png": png(4, 4), "y.png": png(5, 5)})
        code, out = self.cli("style", "split", "风格/2026-10-05_2张", "K01")
        self.assertEqual(code, 2)
        self.assertIn("先跑 vi prepare", out.splitlines()[0])
        self.assertEqual(sorted(os.listdir(os.path.join(raw, "封面"))), ["x.png", "y.png"])
        self.assertEqual(sorted(os.listdir(os.path.join(self.wb.assets, "风格"))), ["2026-10-04_5张", "2026-10-05_2张"])  # 报错时什么都没建


if __name__ == "__main__":
    unittest.main()
