"""build_page.py 测试：生成单文件、重新生成按身份号保留用户的改动、数据和模板不合格时拒绝并说明原因。

大部分用例用 tests/fixtures 里的最小模板和 kit 替身（不随界面代码变）；RealTemplateTests 用 template/ 和 kit/ 里的真东西。
"""
import json, os, re, shutil, subprocess, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from support import APP, FIX_KIT, FIX_TEMPLATE, KIT_FILE, ServerCase, get, post, read, sample  # noqa: E402
import brain_save as bs  # noqa: E402
import build_page  # noqa: E402
import brain_page  # noqa: E402
import creation_doc as cd  # noqa: E402

BUILD_PY = os.path.join(APP, 'build_page.py')
EXTERNAL = re.compile(r'\b(?:src|href)\s*=\s*["\']?\s*(?:https?:)?//|url\(\s*["\']?\s*(?:https?:)?//|@import|<link\b', re.I)


class Base(ServerCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='jc-build-test-')
        self.root = os.path.join(self.tmp, 'brain')
        self.out = os.path.join(self.root, '内容草稿', 'T901_测试', 'T901_创作页.html')

    def tearDown(self):
        self.stop_server()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def build(self, data=None, **kw):
        kw.setdefault('template_dir', FIX_TEMPLATE)
        kw.setdefault('kit_path', FIX_KIT)
        kw.setdefault('root', self.root)
        return build_page.build(sample() if data is None else data, self.out, **kw)

    def doc(self):
        return bs.parse_page(read(self.out))[1]

    def kinds(self, doc, kind):
        return cd.items_of(doc, kind)

    def refused(self, data, *needles, **kw):
        with self.assertRaises(build_page.BuildError) as cm:
            self.build(data, **kw)
        msg = str(cm.exception)
        for n in needles:
            self.assertIn(n, msg)
        return msg

    def jc_save(self, item, field, after, group=None):
        """模拟用户在页面上改一格：按文件当前值和指纹提交给保存服务。"""
        it = next(x for x in self.doc()['items'] if x['id'] == item)
        c = {'change_id': cd.short(12), 'item_id': item, 'field': field, 'before': it['fields'][field], 'after': after, 'item_fp': bs.item_fp(it)}
        if group:
            c['group'] = group
        st, out = post(self.port, {'page_id': self.doc()['page_id'], 'changes': [c]})
        self.assertEqual((st, out['results'][0]['status']), (200, 'ok'), out)
        return out


