"""新手指引和「正在读取……」的浏览器测试：真的起一份工作台（临时家目录，端口从 38878 往后找，不碰正在用的那份），
用无界面 Chrome 照用户的样子点：「内容」页顶部的卡和清单、「带我走一遍」以后每步要亲手点、刷新和换页面接着走、
等 AI 那一步不压暗、等到创作页自动往下走、打开创作页接着走第二段并采纳一条、清单四项打满后收成「重看引导」、
「我自己看」和跳过、「新手指引」从第 1 步重走、要亮的按钮不在就跳过那一步、窄屏不出屏、用到时的提示只出一次、
等 AI 那一步的气泡只说粘贴给 AI、发出去（不摆路径），一键打开的链接开在工作文件夹、填好那句话；
「选题」页的「加你自己的选题」等开场卡收起再出，「复制给 AI：加选题」复制的那句话对、AI 加完切回来就看到。

要 node、Google Chrome 和 Python 的 playwright（pip install playwright；用本机的 Chrome，不用下载 playwright 自带的浏览器），
缺一样就跳过；设环境变量 JC_SKIP_BROWSER=1 也跳过。界面没编译过或代码更新过时，pnpm start 会先编译（第一次要一两分钟）。
期望的字从 ui/lib/tour-steps.ts 读，改了步骤里的字不用改这里；改了步骤的结构（几步、点什么）要照着改这里。
用法（仓库根目录）：python3 -m unittest discover -s tests/browser   或   pnpm test:browser
"""
import json, os, re, shutil, signal, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]
CHROME = os.environ.get('JC_CHROME') or '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
NODE = shutil.which('node')
try:
    from playwright.sync_api import sync_playwright
except ImportError:  # 没装 playwright：整组跳过
    sync_playwright = None
SKIP = os.environ.get('JC_SKIP_BROWSER') == '1' or not NODE or not os.path.exists(CHROME) or sync_playwright is None
BRAND = json.loads((ROOT / 'brand.json').read_text('utf-8'))
SAVED = 'workbench-tour'
HINTS = 'workbench-hints'


