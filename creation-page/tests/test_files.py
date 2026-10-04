"""保存服务的 /f/（只读提供根目录下的任意文件）、页面顶上的横幅、--read-only 只读实例、healthz 给本机页面读。

每个用例用临时根目录和随机端口起服务，测完关掉；不碰真实工作文件夹，不碰 8878、8879、8888、8890、8977、8978、18977。
"""
import errno, hashlib, http.client, json, os, shutil, socket, subprocess, sys, tempfile, time, unittest
from urllib.parse import quote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from support import APP, ServerCase, read  # noqa: E402
import brain_save as bs  # noqa: E402
import spike_pages as make_pages  # noqa: E402

SERVER_PY = os.path.join(APP, 'server', 'brain_save.py')
BANNER_ID = b'id="jc-file-banner"'


def ent(text):
    """横幅里的中文按字符引用写，测试里按同样写法找。"""
    return bs._ascii_html(text).encode('ascii')


class FilesBase(ServerCase):
    READ_ONLY = False

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='jc-files-')
        self.root = os.path.join(self.tmp, '工作文件夹')
        os.makedirs(self.root)
        self.outside = os.path.join(self.tmp, '库外')
        os.makedirs(self.outside)
        self.pages = {p['content_id']: p for p in make_pages.build(self.root)}
        self.start_server(self.root, read_only=self.READ_ONLY)

    def tearDown(self):
        self.stop_server()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, rel, data):
        p = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'wb') as f:
            f.write(data if isinstance(data, bytes) else data.encode('utf-8'))
        return p

    def get(self, path, headers=None, host=None):
        """默认按来源隔离的规矩选 Host：/f/ 用 localhost，其余用 127.0.0.1。"""
        h = {'Host': host or ('localhost:%d' if path.startswith('/f/') else '127.0.0.1:%d') % self.port}
        h.update(headers or {})
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        c.putrequest('GET', path, skip_host=True, skip_accept_encoding=True)  # 路径原样发出，不让客户端替我们规范化
        for k, v in h.items():
            c.putheader(k, v)
        c.endheaders()
        r = c.getresponse()
        raw, hdrs = r.read(), {k.lower(): v for k, v in r.getheaders()}
        c.close()
        return r.status, raw, hdrs

    def f(self, rel, **kw):
        return self.get('/f/' + quote(rel), **kw)