class GenerateTests(Base):
    def test_single_file_structure(self):
        r = self.build()
        self.assertTrue(r['created'])
        text = read(self.out).decode('utf-8')
        doc = self.doc()
        self.assertEqual(doc, r['doc'])
        for k in ('{{TITLE}}', '{{STYLE}}', '{{KIT}}', '{{APP}}'):
            self.assertNotIn(k, text)
        self.assertIn('这里故意写上 {{DOC}}', text)  # 界面脚本里的字样没有被二次替换
        self.assertIn("window.__fixtureApp = '<\\/script>'", text)  # 界面脚本里的 </script 被转义
        self.assertEqual((text.count('<!--jc-kit:start-->'), text.count('<!--jc-kit:end-->')), (1, 1))
        self.assertIn('<title>T901 AI是我们普通人最值得抓住的杠杆</title>', text)
        self.assertIsNone(EXTERNAL.search(text))
        self.assertEqual(text.count('id="jc-doc"'), 1)
        # 页面级键
        self.assertEqual({k: doc[k] for k in ('content_id', 'kind', 'schema')}, {'content_id': 'T901', 'kind': '创作页', 'schema': 1})
        self.assertTrue(bs.ID_OK.fullmatch(doc['page_id']) and len(doc['page_id']) == 10)
        self.assertTrue(doc['token'])
        self.assertEqual(doc['service_origin'], sample()['service_origin'])
        # 条目
        info = doc['items'][0]
        self.assertEqual((info['kind'], info['id'][:5]), ('info', 'info-'))
        self.assertEqual(info['locked']['type'], '口播')
        self.assertEqual(info['locked']['narrative']['audience'], '想抓住 AI 的普通人')
        self.assertEqual(info['fields'], {'overall_note': '', 'approved': '', 'recorded': ''})
        segs, sugs = self.kinds(doc, 'segment'), self.kinds(doc, 'suggestion')
        self.assertEqual([s['locked']['order'] for s in segs], [1, 2, 3])
        self.assertTrue(all(s['id'].startswith('seg-') and s['locked']['ai_state'] == {} for s in segs))
        self.assertEqual(set(segs[0]['fields']), {'mine', 'note'})
        self.assertEqual(segs[0]['locked']['refs'][0]['who'], '博主甲')
        self.assertEqual([g['locked']['segment'] for g in sugs], [s['id'] for s in segs])  # 序号换成了段落 id
        self.assertTrue(all(g['id'].startswith('sug-') and g['fields'] == {'proposed': g['fields']['proposed'], 'decision': ''} for g in sugs))
        self.assertEqual(sugs[1]['locked']['source'], 'AI')  # 没写来源默认 AI
        self.assertEqual(sugs[1]['locked']['verdict'], '待你定')
        self.assertEqual(len({it['id'] for it in doc['items']}), len(doc['items']))

    def test_given_ids_kept_and_segment_by_id(self):
        d = sample()
        d['segments'][0]['id'] = 'open-hook'
        d['suggestions'][0]['segment'] = 'open-hook'
        d['suggestions'][0]['id'] = 'my-sug-1'
        self.build(d)
        doc = self.doc()
        self.assertEqual(self.kinds(doc, 'segment')[0]['id'], 'open-hook')
        g = next(x for x in doc['items'] if x['id'] == 'my-sug-1')
        self.assertEqual(g['locked']['segment'], 'open-hook')

    def test_script_close_in_data_does_not_break_page(self):
        d = sample()
        d['segments'][2]['mine'] = '结尾</script><script>alert(1)</script>结束'
        d['suggestions'].pop()
        self.build(d)
        text = read(self.out).decode('utf-8')
        self.assertNotIn('alert(1)</script>', text)
        self.assertEqual(self.kinds(self.doc(), 'segment')[2]['fields']['mine'], d['segments'][2]['mine'])

    def test_check_only_does_not_write(self):
        r = self.build(check_only=True)
        self.assertFalse(os.path.exists(self.out))
        self.assertTrue(r['doc']['items'])

    def test_page_id_option_for_new_page(self):
        """新建时可以沿用指定的身份号（旧页面移走后重建，旧地址继续能用）；根目录下已有同号页面、或重新生成时换号，都拒绝。"""
        r = self.build(page_id='hm9u4a3ha8')
        self.assertEqual((r['created'], self.doc()['page_id']), (True, 'hm9u4a3ha8'))
        other = os.path.join(self.root, '内容草稿', 'T901_另一份', 'T901_创作页.html')
        with self.assertRaises(build_page.BuildError) as cm:
            build_page.build(sample(), other, root=self.root, template_dir=FIX_TEMPLATE, kit_path=FIX_KIT, page_id='hm9u4a3ha8')
        self.assertIn('已经被', str(cm.exception))
        self.assertFalse(os.path.exists(other))
        self.refused(brain_page.export_data(self.doc()), '不能换成 --page-id', page_id='zzzz9999zz')
        self.build(brain_page.export_data(self.doc()), page_id='hm9u4a3ha8')  # 同号重新生成：照常
        with self.assertRaises(build_page.BuildError) as cm:
            build_page.build(sample(), other, root=self.root, template_dir=FIX_TEMPLATE, kit_path=FIX_KIT, page_id='有 空格')
        self.assertIn('--page-id', str(cm.exception))

    def test_served_page_saves(self):
        self.build()
        self.start_server(self.root)
        pid = self.doc()['page_id']
        st, raw, _ = get(self.port, '/p/' + pid)
        self.assertEqual(st, 200)
        self.assertIn('window.JC_SERVED', raw.decode('utf-8'))
        seg = self.kinds(self.doc(), 'segment')[0]
        self.jc_save(seg['id'], 'mine', '用户在服务版页面上改的')
        self.assertEqual(self.kinds(self.doc(), 'segment')[0]['fields']['mine'], '用户在服务版页面上改的')


