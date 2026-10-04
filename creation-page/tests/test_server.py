"""保存服务测试：每个用例用临时目录和随机端口起服务，测完关掉。

运行：cd creation-page && python3 -m unittest discover -s tests -v
（同一条命令也会跑 tests/test_browser.py 的浏览器场景，约 2 分钟；只想跑服务端和命令行测试，加环境变量 JC_SKIP_BROWSER=1。）
前 53 个用例由同步实验的 tests/test_server.py 迁来；GroupTests、ChangesTests、AiStateTests 是这次新增的。
"""
import hashlib, http.client, json, os, re, shutil, stat, subprocess, sys, tempfile, threading, time, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from support import APP, KIT_FILE, ORIG_KIT_PATH, ServerCase, read  # noqa: E402
import brain_save as server  # noqa: E402
import spike_pages as make_pages  # noqa: E402
import simulate_ai  # noqa: E402

SERVER_PY = os.path.join(APP, 'server', 'brain_save.py')


class Base(ServerCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='jc-save-test-')
        self.pages = {p['content_id']: p for p in make_pages.build(self.root)}
        self.start_server(self.root)

    def tearDown(self):
        self.stop_server()
        shutil.rmtree(self.root, ignore_errors=True)

    # ---- 小工具 ----
    def req(self, method, path, body=None, host=None, origin='self', ctype='application/json'):
        headers = {'Host': host or '127.0.0.1:%d' % self.port}
        if origin == 'self':
            headers['Origin'] = 'http://127.0.0.1:%d' % self.port
        elif origin is not None:
            headers['Origin'] = origin
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode('utf-8')
            headers['Content-Type'] = ctype
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        c.request(method, path, body=data, headers=headers)
        r = c.getresponse()
        raw, hdrs = r.read(), {k.lower(): v for k, v in r.getheaders()}
        c.close()
        return r.status, raw, hdrs

    def pid(self, cid='T999'):
        return self.pages[cid]['page_id']

    def path(self, cid='T999'):
        return self.srv.index.lookup(self.pid(cid))[0]

    def doc(self, cid='T999'):
        return server.parse_page(read(self.path(cid)))[1]

    def item(self, cid, item_id):
        return next(it for it in self.doc(cid)['items'] if it['id'] == item_id)

    def change(self, idx, after, field='改写', cid='T999', before=None, group=None):
        it = self.doc(cid)['items'][idx]
        c = {'change_id': make_pages.short(12), 'item_id': it['id'], 'field': field,
             'before': it['fields'][field] if before is None else before, 'after': after, 'item_fp': server.item_fp(it)}
        if group:
            c['group'] = group
        return c

    def save(self, changes, cid='T999', token=True, origin='self'):
        body = {'page_id': self.pid(cid), 'changes': changes}
        if token is True:
            body['token'] = self.pages[cid]['token']
        elif token:
            body['token'] = token
        st, raw, hdrs = self.req('POST', '/save', body, origin=origin)
        return st, json.loads(raw.decode('utf-8')), hdrs

    def versions(self, cid='T999'):
        d = os.path.join(self.root, '.jc-versions', self.pid(cid))
        return sorted(os.listdir(d)) if os.path.isdir(d) else []

    def log_lines(self, cid='T999'):
        p = os.path.join(self.root, '.jc-changes', self.pid(cid) + '.jsonl')
        if not os.path.exists(p):
            return []
        with open(p, encoding='utf-8') as f:
            return [json.loads(x) for x in f]