class PathTests(FilesBase):
    def test_serves_file_and_relative_links(self):
        self.write('交付物/T903_示例网页/index.html', '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head>'
                   '<body><img src="图/封面 1.png"><script src="app.js"></script></body></html>')
        self.write('交付物/T903_示例网页/styles.css', 'body{color:red}')
        self.write('交付物/T903_示例网页/app.js', 'console.log(1)')
        png = b'\x89PNG\r\n\x1a\n' + bytes(range(256))
        self.write('交付物/T903_示例网页/图/封面 1.png', png)
        st, raw, hdrs = self.f('交付物/T903_示例网页/index.html')
        self.assertEqual(st, 200)
        self.assertEqual(hdrs['content-type'], 'text/html; charset=utf-8')
        self.assertNotIn(BANNER_ID, raw, '纯阅读页不加横幅')
        self.assertEqual(raw, read(os.path.join(self.root, '交付物/T903_示例网页/index.html')))
        # 浏览器按页面地址解析相对链接：同目录的样式、脚本，子目录里带空格和中文的图片
        self.assertEqual(self.f('交付物/T903_示例网页/styles.css')[2]['content-type'], 'text/css; charset=utf-8')
        self.assertEqual(self.f('交付物/T903_示例网页/app.js')[2]['content-type'], 'text/javascript; charset=utf-8')
        st, raw, hdrs = self.f('交付物/T903_示例网页/图/封面 1.png')
        self.assertEqual((st, raw, hdrs['content-type'], hdrs['accept-ranges']), (200, png, 'image/png', 'bytes'))
        self.assertEqual(hdrs['x-content-type-options'], 'nosniff')

    def test_md_txt_csv_json_types(self):
        for rel, ctype in (('a/说明.md', 'text/plain'), ('a/b.txt', 'text/plain'), ('a/c.csv', 'text/csv'), ('a/d.json', 'application/json')):
            self.write(rel, '中文')
            st, raw, hdrs = self.f(rel)
            self.assertEqual((st, hdrs['content-type'], raw.decode('utf-8')), (200, ctype + '; charset=utf-8', '中文'), rel)

    def test_rejects_traversal_and_bad_paths(self):
        self.write('a/ok.html', '<p>ok</p>')
        with open(os.path.join(self.outside, 'secret.html'), 'w') as f:
            f.write('<p>库外</p>')
        cases = [
            ('/f/../库外/secret.html', 400), ('/f/a/../../库外/secret.html', 400), ('/f/%2e%2e/%E5%BA%93%E5%A4%96/secret.html', 400),
            ('/f/a/%2E%2E/%2E%2E/%E5%BA%93%E5%A4%96/secret.html', 400), ('/f/./a/ok.html', 400), ('/f/a//ok.html', 400),
            ('/f/', 400), ('/f//etc/hosts', 400), ('/f/%2Fetc%2Fhosts', 400), ('/f/a%5Cok.html', 400), ('/f/a/ok.html%00.png', 400),
            ('/f/%ff%fe.html', 400), ('/f/a/', 400),
        ]
        for path, code in cases:
            st, raw, hdrs = self.get(quote(path, safe='/%.'))  # 只把中文编码，「..」「%2e」这些原样发出
            self.assertEqual(st, code, path)
            self.assertTrue(hdrs['content-type'].startswith('text/html'), path)
            self.assertNotIn('<p>库外</p>'.encode(), raw, path)
        self.assertEqual(self.get('/f/a/ok.html')[0], 200)

    def test_rejects_hidden_dirs_and_node_modules(self):
        for rel in ('.trash/2026-09-27_旧页.html', '.jc-versions/abcd/1.html', '.obsidian/workspace.json', 'a/.草稿.html',
                    'a/node_modules/x/index.js', 'a/Node_Modules/x.js'):
            self.write(rel, '<p>藏起来的</p>')
            st, raw, _ = self.f(rel)
            self.assertEqual(st, 403, rel)
            self.assertIn('隐藏目录'.encode(), raw, rel)

    def test_symlinks(self):
        with open(os.path.join(self.outside, 'secret.html'), 'w') as f:
            f.write('<p>库外</p>')
        os.makedirs(os.path.join(self.root, 'a'))
        os.symlink(os.path.join(self.outside, 'secret.html'), os.path.join(self.root, 'a', '外链.html'))
        os.symlink(self.outside, os.path.join(self.root, 'a', '外面的目录'))
        self.write('.trash/藏.html', '<p>藏</p>')
        os.symlink(os.path.join(self.root, '.trash', '藏.html'), os.path.join(self.root, 'a', '指进回收站.html'))
        self.write('b/真的.html', '<p>真</p>')
        os.symlink(os.path.join(self.root, 'b', '真的.html'), os.path.join(self.root, 'a', '库内链接.html'))
        self.assertEqual(self.f('a/外链.html')[0], 403)
        self.assertEqual(self.f('a/外面的目录/secret.html')[0], 403)
        st, raw, _ = self.f('a/指进回收站.html')
        self.assertEqual(st, 403)
        self.assertIn('隐藏目录'.encode(), raw)
        self.assertEqual(self.f('a/库内链接.html')[:2], (200, b'<p>\xe7\x9c\x9f</p>'), '指向库内普通文件的快捷方式照常给')

    def test_missing_dir_and_unlisted_types(self):
        self.write('a/脚本.py', 'print(1)')
        self.write('a/配置.env', 'KEY=1')
        self.assertEqual(self.f('a/没有.html')[0], 404)
        self.assertEqual(self.f('a')[0], 404)
        self.assertEqual(self.f('a/脚本.py')[0], 403)
        self.assertEqual(self.f('a/配置.env')[0], 403)

    def test_bad_host_refused(self):
        self.write('a/ok.html', '<p>ok</p>')
        self.assertEqual(self.get('/f/a/ok.html', host='evil.example:80')[0], 403)