class RegenerateTests(Base):
    def setUp(self):
        super().setUp()
        self.build()
        self.start_server(self.root)
        d = self.doc()
        self.pid, self.token = d['page_id'], d['token']
        self.info = cd.info_of(d)['id']
        self.segs = [s['id'] for s in self.kinds(d, 'segment')]
        self.sugs = [g['id'] for g in self.kinds(d, 'suggestion')]

    def exported(self):
        return brain_page.export_data(self.doc())

    def test_keeps_user_edits_by_identity(self):
        s1, s2, s3 = self.segs
        g1 = self.sugs[0]
        self.jc_save(s1, 'mine', '用户改过的开头：我觉得AI真的是我们普通人最值得抓住的杠杆，因为回头看转行做视频的这一年半，跟做梦一样。')
        self.jc_save(s2, 'note', '第二段再短一点')
        self.jc_save(self.info, 'overall_note', '整体节奏再快一点')
        self.jc_save(self.info, 'approved', '2026-09-27T10:00:00+08:00')
        self.jc_save(self.info, 'recorded', '录完的定稿')
        self.jc_save(g1, 'proposed', '回头看转行的这一年半')
        self.jc_save(g1, 'decision', '不采纳')
        page = brain_page.locate(self.out, self.root)
        brain_page.cmd_reply(page, s2, '已经缩短到两句')
        data = self.exported()
        data['stage'] = '审稿'
        data['segments'][0]['title'] = '开头（改了标题）'
        data['segments'][0]['mine'] = 'AI 想塞进来的新稿子'  # 应被忽略：我的版本只归用户
        data['segments'][1]['baseline'] = '新的底稿'
        data['segments'].append({'title': '新加的一段', 'role': '补充', 'mine': '新加的一段正文。'})
        data['suggestions'].append({'segment': 4, 'category': '表达', 'original': '新加的一段正文', 'proposed': '新段正文',
                                    'reason': '更短', 'basis': {'type': 'AI 自己的判断', 'text': ''}})
        r = self.build(data)
        self.assertFalse(r['created'])
        doc = self.doc()
        self.assertEqual((doc['page_id'], doc['token'], cd.info_of(doc)['id']), (self.pid, self.token, self.info))
        info = cd.info_of(doc)
        self.assertEqual(info['fields'], {'overall_note': '整体节奏再快一点', 'approved': '2026-09-27T10:00:00+08:00', 'recorded': '录完的定稿'})
        self.assertEqual(info['locked']['stage'], '审稿')
        segs = {s['id']: s for s in self.kinds(doc, 'segment')}
        self.assertTrue(segs[s1]['fields']['mine'].startswith('用户改过的开头'))
        self.assertEqual(segs[s1]['locked']['title'], '开头（改了标题）')
        self.assertEqual(segs[s2]['fields']['note'], '第二段再短一点')
        self.assertEqual(segs[s2]['locked']['baseline'], '新的底稿')
        self.assertEqual(segs[s2]['locked']['ai_state']['reply'], '已经缩短到两句')  # AI 写的状态也接回来
        self.assertEqual(len(segs), 4)
        new_seg = self.kinds(doc, 'segment')[3]
        self.assertTrue(new_seg['id'].startswith('seg-'))
        g = next(x for x in doc['items'] if x['id'] == g1)
        self.assertEqual(g['fields'], {'proposed': '回头看转行的这一年半', 'decision': '不采纳'})
        self.assertEqual(self.kinds(doc, 'suggestion')[-1]['locked']['segment'], new_seg['id'])
        self.assertTrue(any('mine' in w and '保留页面上的' in w for w in r['warnings']), r['warnings'])
        self.assertTrue(os.listdir(os.path.join(self.root, '.jc-versions', self.pid)))  # 写前留了版本
        # 服务照样认这个页面，新指纹下还能存
        self.jc_save(s1, 'mine', '重新生成之后再改')

    def test_rebuild_same_data_is_noop(self):
        before = read(self.out)
        r = self.build(self.exported())
        self.assertTrue(r.get('unchanged'))
        self.assertEqual(read(self.out), before)

    def test_missing_items_refused_unless_drop_missing(self):
        before = read(self.out)
        msg = self.refused(sample(), '在新数据里找不到', '--drop-missing', 'brain_page.py export')
        for i in self.segs:
            self.assertIn(i, msg)
        self.assertEqual(read(self.out), before)
        r = self.build(sample(), drop_missing=True)
        doc = self.doc()
        self.assertEqual(doc['page_id'], self.pid)
        self.assertFalse(set(self.segs) & {s['id'] for s in self.kinds(doc, 'segment')})
        self.assertTrue(any('--drop-missing' in w for w in r['warnings']))

    def test_suggestion_original_checked_against_kept_mine(self):
        s1 = self.segs[0]
        self.jc_save(s1, 'mine', '用户整句重写了开头，原来那句没了。')
        data = self.exported()
        r = self.build(data)  # 已有建议对不上：只提醒
        self.assertTrue(any('采纳按钮会变灰' in w for w in r['warnings']), r['warnings'])
        data = self.exported()
        data['segments'][0]['mine'] = '回头看转行做视频的这一年半'  # 数据里有，但页面上的我的版本里没有
        data['suggestions'].append({'segment': s1, 'category': '拗口', 'original': '回头看转行做视频的这一年半', 'proposed': 'x',
                                    'reason': 'y', 'basis': {'type': 'AI 自己的判断', 'text': ''}})
        self.refused(data, '找不到', '必须恰好出现一次')

    def test_content_id_mismatch_and_broken_file_refused(self):
        d = self.exported()
        d['content_id'] = 'T902'
        self.refused(d, '多半是路径写错了')
        with open(self.out, 'w', encoding='utf-8') as f:
            f.write('<html>jc-doc 被人删掉了</html>')
        self.refused(sample(), '读不出它的 jc-doc')

    def test_retries_when_file_changes_before_replace(self):
        """重新生成替换前，保存服务刚好写进用户的一格（模拟没拿锁的写入）：要重读重新合并，用户那一格不丢。"""
        s1 = self.segs[0]
        calls = []

        def hook(path):
            calls.append(path)
            if len(calls) == 1:
                text, doc, m = bs.parse_page(read(path))
                next(x for x in doc['items'] if x['id'] == s1)['fields']['mine'] = '替换前一刻用户写进来的'
                with open(path, 'wb') as f:
                    f.write(bs.rewrite(text, m, doc))
        bs.BEFORE_REPLACE = hook
        data = self.exported()
        data['title'] = '新标题'
        self.build(data)
        self.assertEqual(len(calls), 2)
        doc = self.doc()
        self.assertEqual(next(x for x in doc['items'] if x['id'] == s1)['fields']['mine'], '替换前一刻用户写进来的')
        self.assertEqual(cd.info_of(doc)['locked']['title'], '新标题')

    def test_root_found_via_service_or_locks(self):
        data = self.exported()
        data['title'] = '换个标题'
        shutil.rmtree(os.path.join(self.root, '.jc-locks'), ignore_errors=True)
        self.refused(data, '找不到工作文件夹', root=None)  # 服务地址没人听、也没有 .jc-locks
        data['service_origin'] = 'http://127.0.0.1:%d' % self.port
        shutil.rmtree(os.path.join(self.root, '.jc-locks'), ignore_errors=True)
        self.refused(data, '找不到工作文件夹', root=None)  # 旧页面里写的还是那个没人听的地址
        os.makedirs(os.path.join(self.root, '.jc-locks'))
        self.build(data, root=None)  # 往上找到 .jc-locks
        shutil.rmtree(os.path.join(self.root, '.jc-locks'))
        data['title'] = '再换一次'
        self.build(data, root=None)  # 这次旧页面写的是测试服务的地址：问服务要根目录
        self.assertEqual(cd.info_of(self.doc())['locked']['title'], '再换一次')


