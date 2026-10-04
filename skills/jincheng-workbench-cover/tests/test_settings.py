"""封面设置.json：show、set-photo（主照片）、set-default（默认风格，两种风格编号都认）、batch。整份读出来改一项再写回，不认识的键原样留着；写坏了不覆盖。"""
import json
import os
import unittest
from collections import OrderedDict

from support import TempWorkbench, heic_head, jpeg, png, read, run_cli, write


class SettingsTest(unittest.TestCase):
    def setUp(self):
        self.wb = TempWorkbench()
        self.env = self.wb.env()
        self.file = os.path.join(self.wb.assets, "封面设置.json")

    def tearDown(self):
        self.wb.cleanup()

    def cli(self, *args):
        return run_cli(list(args), self.env)

    def saved(self):
        with open(self.file, encoding="utf-8") as f:
            return json.load(f, object_pairs_hook=OrderedDict)

    def test_还没有设置文件_三项都按没设(self):
        code, out = self.cli("settings")
        self.assertEqual(code, 0, out)
        self.assertIn("还没有：主照片、默认风格都没设，一批 5 张", out)
        self.assertIn("主照片：没设", out)
        self.assertIn("照片：我的照片 里还没有", out)
        self.assertIn("默认风格：没设", out)
        self.assertFalse(os.path.exists(self.file))  # 只看不写

    def test_放照片_复制进我的照片_设成默认(self):
        src = write(os.path.join(self.wb.home, "桌面", "我.jpg"), jpeg(30, 40))
        code, out = self.cli("settings", "set-photo", src)
        self.assertEqual(code, 0, out)
        self.assertIn("主照片设好了：我的照片/我.jpg", out)
        self.assertTrue(os.path.isfile(src))  # 原来那张不动
        self.assertEqual(self.saved(), OrderedDict([("photo", "我的照片/我.jpg"), ("benchmark", None), ("batchSize", 5)]))
        # 同一张再放一次：不重复复制；同名的另一张：加 -2
        self.cli("settings", "set-photo", src)
        other = write(os.path.join(self.wb.home, "下载", "我.jpg"), jpeg(32, 40))
        code, out = self.cli("settings", "set-photo", other)
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(os.listdir(os.path.join(self.wb.assets, "我的照片"))), ["我-2.jpg", "我.jpg"])
        self.assertEqual(self.saved()["photo"], "我的照片/我-2.jpg")
        # 已经在「我的照片」里的：直接设
        code, out = self.cli("settings", "set-photo", os.path.join(self.wb.assets, "我的照片", "我.jpg"))
        self.assertEqual(code, 0, out)
        self.assertEqual(self.saved()["photo"], "我的照片/我.jpg")
        heic = write(os.path.join(self.wb.home, "手机.heic"), heic_head())
        code, out = self.cli("settings", "set-photo", heic)
        self.assertEqual(code, 0, out)  # heic 收（生图前 AI 先转成 jpg）
        self.assertEqual(self.saved()["photo"], "我的照片/手机.heic")

    def test_不是照片的不收(self):
        txt = write(os.path.join(self.wb.home, "说明.txt"), "hello")
        code, out = self.cli("settings", "set-photo", txt)
        self.assertEqual(code, 2)
        self.assertIn("这不像照片", out)
        code, out = self.cli("settings", "set-photo", os.path.join(self.wb.home, "没有这张.jpg"))
        self.assertEqual(code, 2)
        self.assertIn("找不到这张照片", out)
        self.assertFalse(os.path.exists(self.file))

    def test_改一项_别的键和不认识的键原样(self):
        write(self.file, json.dumps(OrderedDict([("batchSize", 6), ("photo", "我的照片/旧.png"), ("工作台以后加的", {"a": 1}), ("benchmark", None)]), ensure_ascii=False))
        account = self.wb.account("小红书-示例博主")
        code, out = self.cli("settings", "set-default", "小红书-示例博主")
        self.assertEqual(code, 2)
        self.assertIn("还没有 VI拆解.md", out)
        write(os.path.join(account, "VI拆解.md"), "# 示例博主：封面 VI 拆解\n风格名：蓝白手账风\n")
        code, out = self.cli("settings", "set-default", "小红书-示例博主")
        self.assertEqual(code, 0, out)
        self.assertIn("默认风格设好了：小红书-示例博主（风格名：蓝白手账风）", out)
        self.assertEqual(self.saved(), OrderedDict([("batchSize", 6), ("photo", "我的照片/旧.png"), ("工作台以后加的", {"a": 1}), ("benchmark", "小红书-示例博主")]))
        code, out = self.cli("settings", "batch", "12")
        self.assertEqual(code, 0, out)
        self.assertEqual(list(self.saved().items())[0], ("batchSize", 12))
        code, out = self.cli("settings", "batch", "0")
        self.assertEqual(code, 2)
        code, out = self.cli("settings", "batch", "31")
        self.assertEqual(code, 2)
        code, out = self.cli("settings", "batch", "十")
        self.assertEqual(code, 2)
        self.assertEqual(self.saved()["batchSize"], 12)
        code, out = self.cli("settings", "set-default", "抖音-没有这个人")
        self.assertEqual(code, 2)
        self.assertIn("没有「抖音-没有这个人」", out)
        code, out = self.cli("settings", "show")
        self.assertIn("默认风格：小红书-示例博主（风格名：蓝白手账风）", out)
        self.assertIn("找不到这个文件了", out)  # 设的主照片 旧.png 不在
        # 你放进来的图拆出的风格：写「风格/<文件夹名>」，存的也是这个
        folder = self.wb.style_folder("2026-10-04_8张", {"a.png": png(4, 4)})
        code, out = self.cli("settings", "set-default", "风格/2026-10-04_8张")
        self.assertEqual(code, 2)
        self.assertIn("「风格/2026-10-04_8张」还没有 VI拆解.md", out)
        write(os.path.join(folder, "VI拆解.md"), "# 放进来的 1 张图：封面 VI 拆解\n风格名：蓝白大字风\n")
        for given in ("风格/2026-10-04_8张", "2026-10-04_8张", folder, os.path.join(folder, "封面")):
            code, out = self.cli("settings", "set-default", given)
            self.assertEqual(code, 0, out)
            self.assertIn("默认风格设好了：风格/2026-10-04_8张（风格名：蓝白大字风）", out)
            self.assertEqual(self.saved()["benchmark"], "风格/2026-10-04_8张")
        code, out = self.cli("settings", "show")
        self.assertIn("默认风格：风格/2026-10-04_8张（风格名：蓝白大字风）", out)

    def test_写坏了就报错_不覆盖(self):
        write(self.file, '{"photo": "我的照片/a.jpg",}')
        code, out = self.cli("settings", "batch", "8")
        self.assertEqual(code, 2)
        self.assertIn("封面设置写坏了", out.splitlines()[0])
        self.assertEqual(read(self.file), '{"photo": "我的照片/a.jpg",}')
        code, out = self.cli("where")
        self.assertEqual(code, 0, out)
        self.assertIn("封面设置写坏了", out)

    def test_写得不对的项按没设处理(self):
        write(self.file, json.dumps({"photo": 3, "benchmark": "", "batchSize": "十张"}, ensure_ascii=False))
        code, out = self.cli("settings")
        self.assertEqual(code, 0, out)
        self.assertIn("photo 应该是一个路径或者 null", out)
        self.assertIn("batchSize 应该是不小于 1 的整数，按 5 张处理", out)
        self.assertIn("一批几张：5", out)
        src = write(os.path.join(self.wb.home, "a.png"), png(4, 4))
        code, out = self.cli("settings", "set-photo", src)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.saved()["batchSize"], "十张")  # 只改了 photo，别的原样


if __name__ == "__main__":
    unittest.main()
