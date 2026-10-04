"""「只加不删」扩展性验证：用一份 AI 教程假数据（tests/fixtures/tutorial_ext.json）证明，按三种扩展方式长枝干不用改保存服务。

假数据里用到全部三种扩展方式（键名是教程枝干的暂定名，做教程模块时再定）：
- 给已有条目加可选的锁定键：每段参考带「画面」visual；
- 给已有条目加可选的可改字段：段落带「我方画面」our_visual、「画面类型」visual_type；
- 加新的条目种类：「录屏步骤」step，locked 有所属段落 segment、在哪发 where、对应口播 line、发完应该看到 expect，fields 有要发送的内容 prompt。
另外第 2 段带一条「说明」类参考（不是谁的原话）。

保存服务的逐格保存（judge、merge_changes、/save）这次一行没改，下面的保存测试直接打它。
页面对不认识的种类和字段不报错、兜底模块能改能存，在 tests/browser/ui_scenarios.mjs 的 extend 场景里用真浏览器测。
"""
import json, os, shutil, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from support import KIT_FILE, ServerCase, fixture, post, read  # noqa: E402
import brain_save as bs  # noqa: E402
import build_page  # noqa: E402
import brain_page  # noqa: E402
import creation_doc as cd  # noqa: E402


class TutorialExtensionTests(ServerCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='jc-ext-test-')
        self.root = os.path.join(self.tmp, 'brain')
        os.makedirs(self.root)
        self.start_server(self.root)
        self.out = os.path.join(self.root, '内容草稿', 'T991_扩展验证', 'T991_创作页.html')
        self.data = fixture('tutorial_ext.json')
        self.data['service_origin'] = 'http://127.0.0.1:%d' % self.port
        r = build_page.build(self.data, self.out, root=self.root, kit_path=KIT_FILE)  # 用真模板生成
        self.warnings = r['warnings']
        d = self.doc()
        self.pid = d['page_id']
        self.seg1, self.seg2 = [s['id'] for s in cd.segments_of(d)]

    def tearDown(self):
        self.stop_server()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def doc(self):
        return bs.parse_page(read(self.out))[1]

    def item(self, iid):
        return next(x for x in self.doc()['items'] if x['id'] == iid)

    def save(self, *cells, group=None):
        """模拟用户在页面上改几格：按文件当前值和指纹提交给保存服务，返回每格的结果。"""
        changes = []
        for iid, field, after in cells:
            it = self.item(iid)
            c = {'change_id': cd.short(12), 'item_id': iid, 'field': field, 'before': it['fields'][field], 'after': after, 'item_fp': bs.item_fp(it)}
            if group: c['group'] = group
            changes.append(c)
        st, out = post(self.port, {'page_id': self.pid, 'changes': changes})
        self.assertEqual(st, 200, out)
        return out['results']

    def test_build_keeps_all_three_kinds_of_extension(self):
        self.assertFalse([w for w in self.warnings if '没用上' in w], self.warnings)  # 扩展键没有被当成拼错的键丢掉
        s1, s2 = self.item(self.seg1), self.item(self.seg2)
        self.assertEqual(s1['locked']['refs'][0]['visual'], self.data['segments'][0]['refs'][0]['visual'])  # 参考里的「画面」
        self.assertEqual(s1['fields'], {'mine': self.data['segments'][0]['mine'], 'note': '', 'our_visual': '', 'visual_type': '录屏'})
        self.assertEqual(list(s2['fields']), ['mine', 'note', 'our_visual', 'visual_type'])
        explain = s2['locked']['refs'][1]
        self.assertEqual((explain['source_type'], explain['time'], explain['url'], explain['who']), ('说明', '', '', ''))
        step = self.item('tutstep01')
        self.assertEqual(step['kind'], 'step')
        self.assertEqual(step['locked']['segment'], self.seg1)  # 输入写的是段序号 1，生成时换成段落 id
        self.assertEqual(step['locked']['expect'], '出现 4 张 3:4 的封面草图')
        self.assertEqual(list(step['fields']), ['prompt'])
        self.assertEqual(cd.kind_of(step), 'step')  # 明确写了种类，不靠身份号前缀或键去猜
        self.assertTrue(all(isinstance(it.get('kind'), str) and it['kind'] for it in self.doc()['items']))

    def test_service_saves_new_fields_without_changes(self):
        """保存服务不认识「我方画面」「提示词」也照样逐格写回，和我的版本一样记进改动记录；同组全成。"""
        r = self.save((self.seg1, 'our_visual', '我这边录屏：先放一张做好的封面，再倒回去演示'))
        self.assertEqual((r[0]['status'], r[0]['reason']), ('ok', 'written'))
        r = self.save(('tutstep01', 'prompt', '一张 3:4 的中文视频封面，黑底白字'), (self.seg2, 'visual_type', 'AI 生成'), group='g-ext')
        self.assertEqual([x['reason'] for x in r], ['written', 'written'])
        self.assertEqual(self.item(self.seg1)['fields']['our_visual'], '我这边录屏：先放一张做好的封面，再倒回去演示')
        self.assertEqual(self.item('tutstep01')['fields']['prompt'], '一张 3:4 的中文视频封面，黑底白字')
        self.assertEqual(self.item(self.seg2)['fields']['visual_type'], 'AI 生成')
        log = bs.read_changes(self.root, self.pid)
        self.assertEqual([(c['item'], c['field']) for c in log], [(self.seg1, 'our_visual'), ('tutstep01', 'prompt'), (self.seg2, 'visual_type')])
        self.assertEqual(log[1]['group'], 'g-ext')
        self.assertEqual(len(bs.read_changes(self.root, self.pid, 'tutstep01')), 1)
        # AI 改了录屏步骤的锁定部分（指纹变了），用户这时拿旧指纹改提示词：按冲突处理，和已知条目一样
        stale = self.item('tutstep01')
        page = brain_page.locate(self.out, self.root)
        brain_page.cmd_set_locked(page, 'tutstep01', 'where', '换成手机上的 App')
        c = {'change_id': 'x1', 'item_id': 'tutstep01', 'field': 'prompt', 'before': stale['fields']['prompt'], 'after': '用户拿旧页面改的',
             'item_fp': bs.item_fp(stale)}
        st, out = post(self.port, {'page_id': self.pid, 'changes': [c]})
        self.assertEqual((out['results'][0]['status'], out['results'][0]['reason']), ('conflict', 'item_changed'))

    def test_brain_page_reads_sets_and_exports(self):
        page = brain_page.locate(self.out, self.root)
        self.save((self.seg1, 'our_visual', '用户写的我方画面'))
        text = brain_page.render_read(page, page.doc())
        for needle in ('我方画面（our_visual，可改）', '用户写的我方画面', '画面类型（visual_type，可改）', '## 其他格子和条目',
                       '### 录屏步骤 tutstep01，属于第 1 段', '在哪发（where，锁定）', '要发送的内容（prompt，可改）'):
            self.assertIn(needle, text)
        # AI 改提示词（不是用户的格子，不用 --user-approved），走同一套逐格规则并记进改动记录
        self.assertIn('已写入', brain_page.cmd_set_field(page, 'tutstep01', 'prompt', 'AI 改过的提示词'))
        self.assertEqual(self.item('tutstep01')['fields']['prompt'], 'AI 改过的提示词')
        self.assertEqual(bs.read_changes(self.root, self.pid, 'tutstep01')[-1]['origin'], 'brain_page')
        # 录屏步骤挪到第 2 段：只查段落在不在（建议才要查原句）
        brain_page.cmd_set_locked(page, 'tutstep01', 'segment', self.seg2)
        self.assertEqual(self.item('tutstep01')['locked']['segment'], self.seg2)
        with self.assertRaises(brain_page.CliError):
            brain_page.cmd_set_locked(page, 'tutstep01', 'segment', 'seg-不存在')
        brain_page.cmd_set_locked(page, 'tutstep01', 'segment', self.seg1)
        # 导出带上全部扩展，原样重新生成一个字节都不变
        data = brain_page.export_data(self.doc())
        self.assertEqual(data['segments'][0]['fields'], {'our_visual': '用户写的我方画面', 'visual_type': '录屏'})
        self.assertEqual(data['items'][0]['kind'], 'step')
        before = read(self.out)
        r = build_page.build(data, self.out, root=self.root, kit_path=KIT_FILE)
        self.assertTrue(r.get('unchanged'), r['warnings'])
        self.assertEqual(read(self.out), before)

    def test_regenerate_keeps_user_cells_in_new_fields(self):
        """重新生成：用户在扩展字段里填的内容按身份号保留；AI 漏写了某个扩展字段也不会把它删掉。"""
        self.save((self.seg1, 'our_visual', '用户填的'), ('tutstep01', 'prompt', '用户改的提示词'))
        data = brain_page.export_data(self.doc())
        data['items'][0]['locked']['expect'] = '出现 4 张草图，第二张最顺眼'
        del data['segments'][0]['fields']['our_visual']  # AI 这次没写这一格
        data['segments'][1]['fields']['our_visual'] = 'AI 想塞的'  # 页面上是空的：用新值
        r = build_page.build(data, self.out, root=self.root, kit_path=KIT_FILE)
        self.assertFalse(r['created'])
        self.assertEqual(self.item(self.seg1)['fields']['our_visual'], '用户填的')
        self.assertTrue(any('our_visual' in w and '保留页面上的' in w for w in r['warnings']), r['warnings'])
        self.assertEqual(self.item('tutstep01')['fields']['prompt'], '用户改的提示词')
        self.assertEqual(self.item('tutstep01')['locked']['expect'], '出现 4 张草图，第二张最顺眼')
        self.assertEqual(self.doc()['page_id'], self.pid)

    def test_step_missing_from_new_data_refused_unless_drop(self):
        data = brain_page.export_data(self.doc())
        data.pop('items')
        with self.assertRaises(build_page.BuildError) as cm:
            build_page.build(data, self.out, root=self.root, kit_path=KIT_FILE)
        self.assertIn('tutstep01', str(cm.exception))
        build_page.build(data, self.out, root=self.root, kit_path=KIT_FILE, drop_missing=True)
        self.assertFalse(any(it['id'] == 'tutstep01' for it in self.doc()['items']))

    def test_bad_extension_data_refused_with_reasons(self):
        cases = [
            (lambda d: d['items'].append({'kind': 'segment', 'locked': {}, 'fields': {}}), '请写在 info、segments、suggestions 里'),
            (lambda d: d['items'].append({'kind': '录屏步骤', 'locked': {}, 'fields': {}}), '新种类的名字用小写字母开头'),
            (lambda d: d['items'][0]['locked'].update(segment=9), '一共只有 2 段'),
            (lambda d: d['items'][0]['locked'].update(segment='seg-不存在'), '找不到对应段落'),
            (lambda d: d['items'][0]['fields'].update(prompt=3), '的值必须是文字'),
            (lambda d: d['items'][0]['locked'].update(ai_state={}), '不能写 ai_state'),
            (lambda d: d['items'][0].update(id=d['segments'][0]['id']), '重复'),
            (lambda d: d['segments'][0]['fields'].update(mine='x'), 'mine 是固定键'),
            (lambda d: d['segments'][0].update(locked={'title': '换标题'}), 'title 是固定键'),
            (lambda d: d['segments'][0].update(fields=['our_visual']), 'fields（额外的可改字段）必须是对象'),
            (lambda d: d['segments'][0]['refs'][0].pop('who'), '缺少 who'),
            (lambda d: d['segments'][1]['refs'][1].pop('text'), '缺少 text（说明的内容）'),
        ]
        out = os.path.join(self.tmp, 'new', 'T991_创作页.html')
        for mutate, needle in cases:
            d = fixture('tutorial_ext.json')
            mutate(d)
            with self.subTest(needle=needle):
                with self.assertRaises(build_page.BuildError) as cm:
                    build_page.build(d, out, root=self.root, kit_path=KIT_FILE)
                self.assertIn(needle, str(cm.exception))
                self.assertFalse(os.path.exists(out))

    def test_explain_ref_with_time_or_url_only_warns(self):
        d = fixture('tutorial_ext.json')
        d['segments'][1]['refs'][1].update(time='无', url='https://www.example.com/v')
        r = build_page.build(d, os.path.join(self.tmp, 'new', 'T991_创作页.html'), root=self.root, kit_path=KIT_FILE, check_only=True)
        self.assertTrue(any('是「说明」' in w for w in r['warnings']), r['warnings'])


class ExplainRefLockedRuleTests(unittest.TestCase):
    def test_set_locked_refs_accepts_explain(self):
        rule = brain_page.LOCKED_RULES['refs']
        self.assertIs(rule([{'source_type': '说明', 'text': '她这里没有对应的原话'}]), True)
        self.assertIsNot(rule([{'source_type': '备注', 'text': 'x'}]), True)


if __name__ == '__main__':
    unittest.main()
