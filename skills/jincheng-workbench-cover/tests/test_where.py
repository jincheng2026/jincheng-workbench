"""cover.py where：位置、当前打开的文件夹和读写（说法照创作页的 where.py）、工作台在不在运行、人物参考图片和默认风格、全部风格（两种来源）；
给了编号再说封面候选、下一张的编号（删掉的、第一版收藏过的、生成记录里提过的都不复用）、第几批、上一批的尺寸、这条选题的页面。"""
import errno
import hashlib
import json
import os
import unittest
from unittest import mock

from support import LocalServer, TempWorkbench, jpeg, png, run_cli, write

from cover_kit import places as PL
from cover_kit import where as W


def health(app, settings_file, ui):
    instance = hashlib.sha256(os.path.abspath(settings_file).encode("utf-8")).hexdigest()[:16]
    return json.dumps({"ok": True, "app": app, "version": "1.1.0", "instance": instance, "ui": ui}).encode("utf-8")


class WhereTest(unittest.TestCase):
    def setUp(self):
        self.wb = TempWorkbench(ports={"ui": 39871, "api": 39870})
        self.env = self.wb.env()

    def tearDown(self):
        self.wb.cleanup()

    def where(self, *args, cwd=None):
        return run_cli(["where"] + list(args), self.env, cwd=cwd or self.wb.work)

    def test_位置都打印完整路径(self):
        code, out = self.where()
        self.assertEqual(code, 0, out)
        for line in ("设置文件：%s" % self.wb.settings_file, "工作文件夹：%s" % self.wb.work,
                     "当前打开的文件夹：%s（就是工作文件夹）" % os.path.realpath(self.wb.work), "读写：工作文件夹能读能写",
                     "封面素材：%s" % self.wb.assets, "对标账号：%s" % self.wb.accounts, "调研报告：%s" % self.wb.reports,
                     "内容草稿：%s" % self.wb.drafts, "一批几张：5"):
            self.assertIn(line, out)
        self.assertIn("工作台：没在运行", out)
        self.assertIn("人物参考图片：还没有", out)
        self.assertIn("默认风格：没设，也还没有拆过封面 VI 的风格", out)
        self.assertIn("风格：0 个（拆过 0 个，还没拆 0 个）", out)
        self.assertEqual([n for n in os.listdir(self.wb.work) if n.startswith(".jc-write-check-")], [])  # 查完删掉

    def test_开在别的文件夹_能写就照常_写不了先申请(self):
        other = os.path.join(self.wb.home, "别的文件夹")
        os.makedirs(other)
        code, out = self.where(cwd=other)
        self.assertIn("当前打开的文件夹：%s（不是工作文件夹。封面、VI 拆解都按这里打印的完整路径写进工作文件夹" % os.path.realpath(other), out)
        self.assertIn("读写：工作文件夹能读能写", out)
        self.wb.lock(self.wb.work, 0o555)
        code, out = self.where(cwd=other)
        self.assertIn("读写：工作文件夹写不了", out)
        self.assertIn("还没被允许写工作文件夹：先别写任何文件", out)
        code, out = self.where()
        self.assertIn("这个对话打开的就是工作文件夹，但现在只能读文件", out)

    def test_工作台在运行_给详情页链接(self):
        server = LocalServer()
        try:
            self.wb.write_settings({"workFolder": self.wb.work, "ports": {"ui": server.port, "api": server.port - 1 if server.port > 1025 else server.port + 1}})
            # 别人的工作台（另一个设置文件）不算
            server.routes["/api/health"] = (200, "application/json", health("jincheng-workbench", "/somewhere/else/config.json", server.port))
            code, out = self.where("T002")
            self.assertIn("工作台：没在运行", out)
            server.routes["/api/health"] = (200, "application/json", health(PL.brand_id(), self.wb.settings_file, 40123))
            code, out = self.where("T002")
            self.assertEqual(code, 0, out)
            self.assertIn("工作台：正在运行，http://127.0.0.1:40123（「封面」页：http://127.0.0.1:40123/content?tab=covers）", out)  # 用它报的界面端口
            self.assertIn("工作台里这条选题的页面：http://127.0.0.1:40123/content/T002", out)
            self.assertEqual(server.requests[-1]["host"], "127.0.0.1:%d" % server.port)
        finally:
            server.close()

    def test_沙箱不让连本机端口_说查不了(self):
        def refuse(*a, **k):
            raise PermissionError(errno.EPERM, "Operation not permitted")
        import http.client
        with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(http.client.HTTPConnection, "request", refuse):
            info = W.collect(here=self.wb.work)
        self.assertEqual(info["workbench"]["running"], False)
        self.assertTrue(info["workbench"]["blocked"])
        text = W.show(info)
        self.assertIn("工作台：查不了", text)
        self.assertNotIn("工作台：没在运行", text)

    def test_设置文件写坏了_退出码1(self):
        write(self.wb.settings_file, "{ 坏了")
        code, out = self.where()
        self.assertEqual(code, 1)
        self.assertIn("工作台的设置文件写坏了", out)

    def test_一条内容的封面候选_下一张编号不复用(self):
        self.wb.topic("T002", "用 AI 十分钟写周报")
        draft = self.wb.draft("T002", "用AI写周报")
        cand = os.path.join(draft, "封面候选")
        for n in (1, 2, 3):
            write(os.path.join(cand, "封面-%02d.png" % n), png(8, 8, (n, 1, 1)))
        write(os.path.join(cand, "生图描述-04.md"), "只有提示词\n")
        write(os.path.join(cand, "批注", "封面-02-批注.png"), png(4, 4))
        write(os.path.join(draft, "封面-选定.png"), png(8, 8, (2, 1, 1)))
        # 05 删掉了（挪进回收站）、06 收藏以后删了：编号都不能再用
        write(os.path.join(cand, "生成记录.md"), "# T002 封面生成记录\n\n## 第 1 批\n\n对标：甲\n\n| 编号 | 本张变化 | 自检 | 文件名 |\n| --- | --- | --- | --- |\n"
              "| 01 | K01 | 通过 | 封面-01.png |\n\n## 第 2 批\n\n对标：甲\n\n| 编号 | 本张变化 | 自检 | 文件名 |\n| --- | --- | --- | --- |\n"
              "| 05 | K02 | 通过 | 封面-05.png |\n\n## 记录\n\n- 2026-10-05 21:05 删除 封面-05（挪进回收站）\n")
        write(os.path.join(self.wb.assets, "收藏", "T002_封面-06.png"), png(4, 4))
        write(os.path.join(self.wb.assets, "收藏", "T009_封面-30.png"), png(4, 4))  # 别的选题的不算
        write(os.path.join(draft, "T002_创作页.html"), "<html></html>")
        code, out = self.where("T002")
        self.assertEqual(code, 0, out)
        self.assertIn("T002 的选题名：用 AI 十分钟写周报（选题卡）", out)
        self.assertIn("T002 的草稿文件夹：%s" % draft, out)
        self.assertIn("封面候选：%s（3 张图：封面-01 到 封面-03；1 份只有提示词：生图描述-04.md）" % cand, out)
        self.assertIn("下一张的编号：07（封面-07）", out)
        self.assertIn("批次：现在是第 2 批（登记了 1 张）；再开一批是第 3 批，生成计划写进 %s" % os.path.join(cand, "生成计划-第3批.md"), out)
        self.assertIn("生成记录：%s" % os.path.join(cand, "生成记录.md"), out)
        self.assertIn("选定的封面：封面-选定.png", out)
        self.assertNotIn("批注", out)  # 第一版的批注图只用来认编号，不再说给用户
        self.assertIn("创作页：有", out)
        self.assertIn("T002 的内容类型：口播", out)
        self.assertIn("尺寸：还没有哪一批写过尺寸；没说的话默认 竖版 3:4（内容类型「口播」算视频）", out)
        self.assertIn("工作台里这条选题的页面：http://127.0.0.1:39871/content/T002", out)

    def test_还没有草稿文件夹_选题名从选题总览来(self):
        write(os.path.join(self.wb.work, "选题库", "00_选题总览.md"),
              "# 选题总览\n\n## 选题总表\n\n### 口播\n\n**待做**\n\n| 编号 | 选题 | 来源 | 状态 | 发布日期 | 效果 |\n| --- | --- | --- | --- | --- | --- |\n"
              "| T003 | **三个提示词**写完周报（先拍这条） | 自己的想法 | 待写 |  |  |\n")
        code, out = self.where("t003")
        self.assertEqual(code, 0, out)
        self.assertIn("T003 的选题名：三个提示词写完周报（选题总览）", out)
        self.assertIn("还没有。开一批时（record batch）会建好：%s" % os.path.join(self.wb.drafts, "T003_三个提示词写完周报"), out)
        self.wb.draft("T003", "甲")
        self.wb.draft("T003", "乙")
        code, out = self.where("T003")
        self.assertIn("有 2 个，要先问用户用哪个", out)
        code, out = self.where("第三条")
        self.assertEqual(code, 2)
        self.assertIn("内容编号要写成 T 加三位或四位数字", out)

    def test_照片_默认风格_全部风格两种来源(self):
        photo = os.path.join(self.wb.assets, "人物参考图片", "正脸.jpg")
        write(photo, jpeg(30, 40))
        account = self.wb.account("抖音-某某")
        write(os.path.join(account, "VI拆解.md"), "# 某某：封面 VI 拆解\n风格名：暖黄手写风\n")
        for n in (1, 2, 3):
            write(os.path.join(account, "封面", "K%02d.png" % n), png(6, 8, (n, 0, 0)))
        write(os.path.join(account, "默认构图.json"), json.dumps({"ids": ["K03", "K01"], "by": "AI", "updatedAt": "2026-10-04T21:00:00+08:00"}))
        self.wb.account("抖音-还没拆")
        mine = self.wb.style_folder("2026-10-04_2张", {"a.png": png(4, 4), "b.jpg": jpeg(8, 8)})
        write(os.path.join(mine, "VI拆解.md"), "# 放进来的 2 张图：封面 VI 拆解\n风格名：蓝白大字风\n")
        write(os.path.join(mine, "默认构图.json"), json.dumps({"ids": ["K02"], "by": "你", "updatedAt": "2026-10-04T22:00:00+08:00"}, ensure_ascii=False))
        self.wb.style_folder("2026-10-05_1张", {"c.png": png(4, 4)})
        code, out = self.where()
        self.assertIn("人物参考图片：1 张，出封面默认都用", out)
        self.assertIn("    1. %s" % photo, out)
        self.assertIn("默认风格：没设。拆过的有：抖音-某某（暖黄手写风）、风格/2026-10-04_2张（蓝白大字风）", out)
        self.assertIn("风格：4 个（拆过 2 个，还没拆 2 个）：", out)
        self.assertRegex(out, r"  - 抖音-某某（对标账号）：风格名「暖黄手写风」（\d{4}-\d{2}-\d{2} 拆的），原图 3 张，默认构图：K03、K01（AI 挑的）\n")
        self.assertIn("  - 抖音-还没拆（对标账号）：还没拆，原图 0 张，默认构图：还没有\n", out)
        self.assertRegex(out, r"  - 风格/2026-10-04_2张（放进来的图）：风格名「蓝白大字风」（[^）]+），原图 2 张，默认构图：K02（你改过的）\n")
        self.assertIn("  - 风格/2026-10-05_1张（放进来的图）：还没拆，原图 1 张，默认构图：还没有\n", out)
        self.assertIn("放进来的图：%s" % os.path.join(self.wb.assets, "风格"), out)
        write(os.path.join(self.wb.assets, "封面设置.json"), json.dumps({"photo": "人物参考图片/正脸.jpg", "benchmark": "风格/2026-10-04_2张", "batchSize": 6}, ensure_ascii=False))
        code, out = self.where()
        self.assertIn("    1. %s（主照片）" % photo, out)
        self.assertIn("默认风格：风格/2026-10-04_2张（风格名：蓝白大字风）；VI拆解：%s" % os.path.join(mine, "VI拆解.md"), out)
        self.assertRegex(out, r"  - 风格/2026-10-04_2张（放进来的图）：风格名「蓝白大字风」（[^）]+），原图 2 张，默认构图：K02（你改过的），默认风格\n")
        write(os.path.join(self.wb.assets, "封面设置.json"), json.dumps({"photo": "人物参考图片/正脸.jpg", "benchmark": "抖音-某某", "batchSize": 6}))
        code, out = self.where()
        self.assertIn("默认风格：抖音-某某（风格名：暖黄手写风）；VI拆解：%s" % os.path.join(account, "VI拆解.md"), out)
        self.assertIn("一批几张：6", out)
        code, out = run_cli(["where", "--json"], self.env, cwd=self.wb.work)
        data = json.loads(out)
        self.assertEqual(data["cover"]["settings"]["benchmark"], "抖音-某某")
        self.assertEqual(data["places"]["cover_assets"], self.wb.assets)


