"""和工作台接上的部分：从工作台的设置里找工作文件夹、内容草稿和回收站；保存服务不把回收站里的旧页面当成同号副本；
生成脚本不写 --out 时把页面放进这条内容的草稿文件夹；where.py 说清东西都在哪，
还说这个对话打开的是不是工作文件夹、能不能读写工作文件夹（写稿 Skill 和调研 Skill 开工第一步看这两行）。
每个用例用自己的临时设置文件夹（WORKBENCH_CONFIG_DIR）和临时工作文件夹，不碰本机真实的设置。"""
import io, json, os, shutil, subprocess, sys, tempfile, threading, unittest
from contextlib import redirect_stdout, redirect_stderr

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from support import APP, ServerCase, free_port, sample  # noqa: E402
import brain_save as bs  # noqa: E402

sys.path.insert(0, APP)
import build_page  # noqa: E402
import creation_doc as cd  # noqa: E402
import where  # noqa: E402


class SettingsCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='jc-wb-')
        self.cfg_dir = os.path.join(self.tmp, '设置')
        self.work = os.path.join(self.tmp, '我的 工作文件夹')
        self.old_env = os.environ.get('WORKBENCH_CONFIG_DIR')
        os.environ['WORKBENCH_CONFIG_DIR'] = self.cfg_dir

    def tearDown(self):
        os.environ['WORKBENCH_CONFIG_DIR'] = self.old_env
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_settings(self, settings):
        os.makedirs(self.cfg_dir, exist_ok=True)
        with open(os.path.join(self.cfg_dir, 'config.json'), 'w', encoding='utf-8') as f:
            f.write(settings if isinstance(settings, str) else json.dumps(settings, ensure_ascii=False))


class SettingsTests(SettingsCase):
    def test_reads_work_folder_and_paths_from_settings(self):
        self.write_settings({'workFolder': self.work, 'paths': {'drafts': '稿子', 'trash': '/tmp/别处的回收站'}, 'ports': {'save': 19977}})
        s = cd.workbench_settings()
        self.assertTrue(s['exists'])
        self.assertEqual(s['work_folder'], self.work)
        self.assertEqual(s['drafts'], os.path.join(self.work, '稿子'))
        self.assertEqual(s['trash'], '/tmp/别处的回收站')
        self.assertEqual(s['writing_method'], os.path.join(self.work, '写稿方法'))
        self.assertEqual(s['save_port'], 19977)
        self.assertEqual(cd.default_origin(), 'http://127.0.0.1:19977')

    def test_defaults_when_workbench_never_ran(self):
        s = cd.workbench_settings()
        self.assertFalse(s['exists'])
        self.assertEqual(s['work_folder'], os.path.join(os.path.expanduser('~'), 'Documents', cd.brand_id()))
        self.assertEqual(s['save_port'], bs.DEFAULT_PORT)
        self.assertEqual(cd.default_origin(), 'http://127.0.0.1:%d' % bs.DEFAULT_PORT)

    def test_tilde_and_bad_values_fall_back(self):
        self.write_settings({'workFolder': '~/某个文件夹', 'paths': {'drafts': 3}, 'ports': {'save': 'x'}})
        s = cd.workbench_settings()
        self.assertEqual(s['work_folder'], os.path.join(os.path.expanduser('~'), '某个文件夹'))
        self.assertEqual(s['drafts'], os.path.join(s['work_folder'], '内容草稿'))
        self.assertEqual(s['save_port'], bs.DEFAULT_PORT)

    def test_broken_settings_file_is_reported(self):
        self.write_settings('{"workFolder": "x",}')
        with self.assertRaises(cd.SettingsError) as ctx:
            cd.workbench_settings()
        self.assertIn('写坏了', str(ctx.exception))
        root, how = cd.resolve_root()
        self.assertIsNone(root)
        self.assertIn('写坏了', how)

    def test_resolve_root_uses_settings_work_folder(self):
        os.makedirs(self.work)
        self.write_settings({'workFolder': self.work})
        self.assertEqual(cd.resolve_root(), (self.work, '工作台设置里的工作文件夹'))
        inside = os.path.join(self.work, '内容草稿', 'T001_x', 'T001_创作页.html')
        self.assertEqual(cd.resolve_root(None, inside)[0], self.work)
        outside = os.path.join(self.tmp, '别处', 'T001_创作页.html')
        self.assertIsNone(cd.resolve_root(None, outside)[0], '页面不在工作文件夹里时不能拿它当根目录')
        self.assertEqual(cd.resolve_root('/somewhere/else')[0], '/somewhere/else', '--root 优先')


