"""brain_page.py 测试：read 摘要、reply、suggest、set-locked、set-field（用户的格子默认拒绝）、rebase、export、找页面、发布文字（publish）。

每个用例用临时根目录、fixtures 里的最小模板生成一页 T901 样例，起一个随机端口的保存服务模拟用户在页面上改。
"""
import contextlib, io, json, os, shutil, subprocess, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from support import APP, FIX_KIT, FIX_TEMPLATE, ServerCase, post, read, sample  # noqa: E402
import brain_save as bs  # noqa: E402
import build_page  # noqa: E402
import brain_page  # noqa: E402
import creation_doc as cd  # noqa: E402

PAGE_PY = os.path.join(APP, 'brain_page.py')


class Base(ServerCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='jc-page-test-')
        self.root = os.path.join(self.tmp, 'brain')
        os.makedirs(self.root)
        self.start_server(self.root)
        self.out = os.path.join(self.root, '内容草稿', 'T901_测试', 'T901_创作页.html')
        build_page.build(sample(service_origin='http://127.0.0.1:%d' % self.port), self.out, root=self.root,
                         template_dir=FIX_TEMPLATE, kit_path=FIX_KIT)
        d = self.doc()
        self.pid = d['page_id']
        self.info = cd.info_of(d)['id']
        self.segs = [s['id'] for s in cd.segments_of(d)]
        self.sugs = [g['id'] for g in cd.items_of(d, 'suggestion')]

    def tearDown(self):
        self.stop_server()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def doc(self):
        return bs.parse_page(read(self.out))[1]

    def item(self, iid):
        return next(x for x in self.doc()['items'] if x['id'] == iid)

    def cli(self, *args):
        """在本进程里跑命令，返回 (退出码, 标准输出, 标准错误)。"""
        o, e = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(o), contextlib.redirect_stderr(e):
            code = brain_page.main([str(a) for a in args])
        return code, o.getvalue(), e.getvalue()

    def ok(self, *args):
        code, out, err = self.cli(*args)
        self.assertEqual(code, 0, err)
        return out

    def fails(self, *args):
        code, out, err = self.cli(*args)
        self.assertEqual(code, 1, out)
        return err

    def jc_change(self, iid, field, after):
        it = self.item(iid)
        return {'change_id': cd.short(12), 'item_id': iid, 'field': field, 'before': it['fields'][field], 'after': after, 'item_fp': bs.item_fp(it)}

    def jc_post(self, changes):
        st, out = post(self.port, {'page_id': self.pid, 'changes': changes})
        self.assertEqual(st, 200, out)
        return out['results']

    def jc_save(self, iid, field, after):
        r = self.jc_post([self.jc_change(iid, field, after)])[0]
        self.assertEqual(r['status'], 'ok', r)


