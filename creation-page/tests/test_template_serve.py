"""「模板只有一份，旧页面自动用上新模板」：保存服务按 /p/ 提供页面时，把页面里用首尾标记包住的三段
（保存脚本 kit、样式、界面脚本）都换成模板目录里的当前版本；某段缺失或读坏时退回页面自带的那份，并在 /healthz 报告；
直接打开文件（file://）时用的仍是页面文件里嵌进去的版本（文件本身一个字节都不动）。

每个用例把 template/ 和 kit/ 复制到临时目录当「当前模板」，用真模板生成一页，再改临时模板里的文字，不重新生成页面。
浏览器里真的打开看（file:// 显示旧文字、/p/ 显示新文字）的场景在 tests/browser/ui_scenarios.mjs 的 template 场景。
"""
import json, os, re, shutil, subprocess, sys, tempfile, time, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from support import APP, KIT_FILE, ServerCase, free_port, get, read, sample  # noqa: E402
import brain_save as bs  # noqa: E402
import build_page  # noqa: E402

SERVER_PY = os.path.join(APP, 'server', 'brain_save.py')
NEW_TEXT = '【模板新版：不重新生成页面也能看到】'
HINT = 'AI 直接读得到。'  # template/app.js 底部提示里的一句，用来改


def block(text, name):
    """页面里 <!--jc-name:start--> 和 <!--jc-name:end--> 之间的内容。"""
    st, en = '<!--jc-%s:start-->' % name, '<!--jc-%s:end-->' % name
    return text[text.index(st) + len(st):text.index(en)]


def served_info(text):
    m = re.search(r'window\.JC_SERVED = (\{.*?\});</script>', text)
    return json.loads(m.group(1)) if m else None