class SaveTests(Base):
    def test_normal_save(self):
        ch = self.change(0, '用户改的开头')
        st, out, _ = self.save([ch])
        self.assertEqual(st, 200)
        self.assertEqual(out['results'], [{'change_id': ch['change_id'], 'status': 'ok', 'reason': 'written'}])
        self.assertEqual(self.item('T999', ch['item_id'])['fields']['改写'], '用户改的开头')
        self.assertEqual(len(self.versions()), 1)
        log = self.log_lines()
        self.assertEqual((log[0]['item'], log[0]['field'], log[0]['after']), (ch['item_id'], '改写', '用户改的开头'))
        self.assertEqual(log[0]['origin'], 'http://127.0.0.1:%d' % self.port)
        self.assertEqual(out['fingerprint'], hashlib.sha256(read(self.path())).hexdigest())

    def test_resend_is_already(self):
        ch = self.change(0, '只写一次')
        self.save([ch])
        st, out, _ = self.save([ch])
        self.assertEqual((st, out['results'][0]['status'], out['results'][0]['reason']), (200, 'ok', 'already'))
        self.assertEqual(len(self.versions()), 1)
        self.assertEqual(len(self.log_lines()), 1)

    def test_ai_changed_same_cell_conflict(self):
        ch = self.change(0, '用户的版本')
        simulate_ai.edit(self.root, 'T999', ch['item_id'], '改写', 'AI 的版本')
        st, out, _ = self.save([ch])
        r = out['results'][0]
        self.assertEqual((st, r['status'], r['reason'], r['current']), (200, 'conflict', 'changed', 'AI 的版本'))
        self.assertEqual(self.item('T999', ch['item_id'])['fields']['改写'], 'AI 的版本')

    def test_ai_changed_other_cell_both_kept(self):
        ch = self.change(0, '用户改第一条')
        other = self.doc()['items'][1]['id']
        simulate_ai.edit(self.root, 'T999', other, '改写', 'AI 改第二条')
        st, out, _ = self.save([ch])
        self.assertEqual(out['results'][0]['status'], 'ok')
        self.assertEqual(self.item('T999', ch['item_id'])['fields']['改写'], '用户改第一条')
        self.assertEqual(self.item('T999', other)['fields']['改写'], 'AI 改第二条')

    def test_reorder_writes_by_identity(self):
        a, b, c = [it['id'] for it in self.doc()['items']]
        ch = self.change(1, '写给 b 的改动')  # 改的时候 b 在第 2 个位置
        simulate_ai.reorder(self.root, 'T999', delete=a, seed=1)
        ids = [it['id'] for it in self.doc()['items']]
        self.assertEqual(len(ids), 3)
        self.assertNotIn(a, ids)
        self.assertNotEqual(ids[1], b)  # 重排后第 2 个位置换成了别的条目
        st, out, _ = self.save([ch])
        self.assertEqual(out['results'][0]['status'], 'ok')
        self.assertEqual(self.item('T999', b)['fields']['改写'], '写给 b 的改动')
        self.assertNotEqual(self.item('T999', ids[1])['fields']['改写'], '写给 b 的改动')
        self.assertNotEqual(self.item('T999', c)['fields']['改写'], '写给 b 的改动')
        self.assertEqual(self.doc()['items'][0]['fields']['改写'], '')  # 新插入的条目没被误写

    def test_item_gone(self):
        ch = self.change(2, '改一条马上被删的')
        simulate_ai.reorder(self.root, 'T999', delete=ch['item_id'], seed=2)
        st, out, _ = self.save([ch])
        self.assertEqual((out['results'][0]['status'], out['results'][0]['reason']), ('conflict', 'item_gone'))

    def test_item_changed(self):
        ch = self.change(0, '改写的新值')
        simulate_ai.edit(self.root, 'T999', ch['item_id'], '标题', 'AI 改了标题', locked=True)
        st, out, _ = self.save([ch])
        r = out['results'][0]
        self.assertEqual((r['status'], r['reason']), ('conflict', 'item_changed'))
        self.assertNotEqual(self.item('T999', ch['item_id'])['fields']['改写'], '改写的新值')

    def test_rename_still_found_and_saves(self):
        self.assertEqual(self.req('GET', '/p/%s' % self.pid())[0], 200)  # 先让缓存记住旧路径
        ch = self.change(0, '改名后保存')
        simulate_ai.rename(self.root)
        st, raw, _ = self.req('GET', '/p/%s' % self.pid())
        self.assertEqual(st, 200)
        meta = json.loads(self.req('GET', '/p/%s/meta' % self.pid())[1])
        self.assertTrue(meta['path'].startswith('T999_测试稿_改名/'))
        st, out, _ = self.save([ch])
        self.assertEqual(out['results'][0]['status'], 'ok')
        self.assertIn('T999_测试稿_改名', self.path())
        self.assertEqual(self.item('T999', ch['item_id'])['fields']['改写'], '改名后保存')

    def test_mode_kept_and_bytes_outside_doc_unchanged(self):
        p = self.path()
        os.chmod(p, 0o640)
        old = read(p)
        self.save([self.change(0, '只动数据块')])
        new = read(p)
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o640)
        mo, mn = server.DOC_RE_B.search(old), server.DOC_RE_B.search(new)
        self.assertEqual(old[:mo.start(2)], new[:mn.start(2)])
        self.assertEqual(old[mo.end(2):], new[mn.end(2):])
        self.assertNotEqual(old, new)

    def test_versions_keep_latest_20(self):
        for i in range(25):
            st, out, _ = self.save([self.change(0, '第 %d 版' % i)])
            self.assertEqual(out['results'][0]['status'], 'ok')
        self.assertEqual(len(self.versions()), 20)
        self.assertEqual(len(self.log_lines()), 25)

    def _outside_edit(self, idx, value):
        """模拟不拿锁的外部编辑器：直接原地改文件里某一格。"""
        def hook(path):
            calls.append(path)
            if len(calls) == 1:
                text, doc, m = server.parse_page(read(path))
                doc['items'][idx]['fields']['改写'] = value
                with open(path, 'wb') as f:
                    f.write(server.rewrite(text, m, doc))
        calls = []
        server.BEFORE_REPLACE = hook
        return calls

    def test_remerge_when_file_changed_before_replace(self):
        ch = self.change(0, '用户的改动')
        other = self.doc()['items'][1]['id']
        calls = self._outside_edit(1, '外部编辑')
        st, out, _ = self.save([ch])
        self.assertEqual(out['results'][0]['status'], 'ok')
        self.assertEqual(len(calls), 2)  # 第一次替换前发现被改，重新合并后第二次才替换
        self.assertEqual(self.item('T999', ch['item_id'])['fields']['改写'], '用户的改动')
        self.assertEqual(self.item('T999', other)['fields']['改写'], '外部编辑')
        self.assertNotEqual(out['base_fingerprint'], out['fingerprint'])

    def test_remerge_same_cell_becomes_conflict(self):
        ch = self.change(0, '用户的改动')
        self._outside_edit(0, '外部抢先改了同一格')
        st, out, _ = self.save([ch])
        r = out['results'][0]
        self.assertEqual((r['status'], r['reason'], r['current']), ('conflict', 'changed', '外部抢先改了同一格'))
        self.assertEqual(self.item('T999', ch['item_id'])['fields']['改写'], '外部抢先改了同一格')

    def test_newline_and_nfc_no_false_conflict(self):
        iid = self.doc()['items'][0]['id']
        simulate_ai.edit(self.root, 'T999', iid, '改写', '第一行\r\ncafé')  # CRLF + 分解形式的 é
        ch = self.change(0, '新内容', before='第一行\ncafé')  # 浏览器那边是 LF + 合成形式
        st, out, _ = self.save([ch])
        self.assertEqual((out['results'][0]['status'], out['results'][0]['reason']), ('ok', 'written'))
        simulate_ai.edit(self.root, 'T999', iid, '改写', '结尾café\r\n')
        ch2 = self.change(0, '结尾café\n', before='随便什么')
        st, out, _ = self.save([ch2])
        self.assertEqual((out['results'][0]['status'], out['results'][0]['reason']), ('ok', 'already'))

    def test_review_page_radio_and_note(self):
        chs = [self.change(0, '采纳', field='采纳', cid='T998'), self.change(0, '具体场景更好', field='批注', cid='T998')]
        st, out, _ = self.save(chs, cid='T998')
        self.assertEqual([r['status'] for r in out['results']], ['ok', 'ok'])
        it = self.doc('T998')['items'][0]
        self.assertEqual((it['fields']['采纳'], it['fields']['批注']), ('采纳', '具体场景更好'))

    def test_concurrent_saves_all_land(self):
        chs = [self.change(i, '并发 %d' % i) for i in range(3)]
        outs = []
        ts = [threading.Thread(target=lambda c=c: outs.append(self.save([c])[1])) for c in chs]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(sorted(o['results'][0]['status'] for o in outs), ['ok'] * 3)
        self.assertEqual([it['fields']['改写'] for it in self.doc()['items']], ['并发 0', '并发 1', '并发 2'])