class ReadTests(Base):
    def test_read_summary(self):
        s1, s2, s3 = self.segs
        self.jc_save(s1, 'mine', '我觉得AI是我们普通人最值得抓住的杠杆，因为回头看转行做视频的这一年半，跟做梦一样。')
        self.jc_save(self.info, 'overall_note', '整体再口语一点')
        self.jc_save(self.info, 'approved', '2026-09-27T10:00:00+08:00')
        self.jc_save(self.sugs[1], 'decision', '采纳')
        self.jc_save(s3, 'mine', '所以，AI 是我们最该抓住的杠杆。')  # 第三条建议的原句没了
        out = self.ok('read', self.out, '--root', self.root)
        self.assertIn('# T901 AI是我们普通人最值得抓住的杠杆（创作页）', out)
        self.assertIn('page_id：%s；类型：口播；阶段：写稿；每秒 4 字' % self.pid, out)
        self.assertIn('内容已确认：是（2026-09-27T10:00:00+08:00）', out)
        self.assertIn('整体再口语一点', out)
        self.assertIn('## 待处理的写给 AI 的话（1 条）', out)
        self.assertIn('第 2 段「第一件事」（%s）' % s2, out)
        self.assertIn('这段能不能再短一点？', out)
        self.assertIn('{++他问我会不会用 AI。++}', out)  # 和底稿比的删改
        self.assertRegex(out, r'\{--[^}]*真的[^}]*--\}')
        self.assertIn('- 和底稿比：没有底稿', out)
        self.assertIn('用户的决定：采纳', out)
        self.assertIn('（在我的版本里找不到了）', out)
        self.assertIn('（在我的版本里还能找到 1 处）', out)
        self.assertIn('## 录完的定稿', out)

    def test_critic_markup(self):
        self.assertEqual(cd.critic('今天天气很好', '今天天气很好'), '今天天气很好')
        self.assertEqual(cd.critic('今天天气很好', '今天天气真好'), '今天天气{~~很~>真~~}好')
        self.assertEqual(cd.critic('我去了', '我昨天去了'), '我{++昨天++}去了')
        self.assertEqual(cd.critic('一二三四五', '一五'), '一{--二三四--}五')
        self.assertEqual(cd.critic('甲乙丙丁', '子乙丑丁'), '{~~甲乙丙~>子乙丑~~}丁')  # 中间只隔一个字：并成一处

    def test_export_round_trip_is_noop(self):
        p = os.path.join(self.tmp, 'data.json')
        self.ok('export', self.out, '--root', self.root, '--out', p)
        with open(p, encoding='utf-8') as f:
            data = json.load(f)
        self.assertEqual([s['id'] for s in data['segments']], self.segs)
        self.assertEqual([g['segment'] for g in data['suggestions']], self.segs)
        before = read(self.out)
        r = build_page.build(data, self.out, root=self.root, template_dir=FIX_TEMPLATE, kit_path=FIX_KIT)
        self.assertTrue(r.get('unchanged'))
        self.assertEqual(read(self.out), before)


class ReplyTests(Base):
    def test_reply_marks_handled_and_note_edit_makes_it_pending_again(self):
        s2 = self.segs[1]
        fp = bs.item_fp(self.item(s2))
        out = self.ok('reply', self.out, '--root', self.root, '--item', s2, '--text', '已经缩成两句')
        self.assertIn('已回复', out)
        it = self.item(s2)
        st = it['locked']['ai_state']
        self.assertEqual((st['handled_note'], st['reply']), ('这段能不能再短一点？', '已经缩成两句'))
        self.assertTrue(st['replied_at'])
        self.assertEqual(bs.item_fp(it), fp)  # 回复不改指纹
        self.assertFalse(cd.note_pending(it))
        read_out = self.ok('read', self.out, '--root', self.root)
        self.assertIn('## 待处理的写给 AI 的话（0 条）', read_out)
        self.assertIn('写给 AI 的话：AI 已处理，回复：已经缩成两句', read_out)
        self.jc_save(s2, 'note', '还是太长，再砍一半')  # 用户接着写：同一个指纹，不冲突
        self.assertTrue(cd.note_pending(self.item(s2)))
        self.assertIn('## 待处理的写给 AI 的话（1 条）', self.ok('read', self.out, '--root', self.root))

    def test_reply_while_user_is_editing_no_conflict(self):
        s1, s2 = self.segs[:2]
        pending = [self.jc_change(s2, 'mine', '用户正在改的第二段'), self.jc_change(s2, 'note', '用户改了批注')]  # 页面上已记下、还没写回
        self.ok('reply', self.out, '--root', self.root, '--item', s2, '--text', 'AI 回复')
        self.ok('reply', self.out, '--root', self.root, '--item', s1, '--text', '第一段没有批注也可以回复')
        res = self.jc_post(pending)
        self.assertEqual([(r['status'], r['reason']) for r in res], [('ok', 'written'), ('ok', 'written')])
        self.assertTrue(cd.note_pending(self.item(s2)))

    def test_reply_to_overall_note(self):
        self.jc_save(self.info, 'overall_note', '整体再快一点')
        self.ok('reply', self.out, '--root', self.root, '--item', 'info', '--text', '整体删了 20 字')
        self.assertIn('AI 已处理，回复：整体删了 20 字', self.ok('read', self.out, '--root', self.root))

    def test_reply_to_suggestion_refused(self):
        self.assertIn('这个命令要的是段落或页面信息', self.fails('reply', self.out, '--root', self.root, '--item', self.sugs[0], '--text', 'x'))


