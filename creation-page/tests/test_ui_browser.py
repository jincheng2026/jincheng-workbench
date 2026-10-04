"""创作页界面（template/ 与 kit/kit.js）的浏览器测试：无头 Chrome 真的打字、拖选、点按钮、按快捷键。
场景写在 tests/browser/ui_scenarios.mjs，这里逐个调用，失败时把场景的逐条结果打出来。
每个场景自己用 tests/ui_mini_build.py 生成测试页、在临时端口起 server/brain_save.py，测完关掉；临时文件放在
环境变量 JC_UI_TMP 指的目录（默认系统临时目录下的 jc-creation-ui-test）。
需要 node 和 Google Chrome；没有就跳过。设环境变量 JC_SKIP_BROWSER=1 也跳过（整组约 3 分钟）。
"""
import os, shutil, subprocess, unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNNER = os.path.join(HERE, 'tests', 'browser', 'ui_scenarios.mjs')
CHROME = os.environ.get('JC_CHROME') or '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
NODE = shutil.which('node')
SKIP = os.environ.get('JC_SKIP_BROWSER') == '1' or not NODE or not os.path.exists(CHROME)


@unittest.skipIf(SKIP, '没有 node 或 Chrome，或设置了 JC_SKIP_BROWSER=1')
class UiBrowserTests(unittest.TestCase):
    def run_scenario(self, name):
        r = subprocess.run([NODE, RUNNER, name], cwd=HERE, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=240)
        self.assertEqual(r.returncode, 0, '\n' + r.stdout + r.stderr)

    def test_flow(self): self.run_scenario('flow')      # 改我的版本写回、选中写给 AI、采纳两格同组、撤销重做、原句对不上变灰、R 不采纳、通读 5 秒线、复制提词稿、改动记录、复制给 AI、内容已确认
    def test_reply(self): self.run_scenario('reply')    # AI 写回复不让正在改的格子冲突；已处理 / 待处理
    def test_group(self): self.run_scenario('group')    # 同组冲突整组不写，一起摆出、一起放弃
    def test_more(self): self.run_scenario('more')      # 先改再采纳、像稿子挪进我的版本、复制失败弹文本框、服务不在时的改动记录
    def test_layout(self): self.run_scenario('layout')  # 1440、1280、650、380 宽：顶栏钉住且够矮、不横向滚动、窄屏第一屏见正文、保存圆点和「更多」菜单
    def test_cards(self): self.run_scenario('cards')    # 建议卡变短（两行理由、依据小标签、输入框点了才出）；「改成」为空＝删掉这句，采纳、撤回、撤销；窄屏按钮一行
    def test_review_stage_filter(self): self.run_scenario('review')  # 类别默认筛选只在审稿阶段生效，写稿阶段显示全部；按阶段分别记住
    def test_template_served(self): self.run_scenario('template')  # 改模板不重新生成：/p/ 看到新文字；file:// 仍是嵌进去的；模板缺了退回自带版
    def test_old_page(self): self.run_scenario('oldpage')  # 缺可选字段的旧页面换上新界面脚本照样能显示、能改
    def test_composer(self): self.run_scenario('composer')  # 就地批注框：页面不滚、点别处不丢字、Esc 只关空框、刷新后还在、换视图先保存、通读里也能写、取消
    def test_tutorial(self): self.run_scenario('tutorial')  # 教程枝干：参考角色和画面、本地原片、画面栏、录屏步骤、录制视图、复制画面脚本、没用上的参考
    def test_refnote(self): self.run_scenario('refnote')  # 参考分析：两家以上先看分析、原文按家收起、讲法点着色、可以借的跳建议、骨架对照、一家照旧展开、分析里写给 AI
    def test_extension(self): self.run_scenario('extend')  # 教程假数据：新字段、新种类不报错，兜底模块能改能存；「说明」类参考
    def test_anchor(self): self.run_scenario('anchor')  # 建议贴着原文：定位原句、按原文排序、点原文亮卡、逐条看自动跳下一条、对不上的归到最后、窄屏退到下面
    def test_guide(self): self.run_scenario('guide')  # 新手指引第二段：两步（亮建议和原句、只亮采纳）、别的快捷键不响应、刷新接着走、采纳存回并弹完成反馈、Esc 跳过、第一次不采纳嵌一句提示、?hints=off 不提、窄屏不出屏


if __name__ == '__main__':
    unittest.main()
