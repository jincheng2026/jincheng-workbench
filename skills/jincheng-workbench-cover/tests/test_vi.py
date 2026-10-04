"""拆封面 VI 的全流程：vi prepare（从文件夹复制、从 作品.json 的封面链接下载）→ inventory → check → build → export。
没装 Pillow 也能跑完（COVER_NO_PILLOW=1 模拟没装）；装了的电脑上两种都跑一遍。"""
import hashlib
import json
import os
import unittest
from collections import OrderedDict

from support import LocalServer, TempWorkbench, heic_head, jpeg, pillow_in_cli, png, read, run_cli, write

ACCOUNT = "抖音-示例博主"
NOW = "2026-10-05 21:10"


def study_for(ids):
    """一份写全了的研究数据（逐图观察、一条带频次的规则、一个案例）。"""
    observations = [OrderedDict([
        ("id", i), ("inspection", {"status": "inspected", "method": "打开原尺寸看了人物、文字和手与道具的接触处", "uncertainties": []}),
        ("visible_text", "无可见文字"), ("subject_action", "人物右手托着手机，看向镜头"), ("space", "人在右后，手机在前景放大"),
        ("typography", "顶部白色粗体大字"), ("color_material", "暖黄底，纸质纹理"), ("interpretation", "强调手机里的结果"),
        ("transfer", "新题可以换成自己的成果截图"),
    ]) for i in ids]
    return {
        "title": "示例博主的封面视觉规则", "summary": "前景放大的道具加顶部大字。", "limitations": ["测试用的纯色图"],
        "observations": observations,
        "rules": [{"id": "R1", "name": "前景放大道具", "claim": "主体道具放在前景、比脸大", "scope": "本组全部", "evidence_ids": ids[:1],
                   "exception_ids": [], "boundary": "只看了这几张", "confidence": "看得清",
                   "frequency": {"criterion": "道具是否比脸大", "scope_ids": ids, "present_ids": ids[:1], "absent_ids": ids[1:2], "unknown_ids": ids[2:]}}],
        "cases": [{"id": "C1", "name": "讲台", "evidence_ids": ids[:1], "when": "讲工具结果的题", "relations": "手托道具在前景",
                   "keep": "前景放大", "replace": "道具换成自己的", "inputs": "身份照片", "failure": "手和道具断开"}],
        "review": {"visual_facts": "self-reviewed", "migration": "not-run", "aesthetic": "pending"},
    }