def tour_file():
    """用 node 读步骤文件（Node 24 能直接读 .ts），拿到步骤和那几句话"""
    code = ("const m = await import('./ui/lib/tour-steps.ts'); const a = await import('./ui/lib/ask-ai.ts');"
            " const b = JSON.parse((await import('node:fs')).readFileSync('brand.json', 'utf8'));"
            " const info = {name: b.name, repo: b.repository ?? '', skill: b.id + '-write'};"
            " const ask = a.askWrite(m.TOUR_WORK, info), askTopic = a.askAddTopic(info);"
            " console.log(JSON.stringify({steps: m.TOUR_STEPS, text: m.TOUR_TEXT, card: m.TOUR_CARD,"
            " hints: m.TOUR_HINTS, creation: m.CREATION_PAGE, work: m.TOUR_WORK, version: m.TOUR_VERSION, links: m.AI_LINKS, ask, askTopic}));")
    out = subprocess.run([NODE, '--input-type=module', '-e', code], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return json.loads(out)


@unittest.skipIf(SKIP, '没有 node、Chrome 或 Python 的 playwright，或设置了 JC_SKIP_BROWSER=1')
class TourBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.T = tour_file()
        cls.steps = {s['id']: (i, s) for i, s in enumerate(cls.T['steps'])}
        cls.counted = [s for s in cls.T['steps'] if not s.get('uncounted')]
        cls.home = tempfile.mkdtemp(prefix='workbench-tour-test-')
        config_dir = Path(cls.home, 'Library', 'Application Support', BRAND['id'])
        config_dir.mkdir(parents=True)
        (config_dir / 'config.json').write_text(json.dumps({'ports': {'api': 38878, 'ui': 38879, 'save': 38977}}), 'utf-8')
        cls.config_dir = config_dir
        cls.work = Path(cls.home, 'Documents', BRAND['id'])
        # 钥匙串只用测试专用的服务名，环境变量里的 TikHub key 也不带进去：进「市场调研」页时不碰真的 tikhub-api、不连 TikHub
        # 一键在 AI 里打开：不问这台 Mac 装了什么，当作 Codex、Claude 桌面版、终端里的 Claude Code 都接链接（按钮是否出现的判断在 tests/ai-links.test.mjs）
        env = dict(os.environ, HOME=cls.home, WORKBENCH_DRY_OPEN='1', PYTHONDONTWRITEBYTECODE='1', NEXT_TELEMETRY_DISABLED='1',
                   WORKBENCH_KEYCHAIN_SERVICE=f"{BRAND['id']}-tour-test-{os.getpid()}", WORKBENCH_AI_LINKS='codex,claude-desktop,claude')
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
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(executable_path=CHROME, headless=True)

    @classmethod
    def stop_server(cls):
        if cls.proc.poll() is None:
            cls.proc.send_signal(signal.SIGINT)  # 和在终端里按 Control+C 一样，三个服务一起停
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

    # ---------- 小工具 ----------
    def open(self, width=1440, saved=None, hints=None):
        """一个新的浏览器（像第一次打开）。saved / hints：先在浏览器里记好的新手指引进度和提示（不给就是全新的）"""
        narrow = width <= 720
        ctx = self.browser.new_context(viewport={'width': width, 'height': 844 if narrow else 900}, is_mobile=narrow, has_touch=narrow)
        ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=self.base)
        self.addCleanup(ctx.close)
        page = ctx.new_page()
        errors = []
        page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(f'页面报错：{e}'))
        page.errors = errors
        if saved is not None or hints is not None:
            page.goto(self.base + '/api/health')  # 同一个网址下的随便一页，先把浏览器里的记录写好
            if saved is not None:
                full = {'v': self.T['version'], 'status': 'idle', 'step': 0, 'card': 'open', 'opened': False, **saved}
                page.evaluate('([k, v]) => localStorage.setItem(k, JSON.stringify(v))', [SAVED, full])
            if hints is not None:
                page.evaluate('([k, v]) => localStorage.setItem(k, JSON.stringify(v))', [HINTS, hints])
        return ctx, page

    def saved(self, page):
        return page.evaluate(f"JSON.parse(localStorage.getItem('{SAVED}') || 'null')")

    def count_label(self, step_id):
        index, step = self.steps[step_id]
        if step.get('uncounted'):
            return self.T['text']['uncounted']
        n = self.counted.index(step) + 1
        return self.T['text']['count'].replace('{n}', str(n)).replace('{total}', str(len(self.counted)))

    def popover(self, page, selector='.driver-popover.jc-tour'):
        page.wait_for_selector(selector, timeout=12000)
        page.wait_for_timeout(500)  # 气泡浮出来的动效
        return page.evaluate("""(sel) => { const p = document.querySelector(sel), r = p.getBoundingClientRect(), a = document.querySelector('.driver-active-element');
            return { text: p.innerText.replace(/\\s+/g, ' '), count: p.querySelector('.jc-tour-count')?.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
                     vw: innerWidth, vh: innerHeight, active: a && (a.getAttribute('data-tour') || a.getAttribute('href')) }; }""", selector)

    def assertOnScreen(self, box, what):
        self.assertTrue(box['left'] >= 0 and box['right'] <= box['vw'] and box['top'] >= 0 and box['bottom'] <= box['vh'], f'{what}超出了屏幕：{box}')

    def assertStep(self, page, step_id, active):
        """压暗、只亮一个按钮的那种步骤：角上第几步、那一句、跳过、亮的是哪个、在屏幕里"""
        index, step = self.steps[step_id]
        box = self.popover(page)
        self.assertEqual(box['count'], self.count_label(step_id), box)
        self.assertIn(step.get('textNarrow') if box['vw'] <= 720 and step.get('textNarrow') else step['text'], box['text'])
        self.assertIn(self.T['text']['skip'], box['text'])
        self.assertEqual(box['active'], active, f'亮的不是{active}：{box}')
        self.assertOnScreen(box, '气泡')
        return box

    def no_overlay(self, page):
        page.wait_for_timeout(400)
        return page.locator('.driver-overlay').count() == 0 and page.locator('.driver-popover').count() == 0

    def card_state(self, page):
        """「内容」页顶部那张卡：标题、几项打了勾、主按钮写什么；收起时是那一行的字"""
        page.wait_for_selector('[data-tour="tour-card"], [data-tour="tour-entry"]', timeout=10000)
        return page.evaluate("""() => { const c = document.querySelector('[data-tour="tour-card"]'), e = document.querySelector('[data-tour="tour-entry"]');
            if (e) return { entry: e.innerText.replace(/\\s+/g, ' ').trim() };
            return { title: c.querySelector('.jc-tour-card-title').textContent, count: c.querySelector('.jc-tour-card-count').textContent,
                     done: [...c.querySelectorAll('.jc-tour-checklist li')].map((li) => li.hasAttribute('data-done')),
                     primary: c.querySelector('.jc-button-primary').textContent }; }""")

    def make_creation_page(self, work_id='T001'):
        """假装 AI 写完了：用仓库里的 build_page.py（写稿 Skill 底层调的那个）给这条内容生成创作页，带两条修改建议"""
        folder = self.work / '内容草稿' / f'{work_id}_示例选题'
        folder.mkdir(parents=True, exist_ok=True)
        mine = '你是不是每次都卡在第一句？想了半天还是删掉重来。我用一条提示词，让 AI 一次写五个开头。'
        data = {'content_id': work_id, 'type': '口播', 'stage': '写稿', 'title': '示例：用 AI 三分钟想好一条视频的开头',
                'narrative': {'story': '开头总卡住的人，用一条提示词三分钟想好开头', 'audience': '刚开始做短视频的人', 'problem': '开头 5 秒留不住人'},
                'segments': [{'title': '开头', 'role': '钩子', 'refs': [], 'baseline': mine, 'mine': mine}],
                'suggestions': [
                    {'segment': 1, 'category': '表达', 'original': '想了半天还是删掉重来', 'proposed': '想半天又全删了', 'reason': '更短，更像说话', 'basis': {'type': 'AI 自己的判断', 'text': '口语'}},
                    {'segment': 1, 'category': '表达', 'original': '一次写五个开头', 'proposed': '一口气写五个开头', 'reason': '「一口气」更像说话', 'basis': {'type': 'AI 自己的判断', 'text': '口语'}},
                ]}
        data_file = Path(self.home, f'{work_id}_数据.json')
        data_file.write_text(json.dumps(data, ensure_ascii=False), 'utf-8')
        out = folder / f'{work_id}_创作页.html'
        env = dict(os.environ, HOME=self.home, WORKBENCH_CONFIG_DIR=str(self.config_dir), PYTHONDONTWRITEBYTECODE='1')
        r = subprocess.run([sys.executable, str(ROOT / 'creation-page' / 'build_page.py'), str(data_file), '--out', str(out), '--root', str(self.work)], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return out

    def ask_text(self):
        """复制给 AI 的那句话（详情页和第 2 步复制的是同一句）：ui/lib/ask-ai.ts 的 askWrite，不带这台电脑的路径"""
        return self.T['ask']

    def clipboard(self, page):
        return page.evaluate('navigator.clipboard.readText()')

    def link_query(self, link, scheme, where):
        """一键打开的链接：协议和去处对，返回解开的参数"""
        url = urlsplit(link.get_attribute('href'))
        self.assertEqual(url.scheme, scheme)
        self.assertEqual((url.netloc + url.path).strip('/'), where)
        return parse_qs(url.query)

    def without_creation_page(self):
        """这个场景要 T001 还没有创作页（有了的话等 AI 那一步直接跳过）：先挪开，场景结束再挪回来"""
        page_file = self.work / '内容草稿' / 'T001_示例选题' / 'T001_创作页.html'
        if page_file.exists():
            aside = Path(tempfile.mkdtemp(prefix='tour-aside-')) / page_file.name
            shutil.move(str(page_file), str(aside))
            self.addCleanup(shutil.move, str(aside), str(page_file))

    def decisions_in(self, page_file):
        html = Path(page_file).read_text('utf-8')
        doc = json.loads(re.search(r'<script id="jc-doc" type="application/json">(.*?)</script>', html, re.S).group(1))
        return [it.get('fields', {}).get('decision', '') for it in doc['items'] if it.get('kind') == 'suggestion']

    # ---------- 场景 ----------
    def test_1_loading_line(self):
        """第一次读得慢：内容的位置先出「正在读取……」，读到以后内容出来、这一行不见，中间不是一片空白"""
        ctx, page = self.open(saved={'status': 'done', 'card': 'collapsed'})
        held = []  # 读选题的请求先扣住，看完「正在读取……」再放行
        page.route('**/api/works', lambda route: held.append(route))
        page.goto(self.base + '/content?tab=topics', wait_until='commit')
        page.wait_for_selector('.jc-loading', state='visible', timeout=5000)
        page.wait_for_timeout(900)  # 晚 0.3 秒才浮出来
        self.assertTrue(held, '页面应该在读选题')
        self.assertIn('正在读取', page.locator('.jc-loading').inner_text())
        self.assertGreater(float(page.evaluate("getComputedStyle(document.querySelector('.jc-loading')).opacity")), 0.9)
        page.route('**/api/works', lambda route: route.continue_())  # 之后的请求直接放行
        for route in held:
            try:
                route.continue_()
            except Exception:  # 已经放行过的不用再放
                pass
        page.wait_for_selector('[data-work="T001"]', timeout=10000)
        self.assertEqual(page.locator('.jc-loading').count(), 0)
        self.assertEqual(page.errors, [])

    def test_2_card_on_content_page(self):
        """「内容」页顶部嵌一张卡（不是弹窗）：作者的口吻、清单 1/4；「提示词」页没有；没选之前刷新还在"""
        ctx, page = self.open()
        page.goto(self.base + '/prompts')
        page.wait_for_timeout(1500)
        self.assertEqual(page.locator('[data-tour="tour-card"]').count(), 0, '「提示词」页不该有那张卡')
        page.goto(self.base + '/content?tab=doing')
        state = self.card_state(page)
        author = BRAND.get('copyrightHolder', '')
        self.assertEqual(state['title'], self.T['card']['title'].replace('{作者}', author))
        self.assertEqual(state['count'], '1/4')
        self.assertEqual(state['done'], [True, False, False, False], '清单只有「装好工作台」打了勾')
        self.assertEqual(state['primary'], self.T['card']['start'])
        self.assertIn(self.T['card']['body'], page.inner_text('[data-tour="tour-card"]'))
        self.assertTrue(self.no_overlay(page), '开场不压暗')
        page.reload()
        self.assertEqual(self.card_state(page)['count'], '1/4')
        self.assertEqual(page.errors, [])

    def test_3_later_then_replay(self):
        """「我自己看」：说清在哪重看，卡收成一行「新手指引」，刷新也不再展开；点那一行展开；左下角「新手指引」从第 1 步重走"""
        ctx, page = self.open()
        page.goto(self.base + '/content')
        self.card_state(page)
        page.get_by_role('button', name=self.T['card']['later'], exact=True).click()
        self.assertIn(self.T['text']['skipped'], page.wait_for_selector('[data-tour="feedback"]', timeout=4000).inner_text())
        self.assertIn(self.T['card']['collapsed'], self.card_state(page)['entry'])
        page.reload()
        self.assertIn(self.T['card']['collapsed'], self.card_state(page)['entry'], '收起以后刷新不再展开')
        page.click('[data-tour="tour-entry"]')
        self.assertEqual(self.card_state(page)['count'], '1/4', '点那一行展开')
        page.goto(self.base + '/prompts')
        page.locator('[data-tour="replay"]:visible').click()  # 在别的页面点：回到「内容」从第 1 步走
        page.wait_for_url('**/content**')
        self.assertStep(page, 'open-topic', '/content/T001')
        self.assertEqual(self.saved(page)['status'], 'running')
        self.assertEqual(page.errors, [])

    def test_4_esc_skips(self):
        """走到一半按 Esc：等于跳过"""
        ctx, page = self.open(saved={'status': 'running', 'step': self.steps['open-topic'][0]})
        page.goto(self.base + '/content')
        self.popover(page)
        page.keyboard.press('Escape')
        self.assertTrue(self.no_overlay(page))
        self.assertEqual(self.saved(page)['status'], 'skipped')
        self.assertIn(self.T['text']['skipped'], page.wait_for_selector('[data-tour="feedback"]', timeout=4000).inner_text())
        self.assertEqual(page.errors, [])

    def test_5_narrow(self):
        """390 宽：卡和气泡都在屏幕里，页面不横向滚动；「新手指引」在顶栏右边，点了从第 1 步重走"""
        ctx, page = self.open(width=390)
        page.goto(self.base + '/content')
        self.card_state(page)
        box = page.locator('[data-tour="tour-card"]').bounding_box()
        self.assertTrue(box['x'] >= 0 and box['x'] + box['width'] <= 390, f'卡超出了屏幕：{box}')
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), 390)
        page.get_by_role('button', name=self.T['card']['start'], exact=True).click()
        self.assertStep(page, 'open-topic', '/content/T001')
        page.keyboard.press('Escape')
        self.assertTrue(self.no_overlay(page))
        self.assertIn('右上角', page.wait_for_selector('[data-tour="feedback"]', timeout=4000).inner_text())
        replay = page.locator('[data-tour="replay"]:visible')
        self.assertEqual(replay.count(), 1)
        self.assertIn('jc-topbar', replay.evaluate('e => e.parentElement.className'))
        replay.click()
        self.assertStep(page, 'open-topic', '/content/T001')
        self.assertEqual(page.errors, [])

    def test_6_whole_way(self):
        """从「带我走一遍」走到创作页采纳一条：每步要亲手点（按 → 和点暗处不前进）；刷新、换页面接着走；等 AI 那步不压暗、
        等到创作页自动往下走；创作页里两步；清单四项打满，卡收成一行「重看引导」"""
        ctx, page = self.open()
        requests = []
        ctx.on('request', lambda r: requests.append(r.url))
        page.goto(self.base + '/content')
        self.card_state(page)
        page.get_by_role('button', name=self.T['card']['start'], exact=True).click()
        self.assertStep(page, 'open-topic', '/content/T001')
        page.keyboard.press('ArrowRight')
        page.mouse.click(6, 6)  # 点暗处
        page.wait_for_timeout(500)
        self.assertEqual(self.saved(page)['step'], self.steps['open-topic'][0], '按 → 或点暗处不该往下走')
        page.click('.driver-active-element')
        page.wait_for_url('**/content/T001')
        self.assertStep(page, 'copy-ask', 'ask-ai')
        page.reload()  # 刷新：接着亮这一步
        self.assertStep(page, 'copy-ask', 'ask-ai')
        page.goto(self.base + '/prompts')  # 换到别的页面：顶上细栏「接着走」
        self.assertIn(self.T['text']['resume'], page.wait_for_selector('[data-tour="tour-bar"]', timeout=6000).inner_text())
        page.get_by_role('button', name=self.T['text']['resume'], exact=True).click()
        page.wait_for_url('**/content/T001')
        self.assertStep(page, 'copy-ask', 'ask-ai')
        page.click('.driver-active-element')
        self.assertEqual(page.evaluate('navigator.clipboard.readText()'), self.ask_text())
        self.assertIn(self.steps['copy-ask'][1]['doneText'], page.wait_for_selector('[data-tour="feedback"]', timeout=4000).inner_text())
        # 等 AI：不压暗，气泡贴在那句话旁边，顶上细栏
        wait = self.steps['wait-ai'][1]
        self.assertTrue(self.no_overlay(page), '等 AI 那一步不压暗')
        float_box = self.popover(page, '[data-tour="tour-float"]')
        self.assertEqual(float_box['count'], self.count_label('wait-ai'))
        self.assertIn(wait['text'], float_box['text'])
        self.assertOnScreen(float_box, '不压暗的气泡')
        self.assertIn(wait['waitFor']['text'], page.inner_text('[data-tour="tour-bar"]'))
        page.goto(self.base + '/content')  # 卡上清单：打开过 T001
        self.assertEqual(self.card_state(page)['count'], '2/4')
        page.goto(self.base + '/prompts')  # 等的时候到处看看：细栏一直在
        self.assertIn(wait['waitFor']['text'], page.wait_for_selector('[data-tour="tour-bar"]', timeout=6000).inner_text())
        page.get_by_role('button', name=wait['waitFor']['button'], exact=True).click()  # 还没写好就点「AI 写好了」
        page.wait_for_selector(f"text={wait['waitFor']['notYet']}", timeout=5000)
        page_file = self.make_creation_page()
        page.wait_for_selector(f"[data-tour=\"tour-bar\"] >> text={self.T['text']['resume']}", timeout=12000)  # 每隔几秒问一次，问到了
        page.get_by_role('button', name=self.T['text']['resume'], exact=True).click()
        page.wait_for_url('**/content/T001')
        self.assertStep(page, 'open-creation', 'open-creation')
        with ctx.expect_page() as opened:
            page.click('.driver-active-element')
        creation = opened.value
        param = self.steps['open-creation'][1]['openParam']
        self.assertTrue(any('/p/' in u and param in u for u in requests), f'打开创作页的链接要带上 {param}')
        self.assertEqual(self.saved(page)['status'], 'done')
        # 创作页里第二段：第 1 步亮建议和原句，点「下一步」；第 2 步只亮「采纳」，亲手点
        cp = self.T['creation']
        creation.wait_for_selector('.jc-guide-pop', timeout=15000)
        creation.wait_for_timeout(500)
        self.assertIn(cp['steps'][0], creation.inner_text('.jc-guide-pop'))
        self.assertIn(self.T['text']['count'].replace('{n}', '1').replace('{total}', str(len(cp['steps']))), creation.inner_text('.jc-guide-pop'))
        creation.get_by_role('button', name=cp['next'], exact=True).click()
        creation.wait_for_timeout(500)
        self.assertIn(cp['steps'][1], creation.inner_text('.jc-guide-pop'))
        creation.click('.jc-guide-yes')
        creation.wait_for_selector('.jc-guide-pop.is-done', timeout=8000)
        self.assertIn(cp['done'], creation.inner_text('.jc-guide-pop'))
        for _ in range(40):
            if '采纳' in self.decisions_in(page_file):
                break
            time.sleep(0.15)
        self.assertEqual(self.decisions_in(page_file)[0], '采纳')
        # 回到工作台：清单 4/4，卡收成一行「重看引导」；不再有亮框和细栏
        page.bring_to_front()
        page.goto(self.base + '/content')
        state = self.card_state(page)
        self.assertIn(self.T['card']['replay'], state.get('entry', ''), state)
        self.assertIn('4/4', state['entry'])
        self.assertEqual(page.locator('.driver-popover').count() + page.locator('[data-tour="tour-bar"]').count(), 0)
        self.assertEqual(page.errors, [])

    def test_7_missing_target_skipped(self):
        """要亮的按钮不在就跳过那一步：T001 已经有创作页（上一个场景生成的）、在「在做」里；从第 1 步重走：
        先换到「在做」亮 T001，交给 AI 的那句话不在、等 AI 那步已经等到，直接亮「打开创作页」"""
        if not (self.work / '内容草稿' / 'T001_示例选题' / 'T001_创作页.html').exists():
            self.make_creation_page()
        ctx, page = self.open()
        page.goto(self.base + '/content?tab=topics')
        state = self.card_state(page)
        if 'entry' in state:
            page.click('[data-tour="tour-entry"]')  # 清单打满时是「重看引导」那一行：点了从第 1 步重走
        else:
            page.get_by_role('button', name=self.T['card']['start'], exact=True).click()
        self.assertStep(page, 'open-topic', '/content/T001')
        self.assertIn('tab=doing', page.url, '示例选题在「在做」里：先换过去')
        page.click('.driver-active-element')
        page.wait_for_url('**/content/T001')
        self.assertStep(page, 'open-creation', 'open-creation')
        self.assertEqual(page.errors, [])

    def test_8_hints(self):
        """用到时再提示：嵌在页面里一行；第一次进「提示词」提一句，只出一次；「不再显示这类提示」以后都不提，打开创作页的链接带 hints=off"""
        ctx, page = self.open(saved={'status': 'done', 'card': 'collapsed'})
        requests = []
        ctx.on('request', lambda r: requests.append(r.url))
        hint_text = {h['id']: h['text'] for h in self.T['hints']}
        page.goto(self.base + '/prompts')
        hint = page.wait_for_selector('[data-tour="hint"]', timeout=6000)
        self.assertIn(hint_text['prompts-page'], hint.inner_text())
        self.assertNotIn(page.evaluate("getComputedStyle(document.querySelector('[data-tour=\"hint\"]')).position"), ('fixed', 'absolute'), '提示嵌在页面里，不浮着')
        page.get_by_role('button', name=self.T['text']['hintOk'], exact=True).click()
        page.reload()
        page.wait_for_timeout(1800)
        self.assertEqual(page.locator('[data-tour="hint"]').count(), 0, '同一句只提一次')
        page.goto(self.base + '/content?tab=doing')
        self.assertIn(hint_text['doing-tab'], page.wait_for_selector('[data-tour="hint"]', timeout=6000).inner_text())
        page.get_by_role('button', name=self.T['text']['hintOff'], exact=True).click()
        page.locator('[data-tour="open-work-folder"]').click()  # 第一次点「在访达中打开」：关了就不提
        page.wait_for_timeout(1500)
        self.assertEqual(page.locator('[data-tour="hint"]').count(), 0, '「不再显示这类提示」以后都不提')
        if (self.work / '内容草稿' / 'T001_示例选题' / 'T001_创作页.html').exists():
            page.goto(self.base + '/content/T001')
            with ctx.expect_page():
                page.click('[data-tour="open-creation"]')
            self.assertTrue(any('/p/' in u and 'hints=off' in u for u in requests), '关了提示：打开创作页的链接带 hints=off')
        self.assertEqual(page.errors, [])

    def test_9_hints_on_research_page(self):
        """「市场调研」页第一次进来也提一句；在这一页点左下角「在访达中打开」，那句提示就显示在这一页（不会白白记成提过了）"""
        ctx, page = self.open(saved={'status': 'done', 'card': 'collapsed'})
        hint_text = {h['id']: h['text'] for h in self.T['hints']}
        page.goto(self.base + '/research')
        self.assertIn(hint_text['research-page'], page.wait_for_selector('[data-tour="hint"]', timeout=8000).inner_text())
        page.get_by_role('button', name=self.T['text']['hintOk'], exact=True).click()
        page.locator('[data-tour="open-work-folder"]').click()
        self.assertIn(hint_text['open-work-folder'], page.wait_for_selector('[data-tour="hint"]', timeout=6000).inner_text())
        self.assertEqual(sorted(json.loads(page.evaluate(f"localStorage.getItem('{HINTS}')"))['seen']), ['open-work-folder', 'research-page'])
        self.assertEqual(page.errors, [])


    def test_10_wait_step_paste_anywhere(self):
        """等 AI 那一步（原作者试用时断在这里，2026-10-03 定了「提示词标准」）：气泡只说粘贴给 Codex 或 Claude Code、发出去，
        在哪个对话里都行，不摆路径、不让用户先打开哪个文件夹；那句话不带这台电脑的路径；一键打开的按钮 Codex 在前，
        链接开在工作文件夹、填好那句话（和详情页上的一字不差）；1440 和 390 都不出屏、不横向滚动"""
        self.without_creation_page()
        wait_index, wait = self.steps['wait-ai']
        folder = str(self.work)
        L = self.T['links']
        for width in (1440, 390):
            ctx, page = self.open(width=width, saved={'status': 'running', 'step': wait_index, 'opened': True})
            page.goto(self.base + '/content/T001')
            box = self.popover(page, '[data-tour="tour-float"]')
            for line in (wait['title'], wait['text'], L['caption']):
                self.assertIn(line, box['text'])
            self.assertOnScreen(box, f'{width} 宽的气泡')
            self.assertEqual(page.locator('[data-tour="folder-path"], [data-tour="open-folder-help"], [data-tour="show-help"]').count(), 0, '不摆路径、不教怎么打开文件夹')
            self.assertNotIn(folder, self.ask_text(), '那句话不带这台电脑的路径')
            self.assertEqual(page.inner_text('[data-tour="ask-ai"] .jc-ask-text'), self.ask_text())
            links = page.locator('[data-tour="tour-float"] [data-tour^="open-in-"]')
            # 桌面版和终端版都有时只放桌面版（2026-10-04 原作者要按钮开客户端，不开命令行）
            self.assertEqual([links.nth(i).get_attribute('data-tour') for i in range(links.count())], ['open-in-codex', 'open-in-claude-desktop'])
            self.assertEqual(self.link_query(links.nth(0), 'codex', 'threads/new'), {'path': [folder], 'prompt': [self.ask_text()]})
            self.assertEqual(self.link_query(links.nth(1), 'claude', 'code/new'), {'folder': [folder], 'q': [self.ask_text()]})
            bar = page.locator('[data-tour="tour-bar"]').bounding_box()
            self.assertTrue(bar['x'] >= 0 and bar['x'] + bar['width'] <= width, f'{width} 宽：细栏超出了屏幕：{bar}')
            self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), width, f'{width} 宽：横向滚动了')
            self.assertEqual(self.saved(page)['step'], wait_index, '看气泡不改变走到第几步')
            self.assertEqual(page.errors, [])

    def test_11_add_topic_tip(self):
        """「选题」页的「下一步：加你自己的选题」（2026-10-04 照提示词标准改：不再要用户自己改表格）：
        开场卡摊开时先不出（两个下一步抢），点「我自己看」后出来；「复制给 AI：加选题」复制的是 askAddTopic 那句话，
        同一屏只有一个这个按钮；AI 用 add-topic.mjs 加完，切回工作台（窗口拿到焦点）不点「重新读取」就看到；390 宽不横向滚动"""
        BUTTON = '复制给 AI：加选题'
        ctx, page = self.open()
        page.goto(self.base + '/content?tab=topics')
        self.card_state(page)
        page.wait_for_selector('[data-work="T001"]', timeout=10000)
        self.assertEqual(page.get_by_text('加你自己的选题').count(), 0, '开场卡摊开时不出「加你自己的选题」')
        page.get_by_role('button', name=self.T['card']['later'], exact=True).click()
        tip = page.get_by_text('加你自己的选题')
        tip.wait_for(timeout=4000)
        self.assertEqual(page.get_by_role('button', name=BUTTON).count(), 1, '同一屏只放一个「复制给 AI：加选题」')
        page.get_by_role('button', name=BUTTON).click()
        page.get_by_text('加选题的话已复制').wait_for(timeout=4000)
        self.assertIn('粘贴给 Codex 或 Claude Code', page.inner_text('[data-sonner-toaster]'))
        self.assertEqual(self.clipboard(page), self.T['askTopic'])
        self.assertNotIn(str(self.work), self.T['askTopic'], '那句话不带这台电脑的路径')

        # AI 照写稿 Skill 加了一条（用的就是 Skill 里那条命令）；页面在后台，切回来时自己重新读
        overview = self.work / '选题库' / '00_选题总览.md'
        before = overview.read_text('utf-8')
        self.addCleanup(overview.write_text, before, 'utf-8')
        env = dict(os.environ, HOME=self.home, WORKBENCH_CONFIG_DIR=str(self.config_dir))
        r = subprocess.run([NODE, 'scripts/add-topic.mjs', '--title', '浏览器测试加的选题', '--type', '口播'], cwd=ROOT, env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        card = next((self.work / '选题库' / '口播' / '待做').glob('T00*_浏览器测试加的选题.md'))
        self.addCleanup(card.unlink)
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        new_id = card.name.split('_')[0]
        page.wait_for_selector(f'[data-work="{new_id}"]', timeout=8000)
        page.wait_for_timeout(300)
        self.assertEqual(page.get_by_text('加你自己的选题').count(), 0, '有了两条以后不再出「下一步」')
        self.assertEqual(page.get_by_role('button', name=BUTTON).count(), 1, '页头上还能加')

        ctx2, narrow = self.open(width=390, saved={'status': 'skipped', 'card': 'collapsed'})
        overview.write_text(before, 'utf-8')
        card.rename(card.with_suffix('.md.bak'))
        self.addCleanup(lambda: card.with_suffix('.md.bak').exists() and card.with_suffix('.md.bak').rename(card))
        narrow.goto(self.base + '/content?tab=topics')
        narrow.get_by_text('加你自己的选题').wait_for(timeout=8000)
        self.assertLessEqual(narrow.evaluate('document.documentElement.scrollWidth'), 390, '390 宽：横向滚动了')
        self.assertEqual(page.errors + narrow.errors, [])

if __name__ == '__main__':
    unittest.main()