class SuggestTests(Base):
    def args(self, seg, original, *extra):
        return ['suggest', self.out, '--root', self.root, '--segment', seg, '--category', '衔接', '--original', original,
                '--proposed', '改后的句子', '--reason', '接得更顺', '--basis-type', 'AI 自己的判断', '--basis', '读起来断了'] + list(extra)

    def test_add_suggestion(self):
        s2 = self.segs[1]
        fps = {it['id']: bs.item_fp(it) for it in self.doc()['items']}
        out = self.ok(*self.args(s2, '我去给一个博主当剪辑。'))
        self.assertIn('已新增建议 sug-', out)
        doc = self.doc()
        g = cd.items_of(doc, 'suggestion')[-1]
        self.assertEqual(g['kind'], 'suggestion')
        self.assertEqual(g['locked'], {'segment': s2, 'category': '衔接', 'source': 'AI', 'original': '我去给一个博主当剪辑。',
                                       'reason': '接得更顺', 'basis': {'type': 'AI 自己的判断', 'text': '读起来断了'}, 'verdict': '待你定'})
        self.assertEqual(g['fields'], {'proposed': '改后的句子', 'decision': ''})
        self.assertEqual({i: bs.item_fp(it) for i, it in ((x['id'], x) for x in doc['items']) if i in fps}, fps)  # 别的条目指纹不变

    def test_original_must_occur_exactly_once(self):
        s2 = self.segs[1]
        before = read(self.out)
        self.assertIn('找不到', self.fails(*self.args(s2, '我的版本里没有这句')))
        self.jc_save(s2, 'mine', '他问我。后来他又问我。')
        self.assertIn('出现了 2 次', self.fails(*self.args(s2, '问我。')))
        self.assertIn('出现了 2 次', self.fails(*self.args(s2, '他')))
        self.assertIn('--category 必须是', self.fails(*self.args(s2, '后来', '--category', '节奏')))  # 同一个参数写两次，后一个算数
        self.assertIn('必须是', self.fails(*self.args(s2, '后来') + ['--basis-type', '直觉']))
        self.assertIn('这个命令要的是段落', self.fails(*self.args(self.sugs[0], '后来')))
        self.assertEqual(len(cd.items_of(self.doc(), 'suggestion')), 3)
        self.assertNotEqual(read(self.out), before)  # 只有用户那次保存改了文件


class DeleteSentenceTests(Base):
    """「改成」为空表示删掉整句：suggest、set-field、生成都接受空字符串，read 里写「删掉这句」。"""

    def test_suggest_empty_proposed_and_read_says_delete(self):
        s2 = self.segs[1]
        out = self.ok('suggest', self.out, '--root', self.root, '--segment', s2, '--category', '表达', '--original', '他问我会不会用 AI。',
                      '--proposed', '', '--reason', '这句和下一段重复，删掉更干净', '--basis-type', 'AI 自己的判断')
        self.assertIn('删掉这句', out)
        g = cd.items_of(self.doc(), 'suggestion')[-1]
        self.assertEqual(g['fields']['proposed'], '')
        text = self.ok('read', self.out, '--root', self.root)
        block = text[text.index('- %s ' % g['id']):]
        self.assertIn('  - 改成：删掉这句（「改成」是空的，采纳时整句删掉）', block)
        self.assertNotIn('改成：删掉这句', text[:text.index('- %s ' % g['id'])], '别的建议照常显示改成的文字')

    def test_set_field_proposed_to_empty(self):
        g1 = self.sugs[0]
        self.ok('set-field', self.out, '--root', self.root, '--item', g1, '--field', 'proposed', '--value', '', '--before', '回头看转行这一年半')
        self.assertEqual(self.item(g1)['fields']['proposed'], '')
        self.assertIn('改成：删掉这句', self.ok('read', self.out, '--root', self.root))

    def test_shared_rule(self):
        self.assertTrue(cd.deletes_sentence(''))
        self.assertTrue(cd.deletes_sentence(' \n'), '只有空白也算删句，和页面判断「改成」是不是空的一样')
        self.assertFalse(cd.deletes_sentence('删掉这句'))
        self.assertFalse(cd.deletes_sentence(None))
        self.assertIsNone(cd.proposed_problem(''))
        self.assertIn('空字符串', cd.proposed_problem(None))
        self.assertEqual(cd.proposed_text('改后'), '改后')


