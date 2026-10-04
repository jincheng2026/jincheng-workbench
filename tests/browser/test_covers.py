"""封面（1.1 加）的浏览器测试：真的起一份工作台（临时家目录，端口从 39878 往后找），照用户的样子点两处页面：
- 选题页面的「封面」：出一批的设置（风格跟上一批、参考构图、封面上的字带创作页里定好的、尺寸、张数），
  「在 Codex 里再出一批」的链接和「复制给 AI」复制的话；这条的封面只看（选定的排第一，点开放大，没有选定、批注、收藏、删除）。
- 「内容」栏的「封面」页：风格卡片（默认、设为默认、改默认构图）、一次全拆、贴主页链接、拖图建风格、我的封面按内容和按风格、
  只看文章、我的照片放和拿掉；390 宽不横向滚动。
交给 AI 的话和 ui/lib/ask-ai.ts 一字不差（用 node 读它算出来）。图片是测试里现画的纯色 PNG，不放真实图片。
原作者 2026-10-04 定：挑一张、改一张都在 Codex 桌面版里做，工作台不再有选定、批注、并排对比、收藏、删除这些按钮。

要 node、Google Chrome 和 Python 的 playwright，缺一样就跳过；设环境变量 JC_SKIP_BROWSER=1 也跳过。
用法（仓库根目录）：python3 -m unittest discover -s tests/browser   或   pnpm test:browser
"""
import json, os, re, shutil, signal, struct, subprocess, tempfile, threading, unittest, zlib
from pathlib import Path
from urllib.parse import parse_qs

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