class BannerTests(FilesBase):
    def check(self, rel, content, banner):
        p = self.write(rel, content)
        before = read(p)
        st, raw, _ = self.f(rel)
        self.assertEqual(st, 200, rel)
        self.assertEqual(BANNER_ID in raw, banner, rel)
        self.assertEqual(read(p), before, '文件本身一个字节都不动')
        return raw

    def test_storage_page_gets_yellow_banner_after_body(self):
        raw = self.check('内容草稿/T904_示例教程/T904_参考核对页.html',
                         '<!doctype html><html><head><script>var tpl = "<body>";</script></head>'
                         '<body class="page"><h1>核对</h1><script>localStorage.setItem("k", "v")</script></body></html>', True)
        self.assertIn(ent(bs.BANNER_BROWSER_ONLY), raw)
        head, rest = raw.split(b'<body class="page">', 1)
        self.assertNotIn(BANNER_ID, head, '脚本字符串里的 <body> 不算')
        self.assertTrue(rest.startswith(bs.banner_html(bs.BANNER_BROWSER_ONLY)), '横幅紧跟在 <body> 后面，只用 ASCII 写')

    def test_session_storage_and_indexeddb(self):
        self.check('a/s.html', '<body><script>sessionStorage.x = 1</script></body>', True)
        self.check('a/i.html', '<body><script>indexedDB.open("x")</script></body>', True)

    def test_input_forms(self):
        self.check('a/textarea.html', '<body><textarea></textarea></body>', True)
        self.check('a/editable.html', '<body><div contenteditable="true">改我</div></body>', True)
        self.check('a/checkbox.html', '<body><input type="checkbox"> 做完了</body>', True)
        self.check('a/text.html', '<body><input id="reply" placeholder="你的回应"></body>', True)
        self.check('a/js-built.html', '<body><script>el.innerHTML = \'<textarea class="mine"></textarea>\'</script></body>', True)

    def test_reading_pages_without_banner(self):
        self.check('a/plain.html', '<!doctype html><title>报告</title><body><h1>调研报告</h1><p>正文</p></body>', False)
        self.check('a/search.html', '<body><input id="search" type="search" placeholder="搜索标题"><select id="author"></select></body>', False)
        self.check('a/filter.html', '<body><input id="q" aria-label="搜索画面" placeholder="搜索火箭"><select></select></body>', False)
        self.check('a/buttons.html', '<body><input type="button" value="下一页"><input type="hidden" name="x"><input type="file" hidden></body>', False)
        self.check('a/not-editable.html', '<body><div contenteditable="false">只读</div></body>', False)

    def test_local_script_counts_hidden_and_remote_do_not(self):
        self.write('a/app.js', 'localStorage.setItem("x", 1)')
        self.check('a/uses-app.html', '<body><script type="module" src="app.js?v=2"></script></body>', True)
        self.write('.trash/old.js', 'localStorage.x = 1')
        self.check('a/uses-hidden.html', '<body><script src="../.trash/old.js"></script></body>', False)
        self.check('a/uses-cdn.html', '<body><script src="https://cdn.example/lib.js"></script><script src="//cdn.example/x.js"></script></body>', False)

    def test_no_body_tag_banner_still_inside_document(self):
        raw = self.check('a/bare.html', '<!DOCTYPE html>\n<textarea></textarea>', True)
        self.assertTrue(raw.startswith(b'<!DOCTYPE html><div id="jc-file-banner"'))
        raw = self.check('a/head-only.html', '<html><head><title>x</title></head><textarea></textarea>', True)
        self.assertIn(b'</head><div id="jc-file-banner"', raw)

    def test_non_utf8_page_gets_no_charset_and_ascii_banner(self):
        gbk = '<html><head><meta charset="gbk"></head><body><textarea>中文</textarea></body></html>'.encode('gbk')
        p = self.write('a/gbk.html', gbk)
        st, raw, hdrs = self.f('a/gbk.html')
        self.assertEqual((st, hdrs['content-type']), (200, 'text/html'))
        self.assertIn(ent(bs.BANNER_BROWSER_ONLY), raw)
        self.assertEqual(raw.replace(bs.banner_html(bs.BANNER_BROWSER_ONLY), b''), read(p))

    def test_synced_page_redirects_to_fixed_address(self):
        page = self.pages['T999']
        st, raw, hdrs = self.f(os.path.relpath(page['path'], self.root))
        self.assertEqual((st, hdrs['location']), (302, 'http://127.0.0.1:%d/p/%s' % (self.port, page['page_id'])), '固定网址在 127.0.0.1 上，写完整地址')
        st, raw, _ = self.get('/p/' + page['page_id'])
        self.assertEqual(st, 200)
        self.assertNotIn(BANNER_ID, raw, '可写实例里接入同步的页面不加横幅')