class TemplateServeTests(ServerCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='jc-tpl-serve-')
        self.root = os.path.join(self.tmp, 'brain')
        self.out = os.path.join(self.root, '内容草稿', 'T901_测试', 'T901_创作页.html')
        self.now = os.path.join(self.tmp, 'now')  # 「当前模板」：复制一份，测试里随便改
        shutil.copytree(os.path.join(APP, 'template'), os.path.join(self.now, 'template'))
        shutil.copytree(os.path.join(APP, 'kit'), os.path.join(self.now, 'kit'))
        build_page.build(sample(), self.out, root=self.root, kit_path=KIT_FILE)  # 用真模板生成
        self.file_bytes = read(self.out)
        self.file_text = self.file_bytes.decode('utf-8')
        self.pid = bs.parse_page(self.file_bytes)[1]['page_id']
        bs.TEMPLATE_DIR = os.path.join(self.now, 'template')
        bs.KIT_PATH = os.path.join(self.now, 'kit', 'kit.js')
        self.start_server(self.root)

    def tearDown(self):
        self.stop_server()  # 顺带把 bs.TEMPLATE_DIR、bs.KIT_PATH 改回默认
        shutil.rmtree(self.tmp, ignore_errors=True)

    def edit(self, rel, old, new):
        p = os.path.join(self.now, rel)
        with open(p, encoding='utf-8') as f:
            text = f.read()
        self.assertIn(old, text)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(text.replace(old, new, 1))

    def page(self):
        st, raw, hdrs = get(self.port, '/p/' + self.pid)
        self.assertEqual(st, 200)
        self.assertTrue(hdrs['content-type'].startswith('text/html'))
        return raw.decode('utf-8')

    def healthz(self):
        return json.loads(get(self.port, '/healthz')[1].decode('utf-8'))

    def test_generated_page_has_three_marked_parts(self):
        for k in ('style', 'kit', 'app'):
            self.assertEqual((self.file_text.count('<!--jc-%s:start-->' % k), self.file_text.count('<!--jc-%s:end-->' % k)), (1, 1), k)
        self.assertIn(bs.PART_EOF['app'], block(self.file_text, 'app'))
        self.assertIn(bs.PART_EOF['style'], block(self.file_text, 'style'))
        self.assertIn(HINT, block(self.file_text, 'app'))

    def test_template_text_change_shows_without_rebuilding(self):
        """改模板里一处界面文字和一条样式，不重新生成页面：/p/ 看到新文字，页面文件不变。"""
        self.edit('template/app.js', HINT, HINT + NEW_TEXT)
        self.edit('template/style.css', '.foot-hint {', '.foot-hint { letter-spacing: 3px;')
        page = self.page()
        self.assertIn(NEW_TEXT, block(page, 'app'))
        self.assertIn('letter-spacing: 3px', block(page, 'style'))
        self.assertEqual(served_info(page)['parts'], {'style': 'current', 'kit': 'current', 'app': 'current'})
        # 页面文件一个字节都没动：直接打开文件（file://）用的仍是生成时嵌进去的那份
        self.assertEqual(read(self.out), self.file_bytes)
        self.assertNotIn(NEW_TEXT, self.file_text)
        # 换的只是三段标记之间，外壳和 jc-doc 原样
        self.assertEqual(bs.parse_page(page.encode('utf-8'))[1], bs.parse_page(self.file_bytes)[1])
        strip = lambda t: re.sub(r'<!--jc-(kit|style|app):start-->.*?<!--jc-\1:end-->', '', t, flags=re.S)
        self.assertEqual(strip(page), strip(self.file_text))
        for k in ('style', 'kit', 'app'):
            self.assertEqual(page.count('<!--jc-%s:start-->' % k), 1, k)
        # 再改一次，刷新就是再下一版（服务每次现读，不缓存）
        self.edit('template/app.js', NEW_TEXT, '【第三版】')
        self.assertIn('【第三版】', self.page())

    def test_served_scripts_are_escaped(self):
        self.edit('template/app.js', HINT, HINT + '";var __x = "</script><b>坏</b>";"')
        self.edit('template/style.css', '.foot-hint {', '/* </style> */ .foot-hint {')
        page = self.page()
        self.assertIn('<\\/script><b>坏</b>', block(page, 'app'))
        self.assertIn('<\\/style>', block(page, 'style'))
        self.assertEqual(len(bs.DOC_RE.findall(page)), 1)

    def test_missing_template_falls_back_to_embedded(self):
        shutil.rmtree(os.path.join(self.now, 'template'))
        page = self.page()
        self.assertEqual(block(page, 'app'), block(self.file_text, 'app'))  # 页面自带的界面脚本原样保留
        self.assertEqual(block(page, 'style'), block(self.file_text, 'style'))
        self.assertEqual(served_info(page)['parts'], {'style': 'embedded', 'kit': 'current', 'app': 'embedded'})
        h = self.healthz()
        self.assertEqual((h['kit_ok'], h['style_ok'], h['app_ok']), (True, False, False))
        self.assertIn('读不出 app.js', h['app_problem'])
        self.assertIn('读不出 style.css', h['style_problem'])
        self.assertIn('改用文件里自带的界面脚本', self.log.getvalue())
        self.assertIn('改用文件里自带的样式', self.log.getvalue())

    def test_truncated_app_falls_back_style_still_current(self):
        p = os.path.join(self.now, 'template', 'app.js')
        with open(p, encoding='utf-8') as f:
            text = f.read()
        with open(p, 'w', encoding='utf-8') as f:
            f.write(text[:5000])  # 写了一半：没有结束标记
        self.edit('template/style.css', '.foot-hint {', '.foot-hint { letter-spacing: 3px;')
        page = self.page()
        self.assertEqual(block(page, 'app'), block(self.file_text, 'app'))
        self.assertIn('letter-spacing: 3px', block(page, 'style'))  # 别的段不受影响
        self.assertEqual(served_info(page)['parts']['app'], 'embedded')
        h = self.healthz()
        self.assertEqual((h['app_ok'], h['style_ok']), (False, True))
        self.assertIn('结束标记', h['app_problem'])

    def test_page_without_style_and_app_markers_only_kit_replaced(self):
        """老页面（只有 kit 标记）：只换 kit，样式和界面脚本不动，页面照样能打开。"""
        old = re.sub(r'<!--jc-(style|app):(start|end)-->', '', self.file_text)
        with open(self.out, 'w', encoding='utf-8') as f:
            f.write(old)
        self.edit('template/app.js', HINT, HINT + NEW_TEXT)
        page = self.page()
        self.assertNotIn(NEW_TEXT, page)
        self.assertEqual(served_info(page)['parts'], {'kit': 'current'})
        self.assertEqual(page.count('<!--jc-kit:start-->'), 1)

    def test_cli_template_and_kit_dirs(self):
        """命令行 --template-dir、--kit-dir 换模板目录；healthz 报告用的是哪里。"""
        self.stop_server()
        self.edit('template/app.js', HINT, HINT + NEW_TEXT)
        port = free_port()
        proc = subprocess.Popen([sys.executable, SERVER_PY, '--port', str(port), '--root', self.root,
                                 '--template-dir', os.path.join(self.now, 'template'), '--kit-dir', os.path.join(self.now, 'kit')],
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            h = None
            for _ in range(100):
                time.sleep(0.1)
                try:
                    h = json.loads(get(port, '/healthz')[1].decode('utf-8'))
                    break
                except (OSError, ValueError):
                    continue
            self.assertIsNotNone(h, '服务没起来')
            self.assertEqual((h['template_dir'], h['kit_path']), (os.path.join(self.now, 'template'), os.path.join(self.now, 'kit', 'kit.js')))
            self.assertIn(NEW_TEXT, get(port, '/p/' + self.pid)[1].decode('utf-8'))
        finally:
            proc.terminate()
            proc.wait(10)
            proc.stderr.close()


if __name__ == '__main__':
    unittest.main()
