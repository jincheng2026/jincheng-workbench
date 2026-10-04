"""封面（1.1 加）的浏览器测试：真的起一份工作台（临时家目录，端口从 39878 往后找），在详情页的「封面」里照用户的样子点：
按批次看候选、只有提示词的复制提示词、选张数复制「出一批」那句话、勾两张并排对比后定一张、取消选定、
在图上点位写备注复制「按备注改」那句话（批注图存到话里写的位置）、删除先弹确认再挪进回收站、收藏；390 宽不横向滚动。
复制出来的话和 ui/lib/ask-ai.ts 一字不差（用 node 读它算出来）。图片是测试里现画的纯色 PNG，不放真实图片。

要 node、Google Chrome 和 Python 的 playwright，缺一样就跳过；设环境变量 JC_SKIP_BROWSER=1 也跳过。
用法（仓库根目录）：python3 -m unittest discover -s tests/browser   或   pnpm test:browser
"""
import json, os, re, shutil, signal, struct, subprocess, tempfile, threading, unittest, zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHROME = os.environ.get('JC_CHROME') or '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
NODE = shutil.which('node')
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None
SKIP = os.environ.get('JC_SKIP_BROWSER') == '1' or not NODE or not os.path.exists(CHROME) or sync_playwright is None
BRAND = json.loads((ROOT / 'brand.json').read_text('utf-8'))