class StdinTests(Base):
    """文字参数写成 - 时从标准输入读：去掉末尾换行（heredoc、echo 会多带），一条命令只能有一个 -。"""

    def run_cli(self, args, stdin):
        return subprocess.run([sys.executable, PAGE_PY] + [str(a) for a in args], input=stdin, capture_output=True, text=True,
                              encoding='utf-8', timeout=30)

    def test_trailing_newline_stripped(self):
        s2 = self.segs[1]
        r = self.run_cli(['suggest', self.out, '--root', self.root, '--segment', s2, '--category', '衔接', '--original', '-',
                          '--proposed', '他第一句就问我会不会用 AI。', '--reason', '更直接', '--basis-type', 'AI 自己的判断'], '他问我会不会用 AI。\n')
        self.assertEqual(r.returncode, 0, r.stderr)  # 以前 heredoc 多带的换行让原句对不上，报「找不到」
        self.assertEqual(cd.items_of(self.doc(), 'suggestion')[-1]['locked']['original'], '他问我会不会用 AI。')
        r = self.run_cli(['reply', self.out, '--root', self.root, '--item', s2, '--text', '-'], '第一行\n第二行\r\n\n')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(cd.ai_state(self.item(s2))['reply'], '第一行\n第二行', '中间的换行保留，只去掉末尾的')

    def test_only_one_dash(self):
        before = read(self.out)
        r = self.run_cli(['suggest', self.out, '--root', self.root, '--segment', self.segs[1], '--category', '衔接', '--original', '-',
                          '--proposed', '-', '--reason', 'x', '--basis-type', 'AI 自己的判断'], '他问我会不会用 AI。\n')
        self.assertEqual(r.returncode, 1)
        self.assertIn('只能有一个文字参数写成 -', r.stderr)
        self.assertEqual(read(self.out), before)

    def test_help_explains_stdin(self):
        for args in (['-h'], ['suggest', '-h'], ['set-field', '-h'], ['reply', '-h']):
            r = self.run_cli(args, '')
            self.assertEqual(r.returncode, 0, args)
            self.assertIn('末尾的换行会去掉', r.stdout.replace('\n', ''), args)
        self.assertIn("--proposed ''", self.run_cli(['suggest', '-h'], '').stdout, '帮助里写了怎么删整句')


