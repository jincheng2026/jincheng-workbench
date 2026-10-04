"""cover.py save：把 Codex 刚生成的图（$CODEX_HOME/generated_images/ 里最新的一张）存成 封面候选/封面-NN；
不覆盖、编号不复用、拿到的是旧图或者重复的图就停下。CODEX_HOME 指向临时文件夹，不碰真实的 ~/.codex。
--size（第二版约定）：用 macOS 自带的 sips 从中间裁成这批的比例再存（方形不用裁）；没写就照生成记录里这批写的尺寸。
真的裁图要有 sips，没有 sips 的电脑上那几条跳过（写明原因）；没有 sips 时报清楚的那一条用 COVER_SIPS 指到不存在的路径，哪都能跑。"""
import os
import time
import unittest

from support import NO_SIPS, TempWorkbench, banded_png, jpeg, png, png_pixels, run_cli, sips_here, write

from cover_kit import images as I


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


GREEN = (0, 255, 0)
RED = (255, 0, 0)


def near(color, want, slack=8):
    return all(abs(a - b) <= slack for a, b in zip(color, want))


class SaveSizeTest(unittest.TestCase):
    def setUp(self):
        self.wb = TempWorkbench()
        self.wb.topic("T002", "用 AI 十分钟写周报")
        self.draft = self.wb.draft("T002", "用AI写周报")
        self.cand = os.path.join(self.draft, "封面候选")
        self.gen = os.path.join(self.wb.codex, "generated_images")
        self.env = self.wb.env()

    def tearDown(self):
        self.wb.cleanup()

    def generated(self, name, data):
        return write(os.path.join(self.gen, "会话-1", name), data)

    def save(self, *args, env=None):
        return run_cli(["save", "T002"] + list(args), env or self.env)

    def pixels(self, name):
        with open(os.path.join(self.cand, name), "rb") as f:
            return png_pixels(f.read())

    def assert_all_green_edges(self, name):
        """四个角和四条边的中点都是绿的：红条、蓝条都裁掉了，是从中间裁的。"""
        width, height, pixel = self.pixels(name)
        for x, y in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1), (width // 2, 0), (width // 2, height - 1), (0, height // 2), (width - 1, height // 2)):
            self.assertTrue(near(pixel(x, y), GREEN), "%s 的 (%d, %d) 是 %r，不是绿的：没从中间裁" % (name, x, y, pixel(x, y)))

    @unittest.skipUnless(sips_here(), NO_SIPS)
    def test_竖版_1024x1536_从中间裁成_1024x1365(self):
        source = self.generated("ig_1.png", banded_png(1024, 1536, 80))
        code, out = self.save("--no", "01", "--size", "竖版3:4")
        self.assertEqual(code, 0, out)
        self.assertIn("存好了：%s（1024×1365，从 %s 裁的，从中间裁）" % (os.path.join(self.cand, "封面-01.png"), source), out)
        self.assertIn("尺寸：竖版 3:4（--size 写的）：从 1024×1536 裁成了 1024×1365，上面裁掉 85 像素、下面裁掉 86 像素", out)
        self.assertIn("存完打开这张看一眼", out)
        self.assertEqual(I.image_size(os.path.join(self.cand, "封面-01.png")), (1024, 1365))
        self.assert_all_green_edges("封面-01.png")
        self.assertTrue(os.path.isfile(source))  # 没裁的原图还在 Codex 的生图文件夹里
        self.assertEqual(sorted(os.listdir(self.cand)), ["封面-01.png"])  # 工作文件夹里只有裁好的这张

    @unittest.skipUnless(sips_here(), NO_SIPS)
    def test_标题靠上时从上边开始裁_也能写从第几像素开始留(self):
        self.generated("ig_1.png", banded_png(1024, 1536, 80))
        code, out = self.save("--no", "01", "--size", "竖版3:4", "--keep", "上")
        self.assertEqual(code, 0, out)
        self.assertIn("从上边开始裁（多裁下面）", out)
        self.assertIn("上面裁掉 1 像素、下面裁掉 170 像素", out)
        width, height, pixel = self.pixels("封面-01.png")
        self.assertEqual((width, height), (1024, 1365))
        self.assertTrue(near(pixel(0, 0), RED), "上边的红条留着：从上边开始裁的")
        self.assertTrue(near(pixel(0, height - 1), GREEN), "下边的蓝条裁掉了")
        self.generated("ig_2.png", banded_png(1024, 1536, 80, ))
        os.utime(os.path.join(self.gen, "会话-1", "ig_2.png"))
        with open(os.path.join(self.gen, "会话-1", "ig_2.png"), "ab") as f:  # 内容和第一张不一样，才不会被当成同一张
            f.write(b"\0")
        code, out = self.save("--no", "02", "--size", "竖版3:4", "--keep", "40")
        self.assertEqual(code, 0, out)
        self.assertIn("从上边第 40 像素开始留", out)
        self.assertIn("上面裁掉 40 像素、下面裁掉 131 像素", out)

    @unittest.skipUnless(sips_here(), NO_SIPS)
    def test_没登记前能换个裁法重存_登记以后不能(self):
        source = self.generated("ig_1.png", banded_png(1024, 1536, 80))
        self.assertEqual(self.save("--no", "01", "--size", "竖版3:4")[0], 0)
        code, out = self.save("--no", "01", "--size", "竖版3:4", "--from", source)
        self.assertEqual(code, 2, out)
        self.assertIn("加 --replace 换个 --keep 重存", out)
        code, out = self.save("--no", "01", "--size", "竖版3:4", "--keep", "上", "--replace", "--from", source)
        self.assertEqual(code, 0, out)
        self.assertIn("重存好了", out)
        self.assertTrue(near(self.pixels("封面-01.png")[2](0, 0), RED), "换成了从上边裁的那张")
        self.assertEqual(sorted(os.listdir(self.cand)), ["封面-01.png"])
        code, out = run_cli(["record", "add", "T002", "--no", "01", "--change", "K01 讲台", "--check", "通过", "--file", "封面-01.png", "--tool", "image_gen", "--app", "Codex"], self.env)
        self.assertEqual(code, 0, out)
        code, out = self.save("--no", "01", "--size", "竖版3:4", "--keep", "中", "--replace", "--from", source)
        self.assertEqual(code, 2, out)
        self.assertIn("已经登记进生成记录了，不能重存", out)
        code, out = self.save("--no", "02", "--replace", "--from", source)
        self.assertEqual(code, 2, out)
        self.assertIn("封面候选里还没有 封面-02", out)

    @unittest.skipUnless(sips_here(), NO_SIPS)
    def test_横版_1536x1024_从中间裁成_1536x654_同一张不存两次(self):
        self.generated("ig_1.png", banded_png(1536, 1024, 180))
        code, out = self.save("--no", "01", "--size", "横版 2.35:1")
        self.assertEqual(code, 0, out)
        self.assertEqual(I.image_size(os.path.join(self.cand, "封面-01.png")), (1536, 654))
        self.assert_all_green_edges("封面-01.png")
        code, out = self.save("--no", "02", "--size", "横版2.35:1")  # 这次没生成出来新图：裁出来和 01 一模一样
        self.assertEqual(code, 2)
        self.assertIn("这张图已经存过了，就是 封面-01.png", out)
        self.assertFalse(os.path.exists(os.path.join(self.cand, "封面-02.png")))

    @unittest.skipUnless(sips_here(), NO_SIPS)
    def test_方形不裁_竖版收到方图时切左右并提醒(self):
        data = banded_png(1024, 1024, 100, vertical=True)
        self.generated("ig_1.png", data)
        code, out = self.save("--no", "01", "--size", "方形1:1")
        self.assertEqual(code, 0, out)
        self.assertIn("已经是这个比例，不用裁", out)
        with open(os.path.join(self.cand, "封面-01.png"), "rb") as f:
            self.assertEqual(f.read(), data)  # 原样存，一个字节都不动
        code, out = self.save("--no", "02", "--size", "竖版3:4", "--from", self.generated("ig_2.png", banded_png(1024, 1024, 120, vertical=True)))
        self.assertEqual(code, 0, out)
        self.assertEqual(I.image_size(os.path.join(self.cand, "封面-02.png")), (768, 1024))
        self.assert_all_green_edges("封面-02.png")
        self.assertIn("这张是 1024×1024 的方图，竖版 3:4 要的是 1024×1536 的竖图", out)

    @unittest.skipUnless(sips_here(), NO_SIPS)
    def test_没写尺寸就照生成记录里这批写的_jpg照样是jpg(self):
        write(os.path.join(self.cand, "生成记录.md"), "# T002 封面生成记录\n\n## 第 1 批\n\n对标：抖音-某某（暖黄手写风）；照片：1 张；日期：2026-10-05；软件：Codex；生图：image_gen；尺寸：横版 2.35:1\n")
        self.generated("ig_1.jpg", jpeg(1536, 1024))
        code, out = self.save("--no", "01")
        self.assertEqual(code, 0, out)
        self.assertIn("尺寸：横版 2.35:1（照第 1 批写的）", out)
        self.assertEqual(I.image_size(os.path.join(self.cand, "封面-01.jpg")), (1536, 654))
        with open(os.path.join(self.cand, "封面-01.jpg"), "rb") as f:
            self.assertEqual(I.sniff(f.read(16)), "JPEG")

    def test_没有sips_说清楚_什么都不存(self):
        no_sips = self.wb.env(COVER_SIPS=os.path.join(self.wb.home, "没有这个工具"))
        self.generated("ig_1.png", png(64, 96))
        code, out = self.save("--no", "01", "--size", "竖版3:4", env=no_sips)
        self.assertEqual(code, 2)
        self.assertIn("这台电脑上找不到 sips", out.splitlines()[0])
        self.assertFalse(os.path.exists(os.path.join(self.cand, "封面-01.png")))
        # 已经是这个比例的不用裁，没有 sips 也能存
        self.generated("ig_2.png", png(30, 40))
        code, out = self.save("--no", "01", "--size", "竖版3:4", env=no_sips)
        self.assertEqual(code, 0, out)
        self.assertIn("不用裁", out)
        code, out = self.save("--no", "02", "--size", "4:3")
        self.assertEqual(code, 2)
        self.assertIn("尺寸只能写", out)

    def test_没写尺寸_生成记录里也没写_原样存(self):
        self.generated("ig_1.png", png(64, 96))
        code, out = self.save("--no", "01")
        self.assertEqual(code, 0, out)
        self.assertIn("没写 --size，生成记录里这批也没写尺寸：原样存的，没裁", out)
        self.assertEqual(I.image_size(os.path.join(self.cand, "封面-01.png")), (64, 96))


if __name__ == "__main__":
    unittest.main()