class ValidationTests(Base):
    CASES = [
        (lambda d: d.pop('title'), '缺少 title'),
        (lambda d: d.update(type='短视频'), 'type 必须是'),
        (lambda d: d.update(stage='发布'), 'stage 必须是'),
        (lambda d: d['narrative'].update(story=''), '口播的 narrative.story'),
        (lambda d: d.update(speech_rate=0), 'speech_rate'),
        (lambda d: d.update(service_origin='http://localhost:18977'), 'service_origin 必须是'),
        (lambda d: d.update(segments=[]), 'segments 必须是至少有一段'),
        (lambda d: d['segments'][1].pop('mine'), '第 2 段「第一件事」缺少 mine'),
        (lambda d: d['segments'][0].update(title=''), '第 1 段缺少 title'),
        (lambda d: [s.update(id='same-id') for s in d['segments'][:2]], "id 'same-id' 和第 1 段"),
        (lambda d: d['segments'][0].update(id='3'), '纯数字'),
        (lambda d: d['segments'][0].update(id='有空格 的id'), '只能用字母'),
        (lambda d: d['segments'][0]['refs'][0].update(source_type='视频'), 'source_type 必须是'),
        (lambda d: d['segments'][0]['refs'][0].update(url='ftp://x'), '链接必须'),
        (lambda d: d['suggestions'][0].update(original='我的版本里没有这句'), '找不到，必须恰好出现一次'),
        (lambda d: d['segments'][0].update(mine=d['segments'][0]['mine'] + '回头看转行做视频的这一年半'), '出现了 2 次'),
        (lambda d: d['suggestions'][0].update(category='节奏'), 'category 必须是'),
        (lambda d: d['suggestions'][0].update(segment=9), '一共只有 3 段'),
        (lambda d: d['suggestions'][0].update(segment='seg-不存在'), '找不到对应段落'),
        (lambda d: d['suggestions'][0].update(basis={'type': '直觉', 'text': ''}), 'basis 必须是'),
        (lambda d: d['suggestions'][0].pop('reason'), '缺少 reason'),
        (lambda d: d['suggestions'][0].update(verdict='要改'), 'verdict 必须是'),
        (lambda d: d['suggestions'][0].pop('proposed'), '缺少 proposed（改成，删掉整句时写空字符串）'),
        (lambda d: d['suggestions'][0].update(proposed=None), 'proposed（改成）必须是文字（要删掉整句就写空字符串）'),
        (lambda d: d['segments'][0]['refs'][0].update(role='主参考'), 'role（角色）必须是 对标、补充参考、效果样例 之一'),
        (lambda d: d['segments'][0]['refs'][0].update(video='/Volumes/x/视频.mp4'), 'video（本地原片）：必须是相对页面文件的路径'),
        (lambda d: d['segments'][0]['refs'][0].update(video='https://example.com/video/1'), 'video（本地原片）：必须是相对页面文件的路径'),
    ]

    def refnote_data(self):
        """样例数据第 1 段加一家参考，配一条合格的参考分析和骨架对照。"""
        d = sample()
        seg = d['segments'][0]
        seg['refs'][0]['time'] = '0:00 到 0:10'
        seg['refs'].append({'who': '另一家', 'source_type': '口播原话', 'time': '0:03 到 0:12', 'text': '要说年轻人现在该抓住什么，我的答案是 AI 这个杠杆，没有之一。'})
        d['suggestions'][0]['id'] = 'sug-a'
        d['items'] = [
            {'id': 'rn-1', 'kind': 'refnote', 'locked': {'segment': 1, 'summary': '两家都说 AI 是杠杆；另一家多一句「没有之一」。',
             'points': [{'tag': '引入', 'say': '都说 AI 是最值得抓住的杠杆', 'cover': '共性', 'who': ['博主甲', '另一家'],
                         'quotes': [{'who': '博主甲', 'time': '0:01', 'text': '最值得抓住的杠杆'}, {'who': '另一家', 'time': '0:04', 'text': '我的答案是 AI 这个杠杆'}]}],
             'borrow': [{'type': '照用', 'text': '开头照用「最值得抓住的杠杆」。', 'sug': 'sug-a'}]}},
            {'id': 'sk-1', 'kind': 'skeleton', 'locked': {'families': [{'who': '博主甲'}, {'who': '另一家'}], 'relation': '两家开头一样。',
             'rows': [{'step': '开头', 'segment': 1, 'cells': {'博主甲': '0:00 杠杆', '另一家': '0:03 杠杆'}}]}},
        ]
        return d

    def test_refnote_and_skeleton_accepted(self):
        res = self.build(self.refnote_data())
        kinds = [cd.kind_of(x) for x in self.doc()['items']]
        self.assertIn('refnote', kinds); self.assertIn('skeleton', kinds)
        self.assertFalse([w for w in res['warnings'] if '参考分析' in w or '逐字相同' in w], res['warnings'])

    def test_refnote_problems_refused(self):
        """参考分析的每句都要能在原片里对上：原句逐字、时间落在时间段里、标签固定、几家都这么讲每家都有原句、链接的建议存在。"""
        cases = [
            (lambda d: d['items'][0]['locked']['points'][0]['quotes'][0].update(text='最值得抓的杠杆'), '在博主甲这一段的原文里找不到，必须逐字截取'),
            (lambda d: d['items'][0]['locked']['points'][0]['quotes'][0].update(time='0:40'), '不在博主甲这一段的时间段里'),
            (lambda d: d['items'][0]['locked']['points'][0].update(tag='金句'), 'tag 必须是'),
            (lambda d: d['items'][0]['locked']['points'][0]['quotes'].pop(), '每一家都要有一句原句，缺：另一家'),
            (lambda d: d['items'][0]['locked']['points'][0].update(who=['博主甲', '路人']), 'who 必须是这一段参考里的名字'),
            (lambda d: d['items'][0]['locked']['borrow'][0].update(sug='sug-没有'), '找不到对应的建议'),
            (lambda d: d['items'][0]['locked'].update(points=[]), 'points（讲法点）必须是 1 到 4 条'),
            (lambda d: d['items'].append(dict(d['items'][0], id='rn-2')), '一段只能有一条'),
            (lambda d: d['items'][1]['locked']['rows'][0]['cells'].update({'路人': 'x'}), 'families 之外的名字'),
        ]
        for mutate, needle in cases:
            d = self.refnote_data()
            mutate(d)
            with self.subTest(needle=needle):
                self.refused(d, '拒绝生成', needle)

    def test_overlap_warns_when_refs_rewrite_each_other(self):
        """同一段两家逐字相同占四成以上（中译中），参考分析里没标 merged 就提醒。"""
        d = self.refnote_data()
        d['segments'][0]['refs'][1]['text'] = '我觉得 AI 真的是我们普通人最值得抓住的杠杆，没有之一。'
        d['items'][0]['locked']['points'][0]['quotes'][1]['text'] = '最值得抓住的杠杆，没有之一'
        res = self.build(d)
        self.assertTrue(any('逐字相同' in w and 'merged' in w for w in res['warnings']), res['warnings'])

    def test_tutorial_keys_accepted_and_missing_video_warned(self):
        """教程枝干的键：参考的角色、对方画面、本地原片，建议的「参考画面」「等录屏再定」都合格；本地原片找不到只提醒不拒绝。"""
        d = sample()
        r = d['segments'][0]['refs'][0]
        r.update(role='对标', visual='录屏：打开工具首页', video='../../02_内容素材/没有这个/视频.mp4')
        d['suggestions'][0].update(basis={'type': '参考画面', 'text': '对方 0:20 的画面'}, verdict='等录屏再定')
        res = self.build(d)
        self.assertTrue(any('本地原片找不到' in w and '没有这个' in w for w in res['warnings']), res['warnings'])
        ref = self.kinds(self.doc(), 'segment')[0]['locked']['refs'][0]
        self.assertEqual((ref['role'], ref['visual'], ref['video']), ('对标', '录屏：打开工具首页', '../../02_内容素材/没有这个/视频.mp4'))
        g = self.kinds(self.doc(), 'suggestion')[0]['locked']
        self.assertEqual((g['basis']['type'], g['verdict']), ('参考画面', '等录屏再定'))

    def test_each_problem_refused_with_reason(self):
        for mutate, needle in self.CASES:
            d = sample()
            mutate(d)
            with self.subTest(needle=needle):
                self.refused(d, '拒绝生成', needle)
                self.assertFalse(os.path.exists(self.out))

    def test_empty_proposed_means_delete_sentence(self):
        """「改成」写空字符串是删掉整句：合格，原样写进页面；和 suggest、set-field 同一条规矩。"""
        d = sample()
        d['suggestions'][1]['proposed'] = ''
        self.build(d)
        g = self.kinds(self.doc(), 'suggestion')[1]
        self.assertEqual((g['locked']['original'], g['fields']['proposed']), ('他问我会不会用 AI。', ''))
        self.assertTrue(cd.deletes_sentence(g['fields']['proposed']))

    def test_all_problems_listed_at_once(self):
        d = sample()
        d.pop('title')
        d['suggestions'][0]['category'] = '节奏'
        d['segments'][2].pop('mine')
        msg = self.refused(d)
        self.assertEqual(len([x for x in msg.splitlines() if x.startswith('- ')]), 3, msg)