class ViFlowTest(unittest.TestCase):
    def setUp(self):
        self.wb = TempWorkbench()
        self.account = self.wb.account(ACCOUNT)
        self.covers = os.path.join(self.account, "封面")
        self.study_dir = os.path.join(self.account, "VI研究")

    def tearDown(self):
        self.wb.cleanup()

    def cli(self, env, *args):
        return run_cli(list(args), env)

    def flow(self, env):
        src = os.path.join(self.wb.home, "下载的封面")
        write(os.path.join(src, "封面10.png"), png(30, 40, (10, 10, 10)))
        write(os.path.join(src, "封面2.jpg"), jpeg(24, 32))
        write(os.path.join(src, "封面1.png"), png(30, 40, (200, 10, 10)))
        write(os.path.join(src, "封面1（又存了一次）.png"), png(30, 40, (200, 10, 10)))  # 和 封面1 一模一样，不重复放
        write(os.path.join(src, "手机拍的.heic"), heic_head())
        write(os.path.join(src, "说明.txt"), "不是图")

        code, out = self.cli(env, "vi", "prepare", ACCOUNT, "--from", src)
        self.assertEqual(code, 0, out)
        self.assertIn("一共 3 张：K01 到 K03", out)
        self.assertIn("手机拍的.heic", out)
        self.assertEqual(sorted(os.listdir(src)), sorted(["封面10.png", "封面2.jpg", "封面1.png", "封面1（又存了一次）.png", "手机拍的.heic", "说明.txt"]))  # 原文件夹不动
        self.assertEqual(sorted(os.listdir(self.covers)), ["K01.png", "K02.jpg", "K03.png", "原文件名.md"])
        with open(os.path.join(self.covers, "K01.png"), "rb") as f:
            self.assertEqual(f.read(), png(30, 40, (200, 10, 10)))  # 按文件名的顺序：封面1、封面2、封面10
        names = read(os.path.join(self.covers, "原文件名.md"))
        self.assertIn("| K01.png | 封面1.png（从 下载的封面 复制） |", names)
        self.assertIn("| K03.png | 封面10.png（从 下载的封面 复制） |", names)
        records = json.loads(read(os.path.join(self.study_dir, "records.json")))
        self.assertEqual([r["id"] for r in records["records"]], ["K01", "K02", "K03"])
        self.assertEqual(records["records"][1]["file"], "../封面/K02.jpg")
        self.assertEqual(records["selection"]["mode"], "provided")
        self.assertEqual(records["account"]["label"], "示例博主")

        # 用户后来又放了一张进 封面/：接着编号，不动前面的
        write(os.path.join(self.covers, "新的一张.png"), png(30, 40, (0, 200, 0)))
        write(os.path.join(self.covers, "iPhone.HEIC"), heic_head())
        code, out = self.cli(env, "vi", "prepare", ACCOUNT)
        self.assertEqual(code, 0, out)
        self.assertIn("一共 4 张：K01 到 K04", out)
        self.assertIn("没纳入的：iPhone.HEIC", out)
        names = read(os.path.join(self.covers, "原文件名.md"))
        self.assertIn("| K01.png | 封面1.png（从 下载的封面 复制） |", names)
        self.assertIn("| K04.png | 新的一张.png |", names)
        self.assertIn("没纳入的", names)
        self.assertTrue(os.path.isfile(os.path.join(self.study_dir, "records.上一次.json")))

        code, out = self.cli(env, "vi", "inventory", ACCOUNT)
        self.assertEqual(code, 0, out)
        self.assertIn("研究 4 张：K01、K02、K03、K04", out)
        inventory_text = read(os.path.join(self.study_dir, "inventory.json"))
        self.assertNotIn(self.wb.home, inventory_text)  # 清单里不写本机完整路径
        self.assertNotIn(os.path.realpath(self.wb.home), inventory_text)
        inv = json.loads(inventory_text)
        self.assertEqual(inv["counts"]["research_images"], 4)
        self.assertEqual(inv["records"][1]["display_size"], [24, 32])

        code, out = self.cli(env, "vi", "check", ACCOUNT)
        self.assertEqual(code, 2)
        self.assertIn("还没有 VI研究/study.json", out)
        study = study_for(["K01", "K02", "K03", "K04"])
        study["observations"] = study["observations"][:3]
        write(os.path.join(self.study_dir, "study.json"), json.dumps(study, ensure_ascii=False))
        code, out = self.cli(env, "vi", "check", ACCOUNT)
        self.assertEqual(code, 2)
        self.assertIn("研究数据还要改", out.splitlines()[0])
        self.assertIn("K04", out)
        study = study_for(["K01", "K02", "K03", "K04"])
        study["observations"][1]["inspection"]["status"] = "planned"
        write(os.path.join(self.study_dir, "study.json"), json.dumps(study, ensure_ascii=False))
        code, out = self.cli(env, "vi", "check", ACCOUNT)
        self.assertEqual(code, 2)
        self.assertIn("K02 还没有实际逐图看过", out)
        write(os.path.join(self.study_dir, "study.json"), json.dumps(study_for(["K01", "K02", "K03", "K04"]), ensure_ascii=False))
        code, out = self.cli(env, "vi", "check", ACCOUNT)
        self.assertEqual(code, 0, out)
        self.assertIn("校验通过：4 张都有逐图观察，1 条规律，1 个构图案例", out)

        code, out = self.cli(env, "vi", "build", ACCOUNT)
        self.assertEqual(code, 0, out)
        report = os.path.join(self.wb.reports, "2026-10-05_示例博主封面VI")
        self.assertIn("对照网页：%s" % os.path.join(report, "index.html"), out)
        self.assertEqual(sorted(os.listdir(report)), ["VI规范.md", "images", "index.html", "inventory.json", "meta.json", "study.json"])
        self.assertEqual(json.loads(read(os.path.join(report, "meta.json")), object_pairs_hook=OrderedDict),
                         OrderedDict([("title", "示例博主的封面 VI"), ("date", "2026-10-05"), ("type", "封面VI"), ("source", ACCOUNT),
                                      ("pages", [OrderedDict([("file", "index.html"), ("title", "封面 VI")])]), ("workbenchVisible", True)]))
        self.assertEqual(sorted(os.listdir(os.path.join(report, "images"))), ["K01.png", "K02.jpg", "K03.png", "K04.png"])
        for name in os.listdir(os.path.join(report, "images")):
            with open(os.path.join(report, "images", name), "rb") as a, open(os.path.join(self.covers, name), "rb") as b:
                self.assertEqual(a.read(), b.read())
        page = read(os.path.join(report, "index.html"))
        self.assertNotIn("{{", page)
        self.assertIn('id="sample-K04"', page)
        self.assertIn('src="images/K02.jpg"', page)
        self.assertIn("1 / 2 张可判，另有 2 张不可判；统计范围共 4 张", page)
        self.assertNotIn(self.wb.home, self.wb.all_text(report))
        self.assertNotIn(os.path.realpath(self.wb.home), self.wb.all_text(report))

        code, out = self.cli(env, "vi", "export", ACCOUNT)
        self.assertEqual(code, 2)
        self.assertIn("要给这套风格起个名字", out)
        code, out = self.cli(env, "vi", "export", ACCOUNT, "--style", "暖")
        self.assertEqual(code, 2)
        self.assertIn("四到八个字", out)
        code, out = self.cli(env, "vi", "export", ACCOUNT, "--style", "暖黄手写风")
        self.assertEqual(code, 0, out)
        self.assertIn("下一步：用户还没有默认风格，直接设成默认：settings set-default \"%s\"" % ACCOUNT, out)
        self.assertEqual(json.loads(read(os.path.join(self.account, "默认构图.json")))["ids"], ["K01"])  # 没写 --compositions：照案例的顺序取
        lines = read(os.path.join(self.account, "VI拆解.md")).splitlines()
        self.assertEqual(lines[:2], ["# 示例博主：封面 VI 拆解", "风格名：暖黄手写风"])
        text = "\n".join(lines)
        for heading in ("## 整体规律", "## 整组最值得保留的关系", "## 逐图保留关系与容易丢失的部分", "## 选图建议", "## 逐图观察", "## 限制与验证边界"):
            self.assertIn(heading, text)
        self.assertIn("[K02](封面/K02.jpg)", text)
        self.assertIn("「2026-10-05_示例博主封面VI」", text)
        self.assertIn("只换成我这个人，不混脸、不继承对方的发型衣服", text)
        code, out = self.cli(env, "vi", "export", ACCOUNT)  # 不写 --style：沿用原来的
        self.assertEqual(code, 0, out)
        self.assertEqual(read(os.path.join(self.account, "VI拆解.md")).splitlines()[1], "风格名：暖黄手写风")

        code, out = self.cli(env, "settings", "set-default", ACCOUNT)
        self.assertEqual(code, 0, out)
        code, out = self.cli(env, "where")
        self.assertIn("默认风格：%s（风格名：暖黄手写风）" % ACCOUNT, out)

        code, out = self.cli(env, "vi", "build", ACCOUNT)  # 同一天再出一次：另起一个，不覆盖
        self.assertEqual(code, 0, out)
        self.assertTrue(os.path.isdir(report + "-2"))

        # 原图被换过：校验拦下来
        write(os.path.join(self.covers, "K03.png"), png(30, 40, (1, 2, 3)))
        code, out = self.cli(env, "vi", "check", ACCOUNT)
        self.assertEqual(code, 2)
        self.assertIn("K03 的图片字节或尺寸变了", out)
        return inv

    def test_没有Pillow_全流程(self):
        inv = self.flow(self.wb.env(COVER_NO_PILLOW="1", COVER_NOW=NOW))
        self.assertTrue(all(r["pixel_sha256"] is None for r in inv["records"]))
        self.assertIn("本机没有 Pillow：宽高从文件头读，重复按文件内容认，没有逐张解码确认图片完整", inv["limitations"])

    @unittest.skipUnless(pillow_in_cli(), "这台电脑的 Python 没装 Pillow（或者只装在用户自己的家目录里）：装了 Pillow 的那一遍跳过")
    def test_装了Pillow_全流程(self):
        inv = self.flow(self.wb.env(COVER_NOW=NOW))
        self.assertTrue(all(len(r["pixel_sha256"]) == 64 for r in inv["records"]))

    def test_对标账号还没建档(self):
        code, out = run_cli(["vi", "prepare", "抖音-没有这个人"], self.wb.env())
        self.assertEqual(code, 2)
        self.assertIn("「对标账号」里没有「抖音-没有这个人」", out.splitlines()[0])
        code, out = run_cli(["vi", "prepare", "../../外面"], self.wb.env())
        self.assertEqual(code, 2)

    def test_一张封面都没有_请用户放(self):
        code, out = run_cli(["vi", "prepare", ACCOUNT], self.wb.env())
        self.assertEqual(code, 2)
        first = out.splitlines()[0]
        self.assertIn("还没有能拆的封面", first)
        self.assertIn(self.covers, first)
        self.assertIn("这个账号还没有作品数据", first)

    def test_从账号文件夹本身拿_只拿代表作封面(self):
        write(os.path.join(self.account, "头像.png"), png(10, 10, (1, 1, 1)))
        write(os.path.join(self.account, "主页截图-1.png"), png(10, 10, (2, 2, 2)))
        write(os.path.join(self.account, "代表作封面-1.png"), png(30, 40, (3, 3, 3)))
        code, out = run_cli(["vi", "prepare", ACCOUNT, "--from", self.account], self.wb.env())
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(os.listdir(self.covers)), ["K01.png", "原文件名.md"])