class RangeTests(FilesBase):
    def setUp(self):
        super().setUp()
        self.video = bytes(range(256)) * 40  # 10240 字节
        self.write('交付物/片子/成片.mp4', self.video)
        self.rel = '交付物/片子/成片.mp4'

    def test_full_and_ranges(self):
        st, raw, hdrs = self.f(self.rel)
        self.assertEqual((st, raw, hdrs['content-type'], hdrs['accept-ranges'], hdrs['content-length']), (200, self.video, 'video/mp4', 'bytes', '10240'))
        for rng, (a, b) in (('bytes=0-9', (0, 9)), ('bytes=10000-', (10000, 10239)), ('bytes=-40', (10200, 10239)), ('bytes=5000-99999', (5000, 10239))):
            st, raw, hdrs = self.f(self.rel, headers={'Range': rng})
            self.assertEqual(st, 206, rng)
            self.assertEqual(raw, self.video[a:b + 1], rng)
            self.assertEqual(hdrs['content-range'], 'bytes %d-%d/10240' % (a, b), rng)
            self.assertEqual(hdrs['content-length'], str(b - a + 1), rng)

    def test_unsatisfiable_and_ignored(self):
        st, _, hdrs = self.f(self.rel, headers={'Range': 'bytes=10240-'})
        self.assertEqual((st, hdrs['content-range']), (416, 'bytes */10240'))
        self.assertEqual(self.f(self.rel, headers={'Range': 'bytes=-0'})[0], 416)
        for rng in ('bytes=0-1,5-6', 'items=0-1', 'bytes=9-3'):
            st, raw, _ = self.f(self.rel, headers={'Range': rng})
            self.assertEqual((st, len(raw)), (200, 10240), rng)

    def test_client_disconnect_mid_file_not_logged_as_error(self):
        big = self.write('交付物/片子/大.mp4', b'\0' * (4 * 1024 * 1024))
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        c.request('GET', '/f/' + quote(os.path.relpath(big, self.root)), headers={'Host': 'localhost:%d' % self.port})
        r = c.getresponse()
        r.read(1000)
        c.close()  # 读了一点就断开：像拖动视频进度条
        time.sleep(0.3)
        self.assertEqual(self.f(self.rel)[0], 200, '服务照常工作')
        self.assertNotIn('服务内部出错', self.log.getvalue())