class TemplateTests(Base):
    APP_EOF, STYLE_EOF = bs.PART_EOF['app'], bs.PART_EOF['style']

    def tpl(self, shell=None, app='/* app */', style='/* style */', name='tpl', eof=True):
        """写一套临时模板；eof=True 时给 app.js、style.css 补上结束标记（正式模板都有）。"""
        d = os.path.join(self.tmp, name)
        os.makedirs(d, exist_ok=True)
        if eof:
            app, style = app + '\n' + self.APP_EOF + '\n', style + '\n' + self.STYLE_EOF + '\n'
        for fn, text in (('shell.html', shell), ('app.js', app), ('style.css', style)):
            with open(os.path.join(d, fn), 'w', encoding='utf-8') as f:
                f.write(text)
        return d

    def test_bare_placeholders_are_wrapped(self):
        d = self.tpl('<!doctype html><title>{{TITLE}}</title>{{STYLE}}<body>{{DOC}}{{APP}}{{KIT}}</body>')
        self.build(template_dir=d)
        text = read(self.out).decode('utf-8')
        self.assertIn('<script id="jc-doc" type="application/json">', text)
        self.assertIn('<!--jc-style:start--><style>\n/* style */\n%s\n\n</style><!--jc-style:end-->' % self.STYLE_EOF, text)
        self.assertIn('<!--jc-app:start--><script>\n/* app */\n%s\n\n</script><!--jc-app:end-->' % self.APP_EOF, text)
        self.assertIn('<!--jc-kit:start--><script>', text)
        self.assertEqual(self.doc()['content_id'], 'T901')

    def test_style_and_app_wrapped_in_markers_like_kit(self):
        """样式、界面脚本和 kit 一样用首尾标记包住，各恰好一个；写在带属性的标签里时保留标签属性。"""
        for n, shell in enumerate([
                '<title>{{TITLE}}</title><style>{{STYLE}}</style><script id="jc-doc" type="application/json">{{DOC}}</script>'
                '<script>{{KIT}}</script><script id="jc-app" data-x="1">{{APP}}</script>',
                '<title>{{TITLE}}</title><!--jc-style:start--><style>{{STYLE}}</style><!--jc-style:end-->{{DOC}}'
                '<!--jc-kit:start--><script>{{KIT}}</script><!--jc-kit:end--><!--jc-app:start--><script id="jc-app" data-x="1">\n{{APP}}\n</script><!--jc-app:end-->']):
            with self.subTest(n=n):
                if os.path.exists(self.out): os.unlink(self.out)
                self.build(template_dir=self.tpl(shell, name='mk%d' % n))
                text = read(self.out).decode('utf-8')
                for k in ('style', 'kit', 'app'):
                    self.assertEqual((text.count('<!--jc-%s:start-->' % k), text.count('<!--jc-%s:end-->' % k)), (1, 1), k)
                self.assertIn('<!--jc-app:start--><script id="jc-app" data-x="1">\n/* app */', text)
                self.assertEqual(build_page.check_page(text, self.doc()), [])

    def test_app_and_style_without_eof_refused(self):
        full = '<title>{{TITLE}}</title><style>{{STYLE}}</style>{{DOC}}<script>{{APP}}</script>{{KIT}}'
        msg = self.refused(None, '模板不完整', 'app.js 末尾没有结束标记', 'style.css 末尾没有结束标记',
                           template_dir=self.tpl(full, name='noeof', eof=False))
        self.assertNotIn('kit.js', msg)
        self.assertFalse(os.path.exists(self.out))

    def test_markers_mismatched_refused(self):
        cases = [
            ('<title>{{TITLE}}</title><!--jc-app:start--><style>{{STYLE}}</style><!--jc-app:end-->{{DOC}}<script>{{APP}}</script>{{KIT}}', '对不上'),
            ('<title>{{TITLE}}</title><script>{{STYLE}}</script>{{DOC}}<script>{{APP}}</script>{{KIT}}', '要写在 <style> 里'),
            ('<title>{{TITLE}}</title><style>{{STYLE}}</style><!--jc-style:end-->{{DOC}}<script>{{APP}}</script>{{KIT}}', '<!--jc-style:end-->'),
        ]
        for i, (shell, needle) in enumerate(cases):
            with self.subTest(needle=needle):
                self.refused(None, needle, template_dir=self.tpl(shell, name='mm%d' % i))
        self.refused(None, '<!--jc-app:start-->', template_dir=self.tpl(
            '<title>{{TITLE}}</title><style>{{STYLE}}</style>{{DOC}}<script>{{APP}}</script>{{KIT}}', app='// <!--jc-app:start--> 写在注释里也不行', name='mm-app'))
        self.assertFalse(os.path.exists(self.out))

    def test_kit_already_wrapped_in_markers(self):
        d = self.tpl('<title>{{TITLE}}</title><style>{{STYLE}}</style><script id="jc-doc" type="application/json">{{DOC}}</script>'
                     '<script>{{APP}}</script><!--jc-kit:start--><script>{{KIT}}</script><!--jc-kit:end-->')
        self.build(template_dir=d)
        self.assertEqual(read(self.out).decode('utf-8').count('<!--jc-kit:start-->'), 1)

    def test_bad_templates_refused(self):
        full = '<title>{{TITLE}}</title><style>{{STYLE}}</style>{{DOC}}<script>{{APP}}</script>{{KIT}}'
        cases = [
            (full.replace('{{KIT}}', ''), '{{KIT}} 应该恰好出现 1 次'),
            (full + '{{DOC}}', '{{DOC}} 应该恰好出现 1 次'),
            (full.replace('{{DOC}}', '<script type="application/json">{{DOC}}</script>'), 'id="jc-doc"'),
            (full + '<script src="https://cdn.example.com/x.js"></script>', '外部'),
            (full + '<link rel="stylesheet" href="https://fonts.example.com/a.css">', '外部'),
        ]
        for i, (shell, needle) in enumerate(cases):
            with self.subTest(needle=needle):
                self.refused(None, needle, template_dir=self.tpl(shell, name='bad%d' % i))
        self.refused(None, '@import', template_dir=self.tpl(full, style='@import url("https://x/y.css");', name='badcss'))
        self.refused(None, '各恰好 1 个', template_dir=self.tpl(full, app='// <!--jc-kit:start--> 写在注释里也不行', name='badapp'))
        self.assertFalse(os.path.exists(self.out))

    def test_kit_without_eof_refused(self):
        kit = os.path.join(self.tmp, 'kit-cut.js')
        with open(kit, 'w', encoding='utf-8') as f:
            f.write('window.jcKit = {};')
        self.refused(None, '结束标记', kit_path=kit)