class GuardTests(Base):
    def test_bad_host_403(self):
        for host in ('127.0.0.1', 'localhost', 'evil.example:%d' % self.port, '[::1]:%d' % self.port, '127.0.0.1:%d' % (self.port + 1)):
            self.assertEqual(self.req('GET', '/healthz', host=host)[0], 403, host)
        self.assertEqual(self.req('GET', '/healthz', host='localhost:%d' % self.port)[0], 200, 'healthz 两个主机名都能读')
        before = read(self.path())
        st, _, _ = self.req('POST', '/save', {'page_id': self.pid(), 'changes': [self.change(0, 'x')]}, host='localhost:%d' % self.port)
        self.assertEqual(st, 403)
        self.assertEqual(read(self.path()), before)

    def test_bad_origin_403(self):
        for origin in ('http://evil.example', 'http://127.0.0.1:1', 'http://localhost:%d' % self.port, None):
            st, out, _ = self.save([self.change(0, '不该写进去')], origin=origin)
            self.assertEqual(st, 403, origin)
        self.assertEqual(self.log_lines(), [])

    def test_null_origin_needs_token(self):
        st, _, _ = self.save([self.change(0, '没口令')], origin='null', token=None)
        self.assertEqual(st, 403)
        st, _, _ = self.save([self.change(0, '错口令')], origin='null', token='wrong-token')
        self.assertEqual(st, 403)
        st, out, hdrs = self.save([self.change(0, '对口令')], origin='null')
        self.assertEqual((st, out['results'][0]['status']), (200, 'ok'))
        self.assertEqual(hdrs.get('access-control-allow-origin'), 'null')
        self.assertEqual(self.log_lines()[-1]['origin'], 'null')

    def test_content_type_must_be_json(self):
        body = json.dumps({'page_id': self.pid(), 'token': self.pages['T999']['token'], 'changes': [self.change(0, 'x')]})
        st, _, _ = self.req('POST', '/save', body.encode('utf-8'), ctype='text/plain')
        self.assertEqual(st, 415)

    def test_preflight(self):
        st, _, hdrs = self.req('OPTIONS', '/save', origin='null')
        self.assertEqual(st, 204)
        self.assertEqual(hdrs.get('access-control-allow-origin'), 'null')
        self.assertEqual(hdrs.get('access-control-allow-private-network'), 'true')
        self.assertIn('Content-Type', hdrs.get('access-control-allow-headers', ''))
        st, _, hdrs = self.req('OPTIONS', '/save')
        self.assertEqual((st, hdrs.get('access-control-allow-origin')), (204, 'http://127.0.0.1:%d' % self.port))
        self.assertEqual(self.req('OPTIONS', '/save', origin='http://evil.example')[0], 403)

    def test_broken_doc_refused(self):
        p = self.path()
        ch = self.change(0, '不该写进去')
        data = read(p)
        m = server.DOC_RE_B.search(data)
        broken = data[:m.start(2)] + b'\n{"page_id": "' + self.pid().encode() + b'", "items": [\xe5\x9d\x8f\n' + data[m.end(2):]
        with open(p, 'wb') as f:
            f.write(broken)
        st, out, _ = self.save([ch])
        self.assertEqual(st, 422)
        self.assertIn('页面数据', out['error'])
        self.assertEqual(read(p), broken)
        self.assertEqual(self.req('GET', '/p/%s/doc' % self.pid())[0], 422)
        self.assertEqual(self.versions(), [])

    def test_bad_body_400(self):
        st, _, _ = self.req('POST', '/save', {'page_id': self.pid(), 'changes': [{'change_id': 'x'}]})
        self.assertEqual(st, 400)