class DownloadCoversTest(unittest.TestCase):
    """作品.json 里有封面链接：封面不够时按发布时间从新到旧下载最近的，下过的不重下，坏链接记下来。"""

    def setUp(self):
        self.wb = TempWorkbench()
        self.server = LocalServer()
        for n in range(1, 6):
            self.server.routes["/cover/%d" % n] = (200, "image/jpeg", jpeg(24 + n, 32))
        works = [
            {"id": "7400000000000000101", "published_at": "2026-09-01 08:00", "cover_url": self.server.base + "/cover/1?sign=abc"},
            {"id": "7400000000000000105", "published_at": "2026-09-05 08:00", "cover_url": self.server.base + "/cover/5?sign=abc"},
            {"id": "7400000000000000104", "published_at": "2026-09-04 08:00", "cover_url": self.server.base + "/expired"},
            {"id": "7400000000000000103", "published_at": "2026-09-03 08:00", "cover_url": self.server.base + "/cover/3?sign=abc"},
            {"id": "7400000000000000102", "published_at": "2026-09-02 08:00", "cover_url": self.server.base + "/cover/2?sign=abc"},
            {"id": "7400000000000000100", "published_at": "2026-08-31 08:00"},  # 没有封面链接
        ]
        self.account = self.wb.account(ACCOUNT, works=works)
        self.covers = os.path.join(self.account, "封面")
        self.env = self.wb.env(COVER_NO_PILLOW="1", COVER_NOW=NOW)

    def tearDown(self):
        self.server.close()
        self.wb.cleanup()

    def downloads(self):
        return sorted(r["path"] for r in self.server.requests)

    def test_封面链接都过期了_说清楚(self):
        for n in range(1, 6):
            self.server.routes.pop("/cover/%d" % n)
        code, out = run_cli(["vi", "prepare", ACCOUNT], self.env)
        self.assertEqual(code, 2)
        self.assertIn("作品.json 里的封面链接都下载失败了", out.splitlines()[0])

    def test_连不上网_说清楚_不说链接过期(self):
        import socket
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        closed = sock.getsockname()[1]
        sock.close()  # 这个端口上没人听：连接被拒，和沙箱不让联网一样是「连不上」
        self.wb.account(ACCOUNT, works=[{"id": "7400000000000000201", "published_at": "2026-09-01 08:00",
                                         "cover_url": "http://127.0.0.1:%d/cover.jpg" % closed}])
        code, out = run_cli(["vi", "prepare", ACCOUNT], self.env)
        self.assertEqual(code, 2)
        self.assertIn("下载封面时连不上网", out.splitlines()[0])
        self.assertIn("用能联网的权限再跑一次 vi prepare", out)
        self.assertNotIn("过期", out)

    def test_从新到旧下载_下过的不重下(self):
        code, out = run_cli(["vi", "prepare", ACCOUNT, "--max", "3"], self.env)
        self.assertEqual(code, 0, out)
        self.assertIn("一共 3 张：K01 到 K03（这次下载 3 张、改名 3 张）", out)
        self.assertIn("有 1 张下载失败", out)
        with open(os.path.join(self.covers, "K01.jpg"), "rb") as f:
            self.assertEqual(f.read(), jpeg(29, 32))  # K01 是最新的一条（9 月 5 日）
        with open(os.path.join(self.covers, "K03.jpg"), "rb") as f:
            self.assertEqual(f.read(), jpeg(26, 32))  # 9 月 4 日那条的链接过期了，K03 是 9 月 3 日的
        records = json.loads(read(os.path.join(self.account, "VI研究", "records.json")))
        first = records["records"][0]
        self.assertEqual((first["work_id"], first["preservation"]), ("7400000000000000105", "original-download"))
        self.assertTrue(first["published_at"].startswith("2026-09-05T08:00:00"))
        self.assertEqual(records["selection"]["mode"], "latest")
        self.assertNotIn("sign=abc", json.dumps(records))  # 带签名的封面链接不写进清单
        self.assertIn("作品 7400000000000000105 的封面", read(os.path.join(self.covers, "原文件名.md")))
        before = len(self.server.requests)

        code, out = run_cli(["vi", "prepare", ACCOUNT], self.env)
        self.assertEqual(code, 0, out)
        self.assertIn("一共 4 张：K01 到 K04（这次下载 1 张、改名 1 张）", out)
        new = [r["path"] for r in self.server.requests[before:]]
        self.assertEqual(sorted(new), ["/cover/1?sign=abc", "/expired"])  # 下过的三条不再请求
        code, out = run_cli(["vi", "inventory", ACCOUNT], self.env)
        self.assertEqual(code, 0, out)
        inv = json.loads(read(os.path.join(self.account, "VI研究", "inventory.json")))
        self.assertEqual(inv["selected_ids"], ["K01", "K02", "K03", "K04"])  # 按发布时间从新到旧
        self.assertEqual(inv["counts"]["known_works"], 4)


if __name__ == "__main__":
    unittest.main()