class CliTests(Base):
    def run_cli(self, data, *args):
        p = os.path.join(self.tmp, 'data.json')
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
        return subprocess.run([sys.executable, BUILD_PY, p, '--out', self.out, '--template-dir', FIX_TEMPLATE, '--kit', FIX_KIT] + list(args),
                              capture_output=True, text=True, encoding='utf-8', timeout=30)

    def test_cli_refuses_with_reasons_and_builds(self):
        bad = sample()
        bad['suggestions'][0]['original'] = '没有这句'
        r = self.run_cli(bad)
        self.assertEqual(r.returncode, 1)
        self.assertIn('数据不合格，拒绝生成', r.stderr)
        self.assertIn('找不到', r.stderr)
        self.assertFalse(os.path.exists(self.out))
        r = self.run_cli(sample(), '--check')
        self.assertEqual((r.returncode, os.path.exists(self.out)), (0, False))
        self.assertIn('数据合格', r.stdout)
        r = self.run_cli(sample(), '--page-id', 'abcd2345ef')
        self.assertEqual(r.returncode, 1)
        self.assertIn('指定身份号时要先确认根目录下没有同号的页面', r.stderr)  # 不知道根目录就没法查重，拒绝
        r = self.run_cli(sample(), '--page-id', 'abcd2345ef', '--root', self.root)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('已生成创作页', r.stdout)
        self.assertEqual(self.doc()['page_id'], 'abcd2345ef')
        self.assertIn('/p/abcd2345ef', r.stdout)
        self.assertNotIn('删掉这句', r.stdout, '没有删句建议时不提')

    def test_cli_summary_counts_delete_sentence(self):
        d = sample()
        d['suggestions'][1]['proposed'] = ''
        r = self.run_cli(d, '--check')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('3 条建议（其中 1 条是删掉这句）', r.stdout)