class SetFieldTests(Base):
    def test_mine_refused_without_approval(self):
        s1 = self.segs[0]
        before = read(self.out)
        err = self.fails('set-field', self.out, '--root', self.root, '--item', s1, '--field', 'mine', '--value', 'AI 的版本')
        self.assertIn('「mine」是用户的格子', err)
        self.assertIn('--user-approved', err)
        for iid, field in ((s1, 'note'), (self.sugs[0], 'decision'), (self.info, 'overall_note'), (self.info, 'approved')):
            self.assertIn('是用户的格子', self.fails('set-field', self.out, '--root', self.root, '--item', iid, '--field', field, '--value', 'x'))
        self.assertEqual(read(self.out), before)
        out = self.ok('set-field', self.out, '--root', self.root, '--item', s1, '--field', 'mine', '--value', 'AI 的版本', '--user-approved')
        self.assertIn('已写入', out)
        self.assertEqual(self.item(s1)['fields']['mine'], 'AI 的版本')
        log = bs.read_changes(self.root, self.pid, s1)
        self.assertEqual((log[-1]['origin'], log[-1]['field'], log[-1]['after']), ('brain_page', 'mine', 'AI 的版本'))

    def test_open_fields_and_stale_before(self):
        g1 = self.sugs[0]
        self.ok('set-field', self.out, '--root', self.root, '--item', g1, '--field', 'proposed', '--value', 'AI 换了个改法')
        self.ok('set-field', self.out, '--root', self.root, '--item', 'info', '--field', 'recorded', '--value', '录完的稿')
        self.assertEqual(self.item(g1)['fields']['proposed'], 'AI 换了个改法')
        self.jc_save(g1, 'proposed', '用户先改了')
        err = self.fails('set-field', self.out, '--root', self.root, '--item', g1, '--field', 'proposed', '--value', 'AI 又改', '--before', 'AI 换了个改法')
        self.assertIn('没写', err)
        self.assertIn('用户先改了', err)
        self.assertEqual(self.item(g1)['fields']['proposed'], '用户先改了')
        self.assertIn('没有可改字段「标题」', self.fails('set-field', self.out, '--root', self.root, '--item', g1, '--field', '标题', '--value', 'x'))
        self.assertIn('decision 必须是', self.fails('set-field', self.out, '--root', self.root, '--item', g1, '--field', 'decision',
                                                  '--value', '好', '--user-approved'))


class LockedAndRebaseTests(Base):
    def test_set_locked(self):
        fp = bs.item_fp(cd.info_of(self.doc()))
        self.assertIn('已改条目', self.ok('set-locked', self.out, '--root', self.root, '--item', 'info', '--key', 'stage', '--value', '审稿'))
        info = cd.info_of(self.doc())
        self.assertEqual(info['locked']['stage'], '审稿')
        self.assertNotEqual(bs.item_fp(info), fp)
        self.ok('set-locked', self.out, '--root', self.root, '--item', 'info', '--key', 'narrative', '--json',
                '--value', json.dumps({'story': '新故事', 'audience': '新人群', 'problem': '新问题'}, ensure_ascii=False))
        self.ok('set-locked', self.out, '--root', self.root, '--item', 'info', '--key', 'speech_rate', '--json', '--value', '4.5')
        info = cd.info_of(self.doc())
        self.assertEqual((info['locked']['narrative']['story'], info['locked']['speech_rate']), ('新故事', 4.5))
        self.assertIn('stage 必须是', self.fails('set-locked', self.out, '--root', self.root, '--item', 'info', '--key', 'stage', '--value', '发布'))
        self.assertIn('reply', self.fails('set-locked', self.out, '--root', self.root, '--item', 'info', '--key', 'ai_state', '--value', '{}', '--json'))
        self.assertIn('不是合法 JSON', self.fails('set-locked', self.out, '--root', self.root, '--item', 'info', '--key', 'narrative', '--json', '--value', '{坏'))
        self.assertIn('没有变化', self.ok('set-locked', self.out, '--root', self.root, '--item', 'info', '--key', 'stage', '--value', '审稿'))

    def test_set_locked_original_must_occur_once(self):
        """改建议的原句和 suggest 同一条规矩：新原句在所属段我的版本里恰好一处，否则拒绝、文件不动。"""
        g2, s2 = self.sugs[1], self.segs[1]
        base = ['set-locked', self.out, '--root', self.root, '--item', g2, '--key', 'original', '--value']
        before = read(self.out)
        self.assertIn('找不到', self.fails(*base, '我的版本里没有这句'))
        self.assertIn('出现了 2 次', self.fails(*base, '我'))
        self.assertIn('不能空', self.fails(*base, ' '))
        self.assertEqual(read(self.out), before)
        fp = bs.item_fp(self.item(g2))
        self.assertIn('已改条目', self.ok(*base, '他问我会不会用 AI'))
        self.assertEqual(self.item(g2)['locked']['original'], '他问我会不会用 AI')
        self.assertNotEqual(bs.item_fp(self.item(g2)), fp, '原句在指纹里：用户正在改这条的格子会按冲突处理')
        self.jc_save(s2, 'mine', '第一件事，我去给一个博主当剪辑。')  # 用户把这句删了
        self.assertIn('找不到', self.fails(*base, '他问我会不会用 AI。'))
        self.assertIn('已改条目', self.ok('set-locked', self.out, '--root', self.root, '--item', 'info', '--key', 'original', '--value', '随便'),
                      '页面信息等别的条目的 original 是扩展键，不按建议核对')

    def test_rebase(self):
        s1, s2, s3 = self.segs
        self.ok('rebase', self.out, '--root', self.root, '--item', s1)
        self.assertEqual(self.item(s1)['locked']['baseline'], self.item(s1)['fields']['mine'])
        self.assertNotEqual(self.item(s2)['locked']['baseline'], self.item(s2)['fields']['mine'])
        self.ok('rebase', self.out, '--root', self.root, '--all')
        out = self.ok('read', self.out, '--root', self.root)
        self.assertEqual(out.count('- 和底稿比：没改'), 3)
        self.assertIn('没有变化', self.ok('rebase', self.out, '--root', self.root, '--all'))
        self.assertIn('--all', self.fails('rebase', self.out, '--root', self.root))