对标：抖音-示例博主（暖黄手写风）；照片：1 张；日期：2026-10-04；软件：Codex；生图：image_gen；尺寸：竖版 3:4

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
        # 当作这台 Mac 上装了 Codex 桌面版：按钮是「在 Codex 里……」加「复制给 AI」
        env = dict(os.environ, HOME=cls.home, WORKBENCH_DRY_OPEN='1', PYTHONDONTWRITEBYTECODE='1', NEXT_TELEMETRY_DISABLED='1',
                   WORKBENCH_KEYCHAIN_SERVICE=f"{BRAND['id']}-cover-test-{os.getpid()}", WORKBENCH_AI_LINKS='codex')
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
        # 示例选题 T001：三张图（第 1 批）、一份只有提示词的（第 2 批）、选定的是封面-02；创作页里定好了封面文字
        cls.draft = cls.work / '内容草稿' / 'T001_示例选题'
        cls.covers = cls.draft / '封面候选'
        cls.covers.mkdir(parents=True, exist_ok=True)
        for no, rgb in (('01', (220, 90, 60)), ('02', (60, 140, 220)), ('03', (90, 180, 110))):
            (cls.covers / f'封面-{no}.png').write_bytes(png(90, 120, rgb))
        (cls.draft / '封面-选定.png').write_bytes(png(90, 120, (60, 140, 220)))
        (cls.covers / '生图描述-04.md').write_text('Create ONE complete 3:4 portrait Chinese video cover.\n', 'utf-8')
        (cls.covers / '生成记录.md').write_text(RECORD, 'utf-8')
        doc = {'kind': '创作页', 'page_id': 'cover1234', 'content_id': 'T001', 'items': [
            {'id': 'info-c1', 'kind': 'info', 'locked': {'title': '示例选题'}, 'fields': {}},
            {'id': 'pub-c1', 'kind': 'pubslot', 'locked': {'slot': '封面文字'}, 'fields': {'final': '十分钟写完周报'}}]}
        (cls.draft / 'T001_创作页.html').write_text(
            '<!doctype html><title>T001</title><script id="jc-doc" type="application/json">%s</script>' % json.dumps(doc, ensure_ascii=False), 'utf-8')
        # 风格：一个拆好了的对标账号（默认）、两个还没拆的对标账号、一组拆好了的「你放进来的图」
        accounts = cls.work / '市场调研' / '对标账号'
        dy = accounts / '抖音-示例博主'
        for k in range(1, 7):
            (dy / '封面').mkdir(parents=True, exist_ok=True)
            (dy / '封面' / f'K{k:02d}.png').write_bytes(png(30, 40, (200, 160 - k * 10, 60)))
        (dy / '档案.json').write_text(json.dumps({'platform': '抖音', 'account_name': '示例博主', 'url': 'https://www.douyin.com/user/x', 'note': '', 'tags': [], 'updated_at': '2026-10-01T10:00:00+08:00'}, ensure_ascii=False), 'utf-8')
        (dy / 'VI拆解.md').write_text('# 示例博主 封面 VI 拆解\n风格名：暖黄手写风\n', 'utf-8')
        (dy / '默认构图.json').write_text(json.dumps({'ids': ['K02', 'K04', 'K01'], 'by': 'AI'}), 'utf-8')
        for name, platform in (('小红书-另一个博主', '小红书'), ('抖音-第三个博主', '抖音')):
            (accounts / name).mkdir(parents=True, exist_ok=True)
            (accounts / name / '档案.json').write_text(json.dumps({'platform': platform, 'account_name': name.split('-')[1], 'url': '', 'note': '', 'tags': [], 'updated_at': '2026-10-02T10:00:00+08:00'}, ensure_ascii=False), 'utf-8')
        mine = cls.work / '封面素材' / '风格' / '2026-10-03_4张'
        for k in range(1, 5):
            (mine / '封面').mkdir(parents=True, exist_ok=True)
            (mine / '封面' / f'K{k:02d}.png').write_bytes(png(30, 40, (40, 70, 160 + k * 10)))
        (mine / 'VI拆解.md').write_text('# 放进来的 4 张图\n风格名：蓝白大字风\n', 'utf-8')
        (mine / '风格.json').write_text(json.dumps({'from': '放进来的图', 'createdAt': '2026-10-03T20:00:00+08:00', 'count': 4}), 'utf-8')
        photos = cls.work / '封面素材' / '我的照片'
        photos.mkdir(parents=True, exist_ok=True)
        (photos / '正脸.png').write_bytes(png(40, 40, (180, 140, 120)))
        (cls.work / '封面素材' / '封面设置.json').write_text(json.dumps({'photo': '我的照片/正脸.png', 'benchmark': '抖音-示例博主', 'batchSize': 5}, ensure_ascii=False), 'utf-8')
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

    def open(self, path='/content/T001', ready='[data-cover-make]', width=1440):
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
        page.goto(self.base + path)
        page.wait_for_selector(ready, timeout=20000)
        return page

    def clipboard(self, page):
        return page.evaluate('navigator.clipboard.readText()')

    def codex_prompt(self, link):
        """「在 Codex 里……」链接带的那句话和打开的文件夹"""
        href = link.get_attribute('href')
        self.assertTrue(href.startswith('codex://threads/new?'), href)
        q = parse_qs(href.split('?', 1)[1])
        return q['prompt'][0], q['path'][0]

    def test_1_make_settings_and_sentence(self):
        """出一批：风格跟上一批、参考构图是风格的默认构图、封面上的字带创作页里定好的、尺寸跟上一批、默认 5 张；改了以后话跟着变"""
        page = self.open()
        make = page.locator('[data-cover-make]')
        self.assertEqual(make.locator('select[aria-label="照哪个风格出"]').input_value(), '抖音-示例博主')
        self.assertIn('3 张（默认）', make.inner_text())
        self.assertEqual(make.locator('input[aria-label="封面上的字"]').input_value(), '十分钟写完周报')
        self.assertIn('创作页里你定的', make.inner_text())
        self.assertEqual(make.locator('[aria-label="尺寸"] [aria-checked="true"]').inner_text(), '竖版 3:4')
        self.assertEqual(make.locator('[aria-label="这批几张"] [aria-checked="true"]').inner_text(), '5')
        style = "{id: '抖音-示例博主', kind: 'account', name: '暖黄手写风'}"
        expected = ask(f"a.askMakeCovers('T001', info, {{count: 5, size: '竖版 3:4', style: {style}, compositions: ['K02', 'K04', 'K01'], text: '十分钟写完周报'}})")
        prompt, folder = self.codex_prompt(make.locator('a[data-open-in="codex"]'))
        self.assertEqual(prompt, expected)
        self.assertEqual(Path(folder).resolve(), self.work.resolve(), '在工作文件夹里新开对话')
        self.assertIn('在 Codex 里再出一批', make.locator('a[data-open-in="codex"]').inner_text())
        # 改：横版、3 张、换一句字、构图去掉 K04 加上 K06
        make.locator('[aria-label="尺寸"] button', has_text='横版 2.35:1').click()
        make.locator('[aria-label="这批几张"] button', has_text='3').click()
        make.locator('input[aria-label="封面上的字"]').fill('周报别再熬夜写')
        make.locator('button', has_text='换几张').click()
        page.locator('.jc-comp-item[title="K04"]').click()
        page.locator('.jc-comp-item[title="K06"]').click()
        page.locator('button', has_text='这一批就用这几张').click()
        self.assertIn('3 张（这一批改过）', make.inner_text())
        make.locator('button', has_text='复制给 AI').click()
        page.wait_for_timeout(300)
        expected = ask(f"a.askMakeCovers('T001', info, {{count: 3, size: '横版 2.35:1', style: {style}, compositions: ['K02', 'K01', 'K06'], text: '周报别再熬夜写'}})")
        self.assertEqual(self.clipboard(page), expected)
        self.assertNotIn(str(self.work), self.clipboard(page), '那句话不带这台电脑的路径')
        # 换风格：参考构图换成那个风格的
        make.locator('select[aria-label="照哪个风格出"]').select_option('风格/2026-10-03_4张')
        self.assertIn('你放进来的 4 张图', make.inner_text())
        self.assertIn('4 张（默认）', make.inner_text())
        self.assertEqual(page.errors, [])

    def test_2_topic_covers_view_only(self):
        """这条的封面只看：选定的排第一；新的一批在前；只有提示词的能复制提示词；点开放大能翻；没有选定、批注、收藏、删除"""
        page = self.open()
        box = page.locator('#covers')
        self.assertEqual(box.locator('[data-cover-selected="02"]').count(), 1)
        self.assertIn('用的是封面-02', box.inner_text())
        text = box.inner_text()
        self.assertLess(text.index('第 2 批'), text.index('第 1 批'), '新的一批在前')
        self.assertIn('暖黄手写风 · 竖版 3:4', text)
        for gone in ('就用这张', '写备注', '并排对比', '收藏', '挪进回收站', '取消选定'):
            self.assertEqual(box.locator('button', has_text=gone).count(), 0, gone)
        box.locator('[data-cover="04"] button', has_text='复制提示词').click()
        page.wait_for_timeout(300)
        self.assertEqual(self.clipboard(page), 'Create ONE complete 3:4 portrait Chinese video cover.\n')
        box.locator('[data-cover="01"] .jc-cover-img').click()
        overlay = page.locator('.jc-cover-overlay')
        self.assertIn('封面-01', overlay.inner_text())
        page.keyboard.press('ArrowRight')
        self.assertIn('封面-03', overlay.inner_text())
        page.keyboard.press('Escape')
        self.assertEqual(page.locator('.jc-cover-overlay').count(), 0)
        self.assertEqual(page.errors, [])

    def test_3_styles(self):
        """「封面」页的风格：默认在前；一次全拆的话列出还没拆的两个；设为默认；在卡片上改默认构图（存成「你」挑的）"""
        page = self.open('/content?tab=covers', '[data-style]')
        ids = page.eval_on_selector_all('[data-style]', 'els => els.map(e => e.getAttribute("data-style"))')
        self.assertEqual(ids[0], '抖音-示例博主')
        self.assertIn('默认', page.locator('[data-style="抖音-示例博主"]').inner_text())
        batch = page.locator('a[data-open-in="codex"]', has_text='把还没拆的 2 个对标都拆了')
        prompt, _ = self.codex_prompt(batch)
        names = page.eval_on_selector_all('[data-style][data-style^="小红书"], [data-style][data-style="抖音-第三个博主"]', 'els => els.map(e => e.getAttribute("data-style"))')
        self.assertEqual(len(names), 2)
        self.assertIn('把我还没拆封面 VI 的 2 个对标账号都拆了', prompt)
        self.assertIn('「另一个博主」（小红书）', prompt)
        self.assertIn('「第三个博主」（抖音）', prompt)
        # 设为默认：徽章挪过去
        mine = page.locator('[data-style="风格/2026-10-03_4张"]')
        mine.locator('button', has_text='设为默认').click()
        settings_file = self.work / '封面素材' / '封面设置.json'
        for _ in range(50):
            if json.loads(settings_file.read_text('utf-8')).get('benchmark') == '风格/2026-10-03_4张':
                break
            page.wait_for_timeout(100)
        page.wait_for_timeout(300)
        self.assertNotIn('设为默认', mine.inner_text())
        settings = json.loads((self.work / '封面素材' / '封面设置.json').read_text('utf-8'))
        self.assertEqual(settings['benchmark'], '风格/2026-10-03_4张')
        # 改默认构图
        card = page.locator('[data-style="抖音-示例博主"]')
        card.locator('button', has_text='改').click()
        page.locator('.jc-comp-item[title="K04"]').click()
        page.locator('.jc-comp-item[title="K05"]').click()
        page.locator('button', has_text='存成默认构图').click()
        page.wait_for_timeout(500)
        saved = json.loads((self.work / '市场调研' / '对标账号' / '抖音-示例博主' / '默认构图.json').read_text('utf-8'))
        self.assertEqual((saved['ids'], saved['by']), (['K02', 'K01', 'K05'], '你'))
        self.assertEqual(page.errors, [])

    def test_4_new_style_ways(self):
        """拆一个新风格：对标账号里选一个、贴主页链接（贴了就带上）、拖图进来建一组（卡片上「拆这组图」那句话带它的编号和张数）"""
        page = self.open('/content?tab=covers', '[data-style]')
        way = page.locator('.jc-way-card', has_text='贴博主的主页链接')
        way.locator('input[aria-label="博主的主页链接"]').fill('https://www.douyin.com/user/abc')
        way.locator('button', has_text='复制给 AI').click()
        page.wait_for_timeout(300)
        self.assertEqual(self.clipboard(page), ask("a.askCoverViLink(info, 'https://www.douyin.com/user/abc')"))
        self.assertIn('去接 TikHub', way.inner_text(), '没接 TikHub 时提示旁边就放「去接 TikHub」')
        self.assertIn('connect=tikhub', way.locator('a', has_text='去接 TikHub').get_attribute('href'))
        files = [{'name': f'截图{i}.png', 'mimeType': 'image/png', 'buffer': png(30, 40, (20 * i, 120, 90))} for i in (1, 2)]
        page.set_input_files('input[aria-label="选几张封面图"]', files)
        page.wait_for_selector('[data-style$="_2张"]', timeout=10000)
        card = page.locator('[data-style$="_2张"]')
        style_id = card.get_attribute('data-style')
        self.assertIn('还没拆的 2 张图', card.inner_text())
        prompt, _ = self.codex_prompt(card.locator('a[data-open-in="codex"]'))
        self.assertEqual(prompt, ask(f"a.askCoverViImages({{id: '{style_id}', covers: 2}}, info)"))
        folder = self.work / '封面素材' / style_id
        self.assertEqual(sorted(p.name for p in (folder / '封面').iterdir()), ['截图1.png', '截图2.png'])
        self.assertEqual(page.errors, [])

    def test_5_my_covers_and_photos(self):
        """我的封面：按内容、按风格、只看文章；我的照片：放一张、拿掉一张（挪进回收站）"""
        page = self.open('/content?tab=covers', '[data-library-group="T001"]')
        group = page.locator('[data-library-group="T001"]')
        self.assertIn('视频', group.inner_text())
        self.assertEqual(group.locator('.jc-library-thumb').count(), 3)
        self.assertEqual(group.locator('.jc-library-thumb[data-selected]').count(), 1)
        page.locator('[aria-label="怎么排"] button', has_text='按风格').click()
        self.assertIn('暖黄手写风', page.locator('[data-library-style="抖音-示例博主"]').inner_text())
        page.locator('[aria-label="只看"] button', has_text='文章').click()
        self.assertIn('还没有文章的封面', page.inner_text('body'))
        page.set_input_files('input[aria-label="选几张你的照片"]', [{'name': '侧脸.png', 'mimeType': 'image/png', 'buffer': png(40, 40, (90, 60, 50))}])
        page.wait_for_selector('#my-photos .jc-photo[title="侧脸.png"]', timeout=8000)
        self.assertEqual(page.locator('#my-photos .jc-photo').count(), 2)
        page.locator('#my-photos button[aria-label="拿掉 侧脸.png"]').click()
        page.wait_for_function("document.querySelectorAll('#my-photos .jc-photo').length === 1")
        self.assertTrue(any('侧脸.png' in p.name for p in (self.work / '回收站').iterdir()))
        self.assertEqual(page.errors, [])

    def test_7_sidebar_groups(self):
        """左边菜单（原作者 10-04 定）：有页签的栏目点一下在下面展开子菜单、不换页；点子菜单才换页，标题写子页面名；
        电脑上页面上方不再放那排页签，手机上还放"""
        page = self.open('/research?tab=accounts', '.jc-sidebar button[data-nav="research"]')
        research = page.locator('.jc-sidebar button[data-nav="research"]')
        content = page.locator('.jc-sidebar button[data-nav="content"]')
        self.assertEqual(research.get_attribute('aria-expanded'), 'true', '当前所在的那一栏展开着')
        self.assertEqual(content.get_attribute('aria-expanded'), 'false')
        page.wait_for_selector('.jc-sidebar [data-nav-tab="research:accounts"][aria-current="page"]', timeout=5000)
        self.assertEqual(page.inner_text('h1').strip(), '对标账号')
        self.assertFalse(page.locator('.jc-column-tabs').is_visible(), '电脑上不放那排页签')
        content.click()
        self.assertEqual(content.get_attribute('aria-expanded'), 'true')
        self.assertIn('/research', page.url, '点栏目名只展开，不换页')
        page.locator('.jc-sidebar [data-nav-tab="content:covers"]').click()
        page.wait_for_url('**/content?tab=covers', timeout=10000)
        page.wait_for_selector('.jc-sidebar [data-nav-tab="content:covers"][aria-current="page"]', timeout=5000)
        self.assertEqual(page.inner_text('h1').strip(), '封面')
        self.assertEqual(page.locator('.jc-sidebar button[data-nav="research"]').get_attribute('aria-expanded'), 'false', '离开的那一栏没点过，收起来')
        # 收起当前这一栏：选中落回栏目名上
        page.locator('.jc-sidebar button[data-nav="content"]').click()
        page.wait_for_selector('.jc-sidebar button[data-nav="content"][aria-current="page"]', timeout=5000)
        self.assertEqual(page.errors, [])
        phone = self.open('/research?tab=reports', '.jc-column-tabs', width=390)
        self.assertTrue(phone.locator('.jc-column-tabs').is_visible(), '手机上还是页签')
        self.assertEqual(phone.inner_text('h1').strip(), '市场调研')

    def test_6_narrow(self):
        """390 宽：两处页面都不横向滚动"""
        for path, ready in (('/content?tab=covers', '[data-style]'), ('/content/T001', '[data-cover-make]')):
            page = self.open(path, ready, width=390)
            self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), 390, path)
            self.assertEqual(page.errors, [], path)


if __name__ == '__main__':
    unittest.main()