class HealthzTests(FilesBase):
    def test_loopback_pages_can_read_healthz(self):
        st, raw, hdrs = self.get('/healthz', headers={'Origin': 'http://127.0.0.1:8890'})
        self.assertEqual((st, hdrs.get('access-control-allow-origin')), (200, 'http://127.0.0.1:8890'))
        h = json.loads(raw)
        self.assertIn('files', h['features'])
        self.assertEqual((h['read_only'], h['writable']), (False, True))
        self.assertEqual(self.get('/healthz', headers={'Origin': 'http://localhost:3000'})[2].get('access-control-allow-origin'), 'http://localhost:3000')
        for origin in ('https://evil.example', 'http://127.0.0.1.evil.example:8890', 'http://192.168.1.2:8890'):
            self.assertNotIn('access-control-allow-origin', self.get('/healthz', headers={'Origin': origin})[2], origin)

    def test_other_endpoints_stay_closed_to_other_ports(self):
        st, _, hdrs = self.get('/p/%s/doc' % self.pages['T999']['page_id'], headers={'Origin': 'http://127.0.0.1:8890'})
        self.assertEqual(st, 200)
        self.assertNotIn('access-control-allow-origin', hdrs, '含口令的数据不给别的端口的页面读')


class HostIsolationTests(FilesBase):
    """来源隔离：/f/ 只在 localhost 上给，/p/、/save、/changes、/doc 只认 127.0.0.1，/healthz 两个都能读。
    /f/ 页面里的脚本（来源是 http://localhost:端口）拿不到口令、写不进接入同步页面的格子。"""

    def ip(self): return '127.0.0.1:%d' % self.port
    def name(self): return 'localhost:%d' % self.port

    def change_body(self, token=True):
        """一条完全对得上的改动（指纹、改前值都对），用来说明被拒只是因为来源和主机名。"""
        page = self.pages['T999']
        doc = bs.parse_page(read(self.srv.index.lookup(page['page_id'])[0]))[1]
        it = doc['items'][0]
        change = {'change_id': 'c-iso', 'item_id': it['id'], 'field': '改写', 'before': it['fields']['改写'], 'after': '不该写进去',
                  'item_fp': bs.item_fp(it)}
        body = {'page_id': page['page_id'], 'changes': [change]}
        if token: body['token'] = page['token']
        return json.dumps(body, ensure_ascii=False).encode('utf-8')

    def send(self, method, path, host, headers=None, body=None, addr='127.0.0.1'):
        h = {'Host': host}
        h.update(headers or {})
        c = http.client.HTTPConnection(addr, self.port, timeout=10)
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        raw, hdrs = r.read(), {k.lower(): v for k, v in r.getheaders()}
        c.close()
        return r.status, raw, hdrs

    def test_files_only_on_localhost(self):
        self.write('交付物/报告/总结 1.html', '<p>总结</p>')
        path = '/f/' + quote('交付物/报告/总结 1.html') + '?v=2'
        st, raw, hdrs = self.send('GET', path, self.ip())
        self.assertEqual((st, hdrs['location']), (302, 'http://%s%s' % (self.name(), path)), '127.0.0.1 上的 /f/ 换到 localhost 的同一路径，编码和查询串原样')
        self.assertEqual(self.send('GET', path, self.name())[:2], (200, '<p>总结</p>'.encode()))
        for host in ('evil.example:%d' % self.port, '[::1]:%d' % self.port, 'localhost', 'LOCALHOST:%d' % self.port):
            self.assertEqual(self.send('GET', path, host)[0], 403, host)

    def test_pages_and_data_only_on_127(self):
        pid = self.pages['T999']['page_id']
        for sub in ('', '/meta', '/doc', '/changes', '/changes?item=x'):
            self.assertEqual(self.send('GET', '/p/%s%s' % (pid, sub), self.ip())[0], 200, sub)
            st, raw, hdrs = self.send('GET', '/p/%s%s' % (pid, sub), self.name())
            self.assertEqual(st, 403, sub)
            self.assertNotIn(self.pages['T999']['token'].encode(), raw, '口令一个字都不给')
            self.assertNotIn('access-control-allow-origin', hdrs, sub)
        st, raw, hdrs = self.send('GET', '/p/' + pid, self.name())
        self.assertTrue(hdrs['content-type'].startswith('text/html'), '在浏览器里打开的页面给一句人话')
        self.assertIn(('http://127.0.0.1:%d/p/%s' % (self.port, pid)).encode(), raw, '告诉他换哪个地址')
        self.assertEqual(self.send('GET', '/', self.name())[0], 403, 'localhost 上只有 /f/ 和 /healthz')
        for host in (self.ip(), self.name()):
            st, raw, _ = self.send('GET', '/healthz', host, {'Origin': 'http://' + self.name()})
            h = json.loads(raw)
            self.assertEqual((st, h['origin'], h['files_origin']), (200, 'http://' + self.ip(), 'http://' + self.name()), host)

    def test_cross_origin_write_refused(self):
        """模拟 /f/ 页面里的脚本想改接入同步页面的格子：每一条路都被拒，文件一个字节都不变，也不记改动。"""
        page = self.pages['T999']
        path = self.srv.index.lookup(page['page_id'])[0]
        before = read(path)
        local = 'http://' + self.name()
        # 1. 同源写：/f/ 页面的脚本往自己所在的 localhost 发 /save
        st, raw, _ = self.send('POST', '/save', self.name(), {'Origin': local, 'Content-Type': 'application/json'}, self.change_body())
        self.assertEqual(st, 403, raw)
        # 2. 跨源写：往 127.0.0.1 发，浏览器会带 Origin: http://localhost:端口；先问的预检也不放行
        st, _, hdrs = self.send('OPTIONS', '/save', self.ip(), {'Origin': local, 'Access-Control-Request-Method': 'POST'})
        self.assertEqual(st, 403)
        self.assertNotIn('access-control-allow-origin', hdrs)
        for ctype in ('application/json', 'text/plain'):  # text/plain 是浏览器不用预检就能发的写法
            st, raw, hdrs = self.send('POST', '/save', self.ip(), {'Origin': local, 'Content-Type': ctype}, self.change_body())
            self.assertEqual(st, 403, (ctype, raw))
            self.assertNotIn('access-control-allow-origin', hdrs)
        # 3. 读口令：跨源读 /doc 没有放行头，浏览器不给脚本看；同源读 localhost 上的 /doc 直接 403
        st, raw, hdrs = self.send('GET', '/p/%s/doc' % page['page_id'], self.ip(), {'Origin': local})
        self.assertEqual(st, 200)
        self.assertNotIn('access-control-allow-origin', hdrs, '含口令的数据不给 localhost 来源读')
        for sub in ('meta', 'changes'):
            self.assertNotIn('access-control-allow-origin', self.send('GET', '/p/%s/%s' % (page['page_id'], sub), self.ip(), {'Origin': local})[2], sub)
        # 4. 沙箱框架里来源是 null：不带口令写不进去（口令拿不到，见上）
        st, _, _ = self.send('POST', '/save', self.ip(), {'Origin': 'null', 'Content-Type': 'application/json'}, self.change_body(token=False))
        self.assertEqual(st, 403)
        self.assertEqual(read(path), before)
        self.assertFalse(os.path.exists(os.path.join(self.root, '.jc-changes')), '没有记任何改动')
        # 对照：127.0.0.1 来源、带口令的 null 都能写
        st, out, _ = self.send('POST', '/save', self.ip(), {'Origin': 'http://' + self.ip(), 'Content-Type': 'application/json'}, self.change_body())
        self.assertEqual((st, json.loads(out)['results'][0]['status']), (200, 'ok'))

    def test_listens_on_ipv6_loopback_too(self):
        """localhost 可能先解析到 ::1：同一端口在 ::1 上也有这个服务，规则完全一样。"""
        if self.srv.twin is None:
            self.skipTest('本机没有 IPv6 回环地址：%s' % self.srv.listen_problem)
        self.assertEqual(json.loads(self.get('/healthz')[1])['listen'], ['127.0.0.1', '::1'])
        self.write('a/v6.html', '<p>v6</p>')
        self.assertEqual(self.send('GET', '/f/a/v6.html', self.name(), addr='::1')[:2], (200, b'<p>v6</p>'))
        self.assertEqual(self.send('GET', '/p/%s/meta' % self.pages['T999']['page_id'], self.name(), addr='::1')[0], 403)
        self.assertEqual(self.send('GET', '/p/%s/meta' % self.pages['T999']['page_id'], self.ip(), addr='::1')[0], 200)
        self.assertEqual(self.send('GET', '/healthz', '[::1]:%d' % self.port, addr='::1')[0], 403, '[::1] 这个主机名不认')