class PublishTests(Base):
    """发布文字：逐字稿内容确认后，AI 一次放进标题、封面文字、简介的候选；用户选、改，读回能看出他改了什么。"""
    def pub_file(self, slots):
        p = os.path.join(self.tmp, 'pub.json')
        with open(p, 'w', encoding='utf-8') as f: json.dump({'slots': slots}, f, ensure_ascii=False)
        return p

    def test_publish_read_and_learn(self):
        out = self.ok('read', self.out)
        self.assertNotIn('还没出标题', out)  # 没确认内容时不催
        self.jc_save(self.info, 'approved', '2026-10-01T10:00:00+08:00')
        self.assertIn('还没出标题、封面文字和简介的候选', self.ok('read', self.out))
        f = self.pub_file([{'slot': '标题', 'refs': [{'who': '博主乙', 'text': '蒸馏的保姆级教程', 'stat': '赞 6.3 万'}],
                            'candidates': [{'text': '标题甲', 'angle': '结果型', 'reason': '理由', 'basis': {'type': '参考视频', 'text': '博主乙'}},
                                           {'text': '标题乙', 'reason': '理由'}]},
                           {'slot': '简介', 'candidates': [{'text': '简介甲', 'reason': '理由'}]}])
        self.assertIn('标题 2 个候选（第 1 轮）', self.ok('publish', self.out, '--file', f))
        d = self.doc()
        slot = next(x for x in cd.items_of(d, cd.PUBSLOT) if x['locked']['slot'] == '标题')
        cands = [x for x in cd.items_of(d, cd.PUBCAND) if x['locked']['slot'] == '标题']
        self.assertEqual(slot['fields'], {'final': '', 'note': ''})
        self.assertEqual([c['fields']['text'] for c in cands], ['标题甲', '标题乙'])
        self.assertNotIn('还没出标题', self.ok('read', self.out))
        # 用户选了标题乙，又在「你定的」里加了几个字
        self.jc_save(cands[1]['id'], 'decision', '选用')
        self.jc_save(slot['id'], 'final', '标题乙改过')
        out = self.ok('read', self.out)
        self.assertIn('{++改过++}', out)
        self.assertIn('选用的是 %s' % cands[1]['id'], out)
        # 第二轮只加不删，记轮次
        f2 = self.pub_file([{'slot': '标题', 'candidates': [{'text': '标题丙', 'reason': '按意见重出'}]}])
        self.assertIn('第 2 轮', self.ok('publish', self.out, '--file', f2))
        self.assertEqual(len([x for x in cd.items_of(self.doc(), cd.PUBCAND) if x['locked']['slot'] == '标题']), 3)
        self.assertEqual(self.item(slot['id'])['locked']['refs'][0]['who'], '博主乙')  # 没给 refs 时保留原来的
        # 导出再生成，页面不变
        data = brain_page.export_data(self.doc())
        self.assertEqual(build_page.validate(data)[0], [])

    def test_publish_rules(self):
        self.assertIn('slot 必须是', self.fails('publish', self.out, '--file', self.pub_file([{'slot': '口播', 'candidates': []}])))
        self.assertIn('缺 reason', self.fails('publish', self.out, '--file', self.pub_file([{'slot': '标题', 'candidates': [{'text': 'x'}]}])))
        self.ok('publish', self.out, '--file', self.pub_file([{'slot': '标题', 'candidates': [{'text': 'x', 'reason': 'y'}]}]))
        slot = cd.items_of(self.doc(), cd.PUBSLOT)[0]
        cand = cd.items_of(self.doc(), cd.PUBCAND)[0]
        self.assertIn('用户的格子', self.fails('set-field', self.out, '--item', slot['id'], '--field', 'final', '--value', 'z'))
        self.assertIn('选用', self.fails('set-field', self.out, '--item', cand['id'], '--field', 'decision', '--value', '采纳', '--user-approved'))
        self.jc_save(slot['id'], 'note', '再冲一点')
        self.assertIn('发布文字「标题」', self.ok('read', self.out))
        self.ok('reply', self.out, '--item', slot['id'], '--text', '出了第二轮')
        self.assertFalse(cd.note_pending(self.item(slot['id'])))