def png(width, height, rgb):
    """一张纯色 PNG（标准库画的，浏览器能显示、能画进 canvas）"""
    row = b'\x00' + bytes(rgb) * width
    raw = row * height
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def ask(expr):
    """用 node 读 ui/lib/ask-ai.ts，算出页面该复制的那句话"""
    code = ("const a = await import('./ui/lib/ask-ai.ts');"
            " const b = JSON.parse((await import('node:fs')).readFileSync('brand.json', 'utf8'));"
            " const info = {name: b.name, repo: b.repository ?? '', skill: b.id + '-cover'};"
            f" console.log(JSON.stringify({expr}));")
    out = subprocess.run([NODE, '--input-type=module', '-e', code], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return json.loads(out)


RECORD = """# T001 封面生成记录

## 第 1 批

对标：抖音-示例博主（暖黄手写风）；照片：我的照片/正脸.png；日期：2026-10-04；软件：Codex；生图：image_gen

| 编号 | 本张变化 | 自检 | 文件名 |
| --- | --- | --- | --- |
| 01 | K03 讲台：人在右后 | 通过 | 封面-01.png |
| 02 | K07 对比：左右两半 | 头发遮住「AI」的 A | 封面-02.png |
| 03 | K11 前景大手 | 通过 | 封面-03.png |

## 第 2 批

对标：抖音-示例博主；照片：我的照片/正脸.png；日期：2026-10-05；软件：Claude Code；生图：只出提示词

| 编号 | 本张变化 | 自检 | 文件名 |
| --- | --- | --- | --- |
| 04 | K09 白底大字 | 只出了提示词 | 生图描述-04.md |
"""


@unittest.skipIf(SKIP, '没有 node、Chrome 或 Python 的 playwright，或设置了 JC_SKIP_BROWSER=1')
class CoverBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.mkdtemp(prefix='workbench-cover-test-')
        config_dir = Path(cls.home, 'Library', 'Application Support', BRAND['id'])
        config_dir.mkdir(parents=True)
        (config_dir / 'config.json').write_text(json.dumps({'ports': {'api': 39878, 'ui': 39879, 'save': 39977}}), 'utf-8')
        cls.work = Path(cls.home, 'Documents', BRAND['id'])
        env = dict(os.environ, HOME=cls.home, WORKBENCH_DRY_OPEN='1', PYTHONDONTWRITEBYTECODE='1', NEXT_TELEMETRY_DISABLED='1',
                   WORKBENCH_KEYCHAIN_SERVICE=f"{BRAND['id']}-cover-test-{os.getpid()}", WORKBENCH_AI_LINKS='none')
        env.pop('TIKHUB_API_KEY', None)
        cls.proc = subprocess.Popen([NODE, 'scripts/start.mjs'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        lines, found = [], threading.Event()
        cls.base = None

        def read():
            for line in cls.proc.stdout:
                lines.append(line.rstrip())
                m = re.search(r'打开：(http://127\.0\.0\.1:\d+)', line)
                if m and not cls.base:
                    cls.base = m.group(1)
                    found.set()
            found.set()
        threading.Thread(target=read, daemon=True).start()
        found.wait(360)
        if not cls.base:
            cls.stop_server()
            raise RuntimeError('工作台没有起来：\n' + '\n'.join(lines[-30:]))
        # 示例选题 T001 的草稿文件夹里放好封面候选：三张图（第 1 批）、一份只有提示词的（第 2 批）
        cls.draft = cls.work / '内容草稿' / 'T001_示例选题'
        cls.covers = cls.draft / '封面候选'
        cls.covers.mkdir(parents=True, exist_ok=True)
        for no, rgb in (('01', (220, 90, 60)), ('02', (60, 140, 220)), ('03', (90, 180, 110))):
            (cls.covers / f'封面-{no}.png').write_bytes(png(90, 120, rgb))
        (cls.covers / '生图描述-04.md').write_text('Create ONE complete 3:4 portrait Chinese video cover.\n', 'utf-8')
        (cls.covers / '生成记录.md').write_text(RECORD, 'utf-8')
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(executable_path=CHROME, headless=True)

    @classmethod
    def stop_server(cls):
        if cls.proc.poll() is None:
            cls.proc.send_signal(signal.SIGINT)
            try:
                cls.proc.wait(15)
            except subprocess.TimeoutExpired:
                cls.proc.kill()
        if cls.proc.stdout:
            cls.proc.stdout.close()
        shutil.rmtree(cls.home, ignore_errors=True)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.browser.close()
            cls.pw.stop()
        finally:
            cls.stop_server()

    def open(self, width=1440):
        narrow = width <= 720
        ctx = self.browser.new_context(viewport={'width': width, 'height': 844 if narrow else 900}, is_mobile=narrow, has_touch=narrow)
        ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=self.base)
        self.addCleanup(ctx.close)
        page = ctx.new_page()
        errors = []
        page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(f'页面报错：{e}'))
        page.errors = errors
        # 新手指引走完的样子，免得开场卡和提示挡着
        page.goto(self.base + '/api/health')
        page.evaluate("localStorage.setItem('workbench-tour', JSON.stringify({v: 99, status: 'done', step: 9, card: 'collapsed', opened: true}))")
        page.goto(self.base + '/content/T001')
        page.wait_for_selector('#covers [data-cover="01"] img', timeout=15000)
        return page

    def clipboard(self, page):
        return page.evaluate('navigator.clipboard.readText()')

    def button(self, page, no, label):
        return page.locator(f'[data-cover="{no}"] button[aria-label="{label}"]')

    def test_1_batches_and_prompt_only(self):
        """按批次排；只有提示词的那张能一键复制提示词；复制「出一批」那句话，张数照页面上选的"""
        page = self.open()
        text = page.inner_text('#covers')
        self.assertIn('第 1 批', text)
        self.assertIn('第 2 批', text)
        self.assertIn('头发遮住「AI」的 A', text)
        self.assertEqual(page.locator('#covers [data-cover] img').count(), 3)
        page.locator('[data-cover="04"] button', has_text='复制提示词').click()
        page.wait_for_timeout(300)
        self.assertEqual(self.clipboard(page), 'Create ONE complete 3:4 portrait Chinese video cover.\n')
        page.locator('.jc-cover-counts button', has_text='3').click()
        page.locator('#covers button', has_text='复制给 AI：再出一批').click()
        page.wait_for_timeout(300)
        self.assertEqual(self.clipboard(page), ask("a.askMakeCovers('T001', info, {count: 3})"))
        self.assertNotIn(str(self.work), self.clipboard(page), '那句话不带这台电脑的路径')
        self.assertEqual(page.errors, [])

    def test_2_compare_pick_unselect(self):
        """勾两张出「并排对比」，在对比里定一张：存成封面-选定，卡片标「选定」；取消选定后文件挪走"""
        page = self.open()
        self.button(page, '01', '勾选这张').click()
        self.button(page, '03', '勾选这张').click()
        bar = page.locator('.jc-cover-bar')
        self.assertIn('已勾 2 张', bar.inner_text())
        bar.locator('button', has_text='并排对比').click()
        page.locator('.jc-cover-compare figure', has_text='封面-03').locator('button', has_text='就用这张').click()
        page.wait_for_selector('[data-cover="03"][data-selected]', timeout=5000)
        self.assertTrue((self.draft / '封面-选定.png').exists())
        self.assertEqual((self.draft / '封面-选定.png').read_bytes(), (self.covers / '封面-03.png').read_bytes())
        self.assertEqual(page.locator('.jc-cover-bar').count(), 0, '定了以后勾选清空')
        self.assertTrue(self.button(page, '03', '选定的封面不能删，先取消选定').is_disabled())
        page.locator('#covers button', has_text='取消选定').click()
        page.wait_for_function("!document.querySelector('[data-cover=\"03\"][data-selected]')", timeout=5000)
        self.assertFalse((self.draft / '封面-选定.png').exists())
        self.assertIn('取消选定 封面-03', (self.covers / '生成记录.md').read_text('utf-8'))
        self.assertEqual(page.errors, [])

    def test_3_annotate(self):
        """在图上点两处写备注，复制「按备注改」那句话：话里的批注图位置就是存下来的那张"""
        page = self.open()
        self.button(page, '02', '写备注，交给 AI 改').click()
        area = page.locator('.jc-cover-annotate')
        area.locator('img').wait_for()
        page.wait_for_function("document.querySelector('.jc-cover-annotate img').complete")
        box = area.bounding_box()
        area.click(position={'x': box['width'] * 0.5, 'y': box['height'] * 0.2})
        area.click(position={'x': box['width'] * 0.3, 'y': box['height'] * 0.8})
        self.assertEqual(page.locator('.jc-cover-annotate .jc-cover-mark').count(), 2)
        inputs = page.locator('[role=dialog] input.jc-input')
        inputs.nth(0).fill('标题再大一点')
        inputs.nth(1).fill('手机换成拿在手里')
        page.locator('[role=dialog] button', has_text='复制给 AI：按备注改').click()
        page.wait_for_selector('[role=dialog]', state='detached', timeout=8000)
        expected = ask("a.askReviseCover('T001', '02', info, {notes: ['（图上 1）标题再大一点', '（图上 2）手机换成拿在手里'], markPath: '封面候选/批注/封面-02-批注.png'})")
        self.assertEqual(self.clipboard(page), expected)
        note = self.covers / '批注' / '封面-02-批注.png'
        self.assertTrue(note.exists(), '批注图存在话里写的位置')
        self.assertEqual(note.read_bytes()[:8], b'\x89PNG\r\n\x1a\n')
        self.assertEqual(page.errors, [])

    def test_4_trash_and_favorite(self):
        """删除先弹确认，挪进回收站；收藏复制一份到封面素材/收藏，出一批时能挑它当构图参考"""
        page = self.open()
        self.button(page, '01', '收藏').click()
        page.wait_for_selector('[data-cover="01"] button[aria-label="取消收藏"][aria-pressed="true"]', timeout=5000)
        self.assertTrue((self.work / '封面素材' / '收藏' / 'T001_封面-01.png').exists())
        page.reload()
        page.wait_for_selector('.jc-cover-ref', timeout=8000)
        self.button(page, '02', '挪进回收站').click()
        dialog = page.locator('[role=dialog]')
        self.assertIn('把封面-02 挪进回收站？', dialog.inner_text())
        dialog.locator('button', has_text='挪进回收站').click()
        page.wait_for_selector('[data-cover="02"]', state='detached', timeout=5000)
        self.assertFalse((self.covers / '封面-02.png').exists())
        trash = list((self.work / '回收站').glob('*_T001_封面-02.png'))
        self.assertEqual(len(trash), 1)
        (self.covers / '封面-02.png').write_bytes(trash[0].read_bytes())  # 放回去，别的场景还要用
        self.assertEqual(page.errors, [])

    def test_5_narrow(self):
        """390 宽：两列，不横向滚动；勾选浮条在底部栏目按钮上面"""
        page = self.open(390)
        page.locator('#covers').scroll_into_view_if_needed()
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), 390)
        self.button(page, '01', '勾选这张').click()
        bar = page.locator('.jc-cover-bar').bounding_box()
        self.assertTrue(bar['x'] >= 0 and bar['x'] + bar['width'] <= 390, f'浮条出了屏幕：{bar}')
        self.assertLessEqual(bar['y'] + bar['height'], 844 - 80, '浮条压住了底部的栏目按钮')
        self.assertEqual(page.errors, [])


if __name__ == '__main__':
    unittest.main()