class PageTests(Base):
    def test_healthz(self):
        st, raw, _ = self.req('GET', '/healthz', origin=None)
        h = json.loads(raw)
        self.assertEqual(st, 200)
        self.assertEqual((h['protocol'], h['pid'], h['root'], h['root_ok'], h['writable']), (1, os.getpid(), self.root, True, True))
        for k in ('service', 'started_at'):
            self.assertTrue(h[k])
        self.assertEqual(h['duplicates'], {})
        self.assertEqual((h['service'], h['features']), ('jc-brain-save', ['group', 'changes', 'template', 'files']))
        self.assertIs(h['read_only'], False)
        self.assertEqual((h['kit_ok'], h['style_ok'], h['app_ok'], h['template_dir']), (True, True, True, os.path.join(APP, 'template')))

    def test_duplicate_page_id_reported(self):
        src = self.path()
        dst = os.path.join(self.root, 'T999_复制品', '对照页.html')
        os.makedirs(os.path.dirname(dst))
        shutil.copy2(src, dst)
        self.srv.index.scan()
        h = json.loads(self.req('GET', '/healthz', origin=None)[1])
        self.assertEqual(list(h['duplicates']), [self.pid()])
        self.assertEqual(len(h['duplicates'][self.pid()]), 2)

    def test_page_serves_current_kit(self):
        kit = os.path.join(self.root, 'kit-new.js')
        with open(kit, 'w', encoding='utf-8') as f:
            f.write('/* 新版 kit 标记 KIT-NEW-42 */ var s = "</script>";\n' + server.KIT_EOF + '\n')
        server.KIT_PATH = kit
        st, raw, hdrs = self.req('GET', '/p/%s' % self.pid(), origin=None)
        page = raw.decode('utf-8')
        self.assertEqual(st, 200)
        self.assertTrue(hdrs['content-type'].startswith('text/html'))
        self.assertIn('KIT-NEW-42', page)
        self.assertIn('<\\/script>', page)  # kit 里的 </script> 被转义，不会截断页面
        self.assertIn('window.JC_SERVED', page)
        self.assertEqual(page.count('<!--jc-kit:start-->'), 1)
        file_text = read(self.path()).decode('utf-8')
        self.assertEqual(page[:page.index('<!--jc-kit:start-->')], file_text[:file_text.index('<!--jc-kit:start-->')])

    def test_not_found(self):
        st, raw, hdrs = self.req('GET', '/p/zzzzzzzz', origin=None)
        self.assertEqual(st, 404)
        self.assertIn('找不到', raw.decode('utf-8'))
        self.assertTrue(hdrs['content-type'].startswith('text/html'))
        self.assertEqual(self.req('GET', '/p/zzzzzzzz/meta', origin=None)[0], 404)

    def test_meta_and_doc(self):
        st, raw, _ = self.req('GET', '/p/%s/meta' % self.pid(), origin=None)
        meta = json.loads(raw)
        self.assertEqual(meta['fingerprint'], hashlib.sha256(read(self.path())).hexdigest())
        self.assertEqual(meta['path'], os.path.join('T999_测试稿', '对照页.html'))
        st, raw, _ = self.req('GET', '/p/%s/doc' % self.pid(), origin=None)
        d = json.loads(raw)
        self.assertEqual((d['doc']['page_id'], d['fingerprint']), (self.pid(), meta['fingerprint']))

    def test_item_fp_matches_kit_js(self):
        """kit.js 里的指纹算法要和 brain_save.item_fp 一致，包括不算 ai_state（有 node 才跑）。"""
        node = shutil.which('node')
        if not node:
            self.skipTest('没有 node')
        js = read(KIT_FILE).decode('utf-8')
        start = js.index('var K = ')
        body = js.index('{', js.index('function itemFp'))
        depth, end = 0, body
        for end in range(body, len(js)):  # 找 itemFp 函数体的结尾（按花括号配对）
            depth += {'{': 1, '}': -1}.get(js[end], 0)
            if depth == 0:
                break
        norm_line = re.search(r'function normS\b.*', js).group(0)
        fns = norm_line + '\n' + js[start:end + 1]
        cases = [{'标题': 'café\r\n标题', '参考原文': '含 "引号" 和 </script> 和 \t 制表符', 'n': 3.0, 'x': [1, None, True]},
                 {'title': '段标题', 'order': 2, 'refs': [{'who': '博主甲', 'text': '原话'}], 'ai_state': {'reply': '改好了', 'handled_note': '短一点'}},
                 {'title': '段标题', 'order': 2, 'refs': [{'who': '博主甲', 'text': '原话'}]}]
        code = fns + '\nprocess.stdout.write(JSON.stringify(%s.map(function (l) { return itemFp({locked: l}); })));' % json.dumps(cases, ensure_ascii=False)
        out = subprocess.run([node, '-e', code], capture_output=True, text=True, timeout=20)
        got = json.loads(out.stdout or 'null')
        self.assertEqual(got, [server.item_fp({'locked': c}) for c in cases], out.stderr)
        self.assertEqual(got[1], got[2])  # ai_state 不算进指纹