@unittest.skipUnless(os.path.exists(os.path.join(APP, 'template', 'shell.html')), 'template/shell.html 还没有')
class RealTemplateTests(Base):
    """用 template/ 里真正的界面和 kit/kit.js 生成：占位齐全、自检通过、不依赖网络。"""

    def test_real_template_builds(self):
        shell = read(os.path.join(APP, 'template', 'shell.html')).decode('utf-8')
        for k in ('{{STYLE}}', '{{APP}}', '{{KIT}}', '{{DOC}}', '{{TITLE}}'):
            self.assertIn(k, shell)
        r = build_page.build(sample(), self.out, root=self.root, kit_path=KIT_FILE)
        text = read(self.out).decode('utf-8')
        self.assertEqual(bs.parse_page(text.encode('utf-8'))[1], r['doc'])
        self.assertEqual(text.count('<!--jc-kit:start-->'), 1)
        shell_part = text.replace(bs.DOC_RE.search(text).group(0), '')
        for m in re.finditer(r'<script\b[^>]*>.*?</script>', shell_part, re.S):  # 去掉脚本正文，只查标签和样式
            shell_part = shell_part.replace(m.group(0), '<script></script>')
        self.assertIsNone(EXTERNAL.search(shell_part))


if __name__ == '__main__':
    unittest.main()
