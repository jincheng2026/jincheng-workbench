"""cover.py save：把 Codex 刚生成的图（$CODEX_HOME/generated_images/ 里最新的一张）存成 封面候选/封面-NN；
不覆盖、编号不复用、拿到的是旧图或者重复的图就停下。CODEX_HOME 指向临时文件夹，不碰真实的 ~/.codex。"""
import os
import time
import unittest

from support import TempWorkbench, jpeg, png, run_cli, write


class SaveTest(unittest.TestCase):
    def setUp(self):
        self.wb = TempWorkbench()
        self.wb.topic("T002", "用 AI 十分钟写周报")
        self.draft = self.wb.draft("T002", "用AI写周报")
        self.cand = os.path.join(self.draft, "封面候选")
        self.gen = os.path.join(self.wb.codex, "generated_images")
        self.env = self.wb.env()

    def tearDown(self):
        self.wb.cleanup()

    def generated(self, name, data, minutes_ago=0):
        path = write(os.path.join(self.gen, "会话-1", name), data)
        stamp = time.time() - minutes_ago * 60
        os.utime(path, (stamp, stamp))
        return path

    def save(self, *args):
        return run_cli(["save", "T002"] + list(args), self.env)

    def test_存最新的一张_宽高读出来(self):
        self.generated("ig_old.png", png(8, 8), minutes_ago=3)
        self.generated("ig_new.png", png(1024, 1536, (9, 9, 9)))
        code, out = self.save("--no", "01")
        self.assertEqual(code, 0, out)
        self.assertIn("存好了：%s（1024×1536" % os.path.join(self.cand, "封面-01.png"), out)
        with open(os.path.join(self.cand, "封面-01.png"), "rb") as f:
            self.assertEqual(f.read(), png(1024, 1536, (9, 9, 9)))

    def test_先写了生图描述再存图_照样能存(self):
        write(os.path.join(self.cand, "生图描述-01.md"), "输入图 1：照片\n输入图 2：K03\n\n提示词\n")
        self.generated("ig.png", png(10, 10))
        code, out = self.save("--no", "01")
        self.assertEqual(code, 0, out)
        self.assertTrue(os.path.isfile(os.path.join(self.cand, "封面-01.png")))

    def test_拿到的是上一张或者旧图_停下(self):
        self.generated("ig_1.png", png(8, 8))
        self.save("--no", "1")
        code, out = self.save("--no", "2")  # 这次没生成出来新图，最新的还是刚才那张
        self.assertEqual(code, 2)
        self.assertIn("这张图已经存过了，就是 封面-01.png", out)
        self.generated("ig_2.png", png(9, 9), minutes_ago=40)
        os.utime(os.path.join(self.gen, "会话-1", "ig_1.png"), (time.time() - 3600, time.time() - 3600))
        code, out = self.save("--no", "2")
        self.assertEqual(code, 2)
        self.assertIn("分钟以前的", out.splitlines()[0])
        self.assertFalse(os.path.exists(os.path.join(self.cand, "封面-02.png")))

    def test_编号不复用_不覆盖(self):
        write(os.path.join(self.cand, "封面-01.png"), png(8, 8))
        write(os.path.join(self.cand, "生成记录.md"), "# T002 封面生成记录\n\n## 记录\n\n- 2026-10-05 21:05 删除 封面-02（挪进回收站）\n")
        self.generated("ig.png", png(10, 10))
        for no in ("01", "2"):
            code, out = self.save("--no", no)
            self.assertEqual(code, 2)
            self.assertIn("编号已经用过了", out)
            self.assertIn("封面-03", out)
        code, out = self.save("--no", "03")
        self.assertEqual(code, 0, out)

    def test_指定文件_和没有生图文件夹(self):
        code, out = self.save("--no", "01")
        self.assertEqual(code, 2)
        self.assertIn("Codex 的生图文件夹里没有图", out)
        src = write(os.path.join(self.wb.home, "别处", "出好的.jpg"), jpeg(30, 40))
        code, out = self.save("--no", "01", "--from", src)
        self.assertEqual(code, 0, out)
        self.assertTrue(os.path.isfile(os.path.join(self.cand, "封面-01.jpg")))  # 扩展名跟着实际格式
        txt = write(os.path.join(self.wb.home, "别处", "不是图.png"), "hello")
        code, out = self.save("--no", "02", "--from", txt)
        self.assertEqual(code, 2)
        self.assertIn("不是 png、jpg 或 webp 图片", out)


if __name__ == "__main__":
    unittest.main()