class DuplicateTests(Base):
    """同一个页面身份号出现在两份文件里：服务必须能可靠发现，并且拒绝读写，不按扫描顺序挑一份。"""

    def setUp(self):
        super().setUp()
        self.orig = self.path()

    def copy_page(self, rel):
        dst = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(self.orig, dst)
        return dst

    def change_in(self, path, idx, after):
        """有副本时服务的查找会拒绝，改动直接按某份文件的内容拼。"""
        it = server.parse_page(read(path))[1]['items'][idx]
        return {'change_id': make_pages.short(12), 'item_id': it['id'], 'field': '改写', 'before': it['fields']['改写'], 'after': after,
                'item_fp': server.item_fp(it)}

    def test_healthz_reports_duplicate_without_manual_scan(self):
        self.copy_page(os.path.join('T999_测试稿', '对照页_v2.html'))
        self.assertEqual(self.req('GET', '/p/%s' % self.pid(), origin=None)[0], 409)  # 打开页面总是现扫
        h = json.loads(self.req('GET', '/healthz', origin=None)[1])
        self.assertEqual(list(h['duplicates']), [self.pid()])
        self.assertEqual(sorted(h['duplicates'][self.pid()]), [os.path.join('T999_测试稿', '对照页.html'), os.path.join('T999_测试稿', '对照页_v2.html')])

    def test_polls_see_duplicate_within_30_seconds(self):
        self.req('GET', '/p/%s/meta' % self.pid(), origin=None)
        self.copy_page(os.path.join('T999_副本', '对照页.html'))
        self.assertEqual(self.req('GET', '/p/%s/meta' % self.pid(), origin=None)[0], 200)  # 30 秒内的轮询复用上次扫描
        self.srv.index.scanned_at -= server.Index.POLL_MAX_AGE + 1  # 相当于过了 30 秒
        self.assertEqual(self.req('GET', '/p/%s/meta' % self.pid(), origin=None)[0], 409)
        self.assertEqual(list(json.loads(self.req('GET', '/healthz', origin=None)[1])['duplicates']), [self.pid()])

    def test_duplicate_cleared_is_seen_by_next_poll(self):
        dst = self.copy_page(os.path.join('T999_副本', '对照页.html'))
        self.assertEqual(self.req('GET', '/p/%s' % self.pid(), origin=None)[0], 409)  # 打开页面现扫，缓存记下重复
        self.assertEqual(self.req('GET', '/p/%s/meta' % self.pid(), origin=None)[0], 409)
        os.unlink(dst)  # 副本删掉：缓存还记着重复，但报之前会现扫确认
        self.assertEqual(self.req('GET', '/p/%s/meta' % self.pid(), origin=None)[0], 200)
        self.assertEqual(json.loads(self.req('GET', '/healthz', origin=None)[1])['duplicates'], {})

    def test_copy_to_earlier_folder_then_rescan_save_refused(self):
        """复现：先正常保存；AI 把页面复制到排序更靠前的文件夹；一次 404 触发整目录重扫；之后的保存必须被拒，原文件字节不变。"""
        orig = self.orig
        st, out, _ = self.save([self.change(0, '改动一')])
        self.assertEqual((st, out['path']), (200, os.path.join('T999_测试稿', '对照页.html')))
        after_one = read(orig)
        bak = self.copy_page(os.path.join('2026-09-27_备份', '对照页.html'))
        bak_bytes = read(bak)
        ch2 = self.change_in(orig, 0, '改动二')
        st, out, _ = self.save([ch2])
        self.assertEqual(st, 409)
        self.assertEqual(sorted(out['duplicates']), [os.path.join('2026-09-27_备份', '对照页.html'), os.path.join('T999_测试稿', '对照页.html')])
        self.assertIn('2 份文件', out['error'])
        self.assertEqual(self.req('GET', '/p/deletedpage9/meta', origin=None)[0], 404)  # 另一个标签轮询已删页面，触发重扫
        st, raw, _ = self.req('GET', '/p/%s/meta' % self.pid(), origin=None)
        self.assertEqual(st, 409)
        ch3 = dict(ch2, change_id='c3', after='改动三')
        self.assertEqual(self.save([ch3])[0], 409)
        self.assertEqual(read(orig), after_one)  # 原文件停在改动一，一个字节都没变
        self.assertEqual(read(bak), bak_bytes)   # 备份也没被写
        self.assertIn('请求失败 409 POST /save page_id=%s' % self.pid(), self.log.getvalue())

    def test_duplicate_page_meta_doc_all_409(self):
        self.copy_page(os.path.join('T999_副本', '对照页.html'))
        st, raw, hdrs = self.req('GET', '/p/%s' % self.pid(), origin=None)
        page = raw.decode('utf-8')
        self.assertEqual(st, 409)
        self.assertTrue(hdrs['content-type'].startswith('text/html'))
        self.assertIn('T999_副本/对照页.html', page)
        self.assertIn('T999_测试稿/对照页.html', page)
        self.assertNotIn('jc-kit:start', page)  # 不把任何一份当页面给出去
        st, raw, _ = self.req('GET', '/p/%s/meta' % self.pid(), origin='null')
        self.assertEqual(st, 409)
        self.assertEqual(len(json.loads(raw)['duplicates']), 2)
        self.assertEqual(self.req('GET', '/p/%s/doc' % self.pid(), origin=None)[0], 409)

    def test_duplicate_resolved_saves_again(self):
        dst = self.copy_page(os.path.join('T999_副本', '对照页.html'))
        self.assertEqual(self.save([self.change_in(self.orig, 0, '有副本时')])[0], 409)
        os.unlink(dst)
        st, out, _ = self.save([self.change_in(self.orig, 0, '副本删掉之后')])
        self.assertEqual((st, out['results'][0]['status']), (200, 'ok'))

    def test_hidden_versions_dir_is_not_duplicate(self):
        self.save([self.change(0, '留一个版本')])  # 写前会在 .jc-versions 留一份同号的旧版
        self.assertEqual(json.loads(self.req('GET', '/healthz', origin=None)[1])['duplicates'], {})
        self.assertEqual(self.save([self.change(0, '再改一次')])[0], 200)

    def test_meta_same_file(self):
        me = self.orig
        outside = os.path.join(tempfile.mkdtemp(prefix='jc-outside-'), '对照页.html')
        shutil.copy2(me, outside)
        q = lambda f: json.loads(self.req('GET', '/p/%s/meta?file=%s' % (self.pid(), urllib_quote(f)), origin='null')[1])
        self.assertIs(q(me)['same_file'], True)
        self.assertIs(q(outside)['same_file'], False)
        self.assertIs(q('T999_测试稿/对照页.html')['same_file'], False)  # 相对路径不认
        self.assertNotIn('same_file', json.loads(self.req('GET', '/p/%s/meta' % self.pid(), origin=None)[1]))
        shutil.rmtree(os.path.dirname(outside))

    def test_save_with_wrong_self_path_refused(self):
        outside = os.path.join(tempfile.mkdtemp(prefix='jc-outside-'), '对照页.html')
        shutil.copy2(self.path(), outside)
        before = read(self.path())
        body = {'page_id': self.pid(), 'token': self.pages['T999']['token'], 'self_path': outside, 'changes': [self.change(0, '从别处副本写')]}
        st, raw, _ = self.req('POST', '/save', body, origin='null')
        self.assertEqual(st, 409)
        self.assertIn('不是保存服务使用的那一份', json.loads(raw)['error'])
        self.assertEqual(read(self.path()), before)
        body['self_path'] = self.path()
        st, raw, _ = self.req('POST', '/save', body, origin='null')
        self.assertEqual((st, json.loads(raw)['results'][0]['status']), (200, 'ok'))
        shutil.rmtree(os.path.dirname(outside))

    def test_rescan_only_rereads_changed_files(self):
        calls = []
        real = server.read_page
        server.read_page = lambda p: (calls.append(p), real(p))[1]
        try:
            self.srv.index.scan()
            self.assertEqual(calls, [])  # 启动时读过、之后没改过：只 stat 不读
            simulate_ai.edit(self.root, 'T999', 1, '改写', 'AI 改了')
            calls.clear()
            self.srv.index.scan()
            self.assertEqual(calls, [self.orig])  # 只重读改过的那份
        finally:
            server.read_page = real

    def test_simulate_ai_refuses_duplicates(self):
        self.copy_page(os.path.join('T999_副本', '对照页.html'))
        with self.assertRaises(server.PageError) as cm:
            simulate_ai.edit(self.root, self.orig, 1, '改写', 'AI 改')
        self.assertEqual(cm.exception.code, 409)