class Ipv6BusyTests(unittest.TestCase):
    """::1 上同一端口被别的程序占着：固定端口不启动（退出码 3，日志说清），随机端口换一个再试。"""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='jc-files-v6-')
        self.blocker = None
        for _ in range(20):  # 挑一个 127.0.0.1 上空着的端口号，在 ::1 上把同一个号占住
            probe = socket.socket()
            probe.bind(('127.0.0.1', 0))
            self.port = probe.getsockname()[1]
            probe.close()
            try:
                self.blocker = socket.socket(socket.AF_INET6)
                self.blocker.bind(('::1', self.port))
                self.blocker.listen(1)
                break
            except OSError as e:
                self.blocker.close()
                self.blocker, err = None, e
                if e.errno != errno.EADDRINUSE: break
        if self.blocker is None:
            shutil.rmtree(self.root, ignore_errors=True)
            self.skipTest('本机没有 IPv6 回环地址：%s' % err)

    def tearDown(self):
        self.blocker.close()
        shutil.rmtree(self.root, ignore_errors=True)

    def test_fixed_port_refused(self):
        with self.assertRaises(OSError) as cm:
            bs.make_server(self.root, self.port)
        self.assertEqual((cm.exception.errno, cm.exception.host), (errno.EADDRINUSE, '::1'))
        s = socket.socket()
        s.bind(('127.0.0.1', self.port))  # 127.0.0.1 上那个也已经放掉了
        s.close()

    def test_cli_exits_3_with_reason(self):
        r = subprocess.run([sys.executable, SERVER_PY, '--port', str(self.port), '--root', self.root], capture_output=True, text=True,
                           encoding='utf-8', timeout=30)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn('[::1]:%d 端口已被别的进程占用' % self.port, r.stderr)
        self.assertIn('localhost 可能先解析到 ::1', r.stderr)

    def test_random_port_retries(self):
        calls, orig = [], bs.Server

        class FirstPick(orig):  # 让系统第一次「挑中」::1 上被占的那个号，看它会不会换一个
            def __init__(s, addr, handler):
                addr = (addr[0], self.port) if not calls else addr
                calls.append(addr[1])
                super().__init__(addr, handler)
        bs.Server = FirstPick
        try:
            srv = bs.make_server(self.root, 0)
        finally:
            bs.Server = orig
        try:
            self.assertEqual(calls[0], self.port)
            self.assertEqual(len(calls), 2, '换了一次端口')
            self.assertNotEqual(srv.port, self.port)
            self.assertIsNotNone(srv.twin)
        finally:
            srv.server_close()