class CommandErrorsTest(unittest.TestCase):
    """命令写错了：第一行用中文说清怎么改，退出码 2，不打印英文的 usage。"""

    def test_写错的命令(self):
        wb = TempWorkbench()
        try:
            env = wb.env()
            for args, want in ((["record", "batch", "T002"], "缺参数：--tool"),
                               (["record", "batch", "T002", "--tool", "画图"], "--tool 只能写"),
                               (["where", "T002", "--oops"], "多了看不懂的参数：--oops"),
                               (["save", "T002", "--no"], "--no 后面要写一个值"),
                               (["vi", "prepare", "抖音-某某", "--max", "abc"], "--max 要写数字（收到的是「abc」）"),
                               (["settings", "batch"], "要给张数")):
                code, out = run_cli(args, env)
                self.assertEqual(code, 2, out)
                first = out.splitlines()[0]
                self.assertIn(want, first, args)
                self.assertNotIn("usage", out)
        finally:
            wb.cleanup()


class PlacesTest(unittest.TestCase):
    def test_位置的写法和工作台一样(self):
        env = {"HOME": "/h", "WORKBENCH_CONFIG_DIR": "/nowhere-for-tests"}
        p = PL.settings(env)
        self.assertEqual(p["work_folder"], "/h/Documents/" + PL.brand_id())
        self.assertEqual(p["cover_assets"], "/h/Documents/%s/封面素材" % PL.brand_id())
        self.assertEqual(p["accounts"], "/h/Documents/%s/市场调研/对标账号" % PL.brand_id())
        self.assertEqual(p["ui_port"], 18879)

    def test_设置里改了位置(self):
        wb = TempWorkbench(paths={"coverAssets": "~/封面", "drafts": "/abs/草稿", "researchReports": "研究/报告"}, ports={"ui": 8879})
        try:
            p = PL.settings(wb.env())
            self.assertEqual(p["cover_assets"], os.path.join(wb.home, "封面"))
            self.assertEqual(p["drafts"], "/abs/草稿")
            self.assertEqual(p["reports"], os.path.join(wb.work, "研究", "报告"))
            self.assertEqual(p["ui_port"], 18879)  # 8879 是本机常见服务占用的端口，按默认
        finally:
            wb.cleanup()


if __name__ == "__main__":
    unittest.main()