def urllib_quote(s):
    from urllib.parse import quote
    return quote(s, safe='')


class LogTests(Base):
    """保存失败和内部出错都要在服务日志里留下带时间、页面身份号和原因的一行。"""
    TIME = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} ', re.M)

    def test_failed_saves_logged_with_page_and_reason(self):
        self.save([self.change(0, '错口令')], origin='null', token='wrong-token')
        body = {'page_id': 'nopagezz9', 'token': 'x', 'changes': []}
        self.req('POST', '/save', body)
        log = self.log.getvalue()
        lines = [x for x in log.splitlines() if '请求失败' in x]
        self.assertEqual(len(lines), 2, log)
        for x in lines:
            self.assertRegex(x, self.TIME)
        self.assertIn('请求失败 403 POST /save page_id=%s 原因：口令不对' % self.pid(), lines[0])
        self.assertIn('请求失败 404 POST /save page_id=nopagezz9 原因：找不到页面（页面标识 nopagezz9）', lines[1])

    def test_repeated_failure_logged_once_per_minute(self):
        for _ in range(5):
            self.req('GET', '/p/deletedpage9/meta', origin=None)  # 另一个标签每 3 秒轮询一个已删页面
        lines = [x for x in self.log.getvalue().splitlines() if 'deletedpage9' in x]
        self.assertEqual(len(lines), 1, lines)
        for v in server._fail_seen.values():
            v[0] -= server.FAIL_REPEAT_S + 1  # 相当于过了一分钟
        self.req('GET', '/p/deletedpage9/meta', origin=None)
        lines = [x for x in self.log.getvalue().splitlines() if 'deletedpage9' in x]
        self.assertEqual(len(lines), 2)
        self.assertIn('又出现 4 次', lines[1])

    def test_unhandled_error_returns_500_and_logs_traceback(self):
        real = server.Index.lookup
        def boom(*a, **k): raise RuntimeError('测试用的意外错误')
        server.Index.lookup = boom
        try:
            st, raw, _ = self.req('GET', '/p/%s/meta' % self.pid(), origin=None)
        finally:
            server.Index.lookup = real
        self.assertEqual(st, 500)
        self.assertIn('保存服务内部出错', json.loads(raw)['error'])
        log = self.log.getvalue()
        self.assertRegex(log, self.TIME.pattern + r'服务内部出错 GET /p/%s/meta page_id=%s' % (self.pid(), self.pid()))
        self.assertIn('Traceback', log)
        self.assertIn('测试用的意外错误', log)

    def test_handle_error_outside_handler_has_time(self):
        try:
            raise ValueError('请求头读坏了')
        except ValueError:
            self.srv.handle_error(None, ('127.0.0.1', 1))
        self.assertRegex(self.log.getvalue(), self.TIME.pattern + '处理 127.0.0.1 的请求时出错')


class KitServeTests(Base):
    """kit.js 读不出或被截断时，页面改用文件里自带的 kit，照样能打开能存；healthz 和日志都说明。"""

    def test_kit_js_ends_with_marker(self):
        self.assertEqual(ORIG_KIT_PATH, os.path.join(APP, 'kit', 'kit.js'))  # 服务默认用 creation-page/kit/kit.js
        self.assertTrue(read(ORIG_KIT_PATH).decode('utf-8').rstrip().endswith(server.KIT_EOF))
        self.assertEqual(server.load_kit()[1], '')
        self.assertTrue(json.loads(self.req('GET', '/healthz', origin=None)[1])['kit_ok'])

    def _check_fallback(self, why):
        st, raw, _ = self.req('GET', '/p/%s' % self.pid(), origin=None)
        page = raw.decode('utf-8')
        self.assertEqual(st, 200)
        self.assertIn('window.JC_SERVED', page)
        file_text = read(self.path()).decode('utf-8')
        embedded = file_text[file_text.index('<!--jc-kit:start-->') + len('<!--jc-kit:start-->'):]
        self.assertIn(embedded, page)  # 页面自带的 kit 原样保留
        h = json.loads(self.req('GET', '/healthz', origin=None)[1])
        self.assertEqual((h['kit_ok'], why in h['kit_problem']), (False, True))
        self.assertIn('改用文件里自带的 kit', self.log.getvalue())

    def test_missing_kit_falls_back(self):
        server.KIT_PATH = os.path.join(self.root, '不存在的-kit.js')
        self._check_fallback('读不出 kit.js')

    def test_truncated_kit_falls_back(self):
        kit = os.path.join(self.root, 'kit-cut.js')
        with open(kit, 'w', encoding='utf-8') as f:
            f.write(read(ORIG_KIT_PATH).decode('utf-8')[:20000])
        server.KIT_PATH = kit
        self._check_fallback('结束标记')


class TemplateTests(Base):
    def test_template_turns_off_form_restore_and_waits_for_kit(self):
        t = make_pages.TEMPLATE
        self.assertIn("e.setAttribute('autocomplete', 'off')", t)
        self.assertIn("r.setAttribute('data-item', it.id); r.setAttribute('data-field', k); hold(r);", t)
        self.assertIn("t.setAttribute('data-item', it.id); t.setAttribute('data-field', k); hold(t);", t)
        self.assertIn('保存脚本没有运行', t)

    def test_rerender_keeps_ids_tokens_and_values(self):
        self.save([self.change(0, '重画前改的')])
        old_doc = self.doc()
        p = self.path()
        with open(p, encoding='utf-8') as f:
            text = f.read()
        with open(p, 'w', encoding='utf-8') as f:
            f.write(text.replace("hold(t);", ''))  # 模拟旧模板
        done = make_pages.rerender(self.root)
        self.assertIn(p, done)
        self.assertEqual(self.doc(), old_doc)
        self.assertIn('hold(t);', read(p).decode('utf-8'))