class ReadOnlyTests(FilesBase):
    READ_ONLY = True

    def snapshot(self):
        out = {}
        for dp, dns, fns in os.walk(self.root):
            for fn in fns + dns:
                p = os.path.join(dp, fn)
                out[os.path.relpath(p, self.root)] = hashlib.sha256(read(p)).hexdigest() if os.path.isfile(p) else 'dir'
        return out

    def test_every_write_refused_and_nothing_written(self):
        before = self.snapshot()
        page = self.pages['T999']
        doc = bs.parse_page(read(self.srv.index.lookup(page['page_id'])[0]))[1]
        it = doc['items'][0]
        change = {'change_id': 'c1', 'item_id': it['id'], 'field': '改写', 'before': it['fields']['改写'], 'after': '只读实例里改的',
                  'item_fp': bs.item_fp(it)}
        body = json.dumps({'page_id': page['page_id'], 'token': page['token'], 'changes': [change]}, ensure_ascii=False).encode('utf-8')
        for path, origin, ctype in (('/save', 'http://127.0.0.1:%d' % self.port, 'application/json'), ('/save', 'null', 'application/json'),
                                    ('/other', 'http://127.0.0.1:%d' % self.port, 'text/plain'), ('/save', None, 'application/json')):
            headers = {'Host': '127.0.0.1:%d' % self.port, 'Content-Type': ctype}
            if origin: headers['Origin'] = origin
            c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
            c.request('POST', path, body=body, headers=headers)
            r = c.getresponse()
            data = json.loads(r.read())
            c.close()
            self.assertEqual((r.status, data['error']), (403, bs.READ_ONLY_MSG), (path, origin))
        self.assertEqual(self.snapshot(), before, '只读实例不写任何文件（没有锁、版本、改动记录）')
        for hidden in ('.jc-locks', '.jc-versions', '.jc-changes'):
            self.assertFalse(os.path.exists(os.path.join(self.root, hidden)), hidden)

    def test_healthz_and_pages(self):
        h = json.loads(self.get('/healthz')[1])
        self.assertEqual((h['read_only'], h['writable']), (True, False))
        st, raw, _ = self.get('/p/' + self.pages['T999']['page_id'])
        self.assertEqual(st, 200)
        self.assertIn(ent(bs.BANNER_READ_ONLY), raw, '接入同步的页面在只读实例里也要先说清楚改动不会存回文件')
        self.write('a/storage.html', '<body><script>localStorage.x=1</script></body>')
        self.assertIn(ent(bs.BANNER_BROWSER_ONLY), self.f('a/storage.html')[1])