class LocateTests(Base):
    def test_by_page_id_content_id_and_path(self):
        self.assertIn(self.pid, self.ok('read', self.pid, '--root', self.root))
        self.assertIn(self.pid, self.ok('--root', self.root, 'read', 'T901'))  # --root 写在子命令前面也行
        self.assertIn(self.pid, self.ok('read', self.out))  # 不给根目录：问页面里写的保存服务
        self.assertIn('找不到文件', self.fails('read', self.pid))
        self.assertIn('找到 0 个', self.fails('read', 'T404', '--root', self.root))
        self.assertIn('T901  创作页  page_id=%s' % self.pid, self.ok('list', '--root', self.root))

    def test_root_via_locks_when_service_gone(self):
        self.stop_server()
        shutil.rmtree(os.path.join(self.root, '.jc-locks'), ignore_errors=True)
        self.assertIn('找不到工作文件夹', self.fails('read', self.out))
        os.makedirs(os.path.join(self.root, '.jc-locks'))
        self.assertIn('从页面往上找到的 .jc-locks', self.ok('read', self.out))

    def test_duplicate_or_foreign_copy_refused(self):
        outside = os.path.join(self.tmp, '别处', 'T901_创作页.html')
        os.makedirs(os.path.dirname(outside))
        shutil.copy2(self.out, outside)
        self.assertIn('不是保存服务认的那份', self.fails('reply', outside, '--root', self.root, '--item', self.segs[0], '--text', 'x'))
        dup = os.path.join(self.root, 'T901_副本', 'T901_创作页.html')
        os.makedirs(os.path.dirname(dup))
        shutil.copy2(self.out, dup)
        before = read(self.out)
        self.assertIn('同时出现在 2 份文件里', self.fails('reply', self.out, '--root', self.root, '--item', self.segs[0], '--text', 'x'))
        self.assertEqual(read(self.out), before)

    def test_real_cli_process(self):
        r = subprocess.run([sys.executable, PAGE_PY, 'set-field', self.out, '--root', self.root, '--item', self.segs[0], '--field', 'mine', '--value', 'x'],
                           capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(r.returncode, 1)
        self.assertIn('失败：「mine」是用户的格子', r.stderr)
        r = subprocess.run([sys.executable, PAGE_PY, 'reply', self.out, '--root', self.root, '--item', self.segs[1], '--text', '-'],
                           input='从标准输入读的回复', capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(cd.ai_state(self.item(self.segs[1]))['reply'], '从标准输入读的回复')


if __name__ == '__main__':
    unittest.main()
