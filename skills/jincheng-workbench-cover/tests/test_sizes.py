"""三种尺寸（第二版约定）：写法都认、从中间裁成多大、没说时的默认值和工作台一样。不用 sips，哪台电脑都跑。"""
import unittest

from cover_kit import UserError
from cover_kit import sizes as Z


class SizesTest(unittest.TestCase):
    def test_几种写法都认(self):
        for text in ("竖版 3:4", "竖版3:4", "竖版", "3:4", "3：4", " 竖版  3:4 "):
            self.assertIs(Z.parse(text), Z.PORTRAIT, text)
        for text in ("横版 2.35:1", "横版2.35:1", "横版", "2.35:1"):
            self.assertIs(Z.parse(text), Z.WIDE, text)
        for text in ("方形 1:1", "方形1:1", "方形", "1:1"):
            self.assertIs(Z.parse(text), Z.SQUARE, text)
        for bad in ("4:3", "竖版2.35:1", "", "竖"):
            with self.assertRaises(UserError):
                Z.parse(bad)
        self.assertEqual([s.text for s in Z.SIZES], ["竖版 3:4", "横版 2.35:1", "方形 1:1"])
        self.assertEqual([s.arg for s in Z.SIZES], ["竖版3:4", "横版2.35:1", "方形1:1"])

    def test_从中间裁成多大_和约定的表一样(self):
        self.assertEqual(Z.PORTRAIT.final, (1024, 1365))
        self.assertEqual(Z.WIDE.final, (1536, 654))
        self.assertEqual(Z.SQUARE.final, (1024, 1024))
        self.assertEqual(Z.PORTRAIT.target(1024, 1365), (1024, 1365))  # 已经是这个比例：不裁
        self.assertEqual(Z.WIDE.target(1536, 654), (1536, 654))
        self.assertEqual(Z.PORTRAIT.target(1024, 1024), (768, 1024))   # 方图裁竖版：切左右
        self.assertEqual(Z.WIDE.target(1024, 1536), (1024, 436))       # 竖图裁横版：切上下
        self.assertEqual(Z.SQUARE.target(1024, 1536), (1024, 1024))
        self.assertEqual(Z.SQUARE.target(1536, 1024), (1024, 1024))
        self.assertIn("从中间裁成 1536×654", Z.WIDE.plan())
        self.assertIn("不用裁", Z.SQUARE.plan())

    def test_没说尺寸时的默认值(self):
        self.assertEqual(Z.default(Z.SQUARE, "口播"), (Z.SQUARE, "这条内容上一批用的"))
        for kind in ("公众号文章", "图文", "知识星球", "长文", "帖子", "文章"):
            self.assertIs(Z.default(None, kind)[0], Z.WIDE, kind)
        for kind in ("口播", "教程", "科普", "小红书笔记", "小红书图文", None):
            self.assertIs(Z.default(None, kind)[0], Z.PORTRAIT, kind)

    def test_从一行字里找尺寸(self):
        self.assertIs(Z.find("对标：甲；照片：2 张；日期：2026-10-05；软件：Codex；生图：image_gen；尺寸：横版 2.35:1"), Z.WIDE)
        self.assertIsNone(Z.find("对标：甲；照片：我的照片/正脸.jpg"))
        self.assertIsNone(Z.find("尺寸：很大"))

    def test_生出来的方向不对时提醒(self):
        self.assertEqual(Z.shape_note(Z.PORTRAIT, (1024, 1536)), "")
        self.assertIn("这张是 1024×1024 的方图", Z.shape_note(Z.PORTRAIT, (1024, 1024)))
        self.assertIn("1536×1024 的横图", Z.shape_note(Z.WIDE, (1024, 1536)))
        self.assertEqual(Z.shape_note(Z.SQUARE, (1024, 1024)), "")


if __name__ == "__main__":
    unittest.main()