class CliReadOnlyTests(unittest.TestCase):
    def test_cli_read_only_flag(self):
        root = tempfile.mkdtemp(prefix='jc-files-cli-')
        pages = make_pages.build(root)
        s = socket.socket()
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
        s.close()
        proc = subprocess.Popen([sys.executable, SERVER_PY, '--port', str(port), '--root', root, '--read-only'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline, h = time.time() + 8, None
            while time.time() < deadline and h is None:
                try:
                    c = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
                    c.request('GET', '/healthz', headers={'Host': '127.0.0.1:%d' % port})
                    h = json.loads(c.getresponse().read())
                    c.close()
                except OSError:
                    time.sleep(0.2)
            self.assertIsNotNone(h, '服务没起来')
            self.assertEqual((h['pid'], h['read_only'], h['writable']), (proc.pid, True, False))
            c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            c.request('POST', '/save', body=b'{}', headers={'Host': '127.0.0.1:%d' % port, 'Origin': 'http://127.0.0.1:%d' % port,
                                                            'Content-Type': 'application/json'})
            r = c.getresponse()
            self.assertEqual((r.status, json.loads(r.read())['error']), (403, bs.READ_ONLY_MSG))
            c.close()
            self.assertFalse(os.path.exists(os.path.join(root, '.jc-locks')))
            self.assertEqual(len(pages), 2)
        finally:
            proc.terminate()
            proc.wait(timeout=5)
            err = proc.stderr.read().decode('utf-8', 'replace')
            proc.stdout.close()
            proc.stderr.close()
            shutil.rmtree(root, ignore_errors=True)
        self.assertIn('只读预览：不写任何文件', err)


if __name__ == '__main__':
    unittest.main()