class TrashSkipTests(SettingsCase, ServerCase):
    """挪进回收站的旧页面不算同号副本：保存服务（--skip-dir）和 AI 命令（从设置里读回收站）都跳过它。"""

    def setUp(self):
        SettingsCase.setUp(self)
        os.makedirs(self.work)
        self.write_settings({'workFolder': self.work})
        self.page = os.path.join(self.work, '内容草稿', 'T901_测试', 'T901_创作页.html')
        self.pid = build_page.build(sample(), self.page, root=self.work)['page_id']
        trash = os.path.join(self.work, '回收站')
        os.makedirs(trash)
        shutil.copy(self.page, os.path.join(trash, '2026-10-03_T901_创作页.html'))

    def tearDown(self):
        self.stop_server()
        SettingsCase.tearDown(self)

    def test_save_service_skips_trash(self):
        self.start_server(self.work)  # 不带 skip：回收站里那份算同号副本
        with self.assertRaises(bs.PageError) as ctx:
            self.srv.index.lookup(self.pid)
        self.assertEqual(ctx.exception.code, 409)
        self.stop_server()
        self.log = bs.LOG = io.StringIO()
        self.srv = bs.make_server(self.work, 0, skip=[os.path.join(self.work, '回收站')])
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.assertEqual(self.srv.index.lookup(self.pid)[0], self.page)
        self.assertEqual(self.srv.index.dups, {})

    def test_ai_commands_skip_trash_from_settings(self):
        self.assertEqual(cd.skip_dirs(self.work), [os.path.join(self.work, '回收站')])
        self.assertEqual(cd.index_for(self.work).lookup(self.pid)[0], self.page)
        import brain_page
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = brain_page.main(['read', 'T901'])
        self.assertEqual(code, 0, err.getvalue())
        self.assertIn('工作台设置里的工作文件夹', out.getvalue())

    def test_cli_skip_dir_flag(self):
        port = free_port()
        proc = subprocess.Popen([sys.executable, os.path.join(APP, 'server', 'brain_save.py'), '--root', self.work, '--port', str(port),
                                 '--skip-dir', os.path.join(self.work, '回收站')], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            h = None
            for _ in range(40):
                h = cd._healthz(port, 0.5)
                if h: break
                proc.poll()
                if proc.returncode is not None: break
                __import__('time').sleep(0.2)
            self.assertIsNotNone(h, proc.stderr.read().decode('utf-8', 'replace') if proc.returncode is not None else '服务没起来')
            self.assertEqual((h['root'], h['skip'], h['duplicates']), (self.work, [os.path.join(self.work, '回收站')], {}))
        finally:
            proc.terminate()
            proc.wait(timeout=5)
            proc.stdout.close()
            proc.stderr.close()


class FaviconTests(ServerCase):
    """浏览器打开创作页时自己会要 /favicon.ico：回 204，不在页面控制台里留一条 404。"""

    def tearDown(self):
        self.stop_server()

    def test_favicon_is_204_on_both_hosts(self):
        root = tempfile.mkdtemp(prefix='jc-favicon-')
        try:
            self.start_server(root)
            for host in ('127.0.0.1:%d' % self.port, 'localhost:%d' % self.port):
                c = __import__('http.client').client.HTTPConnection('127.0.0.1', self.port, timeout=5)
                c.request('GET', '/favicon.ico', headers={'Host': host})
                r = c.getresponse()
                self.assertEqual((r.status, r.read()), (204, b''), host)
                c.close()
            self.assertNotIn('favicon', self.log.getvalue())
        finally:
            shutil.rmtree(root, ignore_errors=True)


class DefaultOutTests(SettingsCase):
    def setUp(self):
        super().setUp()
        self.write_settings({'workFolder': self.work})
        self.data = os.path.join(self.tmp, 'T901_创作页数据.json')
        with open(self.data, 'w', encoding='utf-8') as f:
            json.dump(sample(), f, ensure_ascii=False)

    def run_build(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = build_page.main([self.data] + list(args))
        return code, out.getvalue(), err.getvalue()

    def test_page_goes_into_the_content_draft_folder(self):
        folder = os.path.join(self.work, '内容草稿', 'T901_AI 是杠杆')
        os.makedirs(folder)
        os.makedirs(os.path.join(self.work, '内容草稿', 'T0201_别的'))  # 编号前缀不同，不算
        code, out, err = self.run_build()
        self.assertEqual(code, 0, err)
        page = os.path.join(folder, 'T901_创作页.html')
        self.assertTrue(os.path.isfile(page))
        self.assertIn('已生成创作页：%s' % page, out)
        self.assertIn('保存服务现在没在运行', out)

    def test_no_or_several_folders_refused(self):
        code, out, err = self.run_build()
        self.assertEqual(code, 1)
        self.assertIn('没有 T901 开头的文件夹', err)
        os.makedirs(os.path.join(self.work, '内容草稿', 'T901_一'))
        os.makedirs(os.path.join(self.work, '内容草稿', 'T901_二'))
        code, out, err = self.run_build()
        self.assertEqual(code, 1)
        self.assertIn('有 2 个 T901 开头的文件夹', err)

    def test_new_page_uses_settings_save_port(self):
        self.write_settings({'workFolder': self.work, 'ports': {'save': 19977}})
        os.makedirs(os.path.join(self.work, '内容草稿', 'T901_x'))
        data = sample()
        del data['service_origin']
        with open(self.data, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
        code, out, err = self.run_build()
        self.assertEqual(code, 0, err)
        doc = bs.parse_page(bs.read_page(os.path.join(self.work, '内容草稿', 'T901_x', 'T901_创作页.html'))[0])[1]
        self.assertEqual(doc['service_origin'], 'http://127.0.0.1:19977')


class WhereTests(SettingsCase, ServerCase):
    def tearDown(self):
        self.stop_server()
        SettingsCase.tearDown(self)

    def test_where_lists_places_and_the_page(self):
        os.makedirs(self.work)
        folder = os.path.join(self.work, '内容草稿', 'T901_测试')
        page = os.path.join(folder, 'T901_创作页.html')
        pid = build_page.build(sample(), page, root=self.work)['page_id']
        self.start_server(self.work)
        self.write_settings({'workFolder': self.work, 'ports': {'save': self.port}})
        info = where.collect('T901')
        self.assertEqual((info['work_folder'], info['drafts']), (self.work, os.path.join(self.work, '内容草稿')))
        self.assertEqual(info['service'], {'running': True, 'origin': 'http://127.0.0.1:%d' % self.port, 'port': self.port})
        self.assertEqual(info['content']['draft_dirs'], [folder])
        self.assertEqual(info['content']['pages'], [{'path': page, 'page_id': pid, 'url': 'http://127.0.0.1:%d/p/%s' % (self.port, pid)}])
        text = where.show(info)
        self.assertIn('保存服务：正在运行', text)
        self.assertIn('页面链接：http://127.0.0.1:%d/p/%s' % (self.port, pid), text)

    def test_where_without_page_or_service(self):
        self.write_settings({'workFolder': self.work, 'ports': {'save': 1025}})
        os.makedirs(os.path.join(self.work, '内容草稿'))
        text = where.show(where.collect('T005'))
        self.assertIn('T005 的草稿文件夹：还没有', text)
        self.assertIn('保存服务：没在运行', text)



class HereTests(SettingsCase):
    """where.py 的「当前打开的文件夹」和「读写」两行：用户常在装工作台的那个对话（开在仓库文件夹）里让 AI 写稿，
    AI 要先看出来、说一句，能读写工作文件夹就照常按工作文件夹的完整路径做，读写不了就停下。"""

    def setUp(self):
        super().setUp()
        os.makedirs(os.path.join(self.work, '内容草稿'))
        self.write_settings({'workFolder': self.work})
        self.other = os.path.join(self.tmp, 'jincheng-workbench')  # 像装工作台时那个对话开着的仓库文件夹
        os.makedirs(self.other)
        self.locked = []

    def tearDown(self):
        for folder in self.locked:  # 改回能读写，临时文件夹才删得掉
            os.chmod(folder, 0o755)
        super().tearDown()

    def lock(self, folder, mode):
        os.chmod(folder, mode)
        self.locked.append(folder)

    def assertNoProbeLeft(self, folder):
        self.assertEqual([n for n in os.listdir(folder) if n.startswith('.jc-write-check-')], [], '查完能不能写，临时文件要删掉')

    def test_opened_the_work_folder(self):
        info = where.collect(here=self.work)
        self.assertEqual(info['here'], {'path': self.work, 'relation': 'same'})
        self.assertEqual(info['access'], {'checked': True, 'problems': []})
        text = where.show(info)
        self.assertIn('当前打开的文件夹：%s（就是工作文件夹）' % self.work, text)
        self.assertIn('读写：工作文件夹能读能写', text)
        self.assertNoProbeLeft(self.work)

    def test_sandbox_blocks_local_ports(self):
        """AI 工具的沙箱（Codex 默认）不让命令连本机端口：保存服务说「查不了」，不说「没在运行」（2026-10-03 真跑时发现会误报）"""
        import errno, http.client
        from unittest import mock
        def refuse(*a, **k):
            raise PermissionError(errno.EPERM, 'Operation not permitted')
        with mock.patch.object(http.client.HTTPConnection, 'request', refuse):
            info = where.collect(here=self.work)
        self.assertEqual(info['service'], {'running': False, 'blocked': True})
        text = where.show(info)
        self.assertIn('保存服务：查不了', text)
        self.assertNotIn('保存服务：没在运行', text)

    def test_opened_a_folder_inside_it(self):
        inside = os.path.join(self.work, '内容草稿')
        self.assertEqual(where.collect(here=inside)['here']['relation'], 'inside')
        self.assertIn('（在工作文件夹里面）', where.show(where.collect(here=inside)))

    def test_opened_another_folder_but_can_write(self):
        """开在仓库文件夹：说不是工作文件夹、按工作文件夹的完整路径写；能读写，AI 照常做，不叫用户新开对话"""
        info = where.collect(here=self.other)
        self.assertEqual(info['here']['relation'], 'outside')
        text = where.show(info)
        self.assertIn('当前打开的文件夹：%s（不是工作文件夹' % self.other, text)
        self.assertIn('按这里打印的完整路径写进工作文件夹', text)
        self.assertNotIn('新开一个对话', text)
        self.assertIn('工作文件夹：%s' % self.work, text)
        self.assertIn('读写：工作文件夹能读能写', text)
        self.assertEqual(os.listdir(self.other), [], '不往当前打开的文件夹里写东西')
        self.assertNoProbeLeft(self.work)

    def test_parent_folder_is_not_the_work_folder(self):
        self.assertEqual(where.collect(here=self.tmp)['here']['relation'], 'outside')

    def test_symlink_to_the_work_folder_counts(self):
        link = os.path.join(self.tmp, '链接')
        os.symlink(self.work, link)
        self.assertEqual(where.collect(here=link)['here']['relation'], 'same')
        self.assertEqual(where.collect(here=os.path.join(link, '内容草稿'))['here']['relation'], 'inside')

    @unittest.skipIf(hasattr(os, 'geteuid') and os.geteuid() == 0, 'root 不受文件权限限制')
    def test_cannot_write_the_work_folder(self):
        """写不了（比如 Codex 的沙箱只许写打开的文件夹）：说写不了；先用 AI 工具自己的办法申请权限，申请不了再叫用户新开对话"""
        self.lock(self.work, 0o555)
        info = where.collect(here=self.other)
        self.assertEqual(len(info['access']['problems']), 1)
        self.assertTrue(info['access']['problems'][0].startswith('工作文件夹写不了'), info['access'])
        text = where.show(info)
        self.assertIn('读写：工作文件夹写不了', text)
        self.assertIn('先别写任何文件。先用你这个 AI 工具自己的办法申请写工作文件夹的权限', text)
        self.assertIn('申请不了，再请用户新开一个对话，打开工作文件夹', text)
        # 开的就是工作文件夹也写不了：多半是这个对话只能读（Codex 里没用 Git 管的文件夹默认只读），请用户允许改文件，不叫他新开对话
        text = where.show(where.collect(here=self.work))
        self.assertIn('现在只能读文件', text)
        self.assertIn('申请改文件的权限', text)
        self.assertNotIn('新开一个对话', text)

    @unittest.skipIf(hasattr(os, 'geteuid') and os.geteuid() == 0, 'root 不受文件权限限制')
    def test_cannot_read_the_work_folder(self):
        self.lock(self.work, 0o000)
        problems = where.collect(here=self.other)['access']['problems']
        self.assertEqual(len(problems), 1)
        self.assertTrue(problems[0].startswith('工作文件夹读不了'), problems)
        # 开的就是工作文件夹却读不了：多半是 macOS 的隐私设置没允许这个 AI 工具
        text = where.show(where.collect(here=self.work))
        self.assertIn('隐私与安全性', text)
        self.assertNotIn('新开一个对话', text)

    @unittest.skipIf(hasattr(os, 'geteuid') and os.geteuid() == 0, 'root 不受文件权限限制')
    def test_drafts_outside_the_work_folder_are_checked_too(self):
        drafts = os.path.join(self.tmp, '别处的草稿')
        os.makedirs(drafts)
        self.write_settings({'workFolder': self.work, 'paths': {'drafts': drafts}})
        self.assertEqual(where.collect(here=self.work)['access']['problems'], [])
        self.lock(drafts, 0o555)
        problems = where.collect(here=self.work)['access']['problems']
        self.assertEqual(len(problems), 1)
        self.assertTrue(problems[0].startswith('内容草稿写不了'), problems)

    def test_work_folder_missing_skips_the_check(self):
        shutil.rmtree(self.work)
        info = where.collect(here=self.other)
        self.assertEqual(info['access'], {'checked': False, 'problems': []})
        text = where.show(info)
        self.assertIn('（还没有：在后台启动一次工作台就会建好，pnpm --dir', text)
        self.assertIn('start --background）', text)
        self.assertNotIn('读写：', text)

    def test_command_line_uses_the_folder_it_runs_in(self):
        """真的跑命令：不传参数时，当前打开的文件夹就是运行命令时所在的文件夹（AI 在对话里跑命令就在它打开的文件夹）"""
        env = dict(os.environ, WORKBENCH_CONFIG_DIR=self.cfg_dir, PYTHONDONTWRITEBYTECODE='1')
        script = os.path.join(APP, 'where.py')
        r = subprocess.run([sys.executable, script], cwd=self.other, env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('（不是工作文件夹', r.stdout)
        r = subprocess.run([sys.executable, script, '--json'], cwd=self.work, env=env, capture_output=True, text=True)
        info = json.loads(r.stdout)
        self.assertEqual(info['here']['relation'], 'same')
        self.assertEqual(os.path.realpath(info['here']['path']), os.path.realpath(self.work))
        self.assertEqual(info['access']['problems'], [])


if __name__ == '__main__':
    unittest.main()