class CliTests(unittest.TestCase):
    def test_cli_starts_and_answers(self):
        root = tempfile.mkdtemp(prefix='jc-save-cli-')
        make_pages.build(root)
        s = __import__('socket').socket()
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
        s.close()
        proc = subprocess.Popen([sys.executable, SERVER_PY, '--port', str(port), '--root', root],
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
            self.assertEqual((h['pid'], h['root'], h['root_ok']), (proc.pid, os.path.abspath(root), True))
        finally:
            proc.terminate()
            proc.wait(timeout=5)
            proc.stdout.close()
            proc.stderr.close()
            shutil.rmtree(root, ignore_errors=True)


class PortBusyTests(Base):
    def _run_second(self):
        return subprocess.run([sys.executable, SERVER_PY, '--port', str(self.port), '--root', self.root],
                              capture_output=True, text=True, encoding='utf-8', timeout=20)

    def test_second_server_explains_who_holds_port(self):
        r = self._run_second()
        self.assertEqual(r.returncode, server.EXIT_PORT_BUSY)
        self.assertRegex(r.stderr, r'^\d{4}-\d{2}-\d{2}T')
        self.assertIn('端口已被别的进程占用', r.stderr)
        self.assertIn('pid=%d' % os.getpid(), r.stderr)  # 占用者（本测试进程里的服务）的 pid
        self.assertIn('root=%s' % self.root, r.stderr)
        self.assertNotIn('Traceback', r.stderr)
        h = json.loads(self.req('GET', '/healthz', origin=None)[1])
        self.assertEqual(h['pid'], os.getpid())  # 原来的服务不受影响


# ---------------- 新增：整组提交、改动记录、ai_state 不进指纹 ----------------
class GroupTests(Base):
    """同一请求里 group 相同的改动全成或全不成（「采纳」要同时写 mine 和 decision）。"""

    def test_group_all_written(self):
        chs = [self.change(0, '采纳', field='采纳', cid='T998', group='g1'), self.change(0, '好', field='批注', cid='T998', group='g1')]
        st, out, _ = self.save(chs, cid='T998')
        self.assertEqual([(r['status'], r['reason']) for r in out['results']], [('ok', 'written'), ('ok', 'written')])
        self.assertEqual([x.get('group') for x in self.log_lines('T998')], ['g1', 'g1'])
        self.assertEqual(len(self.versions('T998')), 1)  # 一次写入，只留一个版本

    def test_group_one_conflict_nothing_written(self):
        a = self.change(0, '用户的新开头', group='adopt')
        b = self.change(1, '用户的第二条', group='adopt')
        simulate_ai.edit(self.root, 'T999', b['item_id'], '改写', 'AI 抢先改了第二条')
        before = read(self.path())
        st, out, _ = self.save([a, b])
        ra, rb = out['results']
        self.assertEqual(st, 200)
        self.assertEqual((ra['status'], ra['reason'], ra['group'], ra['current']), ('conflict', 'group_conflict', 'adopt', a['before']))
        self.assertEqual(ra['item_fp'], a['item_fp'])
        self.assertEqual((rb['status'], rb['reason'], rb['current'], rb['group']), ('conflict', 'changed', 'AI 抢先改了第二条', 'adopt'))
        self.assertEqual(read(self.path()), before)  # 一个字节都没写
        self.assertEqual(self.log_lines(), [])
        self.assertEqual(out['fingerprint'], out['base_fingerprint'])

    def test_failed_group_does_not_block_others(self):
        g_bad = [self.change(0, 'A1', group='A'), self.change(1, 'A2', group='A', before='对不上的改前值')]
        other = self.change(2, '不带组的改动')
        g_ok = [self.change(0, '采纳', field='采纳', cid='T998', group='B')]  # 别的页面不在同一请求里，这里只测同页
        st, out, _ = self.save(g_bad + [other])
        self.assertEqual([r['status'] for r in out['results']], ['conflict', 'conflict', 'ok'])
        self.assertEqual(self.item('T999', other['item_id'])['fields']['改写'], '不带组的改动')
        self.assertNotEqual(self.item('T999', g_bad[0]['item_id'])['fields']['改写'], 'A1')
        self.assertEqual([x['item'] for x in self.log_lines()], [other['item_id']])
        self.assertEqual(self.save(g_ok, cid='T998')[1]['results'][0]['status'], 'ok')

    def test_group_depending_on_failed_group_also_fails(self):
        """B 组的一格要接着 A 组写进去的值改；A 组整组不写后，B 组那一格就对不上，B 组也要整组不写。"""
        items = self.doc()['items']
        v0 = items[0]['fields']['改写']
        a1 = self.change(0, 'v1', group='A')
        a2 = self.change(1, '随便', group='A', before='对不上')
        b1 = dict(self.change(0, 'v2', group='B'), before='v1')
        b2 = self.change(2, 'B 组第二格', group='B')
        before = read(self.path())
        st, out, _ = self.save([a1, a2, b1, b2])
        got = [(r['status'], r['reason']) for r in out['results']]
        self.assertEqual(got, [('conflict', 'group_conflict'), ('conflict', 'changed'), ('conflict', 'changed'), ('conflict', 'group_conflict')])
        self.assertEqual(out['results'][2]['current'], v0)
        self.assertEqual(read(self.path()), before)

    def test_group_with_deleted_item_fails_whole_group(self):
        a = self.change(0, '写不进去', group='g')
        b = self.change(2, '条目被删', group='g')
        simulate_ai.reorder(self.root, 'T999', delete=b['item_id'], seed=3)
        st, out, _ = self.save([a, b])
        self.assertEqual([r['reason'] for r in out['results']], ['group_conflict', 'item_gone'])
        self.assertNotEqual(self.item('T999', a['item_id'])['fields']['改写'], '写不进去')

    def test_group_already_and_written_ok(self):
        a = self.change(0, '已经写过', group='g')
        self.save([dict(a, change_id='first')])
        b = self.change(1, '第二格', group='g')
        st, out, _ = self.save([a, b])
        self.assertEqual([(r['status'], r['reason']) for r in out['results']], [('ok', 'already'), ('ok', 'written')])

    def test_bad_group_type_400(self):
        st, _, _ = self.req('POST', '/save', {'page_id': self.pid(), 'token': self.pages['T999']['token'],
                                              'changes': [dict(self.change(0, 'x'), group=3)]})
        self.assertEqual(st, 400)


class ChangesTests(Base):
    """GET /p/<page_id>/changes?item=<id>：改动记录，给「改动痕迹」用。"""

    def changes(self, query='', origin=None):
        st, raw, hdrs = self.req('GET', '/p/%s/changes%s' % (self.pid(), query), origin=origin)
        return st, json.loads(raw), hdrs

    def test_empty_before_any_save(self):
        st, out, _ = self.changes()
        self.assertEqual((st, out), (200, {'changes': []}))

    def test_all_and_by_item_in_time_order(self):
        i0, i1 = [it['id'] for it in self.doc()['items'][:2]]
        self.save([self.change(0, '第一次')])
        self.save([self.change(1, '别的条目')])
        self.save([self.change(0, '第二次', group='g')])
        st, out, _ = self.changes()
        self.assertEqual([(c['item'], c['after']) for c in out['changes']], [(i0, '第一次'), (i1, '别的条目'), (i0, '第二次')])
        first = out['changes'][0]
        self.assertEqual(set(first), {'time', 'change_id', 'item', 'field', 'before', 'after', 'origin'})
        self.assertEqual(out['changes'][2]['group'], 'g')
        st, out, _ = self.changes('?item=' + i0)
        self.assertEqual([c['after'] for c in out['changes']], ['第一次', '第二次'])
        self.assertEqual(out['changes'][1]['before'], '第一次')
        self.assertEqual(self.changes('?item=nosuchitem')[1], {'changes': []})

    def test_sorted_by_time_and_skips_broken_lines(self):
        p = os.path.join(self.root, '.jc-changes', self.pid() + '.jsonl')
        os.makedirs(os.path.dirname(p), exist_ok=True)
        rows = [{'time': '2026-09-27T10:00:05+08:00', 'change_id': 'c2', 'item': 'x', 'field': 'mine', 'before': 'a', 'after': 'b', 'origin': 'null'},
                {'time': '2026-09-27T10:00:01+08:00', 'change_id': 'c1', 'item': 'x', 'field': 'mine', 'before': '', 'after': 'a', 'origin': 'null'},
                {'time': '2026-09-27T10:00:05+08:00', 'change_id': 'c3', 'item': 'x', 'field': 'note', 'before': '', 'after': 'n', 'origin': 'null'}]
        with open(p, 'w', encoding='utf-8') as f:
            f.write(json.dumps(rows[0], ensure_ascii=False) + '\n{"time": 写了一半\n')
            for r in rows[1:]:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
        st, out, _ = self.changes('?item=x')
        self.assertEqual([c['change_id'] for c in out['changes']], ['c1', 'c2', 'c3'])  # 同一秒内按写入顺序

    def test_file_page_can_read_and_unknown_page_404(self):
        self.save([self.change(0, '改一下')])
        st, out, hdrs = self.changes(origin='null')
        self.assertEqual((st, len(out['changes']), hdrs.get('access-control-allow-origin')), (200, 1, 'null'))
        st, raw, hdrs = self.req('GET', '/p/zzzzzzzz/changes', origin='null')
        self.assertEqual((st, hdrs.get('access-control-allow-origin')), (404, 'null'))
        self.assertIn('找不到页面', json.loads(raw)['error'])

    def test_duplicate_page_changes_409(self):
        dst = os.path.join(self.root, 'T999_副本', '对照页.html')
        os.makedirs(os.path.dirname(dst))
        shutil.copy2(self.path(), dst)
        self.srv.index.scan()
        self.assertEqual(self.changes()[0], 409)


class AiStateTests(Base):
    """locked.ai_state 是 AI 写的状态，不算进条目指纹：AI 写回复时，用户正在改的格子不冲突。"""

    def test_fp_ignores_ai_state_only(self):
        it = {'locked': {'标题': '开头', '参考原文': '原文'}, 'fields': {}}
        fp = server.item_fp(it)
        it['locked']['ai_state'] = {'reply': '改好了', 'handled_note': '短一点'}
        self.assertEqual(server.item_fp(it), fp)
        it['locked']['ai_state']['reply'] = '又改了一次'
        self.assertEqual(server.item_fp(it), fp)
        it['locked']['标题'] = '新开头'
        self.assertNotEqual(server.item_fp(it), fp)

    def test_ai_writes_ai_state_while_user_edits(self):
        ch = self.change(0, '用户正在改的这一格')  # 页面上改的时候记下的指纹
        simulate_ai.edit(self.root, 'T999', ch['item_id'], 'ai_state', {'reply': 'AI 的回复', 'handled_note': ''}, locked=True)
        st, out, _ = self.save([ch])
        self.assertEqual((out['results'][0]['status'], out['results'][0]['reason']), ('ok', 'written'))
        it = self.item('T999', ch['item_id'])
        self.assertEqual((it['fields']['改写'], it['locked']['ai_state']['reply']), ('用户正在改的这一格', 'AI 的回复'))


if __name__ == '__main__':
    unittest.main()
