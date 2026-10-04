"""cover.py select：你在对话里定了用哪张，复制成草稿文件夹里的 封面-选定.<扩展名>（和工作台「就用这张」一样），「## 记录」记一行；
换了扩展名时原来那份挪进回收站，候选原图不动；只出了提示词、没有图的编号不能选。"""
import os
import re
import unittest

from support import TempWorkbench, jpeg, png, read, run_cli, write


class SelectTest(unittest.TestCase):
    def setUp(self):
        self.wb = TempWorkbench()
        self.wb.topic("T002", "用 AI 十分钟写周报")
        self.draft = self.wb.draft("T002", "用AI写周报")
        self.cand = os.path.join(self.draft, "封面候选")
        self.trash = os.path.join(self.wb.work, "回收站")
        self.env = self.wb.env()

    def tearDown(self):
        self.wb.cleanup()

    def select(self, no):
        return run_cli(["select", "T002", "--no", no], self.env)

    def test_选定一张_复制成封面选定_记一行(self):
        write(os.path.join(self.cand, "封面-01.png"), png(8, 8, (1, 1, 1)))
        write(os.path.join(self.cand, "封面-02.png"), png(8, 8, (2, 2, 2)))
        code, out = self.select("02")
        self.assertEqual(code, 0, out)
        with open(os.path.join(self.draft, "封面-选定.png"), "rb") as f:
            self.assertEqual(f.read(), png(8, 8, (2, 2, 2)))
        self.assertTrue(os.path.isfile(os.path.join(self.cand, "封面-02.png")))  # 候选原图不动
        self.assertRegex(read(os.path.join(self.cand, "生成记录.md")), r"## 记录\s+- \d{4}-\d{2}-\d{2} \d{2}:\d{2} 选定 封面-02")

    def test_换了扩展名_原来那份挪进回收站(self):
        write(os.path.join(self.cand, "封面-01.png"), png(8, 8))
        write(os.path.join(self.cand, "封面-02.jpg"), jpeg(8, 8))
        self.assertEqual(self.select("1")[0], 0)
        code, out = self.select("封面-02")
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(n for n in os.listdir(self.draft) if n.startswith("封面-选定")), ["封面-选定.jpg"])
        trashed = os.listdir(self.trash)
        self.assertEqual(len(trashed), 1)
        self.assertRegex(trashed[0], r"^\d{4}-\d{2}-\d{2}_T002_封面-选定\.png$")
        self.assertIn("原来选定的那份挪进了回收站", out)
        log = read(os.path.join(self.cand, "生成记录.md"))
        self.assertEqual(re.findall(r"选定 封面-(\d+)", log), ["01", "02"])

    def test_只出了提示词的编号不能选(self):
        write(os.path.join(self.cand, "生图描述-03.md"), "提示词")
        code, out = self.select("03")
        self.assertEqual(code, 2, out)
        self.assertIn("这张只出了提示词", out)
        self.assertFalse(any(n.startswith("封面-选定") for n in os.listdir(self.draft)))

    def test_没有这张(self):
        write(os.path.join(self.cand, "封面-01.png"), png(8, 8))
        code, out = self.select("07")
        self.assertEqual(code, 2, out)
        self.assertIn("封面候选里没有 封面-07 的图", out)


if __name__ == "__main__":
    unittest.main()
