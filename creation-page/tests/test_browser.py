"""保存脚本（kit/kit.js）和保存服务的浏览器测试：每个场景用无头 Chrome 真的打字、后退、组字、开两个标签。
由同步实验的 tests/test_browser.py 迁来，场景写在 tests/browser/scenarios.mjs；这里逐个调用，失败时把场景的逐条结果打出来。
需要 node 和 Google Chrome；没有就跳过。设环境变量 JC_SKIP_BROWSER=1 也跳过（整组约 1 分半）。
"""
import os, shutil, subprocess, unittest

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNNER = os.path.join(APP, 'tests', 'browser', 'scenarios.mjs')
CHROME = os.environ.get('JC_CHROME') or '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
NODE = shutil.which('node')
SKIP = os.environ.get('JC_SKIP_BROWSER') == '1' or not NODE or not os.path.exists(CHROME)


@unittest.skipIf(SKIP, '没有 node 或 Chrome，或设置了 JC_SKIP_BROWSER=1')
class BrowserTests(unittest.TestCase):
    def run_scenario(self, name):
        r = subprocess.run([NODE, RUNNER, name], cwd=APP, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=200)
        self.assertEqual(r.returncode, 0, '\n' + r.stdout + r.stderr)

    def test_basic_save_and_reload(self): self.run_scenario('basic')          # 回归：写回、AI 改别的格后停笔再重新加载
    def test_back_button_no_stale_refill(self): self.run_scenario('back')    # 实验必须修 1：后退回来不填回旧文字
    def test_ime_composition(self): self.run_scenario('ime')                 # 实验必须修 2：拼音不进文件、选字时不重新加载
    def test_file_page_duplicate_or_foreign(self): self.run_scenario('dupfile')  # 实验必须修 3：file:// 副本不跳不写
    def test_file_page_no_jump_while_typing(self): self.run_scenario('filetyping')  # 实验建议修 4：打字途中不跳走
    def test_same_cell_and_unregistered(self): self.run_scenario('cells')    # 实验建议修 5：同格多元素、没登记的字段
    def test_broken_kit_locks_page(self): self.run_scenario('brokenkit')     # 实验建议修 7：kit 写坏时锁住并报红
    def test_stash_connection_closed(self): self.run_scenario('idb')         # 实验建议修 8：暂存连接断开后照样写回
    def test_two_tabs_no_false_conflict(self): self.run_scenario('tabs')     # 实验建议修 9：两个标签不误报冲突
    # 创作页新增
    def test_group_all_or_nothing_via_kit(self): self.run_scenario('group')  # jcKit.edit 同组两格：全成或全不成，改动记录带组号
    def test_ai_reply_no_conflict(self): self.run_scenario('aireply')        # AI 写 ai_state 时用户正在打字：不冲突
    def test_files_origin_isolated(self): self.run_scenario('isolation')     # /f/ 页面在 localhost 上，脚本读不到口令、写不进接入同步的页面

    @unittest.skipUnless(os.path.exists(os.path.join(APP, 'template', 'shell.html')), 'template/shell.html 还没有')
    def test_built_page_no_external_requests(self): self.run_scenario('builtpage')  # 真界面生成的页面不向外发请求


if __name__ == '__main__':
    unittest.main()
