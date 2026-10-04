// 创作页界面的浏览器自测：每个场景自己生成测试页、在临时端口起保存服务（server/brain_save.py）、开无头 Chrome，测完全部关掉。
// 用法：node tests/browser/ui_scenarios.mjs <场景名>      列出场景：node tests/browser/ui_scenarios.mjs
// 退出码 0 = 全部通过，1 = 有断言失败，2 = 场景名不对，3 = 超时
import fs from 'node:fs';
import path from 'node:path';
import {
  APP, TMP, PY, py, sleep, freshDir, freePort, launchChrome, startServer, stopServer, buildPage, fileUrl, docOf, fieldOf, waitFor, waitReady, checker,
} from './ui_cdp.mjs';

const FIXTURE = path.join(APP, 'tests', 'fixtures', 'ui_small.json');
const S = {};
const q = s => JSON.stringify(s);
const mineSel = id => `document.querySelector('textarea.mine[data-item=${q(id)}]')`;
const noteSel = id => `document.querySelector('textarea.note[data-item=${q(id)}]')`;
const cardSel = id => `document.querySelector('.card[data-sug=${q(id)}]')`;
const COUNTED = /[\p{Script=Han}\p{L}\p{N}]/gu;
const chars = t => (String(t).match(COUNTED) || []).length;

async function setup(name, c, opts = {}) {
  const dir = freshDir(name), root = path.join(dir, 'brain'), port = await freePort();
  const file = path.join(root, '内容草稿', 'T990_界面自测', 'T990_创作页.html');
  let data = FIXTURE;
  if (opts.mutate) { // 在小样数据上改一点（例如换阶段）再生成
    const d = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    opts.mutate(d);
    data = path.join(dir, 'data.json');
    fs.writeFileSync(data, JSON.stringify(d));
  }
  const pg = buildPage(data, file, port);
  const srv = await startServer(root, port), br = await launchChrome(name), p = br.first;
  await p.viewport(opts.width || 1440, opts.height || 900, !!opts.mobile);
  await br.grantClipboard(`http://127.0.0.1:${port}`);
  await p.go(`http://127.0.0.1:${port}/p/${pg.page_id}`);
  await waitReady(p);
  return { dir, root, port, file, pg, srv, br, p, url: `http://127.0.0.1:${port}/p/${pg.page_id}` };
}
async function teardown(t) { t.br.close(); await stopServer(t.srv); }
async function focusEnd(p, sel) { return p.ev(`(function(){var t=${sel};t.scrollIntoView({block:'center'});t.focus();t.setSelectionRange(t.value.length,t.value.length);return document.activeElement===t;})()`); }
async function selectIn(p, sel, text) { // 在文本框里选中一段文字（之后 insertText 就是替换它）
  return p.ev(`(function(){var t=${sel};var i=t.value.indexOf(${q(text)});if(i<0)return false;t.focus();t.setSelectionRange(i,i+${q(text)}.length);return true;})()`);
}
async function blur(p) { await p.ev('document.activeElement && document.activeElement.blur && document.activeElement.blur(), true'); }
async function drag(p, sel, dx) { // 真的用鼠标拖选：从元素左上角附近往右拖 dx 像素
  const r = await p.ev(`(function(){var e=${sel};e.scrollIntoView({block:'center'});var b=e.getBoundingClientRect();return {x:b.left+14,y:b.top+18};})()`);
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 5; i++) await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + dx * i / 5, y: r.y, button: 'left', buttons: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x + dx, y: r.y, button: 'left', clickCount: 1 });
}
const cmdZ = (p, shift) => p.key('z', 'KeyZ', 4 | (shift ? 8 : 0), 90);
function changesOf(root, pid) {
  const f = path.join(root, '.jc-changes', pid + '.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
}

// 主流程：改我的版本写回、选中文字写给 AI、采纳（两格同组写入）、撤销与重做、原句被改后采纳变灰、R 不采纳、
// 通读视图 5 秒线、复制提词稿、改动记录与「恢复此版本」、复制给 AI、内容已确认
S.flow = async (c) => {
  const t = await setup('flow', c), { p, file, root, pg } = t;
  const [s1, s2, s3] = pg.ids.segs, [g1, g2, g3, g4] = pg.ids.sugs;
  try {
    const bar = await p.bar();
    c.ok(bar && bar.inline, '保存状态画在顶栏里（不是钉在页面最上面的单独一条）', bar);
    c.ok(await waitFor(async () => (await p.bar()).state === 'green', 5000), '状态变绿', await p.bar());
    c.ok(await p.ev(`${mineSel(s1)}.readOnly === false && !document.querySelector('[data-jc-wait]')`), 'kit 就绪后格子全部解锁');
    c.ok(await p.ev(`document.querySelector('.narrative').textContent.includes('一个普通上班族靠会用 AI')`), '叙事卡默认展开，显示讲了个什么故事');
    c.ok(await p.ev(`document.querySelector('.c-sug').textContent`) === '4 条待确认', '顶栏「4 条待确认」', await p.ev(`document.querySelector('.c-sug').textContent`));
    c.ok(await p.ev(`document.querySelectorAll('.seg.current').length === 1 && document.querySelector('.seg.current').dataset.seg === ${q(s1)}`), '默认一次只显示一段（第 1 段）');
    c.ok(await p.ev(`document.querySelector('#seg-${s1} .role').textContent`) === '开头：一句钩子，一句观点', '段标题旁显示这段的作用');
    c.ok(await p.ev(`document.querySelectorAll('#seg-${s1} .ref').length === 2 && !!document.querySelector('#seg-${s1} .ref .watch')`), '两家参考上下堆叠，带「看原片」');
    c.ok(await p.ev(`document.querySelectorAll('#seg-${s1} .mine-back .same').length > 0 && document.querySelectorAll('#seg-${s1} .ref-text .same').length > 0`), '我的版本和参考连续 8 字相同的地方加了点线下划线');
    c.ok(await p.ev(`document.querySelector('#seg-${s1} .count').textContent`) === `${chars(fieldOf(file, s1, 'mine'))} 字 · 约 ${Math.round(chars(fieldOf(file, s1, 'mine')) / 4)} 秒`, '每段字数与秒数', await p.ev(`document.querySelector('#seg-${s1} .count').textContent`));
    c.ok(await p.ev(`document.querySelector('#seg-${s1} .vs-base summary').textContent.includes('删')`), '我的版本下方显示和底稿比的删改');

    // 1. 改我的版本写回
    await focusEnd(p, mineSel(s1)); await p.type('【用户加的】');
    c.ok(await waitFor(() => fieldOf(file, s1, 'mine').endsWith('【用户加的】'), 6000), '改我的版本：停笔 1 秒后写回文件');
    await blur(p);
    c.ok((await p.ev('jcApp.state().undo')) === 1, '离开格子后，这次打字记成一步撤销');

    // 2. 选中参考文字 → 写给 AI
    await drag(p, `document.querySelector('#seg-${s1} .ref-text')`, 180);
    const sel = await p.ev('window.getSelection().toString()');
    c.ok(await waitFor(() => p.ev(`!document.querySelector('.sel-pop').hidden`), 2000), '在参考里拖选文字后浮出「写给 AI」', sel);
    const y0 = await p.ev('scrollY');
    await p.click(`document.querySelector('.sel-pop button')`);
    c.ok(await waitFor(() => p.ev(`!document.querySelector('.composer').hidden && document.activeElement === document.querySelector('.cp-text')`), 2000), '点「写给 AI」：原文旁边打开批注框，光标在框里');
    c.ok(await p.ev('scrollY') === y0, '打开批注框时页面不滚动（原文还在原处）', { y0, y1: await p.ev('scrollY') });
    c.ok(await p.ev(`(function(){var c=document.querySelector('.composer').getBoundingClientRect();return c.top>=0&&c.bottom<=innerHeight;})()`), '批注框整个在屏幕里');
    c.ok(await p.ev(`CSS.highlights.has('jc-quote') && document.querySelector('.cp-quote').textContent.startsWith('原句：「')`), '选中的原句标黄，批注框顶上引着原句');
    c.ok(!fieldOf(file, s1, 'note'), '还没点保存：文件里的「写给 AI 的话」没有变');
    await p.type('这句太长了，能不能短一点？');
    await p.key('Enter', 'Enter', 4, 13); // ⌘ Enter 保存
    c.ok(await waitFor(() => fieldOf(file, s1, 'note') === '原句：「' + sel.replace(/\s+/g, ' ').trim() + '」\n这句太长了，能不能短一点？', 6000), '⌘ Enter：原句和写的话一起写回这段的「写给 AI 的话」', fieldOf(file, s1, 'note'));
    c.ok(await p.ev(`document.querySelector('.composer').hidden && !CSS.highlights.has('jc-quote')`), '保存后批注框关上，黄色标记去掉');
    c.ok(await p.ev('scrollY') === y0, '保存后页面也不滚动');
    c.ok(await waitFor(() => p.ev(`document.querySelector('.c-note').textContent === '1 条待 AI 处理' && document.querySelector('#seg-${s1} .note-status').textContent === '待 AI 处理'`), 3000), '顶栏「1 条待 AI 处理」，便签标「待 AI 处理」');
    // 在我的版本里拖选
    await drag(p, mineSel(s1), 120);
    const selMine = await p.ev(`(function(){var t=${mineSel(s1)};return t.value.slice(t.selectionStart,t.selectionEnd);})()`);
    c.ok(selMine.length > 0 && await waitFor(() => p.ev(`!document.querySelector('.sel-pop').hidden`), 2000), '在我的版本里拖选也浮出「写给 AI」', selMine);
    await p.click(`document.querySelector('.sel-pop button')`);
    c.ok(await waitFor(() => p.ev(`!document.querySelector('.composer').hidden && document.querySelector('#seg-${s1} .mine-back .quote-mark') && document.querySelector('#seg-${s1} .mine-back .quote-mark').textContent === ${q(selMine)}`), 2000), '我的版本里选的也打开批注框，原句在文本框底层标黄');
    await p.type('这里换个说法');
    await p.click(`document.querySelector('.composer .btn.primary')`);
    c.ok(await waitFor(() => fieldOf(file, s1, 'note').endsWith('\n\n原句：「' + selMine.replace(/\s+/g, ' ').trim() + '」\n这里换个说法'), 6000), '点「保存」：追加在已有的话后面，中间空一行', fieldOf(file, s1, 'note'));
    c.ok(await p.ev(`document.querySelector('.composer').hidden && !document.querySelector('.mine-back .quote-mark')`), '保存后我的版本底层的黄色标记也去掉');
    await blur(p);

    // 3. 采纳：mine 和 decision 同组写入
    const before1 = fieldOf(file, s1, 'mine');
    await p.click(`${cardSel(g1)}.querySelector('.yes')`);
    const ok3 = await waitFor(() => fieldOf(file, g1, 'decision') === '采纳' && fieldOf(file, s1, 'mine').includes('我自己都觉得像做梦'), 6000);
    c.ok(ok3, '采纳：我的版本换进新句子，决定写成「采纳」', { mine: fieldOf(file, s1, 'mine'), decision: fieldOf(file, g1, 'decision') });
    const logs = changesOf(root, pg.page_id), pair = logs.filter(l => (l.item === s1 && l.field === 'mine' && l.after.includes('像做梦')) || (l.item === g1 && l.field === 'decision'));
    c.ok(pair.length === 2 && pair[0].group && pair[0].group === pair[1].group, '改动记录里这两格是同一组提交的', pair.map(x => [x.field, x.group]));
    c.ok(await p.ev(`${cardSel(g1)}.classList.contains('is-adopted') && !${cardSel(g1)}.querySelector('.card-actions.done').hidden`), '卡片变成「已采纳」，出现「撤销决定」');

    // 4. 撤销（⌘Z）与重做
    await blur(p); await p.ev('document.body.focus(), true');
    await cmdZ(p, false);
    c.ok(await waitFor(() => fieldOf(file, g1, 'decision') === '' && fieldOf(file, s1, 'mine') === before1, 6000), '⌘Z 撤销采纳：两格都改回旧值', { mine: fieldOf(file, s1, 'mine'), decision: fieldOf(file, g1, 'decision') });
    c.ok(await waitFor(() => p.ev(`!document.querySelector('.redo-btn').disabled && document.querySelector('.redo-btn').title.includes('采纳第 1 段')`), 2000), '撤销以后「更多」里的「重做」可以点，悬停写着要重做哪一步');
    await cmdZ(p, true);
    c.ok(await waitFor(() => fieldOf(file, g1, 'decision') === '采纳' && fieldOf(file, s1, 'mine').includes('像做梦'), 6000), '⇧⌘Z 重做采纳');

    // 5. 原句被改后，采纳变灰
    await p.key('j', 'KeyJ', 0, 74);
    c.ok(await waitFor(() => p.ev(`document.querySelector('.seg.current').dataset.seg === ${q(s2)}`), 2000), 'J 键翻到下一段');
    c.ok(await p.ev(`!${cardSel(g2)}.hidden && !${cardSel(g3)}.hidden && document.querySelector('#seg-${s2} .sug-hidden').hidden`), '写稿阶段默认显示全部类别：「表达」那条也在，没有「按类别筛掉了」');
    c.ok(await p.ev(`${cardSel(g2)}.querySelector('.yes').disabled === false`), '原句还在时可以采纳');
    await selectIn(p, mineSel(s2), '结果，他在'); await p.type('结果呢，他在');
    c.ok(await waitFor(() => p.ev(`${cardSel(g2)}.querySelector('.yes').disabled && ${cardSel(g2)}.querySelector('.miss').textContent === '这句你已经改过，这条建议对不上了'`), 3000), '原句被改后采纳按钮变灰，写明对不上了');
    c.ok(await waitFor(() => fieldOf(file, s2, 'mine').includes('结果呢，他在'), 6000), '改动照样写回');
    await blur(p);
    // 6. R 键不采纳（当前选中的卡是「表达」那条：衔接那条已对不上，A 会提示）
    await p.ev(`${cardSel(g3)}.click(), true`);
    await p.key('r', 'KeyR', 0, 82);
    c.ok(await waitFor(() => fieldOf(file, g3, 'decision') === '不采纳', 6000), 'R 键不采纳：只写决定一格');
    c.ok(fieldOf(file, s2, 'mine').includes('有一个大几百万粉丝的博主'), '不采纳不动我的版本');

    // 7. 通读视图：开头 5 秒线在第 20 字
    await p.click(`document.querySelector('.seg-switch button:nth-child(2)')`);
    c.ok(await p.ev(`!document.querySelector('.reading-view').hidden && document.querySelector('.compare-view').hidden`), '切到通读视图');
    const before5 = await p.ev(`(function(){var m=document.querySelector('.five-sec');if(!m)return null;var r=document.createRange();var t=[...document.querySelectorAll('.r-text')],out='';for(var i=0;i<t.length;i++){if(t[i].contains(m)){r.setStart(t[i],0);r.setEndBefore(m);return out+r.toString();}out+=t[i].textContent;}return null;})()`);
    c.ok(before5 !== null && chars(before5) === 20, '开头 5 秒线画在第 20 个字后面（每秒 4 字）', before5 && before5.slice(-12));
    c.ok(await p.ev(`document.querySelectorAll('.r-seg').length === 3 && !!document.querySelector('textarea.recorded')`), '全文按段连成一栏，底部有「录完的定稿贴这里」');

    // 8. 复制提词稿
    await p.click(`document.querySelector('.copy-tele')`);
    await sleep(400);
    const clip = await p.ev('navigator.clipboard.readText()');
    const expect = pg.ids.segs.map(id => fieldOf(file, id, 'mine').split('\n').map(l => l.trim()).filter(Boolean).join('\n')).filter(Boolean).join('\n');
    c.ok(clip === expect, '复制提词稿：按段顺序只有我的版本正文', { clip: clip.slice(0, 40) });
    c.ok(!/\n\s*\n/.test(clip) && clip.split('\n').length >= 4, '提词稿没有空行、保留换行', clip.split('\n').length);

    // 9. 改动记录：两分钟内合并算一版，「恢复此版本」改回（先塞一条 10 分钟前的旧记录，模拟更早的一版）
    const old = { time: new Date(Date.now() - 10 * 60 * 1000).toISOString().replace(/\.\d+Z$/, '+00:00'), change_id: 'old1', item: s1, field: 'mine', before: fieldOf(file, s1, 'mine'), after: '十分钟前的旧版本。', origin: 'brain_page' };
    const lf = path.join(root, '.jc-changes', pg.page_id + '.jsonl');
    fs.writeFileSync(lf, JSON.stringify(old) + '\n' + fs.readFileSync(lf, 'utf8'));
    await p.click(`document.querySelector('.seg-switch button:nth-child(1)')`);
    await p.ev('jcApp.goSeg(0, true), true');
    await p.click(`document.querySelector('#seg-${s1} .seg-head .btn')`);
    c.ok(await waitFor(() => p.ev(`document.querySelectorAll('#seg-${s1} .hist-panel .ver:not(.base)').length === 2`), 4000), '改动记录：两分钟内的保存合并成一版，更早的单独一版',
      await p.ev(`[...document.querySelectorAll('#seg-${s1} .hist-panel .ver-head')].map(x => x.textContent)`));
    c.ok(await p.ev(`document.querySelector('#seg-${s1} .hist-panel .ver').classList.contains('now')`), '最新那一版标「当前」');
    await p.click(`[...document.querySelectorAll('#seg-${s1} .hist-panel .ver:not(.base) .btn.small:not(.ghost)')].find(b => b.textContent === '恢复此版本')`);
    c.ok(await waitFor(() => fieldOf(file, s1, 'mine') === '十分钟前的旧版本。', 6000), '「恢复此版本」把我的版本改回那一版并保存到文件');
    c.ok(await waitFor(() => p.ev(`${cardSel(g1)}.querySelector('.card-actions.done') && !${cardSel(g1)}.querySelector('.card-actions.done').hidden`), 2000), '已采纳的卡片保持「已采纳」');
    await cmdZ(p, false);
    c.ok(await waitFor(() => fieldOf(file, s1, 'mine').includes('像做梦'), 6000), '「恢复此版本」也能撤销');

    // 10. 复制给 AI、内容已确认
    const md = await p.ev('jcApp.aiMarkdown()');
    c.ok(md.includes('page_id：' + pg.page_id) && md.includes('原句：「') && (md.includes('{~~') || md.includes('{--')), '复制给 AI：带 page_id、待处理的话（含原句）、和底稿比的删改', md.slice(0, 80));
    c.ok(md.includes('：采纳。') && md.includes('：不采纳。') && md.includes('还没定'), '复制给 AI：列出各建议的决定');
    await p.click(`document.querySelector('.btn.approve')`);
    c.ok(await waitFor(() => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(fieldOf(file, pg.ids.info, 'approved')), 6000), '「内容已确认」写进页面信息（带时间）', fieldOf(file, pg.ids.info, 'approved'));
    c.ok(await p.ev(`document.querySelector('.btn.approve').getAttribute('aria-pressed') === 'true'`), '按钮变成已认状态');
    c.ok(p.errors.length === 0 && p.logs.length === 0, '页面没有脚本报错', p.errors.concat(p.logs));
  } finally { await teardown(t); }
};

// AI 写回复（ai_state）不让用户正在改的格子冲突；回复后显示「AI 已处理」，用户再改变回「待处理」
S.reply = async (c) => {
  const t = await setup('reply', c), { p, file, root, pg } = t;
  const [s1] = pg.ids.segs;
  try {
    await focusEnd(p, noteSel(s1)); await p.type('开头能不能更狠一点？');
    c.ok(await waitFor(() => fieldOf(file, s1, 'note') === '开头能不能更狠一点？', 6000), '先写一条给 AI 的话');
    await focusEnd(p, noteSel(s1)); await p.type('再短一点');
    py([path.join(APP, 'brain_page.py'), '--root', root, 'reply', file, '--item', s1, '--text', '已改成一条新建议，见第 1 段。']); // AI 在用户打字时回复
    c.ok(await waitFor(() => fieldOf(file, s1, 'note') === '开头能不能更狠一点？再短一点', 6000), 'AI 写回复的同时用户接着打的字照样写回，没有冲突', fieldOf(file, s1, 'note'));
    c.ok((await p.ev('jcKit.state().conflicts')) === 0, '暂存里没有冲突');
    await p.ev('window.__m = 1'); await blur(p);
    c.ok(await waitFor(async () => (await p.ev('window.__m')) === undefined && await p.ev('!!(window.jcKit && jcKit.ready && window.jcApp)'), 12000), '停笔后页面自动重新加载，跟上 AI 的回复');
    await waitReady(p);
    c.ok(await p.ev(`document.querySelector('#seg-${s1} .ai-reply').textContent.includes('已改成一条新建议')`), '显示 AI 的回复');
    c.ok(await p.ev(`document.querySelector('#seg-${s1} .note-status').textContent`) === '待 AI 处理', 'AI 回复时抄下的是旧话，用户后来又加了字，所以仍是「待 AI 处理」');
    py([path.join(APP, 'brain_page.py'), '--root', root, 'reply', file, '--item', s1, '--text', '这次两句都看了。']);
    await p.ev('window.__m = 1');
    c.ok(await waitFor(async () => (await p.ev('window.__m')) === undefined && await p.ev('!!(window.jcKit && jcKit.ready && window.jcApp)'), 12000), 'AI 再回复后页面重新加载');
    await waitReady(p);
    c.ok(await waitFor(() => p.ev(`document.querySelector('#seg-${s1} .note-status').textContent === 'AI 已处理' && document.querySelector('.c-note').textContent === '0 条待 AI 处理'`), 3000), '便签变成「AI 已处理」，顶栏待 AI 处理数变 0');
    await focusEnd(p, noteSel(s1)); await p.type('！');
    c.ok(await waitFor(() => p.ev(`document.querySelector('#seg-${s1} .note-status').textContent === '待 AI 处理'`), 2000), '用户再改便签，自动变回「待 AI 处理」');
    c.ok(p.errors.length === 0, '页面没有脚本报错', p.errors);
  } finally { await teardown(t); }
};

// 同组冲突：AI 改了这段我的版本，页面还拿着旧值去采纳 → 整组不写，两格一起摆出来，一起放弃或一起换回
S.group = async (c) => {
  const t = await setup('group', c), { p, file, root, pg } = t;
  const [, s2] = pg.ids.segs, [, g2] = pg.ids.sugs;
  try {
    await p.key('j', 'KeyJ', 0, 74);
    await focusEnd(p, noteSel(s2)); await p.type('先占住');
    const aiMine = fieldOf(file, s2, 'mine') + '（AI 补的一句）';
    py([path.join(APP, 'brain_page.py'), '--root', root, 'set-field', file, '--item', s2, '--field', 'mine', '--value', aiMine, '--user-approved']);
    await p.click(`${cardSel(g2)}.querySelector('.yes')`);
    c.ok(await waitFor(() => p.ev(`!!document.querySelector('#seg-${s2} .jc-kit-gbox')`), 12000), '整组冲突框出现在这段我的版本下面');
    c.ok(fieldOf(file, g2, 'decision') === '' && fieldOf(file, s2, 'mine') === aiMine, '整组都没写：决定还是空，我的版本是 AI 的版本', { d: fieldOf(file, g2, 'decision') });
    const txt = await p.ev(`document.querySelector('#seg-${s2} .jc-kit-gbox').textContent`);
    c.ok(txt.includes('2 处内容') && txt.includes('我的版本') && txt.includes('决定'), '冲突框用大白话写出是哪两处内容', txt.slice(0, 90));
    c.ok(await p.ev(`${mineSel(s2)}.readOnly && ${mineSel(s2)}.value === ${q(aiMine)}`), '冲突时格子里显示文件里的版本并锁住');
    await p.click(`[...document.querySelectorAll('#seg-${s2} .jc-kit-gbox button')].find(b => b.textContent.startsWith('整组放弃改动'))`);
    c.ok(await waitFor(() => p.ev(`!document.querySelector('.jc-kit-gbox') && jcKit.state().conflicts === 0`), 4000), '选「整组放弃改动」：冲突框消失，暂存清掉');
    c.ok(await waitFor(() => p.ev(`${mineSel(s2)}.readOnly === false && !${cardSel(g2)}.querySelector('.yes').disabled`), 4000), '格子解锁，建议卡回到待定、还能采纳（AI 的版本里原句还在）');
    await p.click(`${cardSel(g2)}.querySelector('.yes')`);
    c.ok(await waitFor(() => fieldOf(file, g2, 'decision') === '采纳' && fieldOf(file, s2, 'mine').includes('（AI 补的一句）') && fieldOf(file, s2, 'mine').includes('只回了我三个字'), 6000), '重新采纳：换进新句子，AI 补的那句还在');
    c.ok(p.errors.length === 0, '页面没有脚本报错', p.errors);
  } finally { await teardown(t); }
};

// 先改再采纳（改过的「改成」和我的版本、决定同组写入）、像稿子的便签挪进我的版本（两格一起）、复制失败弹全选好的文本框、服务不在时的改动记录
S.more = async (c) => {
  const t = await setup('more', c), { p, file, pg } = t;
  const [s1, , s3] = pg.ids.segs, [, , , g4] = pg.ids.sugs;
  try {
    // 先改再采纳
    await p.ev('jcApp.goSeg(2, true), true');
    await p.click(`[...${cardSel(g4)}.querySelectorAll('button')].find(b => b.textContent === '先改再采纳')`);
    c.ok(await p.ev(`document.activeElement === ${cardSel(g4)}.querySelector('textarea.proposed')`), '「先改再采纳」把光标放进「改成」');
    await p.ev(`${cardSel(g4)}.querySelector('textarea.proposed').select(), true`);
    await p.type('先把 AI 用在你每天都做的一件事上');
    await p.click(`${cardSel(g4)}.querySelector('.yes')`);
    c.ok(await waitFor(() => fieldOf(file, g4, 'decision') === '采纳' && fieldOf(file, s3, 'mine').includes('先把 AI 用在你每天都做的一件事上') && fieldOf(file, g4, 'proposed') === '先把 AI 用在你每天都做的一件事上', 6000),
      '改过的句子换进我的版本，「改成」和「决定」也写回', { mine: fieldOf(file, s3, 'mine'), proposed: fieldOf(file, g4, 'proposed') });
    await blur(p); await p.ev('document.body.focus(), true');
    await cmdZ(p, false);
    c.ok(await waitFor(() => fieldOf(file, g4, 'decision') === '' && fieldOf(file, s3, 'mine').includes('先把 AI 用起来'), 6000), '撤销采纳：我的版本和决定退回，「改成」保留你改的措辞', fieldOf(file, g4, 'proposed'));
    // 像稿子的便签
    await p.ev('jcApp.goSeg(0, true), true');
    const draft = '其实我最想讲的是那天早上收到回复的感觉，酒店里天刚亮，脑袋昏昏沉沉，看到三个字的时候整个人都醒了，这种反差才是这一段最有画面感的地方。';
    await focusEnd(p, noteSel(s1)); await p.type(draft);
    c.ok(await waitFor(() => p.ev(`!document.querySelector('#seg-${s1} .draft-hint').hidden`), 2000), '便签写得像稿子（超过 60 字、没问句、没「你」）时提示要不要挪进我的版本');
    const mineBefore = await p.ev(`${mineSel(s1)}.value`);
    await p.click(`[...document.querySelectorAll('#seg-${s1} .draft-hint button')].find(b => b.textContent === '挪进我的版本')`);
    c.ok(await waitFor(() => fieldOf(file, s1, 'mine') === mineBefore + '\n' + draft && fieldOf(file, s1, 'note') === '', 6000), '「挪进我的版本」：我的版本末尾加上这段、便签清空，两格一起写回');
    // 复制失败：弹出全选好的文本框
    await p.ev(`navigator.clipboard.writeText = () => Promise.reject(new Error('不让复制')); document.execCommand = () => false; true`);
    await p.click(`document.querySelector('.copy-tele')`);
    c.ok(await waitFor(() => p.ev(`(function(){var t=document.querySelector('.manual textarea');return !!t && document.activeElement===t && t.selectionStart===0 && t.selectionEnd===t.value.length && t.value===jcApp.teleprompterText();})()`), 2000), '复制失败时弹出文本框，提词稿已经全选好');
    await p.click(`document.querySelector('.manual .btn')`);
    // 服务不在时的改动记录
    await stopServer(t.srv);
    await p.click(`document.querySelector('#seg-${s1} .seg-head .btn')`);
    c.ok(await waitFor(() => p.ev(`(document.querySelector('#seg-${s1} .hist-off')||{}).textContent`).then(x => x && x.startsWith('无法读取改动记录（保存服务未连接）')), 8000), '服务不在：改动记录写明无法读取、先显示和 AI 交稿版相比的改动');
    c.ok(await p.ev(`!!document.querySelector('#seg-${s1} .hist-panel .diff ins')`), '和底稿比的删改照样显示');
    c.ok(p.errors.length === 0, '页面没有脚本报错', p.errors);
  } finally { await teardown(t); }
};

// 版式：用户多在客户端右侧约 650（有时 380）宽的面板里看，也会整窗 1280 看。
// 钉住的顶栏：1440、1280 宽不超过 129 像素（改版前的高度），650 宽不超过 100，380 宽不超过 110；都不横向滚动；
// 窄屏第一屏看得到第 1 段的参考和我的版本开头；段落条只有段号、不折行；保存状态收成圆点，点开看全文；「更多」菜单能用；
// 宽屏「内容已确认」带上日期后第二行也不折行；服务断开变黄时圆点旁必须有字。截图留给人看
const stickyOf = p => p.ev(`(function(){var t=document.querySelector('.topbar');return {pos:getComputedStyle(t).position,h:Math.round(t.getBoundingClientRect().height)};})()`);
const noHScroll = p => p.ev('({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})');
const visible = sel => `(function(){var e=${sel};if(!e)return false;var r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';})()`;
S.layout = async (c) => {
  const t = await setup('layout', c), { p, dir, url, file, pg } = t;
  const [s1] = pg.ids.segs;
  try {
    for (const [w, hgt, limit, compact] of [[1440, 900, 129, false], [1280, 800, 129, false], [650, 820, 100, true], [380, 820, 110, true]]) {
      await p.viewport(w, hgt, false);
      await p.go(url); await waitReady(p); // 按这个宽度重新打开：叙事卡默认展开还是收起按打开时的宽窄定
      await p.ev('jcApp.setView("compare"), jcApp.goSeg(0, false), window.scrollTo(0, 0), true');
      await sleep(300);
      c.ok((await p.ev('jcApp.state().compact')) === compact, `${w} 宽用${compact ? '窄屏两行细条' : '宽屏三行'}顶栏`);
      const st = await stickyOf(p);
      c.ok(st.pos === 'sticky' && st.h <= limit, `${w} 宽顶栏钉住、高 ${st.h} 像素（不超过 ${limit}）`, st);
      await p.ev('window.scrollTo(0, 500), true'); await sleep(200);
      const top = await p.ev(`Math.round(document.querySelector('.topbar').getBoundingClientRect().top)`);
      c.ok(top === 0, `${w} 宽往下滚以后顶栏还钉在最上面`, top);
      await p.ev('window.scrollTo(0, 0), true'); await sleep(150);
      let o = await noHScroll(p);
      c.ok(o.sw <= o.cw, `${w} 宽对照视图不横向滚动`, o);
      await p.shot(path.join(dir, `对照_${w}.png`));
      if (compact) {
        const first = await p.ev(`(function(){var s=document.querySelector('#seg-${s1}');var r=s.querySelector('.ref').getBoundingClientRect(),m=s.querySelector('textarea.mine').getBoundingClientRect();return {ref:Math.round(r.top),mine:Math.round(m.top),vh:innerHeight};})()`);
        c.ok(first.ref < first.vh - 60 && first.mine + 40 < first.vh, `${w} 宽第一屏看得到第 1 段的参考和我的版本开头`, first);
        c.ok(await p.ev(`document.querySelector('.narr-toggle').getAttribute('aria-expanded') === 'false'`), `${w} 宽叙事卡默认收起，不钉住`);
        c.ok(await p.ev(`(function(){var b=[...document.querySelectorAll('.segnav .nav-btn')];return b.length===3&&b.every(x=>x.offsetTop===b[0].offsetTop)&&b.every(x=>getComputedStyle(x.querySelector('.nav-t')).display==='none');})()`), `${w} 宽段落条只有段号、一行不折`);
        c.ok(await p.ev(`(function(){var n=document.querySelector('.segnav');return getComputedStyle(n).overflowX==='auto'&&getComputedStyle(n).flexWrap==='nowrap';})()`), `${w} 宽段落条横向滚动`);
        c.ok(await p.ev(`${visible("document.querySelector('.save-ind')")} && !${visible("document.querySelector('.save-slot')")} && document.querySelector('.save-short').hidden`), `${w} 宽保存状态收成圆点（绿色时不带字）`);
        c.ok(await p.ev(`document.querySelector('.save-ind').title.includes('保存服务') || document.querySelector('.save-ind').title.includes('已保存')`), `${w} 宽悬停圆点能看到全文`, await p.ev(`document.querySelector('.save-ind').title`));
        c.ok(await p.ev(`document.querySelector('.c-sug').textContent === '4 条待确认' && getComputedStyle(document.querySelector('.c-sug .c-unit')).display === 'none' && document.querySelector('.c-sug .c-label').getBoundingClientRect().left < document.querySelector('.c-sug b').getBoundingClientRect().left && document.querySelector('.c-note .c-label').getBoundingClientRect().left < document.querySelector('.c-note b').getBoundingClientRect().left`), `${w} 宽计数排成「待确认 4」「待 AI 处理 N」`);
        await p.click(`document.querySelector('.save-ind')`);
        c.ok(await waitFor(() => p.ev(`${visible("document.querySelector('.save-slot .jc-kit-bar')")} && document.querySelector('.save-slot .jc-kit-msg').textContent.length > 4`), 1500), `${w} 宽点圆点弹出保存状态全文`);
        await p.click(`document.querySelector('#seg-${s1} .seg-head h2')`);
        c.ok(await waitFor(() => p.ev(`!${visible("document.querySelector('.save-slot')")}`), 1500), `${w} 宽点别处收起保存状态`);
        // 「更多」菜单
        c.ok(await p.ev(`!${visible("document.querySelector('.more-menu')")} && !${visible("document.querySelector('.btn.approve')")}`), `${w} 宽「更多」菜单默认收着`);
        await p.click(`document.querySelector('.more-toggle')`);
        const menu = await p.ev(`(function(){var m=document.querySelector('.more-menu'),r=m.getBoundingClientRect(),t=m.textContent;return {vis:getComputedStyle(m).display!=='none',l:r.left,r:r.right,w:innerWidth,t:t};})()`);
        c.ok(menu.vis && menu.l >= 0 && menu.r <= menu.w, `${w} 宽点「更多」弹出菜单，不出屏幕`, { l: menu.l, r: menu.r });
        c.ok(['复制给 AI', '内容已确认', '字号', 'A−', 'A＋', '撤销', '重做', '只看待确认', '复制未保存的改动', '每秒 4 字'].every(x => menu.t.includes(x)), `${w} 宽菜单里有复制给 AI、内容已确认、字号、撤销与重做、只看待确认、复制未保存的改动和全稿字数`, menu.t);
        o = await noHScroll(p);
        c.ok(o.sw <= o.cw, `${w} 宽菜单打开时也不横向滚动`, o);
        await p.shot(path.join(dir, `更多菜单_${w}.png`));
        await p.click(`document.querySelector('.m-font button[aria-label="放大字号"]')`);
        c.ok(await p.ev(`document.querySelector('.font-now').textContent === '18' && ${visible("document.querySelector('.more-menu')")}`), `${w} 宽菜单里点 A＋：字号变 18，菜单不关，可以接着点`);
        await p.click(`document.querySelector('.m-font button[aria-label="缩小字号"]')`);
        await p.key('Escape', 'Escape', 0, 27);
        c.ok(await p.ev(`!${visible("document.querySelector('.more-menu')")} && document.activeElement === document.querySelector('.more-toggle')`), `${w} 宽按 Esc 收起菜单，光标回到「更多」`);
        await p.click(`document.querySelector('.more-toggle')`);
        await p.click(`document.querySelector('.m-ai')`);
        await sleep(300);
        c.ok((await p.ev('navigator.clipboard.readText()')).includes('page_id：' + pg.page_id) && await p.ev(`!${visible("document.querySelector('.more-menu')")}`), `${w} 宽菜单里「复制给 AI」复制了清单，菜单随之收起`);
      } else {
        c.ok(await p.ev(`!${visible("document.querySelector('.save-ind')")} && ${visible("document.querySelector('.save-slot .jc-kit-bar')")} && ${visible("document.querySelector('.m-ai')")} && ${visible("document.querySelector('.btn.approve')")} && ${visible("document.querySelector('.m-only')")}`),
          `${w} 宽保存状态整条显示；复制给 AI、内容已确认、只看待确认排在顶栏上`);
        c.ok(await p.ev(`document.querySelector('.c-sug').textContent === '4 条待确认' && ${visible("document.querySelector('.c-sug .c-unit')")} && ${visible("document.querySelector('.nav-t')")}`), `${w} 宽计数写全「4 条待确认」，段落条带段标题`);
        await p.click(`document.querySelector('.more-toggle')`);
        c.ok(await p.ev(`${visible("document.querySelector('.m-font')")} && ${visible("document.querySelector('.m-undo')")} && !${visible("document.querySelector('.m-kitcopy')")} && !${visible("document.querySelector('.menu-info')")}`), `${w} 宽「更多」里是字号、撤销和重做`);
        await p.click(`document.querySelector('#seg-${s1} .seg-head h2')`);
        c.ok(await p.ev(`!${visible("document.querySelector('.more-menu')")}`), `${w} 宽点别处收起「更多」`);
      }
      await p.ev('jcApp.setView("reading"), window.scrollTo(0, 0), true');
      await sleep(300);
      o = await noHScroll(p);
      c.ok(o.sw <= o.cw, `${w} 宽通读视图不横向滚动`, o);
      await p.shot(path.join(dir, `通读_${w}.png`));
      await p.ev('jcApp.setView("compare"), true');
    }
    // 手机（带触屏的 390 宽）也不横向滚动
    await p.viewport(390, 844, true); await p.go(url); await waitReady(p); await sleep(300);
    let o = await noHScroll(p);
    c.ok(o.sw <= o.cw && (await stickyOf(p)).h <= 110, '390 宽手机不横向滚动，顶栏不超过 110 像素', o);
    // 宽屏「内容已确认」带上日期：1200 宽（宽屏版式最窄处）第二行也不折行
    await p.viewport(1200, 800, false); await p.go(url); await waitReady(p);
    await p.click(`document.querySelector('.btn.approve')`);
    c.ok(await waitFor(() => (fieldOf(file, pg.ids.info, 'approved') || '').length > 10, 6000) && await waitFor(() => p.ev(`document.querySelector('.btn.approve').textContent.includes('/')`), 2000), '点「内容已确认」，按钮带上日期');
    let st = await stickyOf(p);
    c.ok(!(await p.ev('jcApp.state().compact')) && st.h <= 129, `1200 宽勾选「内容已确认」以后顶栏仍是三行、高 ${st.h} 像素（不超过 129）`, st);
    await p.shot(path.join(dir, '内容已确认_1200.png'));
    // 保存状态的简短说法：绿、灰不带字；黄、红必须带字；有冲突写几处
    const lab = (a, b) => p.ev(`jcApp.saveLabel(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    c.ok((await lab({ state: 'green', msg: '已保存到文件 10:00' }, { online: true })).short === '', '绿色：只有圆点');
    c.ok((await lab({ state: 'grey', msg: '正在编辑' }, { online: true })).short === '', '灰色（正在保存）：只有圆点');
    c.ok((await lab({ state: 'yellow', msg: 'x' }, { online: false })).short === '服务未连接', '黄色（保存服务未连接）：写「服务未连接」');
    c.ok((await lab({ state: 'yellow', msg: 'x' }, { online: true, storeKind: 'memory' })).short === '暂存不可用', '黄色（浏览器暂存不可用）：写「暂存不可用」');
    c.ok((await lab({ state: 'red', msg: 'x' }, { online: false })).short === '服务已断开', '红色（断开很久）：写「服务已断开」');
    c.ok((await lab({ state: 'red', msg: 'x' }, { online: true, saveRefused: '403' })).short === '保存被拒绝', '红色（保存被拒绝）：写「保存被拒绝」');
    c.ok((await lab({ state: 'red', msg: 'x' }, { online: true, storeError: '坏了' })).short === '暂存出错', '红色（暂存出错）：写「暂存出错」');
    c.ok((await lab({ state: 'red', msg: 'x' }, { online: true, unregistered: 2 })).short === '部分无法保存', '红色（有输入框没登记）：写「部分无法保存」');
    const conf = await lab({ state: 'green', msg: '已保存到文件 10:00', conflicts: 2 }, { online: true });
    c.ok(conf.short === '2 处冲突' && conf.msg.includes('2 处冲突待处理'), '有冲突：圆点旁写「2 处冲突」，全文也带上', conf);
    // 真的断开服务：380 宽圆点变黄，旁边写字
    await p.viewport(380, 820, false); await p.go(url); await waitReady(p);
    await stopServer(t.srv);
    c.ok(await waitFor(() => p.ev(`document.querySelector('.save-ind').getAttribute('data-state') === 'yellow'`), 10000), '保存服务停掉后 380 宽的圆点变黄');
    c.ok(await p.ev(`${visible("document.querySelector('.save-short')")} && document.querySelector('.save-short').textContent === '服务未连接'`), '变黄时圆点旁写「服务未连接」，不只剩圆点', await p.ev(`document.querySelector('.save-ind').textContent`));
    c.ok((await stickyOf(p)).h <= 110, '带字以后顶栏仍不超过 110 像素', await stickyOf(p));
    await p.shot(path.join(dir, '服务未连接_380.png'));
    c.note('截图在 ' + dir);
    c.ok(p.errors.length === 0, '页面没有脚本报错', p.errors);
  } finally { await teardown(t); }
};

// 建议卡变短、删掉整句：默认只有删改对照、结论和按钮，「为什么改」两行、「依据」收成小标签、「改成」输入框点了才出来；
// 「改成」是空的写「删掉这句」，采纳就从我的版本删去原句（和决定同组提交），删整段时不留空行；撤回、⌘Z 都能放回去；窄屏按钮一行排下
const LONG_REASON = '这句是在铺垫竞争有多激烈，但前面已经说了「大几百万粉丝的博主直播招剪辑」，观众自己就能想到人多；再补一句「没有上千也有几百」，节奏反而拖慢了，念出来还多了四五秒。删掉以后「招一个剪辑」直接接「结果他回了我三个字」，反差更干脆。';
S.cards = async (c) => {
  const t = await setup('cards', c, {
    mutate: d => {
      d.suggestions.push({ segment: 2, category: '表达', source: 'AI', original: '想去的人没有上千也有几百。', proposed: '', reason: LONG_REASON,
        basis: { type: '参考口播', text: '博主甲这一段没有铺垫人数，直接讲结果。' }, verdict: '待你定' });
      d.suggestions.push({ segment: 1, category: '口径', source: '运营', original: '我从一个普通上班族变成了一个十万粉丝的博主。', proposed: '',
        reason: '十万粉丝这件事后面第三件事会讲，开头先不剧透。', basis: { type: '运营', text: '开头只留一个钩子。' }, verdict: '已定要改' });
    },
  });
  const { p, file, root, pg, dir } = t;
  const [s1, s2] = pg.ids.segs, d2 = pg.ids.sugs[4], d1 = pg.ids.sugs[5], g1 = pg.ids.sugs[0];
  const vis = sel => p.ev(visible(sel));
  try {
    // 替换与删除的规则（纯函数）
    const ro = (a, b, x) => p.ev(`jcApp.replaceOnce(${q(a)}, ${q(b)}, ${q(x)})`);
    c.ok(await ro('甲乙丙', '乙', '丁') === '甲丁丙', '换句：原句换成新句');
    c.ok(await ro('甲乙丙', '乙', '') === '甲丙', '删句：句中删掉原句');
    c.ok(await ro('甲乙丙', '乙', '  ') === '甲丙', '「改成」只有空白也算删掉');
    c.ok(await ro('A\n\nB\n\nC', 'B', '') === 'A\n\nC', '删掉中间一整段：不留多出来的空行');
    c.ok(await ro('A\nB\n\nC', 'B', '') === 'A\n\nC', '删掉一行：前后换行取多的那边，段落分隔还在');
    c.ok(await ro('B\n\nC', 'B', '') === 'C' && await ro('A\n\nB', 'B', '') === 'A', '删掉第一段或最后一段：不留开头或结尾的空行');
    c.ok(await ro('甲乙丙', '戊', '') === null, '原句找不到：不改');

    // 卡片默认很短
    await p.ev('jcApp.goSeg(1, true), true'); await sleep(200);
    const card = `document.querySelector('.card[data-sug=${q(d2)}]')`;
    const info = await p.ev(`(function(){var k=${card};var r=k.querySelector('.reason');var lh=parseFloat(getComputedStyle(r).lineHeight);
      return {h:Math.round(k.getBoundingClientRect().height),rh:r.clientHeight,lh:lh,more:!k.querySelector('.reason-more').hidden,moreText:k.querySelector('.reason-more').textContent,
        tag:k.querySelector('.del-tag')&&k.querySelector('.del-tag').textContent,del:k.querySelector('.change del')&&k.querySelector('.change del').textContent,ins:!!k.querySelector('.change ins'),
        yes:k.querySelector('.yes').disabled,miss:k.querySelector('.miss').hidden,basisTag:k.querySelector('.basis-tag').textContent,basisHidden:k.querySelector('.basis-text').hidden,
        editHidden:k.querySelector('.edit-box').hidden,orig:!!k.querySelector('.orig')};})()`);
    c.ok(info.tag === '删掉这句' && info.del === '想去的人没有上千也有几百。' && !info.ins, '「改成」是空的：卡片写「删掉这句」，原句整句划掉', info);
    c.ok(info.yes === false && info.miss === true, '删掉整句的建议可以采纳，不再提示「改成是空的」', info);
    c.ok(info.rh <= info.lh * 2 + 2 && info.more && info.moreText === '展开', '「为什么改」默认只显示两行，超出的给「展开」', info);
    c.ok(info.basisTag.startsWith('依据：参考口播') && info.basisHidden, '「依据」默认收成彩色小标签，说明收着', info);
    c.ok(info.editHidden && !info.orig, '「改成」输入框默认收着，也没有单独的原句框', info);
    // 2026-10 起卡片上多了改的那一句的前后文（灰字），比原来高一行左右
    c.ok(info.h <= 240, `卡片默认高 ${info.h} 像素（不超过 240）`, info.h);
    await p.shot(path.join(dir, '建议卡_1440.png'));
    await p.click(`${card}.querySelector('.reason-more')`);
    c.ok(await p.ev(`(function(){var r=${card}.querySelector('.reason');return !r.classList.contains('clamp') && r.scrollHeight <= r.clientHeight + 1 && ${card}.querySelector('.reason-more').textContent === '收起';})()`), '点「展开」看全「为什么改」，按钮变「收起」');
    await p.click(`${card}.querySelector('.reason-more')`);
    c.ok(await p.ev(`${card}.querySelector('.reason').classList.contains('clamp')`), '点「收起」又回到两行');
    await p.click(`${card}.querySelector('.basis-tag')`);
    c.ok(await p.ev(`!${card}.querySelector('.basis-text').hidden && ${card}.querySelector('.basis-text').textContent.includes('没有铺垫人数') && ${card}.querySelector('.basis-tag').getAttribute('aria-expanded') === 'true'`), '点「依据」小标签看说明');
    // 结论：结论值「待你定」（显示「建议修改」）时只留右上角的「待确认」；「已定要改」照常显示为「需要修改」
    c.ok(await p.ev(`${card}.querySelector('.verdict').hidden && ${card}.querySelector('.dec-badge').textContent === '待确认'`), '结论值是「待你定」时不显示结论标签，右上角写「待确认」');

    // 采纳删句：我的版本删去原句，和决定同组提交
    const mine2 = fieldOf(file, s2, 'mine');
    await p.click(`${card}.querySelector('.yes')`);
    const want2 = mine2.replace('想去的人没有上千也有几百。', '');
    c.ok(await waitFor(() => fieldOf(file, d2, 'decision') === '采纳' && fieldOf(file, s2, 'mine') === want2, 6000), '采纳：我的版本删掉这句，决定写成「采纳」', { mine: fieldOf(file, s2, 'mine') });
    const logs = changesOf(root, pg.page_id).filter(l => (l.item === s2 && l.field === 'mine') || (l.item === d2 && l.field === 'decision'));
    c.ok(logs.length === 2 && logs[0].group && logs[0].group === logs[1].group, '删句和决定是同一组提交的', logs.map(x => [x.field, x.group]));
    c.ok(await p.ev(`${card}.querySelector('.decided-text').textContent === '已从我的版本删掉这句'`), '卡片写明已经从我的版本删掉这句');
    // 撤回：放回原处
    await p.click(`${card}.querySelector('.card-actions.done button')`);
    c.ok(await waitFor(() => fieldOf(file, d2, 'decision') === '' && fieldOf(file, s2, 'mine') === mine2, 6000), '撤销：删掉的句子放回原处，决定改回待确认', { mine: fieldOf(file, s2, 'mine') });

    // 删掉整段：不留空行；⌘Z 撤销放回
    await p.ev('jcApp.goSeg(0, true), true'); await sleep(200);
    const mine1 = fieldOf(file, s1, 'mine'), card1 = `document.querySelector('.card[data-sug=${q(d1)}]')`;
    c.ok(await p.ev(`!${card1}.querySelector('.verdict').hidden && ${card1}.querySelector('.verdict').textContent === '结论：需要修改' && ${card1}.querySelector('.by').textContent === '运营建议'`), '「已定要改」的结论显示为「需要修改」，来源显示「运营建议」');
    await p.click(`${card1}.querySelector('.yes')`);
    c.ok(await waitFor(() => fieldOf(file, d1, 'decision') === '采纳' && fieldOf(file, s1, 'mine') === mine1.split('\n\n')[0], 6000), '删掉最后一整段：我的版本只剩第一段，结尾不留空行', { mine: fieldOf(file, s1, 'mine') });
    await blur(p); await p.ev('document.body.focus(), true');
    await cmdZ(p, false);
    c.ok(await waitFor(() => fieldOf(file, d1, 'decision') === '' && fieldOf(file, s1, 'mine') === mine1, 6000), '⌘Z 撤销：整段放回，决定改回待定');
    c.ok((await p.ev('jcApp.aiMarkdown()')).includes('原句「想去的人没有上千也有几百。」→ 删掉这句'), '复制给 AI 里写「删掉这句」，不写空的「改成」');

    // 先改再采纳：点了才出输入框，改的字即时进删改对照；再点收起
    const g1card = `document.querySelector('.card[data-sug=${q(g1)}]')`;
    await p.click(`${g1card}.querySelector('.edit-first')`);
    c.ok(await p.ev(`!${g1card}.querySelector('.edit-box').hidden && document.activeElement === ${g1card}.querySelector('textarea.proposed') && ${g1card}.querySelector('.edit-first').textContent === '收起修改框'`), '「先改再采纳」打开输入框、光标放进去，按钮变「收起修改框」');
    await p.type('我自己都觉得在做梦');
    c.ok(await waitFor(() => p.ev(`${g1card}.querySelector('.change ins') && ${g1card}.querySelector('.change').textContent.includes('在做梦')`), 2000), '改的字即时出现在删改对照里');
    c.ok(await waitFor(() => fieldOf(file, g1, 'proposed') === '我自己都觉得在做梦', 6000), '改的「改成」照样写回文件');
    await p.click(`${g1card}.querySelector('.edit-first')`);
    c.ok(await p.ev(`${g1card}.querySelector('.edit-box').hidden`), '再点「收起修改框」收起');

    // 「改成」有冲突（用户正在改，AI 同时改了同一格）：输入框收着也要露出来并锁住，冲突框挂在卡片里
    const g4 = pg.ids.sugs[3], g4card = `document.querySelector('.card[data-sug=${q(g4)}]')`;
    await p.ev('jcApp.goSeg(2, true), true'); await sleep(200);
    await p.click(`${g4card}.querySelector('.edit-first')`);
    await p.type('用户自己的改法');
    py([path.join(APP, 'brain_page.py'), '--root', root, 'set-field', file, '--item', g4, '--field', 'proposed', '--value', 'AI 同时写的改法']);
    await blur(p);
    c.ok(await waitFor(async () => { try { await waitReady(p, 2000); } catch (e) { return false; } return p.ev(`!!${g4card} && !!${g4card}.querySelector('.jc-kit-cbox')`); }, 15000), '「改成」冲突：冲突框挂在这张卡片里');
    await p.ev('jcApp.goSeg(2, true), true'); await sleep(300);
    c.ok(await p.ev(`(function(){var k=${g4card},t=k.querySelector('textarea.proposed');return !k.querySelector('.edit-box').hidden && t.readOnly && t.value === 'AI 同时写的改法' && k.querySelector('.change').title.endsWith('改成：AI 同时写的改法');})()`),
      '冲突时「改成」输入框露出来、锁住，显示文件里的版本，删改对照也按文件里的版本');
    await p.click(`[...${g4card}.querySelectorAll('.jc-kit-cbox button')].find(b => b.textContent === '用文件里的')`);
    c.ok(await waitFor(() => p.ev(`!${g4card}.querySelector('.jc-kit-cbox') && !${g4card}.querySelector('textarea.proposed').readOnly && ${g4card}.querySelector('.edit-box').hidden`), 4000), '选「用文件里的」：冲突框消失、解锁，输入框又收起来');

    // 窄屏：按钮一行排下、不横向滚动；卡片也短
    await p.viewport(380, 820, false); await sleep(300);
    await p.ev('jcApp.goSeg(1, true), true'); await sleep(300);
    const narrow = await p.ev(`(function(){var k=${card};k.scrollIntoView({block:'center'});var b=[...k.querySelectorAll('.card-actions:not(.done) button')];
      return {same:b.every(x=>x.offsetTop===b[0].offsetTop),inside:b.every(x=>x.getBoundingClientRect().right<=k.getBoundingClientRect().right+0.5),h:Math.round(k.getBoundingClientRect().height),sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth};})()`);
    c.ok(narrow.same && narrow.inside, '380 宽建议卡的按钮一行排下，不出卡片', narrow);
    c.ok(narrow.sw <= narrow.cw && narrow.h <= 260, `380 宽不横向滚动，卡片高 ${narrow.h} 像素`, narrow);
    await sleep(200); await p.shot(path.join(dir, '建议卡_380.png'));
    c.note('截图在 ' + dir);
    c.ok(p.errors.length === 0 && p.logs.length === 0, '页面没有脚本报错', p.errors.concat(p.logs));
  } finally { await teardown(t); }
};

// 等页面因为文件被 AI 改了而自动重新加载，并且 kit 和界面都就绪
async function waitReload(p, ms = 12000) {
  const ok = await waitFor(async () => (await p.ev('window.__m')) === undefined && await p.ev('!!(window.jcKit && jcKit.ready && window.jcApp)'), ms);
  if (ok) await waitReady(p);
  return ok;
}
const catsNow = p => p.ev('jcApp.state()');

// 建议类别的默认筛选只在审稿阶段生效：写稿阶段显示全部；AI 把阶段改成审稿后按类型配置默认只看衔接、拗口、口径；
// 用户点「都显示」按阶段记住；改回写稿又是全部
S.review = async (c) => {
  const t = await setup('review', c), { p, file, root, pg, url } = t;
  const [, s2] = pg.ids.segs, [, g2, g3] = pg.ids.sugs;
  const setStage = async (stage) => {
    await p.ev('window.__m = 1');
    py([path.join(APP, 'brain_page.py'), '--root', root, 'set-locked', file, '--item', 'info', '--key', 'stage', '--value', stage]);
    return waitReload(p);
  };
  try {
    await p.ev('jcApp.goSeg(1, true), true');
    let st = await catsNow(p);
    c.ok(st.stage === '写稿' && st.catFilter === false && st.cats.includes('表达') && st.cats.length === 4, '写稿阶段：类别不默认筛选，4 类都显示', st);
    c.ok(await p.ev(`!${cardSel(g3)}.hidden && !${cardSel(g2)}.hidden && document.querySelector('#seg-${s2} .sug-hidden').hidden`), '写稿阶段：「表达」那条卡片也在，没有「按类别筛掉了」');
    c.ok(await p.ev(`[...document.querySelectorAll('#seg-${s2} .chip')].every(b => b.getAttribute('aria-pressed') === 'true')`), '类别按钮全是按下的');
    c.ok(await p.ev('JSON.stringify(jcApp.config.defaultCategories) === JSON.stringify(["衔接","拗口","口径"]) && jcApp.config.filterStages.join() === "审稿"'), '口播的默认类别和生效阶段仍写在类型配置表里');

    c.ok(await setStage('审稿'), 'AI 用 brain_page.py 把阶段改成审稿后，页面自动重新加载');
    await p.ev('jcApp.goSeg(1, true), true');
    st = await catsNow(p);
    c.ok(st.stage === '审稿' && st.catFilter === true && st.cats.join() === '衔接,拗口,口径', '审稿阶段：默认只看衔接、拗口、口径', st);
    c.ok(await p.ev(`document.querySelector('.stages li.now').textContent`) === '审稿', '阶段条停在审稿');
    c.ok(await p.ev(`${cardSel(g3)}.hidden && !${cardSel(g2)}.hidden && !document.querySelector('#seg-${s2} .sug-hidden').hidden && document.querySelector('#seg-${s2} .sug-hidden').textContent.includes('另有 1 条（表达 1）')`),
      '审稿阶段：「表达」那条筛掉了，并写明另有 1 条', await p.ev(`document.querySelector('#seg-${s2} .sug-hidden').textContent`));
    c.ok(await p.ev(`document.querySelector('.c-sug').textContent`) === '4 条待确认', '顶栏计数不受筛选影响，仍是 4 条');
    await p.click(`document.querySelector('#seg-${s2} .sug-hidden .link')`);
    c.ok(await p.ev(`!${cardSel(g3)}.hidden`), '点「都显示」后「表达」那条出来了');
    await p.go(url); await waitReady(p); await p.ev('jcApp.goSeg(1, true), true');
    c.ok(await p.ev(`!${cardSel(g3)}.hidden`) && (await catsNow(p)).cats.length === 4, '刷新后还记得：审稿阶段用户选了都显示');

    c.ok(await setStage('写稿'), '阶段改回写稿，页面自动重新加载');
    await p.ev('jcApp.goSeg(1, true), true');
    st = await catsNow(p);
    c.ok(st.stage === '写稿' && st.catFilter === false && st.cats.length === 4 && await p.ev(`!${cardSel(g3)}.hidden`), '写稿阶段又是全部类别', st);
    await p.click(`[...document.querySelectorAll('#seg-${s2} .chip')].find(b => b.textContent.startsWith('表达'))`);
    c.ok(await p.ev(`${cardSel(g3)}.hidden`), '写稿阶段也能手动点掉某一类');
    c.ok(await setStage('审稿'), '再改成审稿');
    await p.ev('jcApp.goSeg(1, true), true');
    c.ok(await p.ev(`!${cardSel(g3)}.hidden`), '各阶段的选择分开记：审稿阶段仍是之前选的都显示，不受写稿阶段点掉的影响');
    c.ok(p.errors.length === 0 && p.logs.length === 0, '页面没有脚本报错', p.errors.concat(p.logs));
  } finally { await teardown(t); }
};

// 模板只有一份：改模板里的界面文字和样式、不重新生成页面，/p/ 刷新就看到新的；直接打开文件仍是生成时的；
// 当前模板缺了界面脚本时退回页面自带的那份，照样能改能存
S.template = async (c) => {
  const dir = freshDir('template'), root = path.join(dir, 'brain'), port = await freePort(), now = path.join(dir, 'now');
  const file = path.join(root, '内容草稿', 'T990_界面自测', 'T990_创作页.html');
  const pg = buildPage(FIXTURE, file, port);
  fs.cpSync(path.join(APP, 'template'), path.join(now, 'template'), { recursive: true });
  fs.cpSync(path.join(APP, 'kit'), path.join(now, 'kit'), { recursive: true });
  const edit = (rel, a, b) => { const f = path.join(now, rel), x = fs.readFileSync(f, 'utf8'); if (!x.includes(a)) throw new Error(rel + ' 里没有 ' + a); fs.writeFileSync(f, x.replace(a, b)); };
  edit('template/app.js', 'AI 直接读得到。', 'AI 直接读得到。【模板新版】');
  edit('template/style.css', '.foot-hint {', '.foot-hint { letter-spacing: 3px;');
  const before = fs.readFileSync(file);
  const br = await launchChrome('template'), p = br.first;
  const hint = () => p.ev(`(function(){var e=document.querySelector('.foot-hint');return e?{text:e.textContent,ls:getComputedStyle(e).letterSpacing}:null;})()`);
  let srv;
  try {
    // 1. 直接打开文件（服务没开）：用的是文件里嵌进去的那份
    await p.go(fileUrl(file));
    c.ok(await waitFor(() => p.ev('!!window.jcApp'), 8000), 'file:// 打开：界面画出来了');
    let h = await hint();
    c.ok(h && !h.text.includes('【模板新版】') && h.ls !== '3px', 'file:// 打开：还是生成时嵌进去的文字和样式', h);
    // 2. 服务按 /p/ 提供：换上当前模板
    srv = await startServer(root, port, ['--template-dir', path.join(now, 'template'), '--kit-dir', path.join(now, 'kit')]);
    const url = `http://127.0.0.1:${port}/p/${pg.page_id}`;
    await p.go(url); await waitReady(p);
    h = await hint();
    c.ok(h && h.text.includes('【模板新版】') && h.ls === '3px', '/p/ 打开：不重新生成页面，就看到模板里新改的文字和样式', h);
    c.ok(JSON.stringify(await p.ev('window.JC_SERVED.parts')) === JSON.stringify({ style: 'current', kit: 'current', app: 'current' }), '三段都用的是当前模板', await p.ev('window.JC_SERVED.parts'));
    c.ok(await waitFor(async () => (await p.bar()).state === 'green', 5000), '保存状态变绿');
    // 3. 再改一次模板，刷新就是再下一版
    edit('template/app.js', '【模板新版】', '【第三版】');
    await p.go(url); await waitReady(p);
    c.ok((await hint()).text.includes('【第三版】'), '模板再改一次，刷新就看到');
    c.ok(fs.readFileSync(file).equals(before), '页面文件一个字节都没动');
    // 4. 当前模板缺了界面脚本：退回页面自带的那份，照样能改能存
    fs.renameSync(path.join(now, 'template', 'app.js'), path.join(now, 'template', 'app.js.挪走'));
    await p.go(url); await waitReady(p);
    h = await hint();
    c.ok(h && !h.text.includes('【') && h.ls === '3px', '模板缺了 app.js：界面脚本退回页面自带的，样式仍是当前的', h);
    c.ok(await p.ev('window.JC_SERVED.parts.app') === 'embedded', 'JC_SERVED 写明界面脚本用的是页面自带的');
    const hz = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    c.ok(hz.app_ok === false && hz.app_problem.includes('读不出 app.js') && hz.style_ok === true && hz.kit_ok === true, 'healthz 报告界面脚本读不出', { app_ok: hz.app_ok, app_problem: hz.app_problem });
    const s1 = pg.ids.segs[0];
    await p.ev(`(function(){var t=document.querySelector('textarea.mine[data-item=${q(s1)}]');t.focus();t.setSelectionRange(t.value.length,t.value.length);})()`);
    await p.type('【退回自带版也能存】');
    c.ok(await waitFor(() => fieldOf(file, s1, 'mine').endsWith('【退回自带版也能存】'), 6000), '退回自带版时改我的版本照样写回文件');
    c.ok(p.errors.length === 0 && p.logs.length === 0, '页面没有脚本报错', p.errors.concat(p.logs));
  } finally { br.close(); await stopServer(srv); }
};

// 旧页面缺了可选字段（没有叙事、每秒字数、底稿、参考的类型和链接、建议的依据和结论、「内容已确认」「录完的定稿」两格等），
// 换上新界面脚本照样能显示、能改、能采纳
S.oldpage = async (c) => {
  const dir = freshDir('oldpage'), root = path.join(dir, 'brain'), port = await freePort();
  const file = path.join(root, '内容草稿', 'T900_旧页面', 'T900_创作页.html'), data = path.join(dir, 'old.json');
  fs.writeFileSync(data, JSON.stringify({
    page_id: 'oldpage001', content_id: 'T900', kind: '创作页', schema: 1, token: 'old-token',
    items: [
      { id: 'info-old', kind: 'info', locked: { type: '口播', stage: '写稿', title: '一个缺了很多可选字段的旧页面' }, fields: { overall_note: '' } },
      { id: 'seg-old1', kind: 'segment', locked: { order: 1, title: '只有标题和正文' }, fields: { mine: '旧页面的第一段正文，没有参考、没有底稿。' } },
      { id: 'seg-old2', locked: { order: 2, title: '没写种类的段', refs: [{ who: '某人', text: '只有谁和原文，没有类型、时间、链接。' }] }, fields: { mine: '第二段的正文在这里。', note: '' } },
      { id: 'sug-old1', kind: 'suggestion', locked: { segment: 'seg-old2', original: '第二段的正文', category: '表达' }, fields: { proposed: '第二段正文', decision: '' } },
    ],
  }));
  buildPage(data, file, port, ['--doc']);
  const srv = await startServer(root, port), br = await launchChrome('oldpage'), p = br.first;
  try {
    await p.go(`http://127.0.0.1:${port}/p/oldpage001`); await waitReady(p);
    c.ok(await waitFor(async () => (await p.bar()).state === 'green', 5000), '保存状态变绿');
    c.ok(await p.ev(`document.querySelectorAll('.segnav .nav-btn').length === 2 && document.querySelectorAll('.seg').length === 2`), '两段都画出来了（没写种类的那段也认得）');
    c.ok(await p.ev(`document.querySelector('.narr-sum').textContent === '（AI 还没写叙事）'`), '没有叙事：叙事卡写明还没写');
    c.ok(await p.ev(`!document.querySelector('#seg-seg-old1 .vs-base') && document.querySelector('#seg-seg-old1 .grid').classList.contains('no-ref')`), '没有底稿、没有参考的段：不画「和底稿比」，参考栏收起');
    c.ok(await p.ev(`document.querySelector('.total').textContent.includes('每秒 5 字')`), '没写每秒字数：按默认每秒 5 字算');
    await p.ev('jcApp.goSeg(1, true), true');
    c.ok(await p.ev(`(function(){var r=document.querySelector('#seg-seg-old2 .ref');return !!r && !r.querySelector('.src-tag') && !r.querySelector('.time') && !r.querySelector('.watch');})()`), '参考只有谁和原文：不画类型、时间、看原片');
    c.ok(await p.ev(`(function(){var k=document.querySelector('.card[data-sug="sug-old1"]');return !!k && !k.hidden && !k.querySelector('.basis') && !k.querySelector('.verdict') && !k.querySelector('.yes').disabled;})()`), '建议没有依据和结论：卡片照样显示，能采纳');
    c.ok(await p.ev(`!document.querySelector('.btn.approve') && document.querySelector('.c-sug').textContent === '1 条待确认'`), '没有「内容已确认」这一格：不画这个按钮；计数照常');
    await p.click(`document.querySelector('.card[data-sug="sug-old1"] .yes')`);
    c.ok(await waitFor(() => fieldOf(file, 'sug-old1', 'decision') === '采纳' && fieldOf(file, 'seg-old2', 'mine') === '第二段正文在这里。', 6000), '采纳：两格照样同组写回', { mine: fieldOf(file, 'seg-old2', 'mine') });
    await p.ev('jcApp.setView("reading"), true');
    c.ok(await p.ev(`document.querySelectorAll('.r-seg').length === 2 && !document.querySelector('textarea.recorded')`), '通读视图照常；没有「录完的定稿」这一格就不画');
    c.ok(p.errors.length === 0 && p.logs.length === 0, '页面没有脚本报错', p.errors.concat(p.logs));
  } finally { br.close(); await stopServer(srv); }
};

// 只加不删：AI 教程假数据（参考带「画面」、段落带「我方画面」「画面类型」、新种类「录屏步骤」、一条「说明」类参考），
// 用正式 build_page.py 生成、不改保存服务：页面不报错，兜底模块把新格子和录屏步骤列出来，改了照样写回
S.extend = async (c) => {
  const dir = freshDir('extend'), root = path.join(dir, 'brain'), port = await freePort();
  const file = path.join(root, '内容草稿', 'T991_扩展验证', 'T991_创作页.html'), data = path.join(dir, 'data.json');
  const d = JSON.parse(fs.readFileSync(path.join(APP, 'tests', 'fixtures', 'tutorial_ext.json'), 'utf8'));
  d.service_origin = `http://127.0.0.1:${port}`;
  // 教程已经有了专门的枝干（见 S.tutorial）；这里把类型换成还没有枝干的 科普，验证「新格子、新种类按原样列出、能改能存」这条后路一直在
  d.type = '科普';
  // 带 who 的说明；里面故意抄了我的版本的一句，证明「说明」不参与连续 8 字相同的标记
  d.segments[0].refs.push({ who: '博主甲', source_type: '说明', time: '', text: '她这一段没有对应的原话；「把下面这段提示词原样贴进去」是我们自己加的。' });
  fs.writeFileSync(data, JSON.stringify(d));
  py([path.join(APP, 'build_page.py'), data, '--out', file, '--root', root]);
  const doc = docOf(file), pid = doc.page_id, [s1, s2] = doc.items.filter(x => x.kind === 'segment').map(x => x.id);
  const srv = await startServer(root, port), br = await launchChrome('extend'), p = br.first;
  try {
    await p.go(`http://127.0.0.1:${port}/p/${pid}`); await waitReady(p);
    c.ok(await waitFor(async () => (await p.bar()).state === 'green', 5000), '保存状态变绿，没有「没登记的格子」', await p.bar());
    c.ok((await p.ev('jcKit.state().unregistered')) === 0, '页面上的格子都登记在 jc-doc 里');
    c.ok(await p.ev(`document.querySelector('.type-tag').textContent.startsWith('科普')`), '类型 科普：还没有专门枝干，先按主干显示');
    c.ok(await p.ev(`(function(){var x=document.querySelector('#seg-${s1} .ref .ref-visual');return !!x && x.textContent.includes('画面') && x.textContent.includes('录屏：浏览器打开生图工具首页') && !document.querySelector('#seg-${s1} .ref .ref-extra');})()`), '参考里的「画面」是主干就认的：显示在原文下面，不再重复列一遍');
    c.ok(await p.ev(`(function(){var b=document.querySelector('#seg-${s1} .extras');return !!b && !!b.querySelector('textarea[data-field="our_visual"]') && b.querySelector('textarea[data-field="visual_type"]').value === '录屏' && b.textContent.includes('我方画面') && b.textContent.includes('画面类型');})()`), '段落的「我方画面」「画面类型」画成可改的格子');
    c.ok(await p.ev(`(function(){var o=document.querySelector('#seg-${s1} .other-item[data-other="tutstep01"]');return !!o && o.textContent.includes('录屏步骤') && o.textContent.includes('在哪发') && o.textContent.includes('发完应该看到') && !!o.querySelector('textarea[data-field="prompt"]');})()`), '没有录屏步骤模块的类型：录屏步骤按原样列在所属的第 1 段里，提示词是可改的格子');
    c.ok(await p.ev(`(function(){var e=document.querySelector('#seg-${s1} .ref-explain');return !!e && e.textContent.includes('说明') && e.textContent.includes('参考：博主甲') && !e.querySelector('.time') && !e.querySelector('.watch') && !e.querySelector('[data-quote-seg]') && !document.querySelector('#seg-${s1} .ref-pick');})()`),
      '「说明」类参考：灰色说明样式，不当原话显示，没有时间和「看原片」，也不算进「显示哪家」的勾选');
    c.ok(await p.ev(`!!document.querySelector('#seg-${s1} .ref-text .same') && !document.querySelector('#seg-${s1} .ref-explain .same')`), '「说明」不参与连续 8 字相同的标记（原话参考照常标）');
    const ta = f => `document.querySelector('#seg-${s1} textarea[data-field="${f}"]')`;
    await p.ev(`(function(){var t=${ta('our_visual')};t.scrollIntoView({block:'center'});t.focus();})()`);
    await p.type('我这边：先放做好的封面，再倒回去演示');
    c.ok(await waitFor(() => fieldOf(file, s1, 'our_visual') === '我这边：先放做好的封面，再倒回去演示', 6000), '改「我方画面」：停笔后写回文件（保存服务没改过）');
    await p.ev(`(function(){var t=${ta('prompt')};t.scrollIntoView({block:'center'});t.focus();t.setSelectionRange(t.value.length,t.value.length);})()`);
    await p.type('，暖色调');
    c.ok(await waitFor(() => (fieldOf(file, 'tutstep01', 'prompt') || '').endsWith('，暖色调'), 6000), '改录屏步骤「要发送的内容」：照样写回文件');
    const log = fs.readFileSync(path.join(root, '.jc-changes', pid + '.jsonl'), 'utf8');
    c.ok(log.includes('"field": "our_visual"') && log.includes('"field": "prompt"'), '两格都记进了改动记录');
    await p.ev('jcApp.goSeg(1, true), true');
    c.ok(await p.ev(`(function(){var e=document.querySelector('#seg-${s2} .ref-explain');return !!e && e.textContent.includes('对方这里没讲怎么改字号') && !e.textContent.includes('参考：');})()`), '第 2 段没写 who 的「说明」也能显示');
    const md = await p.ev('jcApp.aiMarkdown()');
    c.ok(md.includes('## 其他格子') && md.includes('「我方画面」') && md.includes('「要发送的内容」'), '复制给 AI 里带上了新格子的内容');
    await p.ev('jcApp.setView("reading"), true');
    c.ok(await p.ev(`document.querySelectorAll('.r-seg').length === 2`), '通读视图照常');
    await p.viewport(390, 844, true); await p.ev('jcApp.setView("compare"), jcApp.goSeg(0, false), window.scrollTo(0, 0), true'); await sleep(300);
    const o = await p.ev('({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})');
    c.ok(o.sw <= o.cw, '390 宽不横向滚动', o);
    await p.shot(path.join(dir, '扩展验证_390.png'));
    await p.viewport(1440, 900, false); await sleep(200);
    await p.shot(path.join(dir, '扩展验证_1440.png'));
    c.note('截图在 ' + dir);
    c.ok(p.errors.length === 0 && p.logs.length === 0, '页面没有脚本报错', p.errors.concat(p.logs));
  } finally { br.close(); await stopServer(srv); }
};

// 教程枝干：参考的角色、对方画面、本地原片从这段开头播；画面栏（画面类型点选、我方画面）；录屏步骤卡（能改、能复制）；
// 录制视图（一栏、全部展开、等录屏的句子标出来、复制画面脚本是表格）；没用上的参考；同一家参考只出一个勾选框
S.tutorial = async (c) => {
  const dir = freshDir('tutorial'), root = path.join(dir, 'brain'), port = await freePort();
  const file = path.join(root, '内容草稿', 'T992_教程枝干', 'T992_创作页.html'), data = path.join(dir, 'data.json');
  const video = path.join(root, '02_内容素材', '某教程', '视频.mp4');
  fs.mkdirSync(path.dirname(video), { recursive: true });
  fs.writeFileSync(video, Buffer.alloc(2048, 1)); // 假原片：只验证地址和能不能取到
  const d = JSON.parse(fs.readFileSync(path.join(APP, 'tests', 'fixtures', 'tutorial_ext.json'), 'utf8'));
  d.service_origin = `http://127.0.0.1:${port}`;
  d.stage = '录制准备'; // 到录制准备阶段，没点过视图时默认打开录制视图
  d.segments[0].refs[0].role = '对标';
  d.segments[0].refs[0].video = '../../02_内容素材/某教程/视频.mp4';
  d.segments[0].refs.push({ who: '某教程博主', source_type: '口播原话', time: '0:41 到 0:50', text: '最后导出，发给朋友看看。', role: '对标', visual: '录屏：点右上角导出' });
  d.segments[0].refs.push({ who: '另一个博主', source_type: '口播原话', time: '1:02 到 1:10', text: '我一般会先把尺寸调成 3:4。', role: '补充参考' });
  d.suggestions.push({ segment: 2, category: '事实', original: '出来四张以后，', proposed: '出来【录屏后按真实张数填】以后，', reason: '出几张要看真实运行结果', basis: { type: '参考画面', text: '对方 0:20 画面上是四张' }, verdict: '等录屏再定' });
  d.info = { locked: { spare_refs: [{ who: '另一个博主', source_type: '口播原话', time: '1:20 到 1:30', text: '顺便说一下怎么批量改字。', role: '补充参考', why: '我们这条不讲批量' }] } };
  fs.writeFileSync(data, JSON.stringify(d));
  py([path.join(APP, 'build_page.py'), data, '--out', file, '--root', root]);
  const doc = docOf(file), pid = doc.page_id, [s1, s2] = doc.items.filter(x => x.kind === 'segment').map(x => x.id);
  const srv = await startServer(root, port), br = await launchChrome('tutorial'), p = br.first;
  await p.viewport(1440, 900, false);
  await br.grantClipboard(`http://127.0.0.1:${port}`);
  try {
    await p.go(`http://127.0.0.1:${port}/p/${pid}`); await waitReady(p);
    c.ok(await waitFor(async () => (await p.bar()).state === 'green', 5000), '保存状态变绿', await p.bar());
    c.ok((await p.ev('jcKit.state().unregistered')) === 0, '页面上的格子都登记在页面数据里');
    // 录制视图：录制准备阶段默认打开
    c.ok(await p.ev(`jcApp.state().view === 'record' && document.body.classList.contains('view-record') && !document.querySelector('.record-head').hidden`), '录制准备阶段：默认打开录制视图，顶上是录制清单');
    c.ok(await p.ev(`document.querySelector('.record-head').textContent.includes('2 段，1 个录屏步骤，1 句录屏后再定')`), '录制清单写明段数、录屏步骤数、等录屏的句数', await p.ev(`document.querySelector('.record-head').textContent`));
    c.ok(await p.ev(`[...document.querySelectorAll('.seg')].every(x => getComputedStyle(x).display !== 'none') && getComputedStyle(document.querySelector('#seg-${s1} .refs')).display === 'none' && !document.querySelector('#seg-${s2} .sugs').offsetParent`), '录制视图：所有段都展开，参考和建议藏起来');
    c.ok(await p.ev(`(function(){var s=document.querySelector('#seg-${s2}'),m=s.querySelector('.mine-back .sm');return getComputedStyle(s.querySelector('.mine-gut')).display === 'none' && getComputedStyle(s.querySelector('textarea.mine')).paddingLeft === '12px' && (!m || getComputedStyle(m).backgroundColor === 'rgba(0, 0, 0, 0)');})()`), '录制视图：有建议的段也不显示编号窄边和标记，我的版本照常排');
    c.ok(await p.ev(`document.querySelector('#seg-${s1} .steps-box').open && !!document.querySelector('#seg-${s1} .step .step-caution') === false && document.querySelector('#seg-${s1} .step').textContent.includes('发完应该看到')`), '录屏步骤卡展开：在哪发、对应口播、要发送的内容、发完应该看到');
    c.ok(await p.ev(`(function(){var f=document.querySelector('#seg-${s2} .rec-flag');return !f.hidden && getComputedStyle(f).display !== 'none' && f.textContent.includes('出来四张以后');})()`), '有「等录屏再定」的段：标出要看录屏结果再写的句子');
    c.ok(await p.ev(`getComputedStyle(document.querySelector('.spare')).display === 'none'`), '录制视图里不显示「没用上的参考」');
    // 复制画面脚本：剪贴板里是表格
    await p.click(`document.querySelector('.record-head .btn')`);
    let clip = '';
    await waitFor(async () => (clip = await p.ev(`navigator.clipboard.read().then(async its => { for (const it of its) if (it.types.includes('text/html')) return await (await it.getType('text/html')).text(); return ''; }, () => '')`)), 3000);
    c.ok(typeof clip === 'string' && clip.includes('<table>') && clip.includes('<th>口播</th>') && clip.includes('【录屏】'), '复制画面脚本：贴进在线表格是一张「段、口播、画面」的表', typeof clip === 'string' ? clip.slice(0, 160) : clip);
    // 录制视图里按 A 不会采纳（建议卡藏着）
    await p.ev('document.activeElement && document.activeElement.blur && document.activeElement.blur(), true');
    await p.key('a', 'KeyA', 0, 65);
    await sleep(600);
    c.ok(!doc.items.some(x => x.kind === 'suggestion' && fieldOf(file, x.id, 'decision')), '录制视图里按 A 不会采纳建议');
    // 切回对照
    await p.click(`document.querySelector('.seg-switch button')`);
    c.ok(await waitFor(() => p.ev(`jcApp.state().view === 'compare' && !document.body.classList.contains('view-record')`), 2000), '切回对照');
    await p.ev('jcApp.goSeg(0, true), true');
    c.ok(await p.ev(`(function(){var r=document.querySelector('#seg-${s1} .ref');return r.querySelector('.role-tag').textContent === '对标' && r.querySelector('.ref-visual').textContent.includes('录屏：浏览器打开生图工具首页');})()`), '参考头上标角色「对标」，原文下面一行对方画面');
    c.ok(await p.ev(`document.querySelectorAll('#seg-${s1} .ref-pick input').length === 2`), '同一家参考在这段有两条：「显示」只出一个勾选框（两家两个）');
    const href = await p.ev(`document.querySelector('#seg-${s1} .ref .watch').href`);
    c.ok(href.startsWith(`http://localhost:${port}/f/`) && href.endsWith('#t=5'), '看原片：用本地原片（只读文件地址），从这段开头 0:05 播', href);
    const got = await fetch(href.split('#')[0]).then(r => r.status, e => String(e));
    c.ok(got === 200, '看原片的地址能取到文件', got);
    // 画面栏
    c.ok(await p.ev(`[...document.querySelectorAll('#seg-${s1} .vt')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent).join() === '录屏'`), '画面类型点选：数据里的「录屏」是选上的');
    await p.click(`[...document.querySelectorAll('#seg-${s1} .vt')].find(b => b.textContent === '截图')`);
    c.ok(await waitFor(() => fieldOf(file, s1, 'visual_type') === '录屏、截图', 6000), '点「截图」：画面类型写回文件，按选项顺序用顿号连起来', fieldOf(file, s1, 'visual_type'));
    await p.click(`[...document.querySelectorAll('#seg-${s1} .vt')].find(b => b.textContent === '录屏')`);
    c.ok(await waitFor(() => fieldOf(file, s1, 'visual_type') === '截图', 6000), '再点「录屏」取消：只剩截图', fieldOf(file, s1, 'visual_type'));
    await cmdZ(p, false);
    c.ok(await waitFor(() => fieldOf(file, s1, 'visual_type') === '录屏、截图', 6000), '⌘Z 撤销点选', fieldOf(file, s1, 'visual_type'));
    await p.ev(`(function(){var t=document.querySelector('#seg-${s1} textarea.our-visual');t.scrollIntoView({block:'center'});t.focus();t.setSelectionRange(t.value.length,t.value.length);})()`);
    await p.type('先放封面成品');
    c.ok(await waitFor(() => fieldOf(file, s1, 'our_visual') === '先放封面成品', 6000), '我方画面：直接写，停笔后写回文件');
    // 录屏步骤：改提示词、复制
    await p.ev(`(function(){var t=document.querySelector('#seg-${s1} textarea.step-prompt');t.scrollIntoView({block:'center'});t.focus();t.setSelectionRange(t.value.length,t.value.length);})()`);
    await p.type('，暖色调');
    c.ok(await waitFor(() => (fieldOf(file, 'tutstep01', 'prompt') || '').endsWith('，暖色调'), 6000), '录屏步骤里要发送的内容可以直接改，写回文件');
    await p.click(`document.querySelector('#seg-${s1} .step .btn')`);
    let copied = '';
    await waitFor(async () => (copied = await p.ev(`navigator.clipboard.readText().then(t => t, () => '')`)).endsWith('，暖色调'), 3000);
    c.ok(typeof copied === 'string' && copied.endsWith('，暖色调') && copied.startsWith('一张 3:4'), '点「复制」：复制的是改过的那一版', copied);
    // 没用上的参考
    c.ok(await p.ev(`(function(){var s=document.querySelector('.spare');return !!s && getComputedStyle(s).display !== 'none' && s.textContent.includes('1 段') && s.textContent.includes('我们这条不讲批量');})()`), '对照视图底下：「参考里有、这一稿没用上的」，附为什么没用上');
    // 复制给 AI 带上画面和录屏步骤；提词稿不带提示词
    const md = await p.ev('jcApp.aiMarkdown()');
    c.ok(md.includes('## 画面') && md.includes('【录屏、截图】先放封面成品') && md.includes('## 录屏步骤') && md.includes('，暖色调'), '复制给 AI：带上画面和录屏步骤（以页面上改过的为准）');
    c.ok(!(await p.ev('jcApp.teleprompterText()')).includes('一张 3:4'), '复制提词稿：不带录屏提示词');
    // 窄面板
    await p.viewport(390, 844, true); await p.ev('jcApp.setView("record"), true'); await sleep(300);
    const o = await p.ev('({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})');
    c.ok(o.sw <= o.cw, '390 宽录制视图不横向滚动', o);
    await p.shot(path.join(dir, '教程_录制_390.png'));
    await p.viewport(1440, 900, false); await p.ev('jcApp.setView("compare"), true'); await sleep(200);
    await p.shot(path.join(dir, '教程_对照_1440.png'));
    c.note('截图在 ' + dir);
    c.ok(p.errors.length === 0 && p.logs.length === 0, '页面没有脚本报错', p.errors.concat(p.logs));
  } finally { br.close(); await stopServer(srv); }
};

// 参考分析（编导的功课）：两家及以上参考时先看分析、原文按家收起；讲法点合并（几家都这么讲 / 只有某家）；
// 点一家只展开这一家，关键句按讲法点的颜色标；「可以借的」能跳到对应的修改建议；全片骨架对照；一家参考时原文照旧展开；
// 在分析里选字写给 AI，批注标成「分析：」
S.refnote = async (c) => {
  const dir = freshDir('refnote'), root = path.join(dir, 'brain'), port = await freePort();
  const file = path.join(root, '内容草稿', 'T993_参考分析', 'T993_创作页.html'), data = path.join(dir, 'data.json');
  const video = path.join(root, '02_内容素材', '另一个', '视频.mp4');
  fs.mkdirSync(path.dirname(video), { recursive: true });
  fs.writeFileSync(video, Buffer.alloc(1024, 1));
  const d = JSON.parse(fs.readFileSync(path.join(APP, 'tests', 'fixtures', 'tutorial_ext.json'), 'utf8'));
  d.service_origin = `http://127.0.0.1:${port}`;
  d.stage = '写稿';
  d.segments[0].refs[0].role = '对标';
  d.segments[0].refs.push({ who: '另一个博主', source_type: '口播原话', time: '0:10 到 0:30', role: '补充参考', video: '../../02_内容素材/另一个/视频.mp4',
    text: '先打开生图工具。我一般会先把尺寸调成 3:4，这样发出去不会被裁。然后把提示词原样贴进去。' });
  d.suggestions[0].id = 'tutsug01';
  d.items = (d.items || []).concat([
    { id: 'rn1', kind: 'refnote', locked: { segment: 1, summary: '两家都先打开工具、原样贴提示词；只有另一个博主先调尺寸。',
      points: [
        { tag: '顺序', say: '先打开工具，再原样贴提示词', cover: '共性', who: ['某教程博主', '另一个博主'],
          quotes: [{ who: '某教程博主', time: '0:05', text: '把我给你的这段提示词原样贴进去' }, { who: '另一个博主', time: '0:20', text: '然后把提示词原样贴进去' }] },
        { tag: '操作', say: '贴之前先把尺寸调成 3:4', cover: '独有', who: ['另一个博主'],
          quotes: [{ who: '另一个博主', time: '0:14', text: '我一般会先把尺寸调成 3:4' }], visual: { who: '另一个博主', time: '0:15', text: '录屏：尺寸下拉框选 3:4' } }
      ],
      borrow: [{ type: '照用', text: '贴提示词之前加一句调尺寸。', sug: 'tutsug01' }, { type: '超一步', text: '说清为什么是 3:4。' }],
      merged: [{ who: '另一个博主', base: '某教程博主', ratio: 0.3 }] } },
    { id: 'rn2', kind: 'refnote', locked: { segment: 2, summary: '只有一家参考：挑一张最顺眼的，把标题换成自己的。',
      points: [{ tag: '操作', say: '挑一张最顺眼的', cover: '独有', who: ['某教程博主'], quotes: [{ who: '某教程博主', time: '0:25', text: '挑一张最顺眼的' }] }] } },
    { id: 'sk1', kind: 'skeleton', locked: { families: [{ who: '某教程博主', role: '对标' }, { who: '另一个博主', role: '补充参考' }],
      relation: '两家骨架一样，只有调尺寸这一步不同。',
      rows: [{ step: '打开工具贴提示词', segment: 1, cells: { '某教程博主': '0:05 原样贴', '另一个博主': '0:10 先调尺寸', }, more: ['另一个博主'] },
             { step: '挑图改字', segment: 2, cells: { '某教程博主': '0:20 挑最顺眼的' } }] } }
  ]);
  fs.writeFileSync(data, JSON.stringify(d));
  py([path.join(APP, 'build_page.py'), data, '--out', file, '--root', root]);
  const doc = docOf(file), pid = doc.page_id, [s1, s2] = doc.items.filter(x => x.kind === 'segment').map(x => x.id);
  const srv = await startServer(root, port), br = await launchChrome('refnote'), p = br.first;
  await p.viewport(1440, 900, false);
  try {
    await p.go(`http://127.0.0.1:${port}/p/${pid}`); await waitReady(p);
    c.ok(await waitFor(async () => (await p.bar()).state === 'green', 5000), '保存状态变绿', await p.bar());
    c.ok((await p.ev('jcKit.state().unregistered')) === 0, '页面上的格子都登记在页面数据里');
    c.ok(await p.ev(`!document.querySelector('.extras') || !document.querySelector('.extras').textContent.includes('参考分析')`), '参考分析和骨架对照不当成「其他格子」列出');
    // 两家：分析模式
    c.ok(await p.ev(`(function(){var a=document.querySelector('#seg-${s1} .ana');return !!a && a.querySelector('.ana-sum').textContent.includes('只有另一个博主先调尺寸') && !document.querySelector('#seg-${s1} .ref-pick');})()`), '两家参考：先看「这一段参考怎么讲」，没有「显示：」勾选框');
    c.ok(await p.ev(`[...document.querySelectorAll('#seg-${s1} .pt-cover')].map(x=>x.textContent).join('|') === '2 家都这么讲|只有 另一个博主'`), '讲法点写明几家都这么讲、只有哪家', await p.ev(`[...document.querySelectorAll('#seg-${s1} .pt-cover')].map(x=>x.textContent).join('|')`));
    // 分析是页面第一次画的时候画的：颜色编号要在那之前就定好，不然每一行都是 pcNaN，左边色条和「几家都这么讲」的底色都没了
    const pts = await p.ev(`[...document.querySelectorAll('#seg-${s1} .ana-pts > .pt')].map(x=>({cls:[...x.classList].filter(n=>/^pc/.test(n)).join(' '),line:getComputedStyle(x).borderLeftStyle}))`);
    c.ok(pts.map(x => x.cls).join('|') === 'pc0|pc1' && pts.every(x => x.line === 'solid'), '讲法点按顺序配上颜色（pc0、pc1，不是 pcNaN），左边色条画出来', pts);
    c.ok(await p.ev(`document.querySelectorAll('#seg-${s1} .fam-row').length === 2 && [...document.querySelectorAll('#seg-${s1} .fam-body')].every(b => b.hidden)`), '原文按家收成两行，默认都收着');
    const href = await p.ev(`[...document.querySelectorAll('#seg-${s1} .pt-src')].find(a => a.textContent.startsWith('另一个博主 0:14')).href`);
    c.ok(href.startsWith(`http://localhost:${port}/f/`) && href.endsWith('#t=14'), '原句的出处能点：用本地原片从 0:14 播', href);
    await p.click(`document.querySelectorAll('#seg-${s1} .fam-row')[1]`);
    c.ok(await p.ev(`(function(){var b=document.querySelectorAll('#seg-${s1} .fam-body');return b[0].hidden && !b[1].hidden;})()`), '点第二家：展开这一家');
    // 中译中：照着别家改写的那家，和被照着的那家逐字相同的部分灰掉，剩下的就是他改的地方
    c.ok(await p.ev(`document.querySelectorAll('#seg-${s1} .fam-row')[1].textContent.includes('灰色字和某教程博主一样')`), '照着改写的那家，那一行写明灰色字和谁一样');
    c.ok(await p.ev(`[...document.querySelectorAll('#seg-${s1} .fam-body:not([hidden]) .dup')].map(x=>x.textContent).join('') === '提示词原样贴进去'`), '和被照着的那家逐字相同的部分灰掉，改过的地方不灰', await p.ev(`[...document.querySelectorAll('#seg-${s1} .fam-body:not([hidden]) .dup')].map(x=>x.textContent).join('|')`));
    // 和我的版本连续 8 字相同的地方另有下划线，会把一句切成几小段：同色的几段拼起来比
    c.ok(await p.ev(`(function(){var t=function(c){return [...document.querySelectorAll('#seg-${s1} .fam-body:not([hidden]) .pm.'+c)].map(x=>x.textContent).join('');};return t('pc0')==='然后把提示词原样贴进去' && t('pc1')==='我一般会先把尺寸调成 3:4';})()`), '展开的原文里，关键句按讲法点的颜色标出');
    await p.click(`document.querySelectorAll('#seg-${s1} .fam-row')[0]`);
    c.ok(await p.ev(`[...document.querySelectorAll('#seg-${s1} .fam-body')].every(b => !b.hidden)`), '再点第一家：两家同时展开，可以对照着看');
    c.ok(await p.ev(`!document.querySelector('#seg-${s1} .fam-body .ref-head > b').offsetParent`), '展开的原文里不重复写谁（那一行已经写了）');
    // 宽屏时我的版本钉在顶栏下面：往下翻原文，稿子一直在眼前
    // 把这一段两栏的顶部滚到屏幕最上面（顶栏后面）：不钉住的话我的版本会跟着滚到顶栏后面，钉住的话停在顶栏下面
    await p.ev(`(function(){var g=document.querySelector('#seg-${s1} .grid');window.scrollTo(0, g.getBoundingClientRect().top + window.scrollY - 30);})(), true`);
    await sleep(200);
    const st = await p.ev(`(function(){var m=document.querySelector('#seg-${s1} .mine-cell'),r=m.getBoundingClientRect(),bar=document.querySelector('.topbar').offsetHeight;return {pos:getComputedStyle(m).position,top:r.top,bar:bar};})()`);
    c.ok(st.pos === 'sticky' && st.top >= st.bar - 1 && st.top <= st.bar + 20, '往下翻原文时，我的版本钉在顶栏下面', st);
    await p.click(`document.querySelector('#seg-${s1} .fams-all')`);
    c.ok(await p.ev(`[...document.querySelectorAll('#seg-${s1} .fam-body')].every(b => b.hidden) && document.querySelector('#seg-${s1} .fams-all').textContent === '全部展开'`), '「全部收起」：几家都收起，按钮变回「全部展开」');
    await p.click(`document.querySelector('#seg-${s1} .fams-all')`);
    c.ok(await p.ev(`[...document.querySelectorAll('#seg-${s1} .fam-body')].every(b => !b.hidden)`), '「全部展开」：几家一起展开');
    await p.click(`document.querySelector('#seg-${s1} .fams-all')`);
    // 段和段的衔接：我的版本上面露出上一段结尾，下面露出下一段开头
    await p.ev('jcApp.goSeg(1, false), true');
    c.ok(await p.ev(`(function(){var pv=document.querySelector('#seg-${s2} .ctx-prev');return !!pv && pv.textContent.includes('接上一段') && pv.textContent.includes('原样贴进去，别改。');})()`), '第 2 段我的版本上面露出第 1 段的结尾', await p.ev(`document.querySelector('#seg-${s2} .ctx-prev') && document.querySelector('#seg-${s2} .ctx-prev').textContent`));
    c.ok(await p.ev(`!document.querySelector('#seg-${s1} .ctx-prev') && !document.querySelector('#seg-${s2} .ctx-next') && !!document.querySelector('#seg-${s1} .ctx-next')`), '第一段没有「上一段」，最后一段没有「下一段」');
    await p.click(`document.querySelector('#seg-${s2} .ctx-prev')`);
    c.ok(await waitFor(() => p.ev(`jcApp.state().seg === ${q(s1)}`), 2000), '点「接上一段」跳回上一段');
    // 可以借的 → 修改建议
    await p.click(`document.querySelector('#seg-${s1} .bw-go')`);
    c.ok(await waitFor(() => p.ev(`jcApp.state().activeSug === 'tutsug01' && jcApp.state().seg === ${q(s2)}`), 2000), '「看对应的修改建议」跳到那张建议卡（在第 2 段）');
    // 一家参考：原文照旧展开，分析放上面
    c.ok(await p.ev(`(function(){var s=document.querySelector('#seg-${s2}');return !!s.querySelector('.ana') && !s.querySelector('.fams') && !!s.querySelector('.ref .ref-text') && !s.querySelector('.ref').hidden;})()`), '一家参考：分析在上，原文照旧直接展开');
    // 骨架对照
    await p.ev('jcApp.goSeg(0, false), true');
    c.ok(await p.ev(`(function(){var k=document.querySelector('.skel');return !!k && !k.open && k.querySelector('summary').textContent.includes('两家骨架一样');})()`), '全片「几家参考的关系」默认收成一行');
    await p.ev(`document.querySelector('.skel').open = true, true`);
    c.ok(await p.ev(`document.querySelectorAll('.skel-t tbody tr').length === 2 && !!document.querySelector('.skel-t .sk-more') && document.querySelectorAll('.skel-t tbody tr')[1].textContent.includes('无')`), '展开是每一步各家怎么做的窄表，多做的格子标出，没讲的写「无」');
    await p.click(`[...document.querySelectorAll('.skel-t button')].find(b => b.textContent === '第 2 段')`);
    c.ok(await waitFor(() => p.ev(`jcApp.state().seg === ${q(s2)}`), 2000), '点表里的「第 2 段」跳到那一段');
    // 在分析里选字写给 AI
    await p.ev('jcApp.goSeg(0, false), true');
    await drag(p, `document.querySelector('#seg-${s1} .ana-sum')`, 120);
    c.ok(await waitFor(() => p.ev(`!document.querySelector('.sel-pop').hidden`), 2000), '在参考分析里拖选文字，浮出「写给 AI」');
    await p.click(`document.querySelector('.sel-pop button')`);
    c.ok(await waitFor(() => p.ev(`!document.querySelector('.composer').hidden && document.querySelector('.cp-where').textContent.includes('选自参考分析')`), 2000), '批注框写明选自参考分析');
    await p.type('这条分析不对，我觉得三家都调了尺寸');
    await p.key('Enter', 'Enter', 4, 13);
    c.ok(await waitFor(() => /^分析：「.+」\n这条分析不对/.test(fieldOf(file, s1, 'note') || ''), 6000), '保存进这段的「写给 AI 的话」，引文标成「分析：」', fieldOf(file, s1, 'note'));
    c.ok(await p.ev(`!document.querySelector('#seg-${s1} .draft-hint') || document.querySelector('#seg-${s1} .draft-hint').hidden`), '引分析的批注不会被当成「像稿子」');
    // 窄面板
    await p.viewport(650, 860, false); await sleep(300);
    const o = await p.ev('({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})');
    c.ok(o.sw <= o.cw, '650 宽不横向滚动', o);
    await p.shot(path.join(dir, '参考分析_650.png'));
    c.note('截图在 ' + dir);
    c.ok(p.errors.length === 0 && p.logs.length === 0, '页面没有脚本报错', p.errors.concat(p.logs));
  } finally { br.close(); await stopServer(srv); }
};

// 就地批注框：点别处不丢字、Esc 只关空框、刷新后批注框和字都还在、换视图先保存、通读里也能写、窄面板里不滚走原文
S.composer = async (c) => {
  const t = await setup('composer', c, { width: 650, height: 820 }), { p, file, pg } = t;
  const [s1, s2] = pg.ids.segs;
  const open = async (sel) => {
    await drag(p, sel, 140);
    if (!await waitFor(() => p.ev(`!document.querySelector('.sel-pop').hidden`), 2000)) return false;
    await p.click(`document.querySelector('.sel-pop button')`);
    return waitFor(() => p.ev(`!document.querySelector('.composer').hidden && document.activeElement === document.querySelector('.cp-text')`), 2000);
  };
  const cpOpen = () => p.ev(`!document.querySelector('.composer').hidden`);
  try {
    // 窄面板（650 宽）里在参考选字：批注框在原文下面，原句仍在顶栏下方看得见
    c.ok(await open(`document.querySelector('#seg-${s1} .ref-text')`), '650 宽：选中参考文字打开批注框');
    const pos = await p.ev(`(function(){var bar=document.querySelector('.topbar').offsetHeight,c=document.querySelector('.composer').getBoundingClientRect(),r=document.querySelector('#seg-${s1} .ref-text').getBoundingClientRect();return {bar:bar,cTop:c.top,cBottom:c.bottom,refTop:r.top,w:c.width,vw:document.documentElement.clientWidth,vh:innerHeight};})()`);
    c.ok(pos.cBottom <= pos.vh && pos.refTop >= pos.bar - 2 && pos.w <= pos.vw - 32, '批注框整个在屏幕里、没超出宽度，原文开头没被滚到顶栏下面', pos);
    // Esc：空框直接关
    await p.key('Escape', 'Escape', 0, 27);
    c.ok(await waitFor(async () => !(await cpOpen()), 1000), 'Esc：框里没字时关上');
    // 写了字：点别处不关，Esc 也不关
    c.ok(await open(`document.querySelector('#seg-${s1} .ref-text')`), '再打开一次');
    await p.type('半句话');
    await p.click(`document.querySelector('#seg-${s1} .seg-head h2')`);
    c.ok(await cpOpen() && await p.ev(`document.querySelector('.cp-text').value`) === '半句话', '框里有字时点别处不关，字还在');
    await p.ev(`document.querySelector('.cp-text').focus(), true`);
    await p.key('Escape', 'Escape', 0, 27);
    c.ok(await cpOpen(), '框里有字时 Esc 不关（提示点「取消」）');
    // 刷新：批注框和字都还在，原句位置也找回来
    await p.ev('location.reload(), true');
    await waitReady(p);
    c.ok(await waitFor(() => p.ev(`!document.querySelector('.composer').hidden && document.querySelector('.cp-text').value === '半句话' && CSS.highlights.has('jc-quote')`), 4000), '刷新页面后批注框、写了一半的字、原句黄标都还在');
    c.ok(!fieldOf(file, s1, 'note'), '刷新前后都没点保存：文件没有被写');
    // 换到通读：写了字的先保存
    await p.click(`Array.from(document.querySelectorAll('.seg-switch button')).find(function(b){return b.textContent==='通读';})`);
    c.ok(await waitFor(() => (fieldOf(file, s1, 'note') || '').endsWith('」\n半句话'), 6000), '切到通读前，框里写了字的批注先保存', fieldOf(file, s1, 'note'));
    c.ok(await waitFor(async () => !(await cpOpen()), 2000), '保存后批注框关上');
    // 通读里选字写批注，写进对应的段
    c.ok(await open(`document.querySelector('.r-text[data-quote-seg=${q(s2)}]')`), '通读视图里选字也能打开批注框');
    c.ok(await p.ev(`document.body.classList.contains('view-reading') && document.querySelector('.cp-where').textContent.includes('第 2 段')`), '仍在通读视图，批注框写明是第 2 段');
    await p.type('通读时想到的');
    await p.key('Enter', 'Enter', 4, 13);
    c.ok(await waitFor(() => (fieldOf(file, s2, 'note') || '').endsWith('」\n通读时想到的'), 6000), '通读里写的批注进了第 2 段', fieldOf(file, s2, 'note'));
    c.ok(await p.ev(`document.body.classList.contains('view-reading')`), '保存后还在通读视图，没有跳走');
    // 取消：丢掉框里的字，文件不变
    c.ok(await open(`document.querySelector('.r-text[data-quote-seg=${q(s2)}]')`), '再打开一次');
    const before = fieldOf(file, s2, 'note');
    await p.type('不要了');
    await p.click(`document.querySelector('.composer .cp-foot .btn.ghost')`);
    c.ok(!(await cpOpen()) && fieldOf(file, s2, 'note') === before, '点「取消」：批注框关上，文件不变');
    c.ok(p.errors.length === 0 && p.logs.length === 0, '页面没有脚本报错', p.errors.concat(p.logs));
  } finally { await teardown(t); }
};

// 修改建议贴着原文（2026-09-28 用户：「我看不到我的原文，根本不知道是否应该改」）：
// 定位原句、原文里标出那一句并编号、卡片按原文顺序排在我的版本右边一列、卡上带前后文；点原文那一句亮卡，点卡亮原文那一句；
// 逐条看：从顶上「N 条待确认」开始，采纳、不采纳以后自动跳到原文里的下一条，看完一段到下一段；
// 已处理的收成一行；原句被改掉对不上的排到这段最后、收起并写明原因；窄了挪到我的版本下面，仍按原文顺序
S.anchor = async (c) => {
  const t = await setup('anchor', c, {
    mutate: d => {
      d.suggestions.push({ segment: 2, category: '表达', source: 'AI', original: '想去的人没有上千也有几百。', proposed: '', reason: '这句是铺垫，删掉节奏更快。',
        basis: { type: 'AI 自己的判断', text: '念出来多四五秒。' }, verdict: '待你定' });
      d.suggestions.push({ segment: 2, category: '衔接', source: 'AI', original: '这句已经不在稿子里了。', proposed: '这是改后的句子。', reason: '原句早被改掉了。',
        basis: { type: 'AI 自己的判断', text: '用来验证找不到原句的情况。' }, verdict: '待你定' });
    },
  });
  const { p, file, pg, url, dir } = t;
  const [s1, s2, s3] = pg.ids.segs, [g1, g2, g3, g4, d5, x6] = pg.ids.sugs;
  const card = id => `document.querySelector('.card[data-sug=${q(id)}]')`;
  const orderIn = s => p.ev(`[...document.querySelectorAll('#seg-${s} .cards > .card')].map(function(k){return k.dataset.sug;})`);
  const noOf = id => p.ev(`${card(id)}.querySelector('.card-head .sug-no').textContent`);
  const st = () => p.ev('jcApp.state()');
  try {
    // 前后文的取法（纯函数）
    const cx = (m, a, b) => p.ev(`jcApp.ctxAround(${q(m)}, ${a}, ${b})`);
    let r = await cx('甲说完了。\n乙丙丁。\n戊己。', 6, 10);
    c.ok(r.before === '甲说完了。' && r.beforeBreak && r.after === '戊己。' && r.afterBreak, '原句单独一行：前文取上一行、后文取下一行，各自另起一行', r);
    r = await cx('一二三四五六七八九十', 3, 5);
    c.ok(r.before === '一二三' && !r.beforeBreak && r.after === '六七八九十' && !r.afterBreak, '原句在一行中间：前后文取同一行里的字', r);
    r = await cx('前'.repeat(30) + '原句' + '后'.repeat(30), 30, 32);
    c.ok(r.before === '…' + '前'.repeat(18) && r.after === '后'.repeat(18) + '…', '前后文太长：只留挨着原句的 18 个字，带省略号', r);

    // 定位原句、按原文排序（第 2 段：数据里的顺序是 衔接、表达、删句、对不上，原文里的先后是 表达、删句、衔接）
    await p.ev('jcApp.goSeg(1, false), window.scrollTo(0, 0), true'); await sleep(400);
    c.ok(JSON.stringify(await orderIn(s2)) === JSON.stringify([g3, d5, g2, x6]), '卡片按改的那一句在原文里的先后排，找不到原句的排最后', await orderIn(s2));
    c.ok(JSON.stringify(await p.ev(`jcApp.order(${q(s2)}).map(function(x){return x.no;})`)) === '[1,2,3,4]' && await noOf(g3) === '1' && await noOf(g2) === '3', '编号按原文先后从 1 起');
    const marks = await p.ev(`[...document.querySelectorAll('#seg-${s2} .mine-back [data-k]')].map(function(s){return {k:s.dataset.k,t:s.textContent,c:s.className};})`);
    c.ok(marks.some(m => m.k === g3 && m.t.includes('有一个大几百万粉丝的博主')) && marks.some(m => m.k === g2 && m.t.includes('结果')) && marks.some(m => m.k === d5 && /sm-del/.test(m.c)) && !marks.some(m => m.k === x6),
      '原文里标出每条待确认建议改的那一句；删整句的标成删除线样式；找不到原句的不标', marks.map(m => m.k.slice(-4) + ':' + m.c));
    const gut = await p.ev(`[...document.querySelectorAll('#seg-${s2} .mine-gut .sm-no')].map(function(b){return b.textContent;})`);
    c.ok(JSON.stringify(gut) === '["1","2","3"]', '我的版本左边窄边上的编号和卡片一样：1、2、3（对不上的那条没有）', gut);
    const lay = await p.ev(`(function(){var m=document.querySelector('#seg-${s2} .mine-cell').getBoundingClientRect(),b=document.querySelector('#seg-${s2} .sugs').getBoundingClientRect();return {side:jcApp.side(${q(s2)}),inGrid:!!document.querySelector('#seg-${s2} .grid > .sugs'),ml:m.left,mr:m.right,bl:b.left};})()`);
    c.ok(lay.side && lay.inGrid && lay.bl >= lay.mr - 2, '1440 宽：修改建议排在我的版本右边一列', lay);
    const al = await p.ev(`(function(){var s=document.querySelector('#seg-${s2} .mine-back [data-k=${q(g3)}]').getBoundingClientRect(),k=${card(g3)}.getBoundingClientRect();return {sent:Math.round(s.top),card:Math.round(k.top)};})()`);
    c.ok(Math.abs(al.card - al.sent) <= 24, '第一张卡和它改的那一句差不多对齐', al);
    const ctx = await p.ev(`[...${card(d5)}.querySelectorAll('.change .cx')].map(function(x){return x.textContent;})`);
    c.ok(ctx.length === 2 && ctx[0].endsWith('招一个剪辑，') && ctx[1].startsWith('结果，他在微信上'), '卡片上带改的那一句的前一句结尾、后一句开头（灰字）', ctx);
    c.ok(await p.ev(`${card(x6)}.classList.contains('is-folded') && ${card(x6)}.querySelector('.fold-snip').textContent.startsWith('这句你已经改过，这条建议对不上了')`), '找不到原句的那条收成一行，写明「这句你已经改过，这条建议对不上了」');
    await p.shot(path.join(dir, '贴着原文_1440.png'));

    // 点原文那一句：对应的卡亮起来；点卡：原文那一句亮起来
    const pt = await p.ev(`(function(){var s=document.querySelector('#seg-${s2} .mine-back [data-k=${q(g2)}]');var r=s.getClientRects()[0];return {x:r.left+12,y:r.top+r.height/2};})()`);
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    c.ok(await waitFor(async () => (await st()).activeSug === g2 && await p.ev(`${card(g2)}.classList.contains('is-active')`), 2000), '点原文里标出来的那一句：对应的卡亮起来', await st());
    await p.ev(`${card(g3)}.querySelector('.change').click(), true`);
    c.ok(await waitFor(() => p.ev(`jcApp.state().activeSug === ${q(g3)} && document.querySelector('#seg-${s2} .mine-back [data-k=${q(g3)}]').classList.contains('sm-on')`), 2000), '点卡片：原文里那一句换成「当前」的颜色');
    await p.click(`[...document.querySelectorAll('#seg-${s2} .mine-gut .sm-no')].find(function(b){return b.textContent==='2';})`);
    c.ok(await waitFor(() => p.ev(`jcApp.state().activeSug === ${q(d5)}`), 2000), '点左边的编号：对应的卡亮起来');
    await blur(p);

    // 逐条看：顶上「N 条待确认」从第一条开始；采纳、不采纳以后自动跳到原文里的下一条，看完一段到下一段
    c.ok(await p.ev(`document.querySelector('.c-sug').textContent`) === '6 条待确认', '顶栏 6 条待确认');
    await p.click(`document.querySelector('.c-sug')`);
    c.ok(await waitFor(async () => { const s = await st(); return s.walk && s.activeSug === g1 && s.seg === s1; }, 2000), '点「6 条待确认」：从第 1 段第一条开始逐条看', await st());
    c.ok(await p.ev(`!document.querySelector('#seg-${s1} .walk-bar').hidden && document.querySelector('#seg-${s1} .walk-bar').textContent.includes('这一段还有 1 条待确认')`), '逐条看时顶上一条写着这一段还剩几条');
    await p.ev('document.body.focus(), true');
    await p.key('a', 'KeyA', 0, 65);
    c.ok(await waitFor(async () => { const s = await st(); return fieldOf(file, g1, 'decision') === '采纳' && s.seg === s2 && s.activeSug === g3; }, 6000), '按 A 采纳以后：第 1 段看完了，自动跳到第 2 段原文里的第一条', await st());
    c.ok(await p.ev(`${card(g1)}.classList.contains('is-folded') && ${card(g1)}.querySelector('.fold-state').textContent === '已采纳' && !${card(g1)}.querySelector('.card-actions.done').hidden`), '采纳过的那条收成一行，留着「撤销决定」');
    // 正看着这一条时直接在我的版本里改了这句：这条变成对不上、挪到这段最后（因为正在看，先不收起）；定了以后仍接着看原文里它后面的那几条
    await selectIn(p, mineSel(s2), '大几百万粉丝的博主'); await p.type('几百万粉丝的大博主'); await blur(p);
    c.ok(await waitFor(async () => JSON.stringify(await orderIn(s2)) === JSON.stringify([d5, g2, g3, x6]) && await p.ev(`${card(g3)}.classList.contains('is-miss') && !${card(g3)}.classList.contains('is-folded')`), 3000),
      '正看着的这条原句被改掉：排到这段最后（对不上的按生成先后排），先不收起', await orderIn(s2));
    await p.ev('document.body.focus(), true');
    await p.key('r', 'KeyR', 0, 82);
    c.ok(await waitFor(async () => fieldOf(file, g3, 'decision') === '不采纳' && (await st()).activeSug === d5, 6000), '按 R 不采纳以后：接着看原文里它后面的那一条（删句那条），不会跳过', await st());
    c.ok(await p.ev(`${card(g3)}.classList.contains('is-folded')`), '不采纳的那条收成一行');
    await p.click(`[...document.querySelectorAll('#seg-${s2} .walk-bar button')].find(function(b){return b.textContent==='跳过这条';})`);
    c.ok(await waitFor(async () => (await st()).activeSug === g2, 2000) && !fieldOf(file, d5, 'decision'), '「跳过这条」：不定这条，跳到下一条', await st());
    await p.ev('document.body.focus(), true');
    await p.key('r', 'KeyR', 0, 82);
    c.ok(await waitFor(async () => fieldOf(file, g2, 'decision') === '不采纳' && (await st()).activeSug === x6, 6000), '再按 R：跳到最后那条对不上的', await st());
    c.ok(await p.ev(`!${card(x6)}.classList.contains('is-folded') && ${card(x6)}.querySelector('.yes').disabled`), '逐条看到对不上的那条：展开、采纳按钮变灰，可以点不采纳');
    await p.key('r', 'KeyR', 0, 82);
    c.ok(await waitFor(async () => { const s = await st(); return fieldOf(file, x6, 'decision') === '不采纳' && s.seg === s3 && s.activeSug === g4; }, 6000), '第 2 段看完，自动到第 3 段', await st());
    await p.key('a', 'KeyA', 0, 65);
    c.ok(await waitFor(async () => fieldOf(file, g4, 'decision') === '采纳' && (await st()).walk === false, 6000), '最后一条定了：逐条看结束', await st());
    c.ok(await waitFor(() => p.ev(`document.querySelector('.toast').textContent.includes('前面还有 1 条跳过的')`), 2000), '提示还有 1 条跳过的，可以从头再看', await p.ev(`document.querySelector('.toast').textContent`));
    c.ok(await p.ev(`document.querySelector('.c-sug').textContent`) === '1 条待确认', '顶栏只剩跳过的 1 条');
    // 收起的可以展开、再收起
    await p.ev('jcApp.goSeg(1, false), true'); await sleep(300);
    await p.click(`${card(g3)}.querySelector('.fold-row')`);
    c.ok(await waitFor(() => p.ev(`!${card(g3)}.classList.contains('is-folded') && !${card(g3)}.querySelector('.fold-close').hidden`), 2000), '点收起的那一行：展开看全，出现「收起」');
    await p.click(`${card(g3)}.querySelector('.fold-close')`);
    c.ok(await waitFor(() => p.ev(`${card(g3)}.classList.contains('is-folded')`), 2000), '点「收起」又收成一行');

    // 窄了：建议挪到我的版本下面（原文、下面跟着它的建议），仍按原文顺序；我的版本那一栏不再钉住；放回宽屏又排到右边
    await p.viewport(900, 860, false); await sleep(500);
    const nar = await p.ev(`(function(){var s=document.querySelector('#seg-${s2}'),m=s.querySelector('.mine-cell'),b=s.querySelector('.sugs'),w=s.querySelector('.mine-wrap');
      return {inCell:b.parentNode===m,side:jcApp.side(${q(s2)}),below:b.getBoundingClientRect().top>=w.getBoundingClientRect().bottom,pos:getComputedStyle(m).position};})()`);
    c.ok(nar.inCell && !nar.side && nar.below && nar.pos === 'static', '900 宽：修改建议挪到我的版本下面，我的版本那一栏不钉住', nar);
    c.ok(JSON.stringify(await orderIn(s2)) === JSON.stringify([d5, g2, g3, x6]), '退到下面以后仍按原文顺序（改过的那句对不上了，排在后面）', await orderIn(s2));
    let o = await p.ev('({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})');
    c.ok(o.sw <= o.cw, '900 宽不横向滚动', o);
    await p.shot(path.join(dir, '贴着原文_900.png'));
    await p.viewport(390, 844, true); await sleep(500);
    o = await p.ev('({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, iw: innerWidth})');
    c.ok(o.sw <= o.cw && o.iw === 390, '390 宽手机不横向滚动', o);
    await p.viewport(1440, 900, false); await sleep(500);
    c.ok(await p.ev(`jcApp.side(${q(s2)}) && !!document.querySelector('#seg-${s2} .grid > .sugs')`), '放回 1440 宽：又排到我的版本右边');
    c.note('截图在 ' + dir);
    c.ok(p.errors.length === 0 && p.logs.length === 0, '页面没有脚本报错', p.errors.concat(p.logs));
  } finally { await teardown(t); }
};

// 新手指引的第二段（工作台的「打开创作页」带 ?guide=first-suggestion），两步：第 1 步亮第一条待确认的建议和它贴着的原句，点「下一步」；
// 第 2 步只亮「采纳」，要亲手点；别的快捷键先不响应；走到第几步刷新也记得；采纳存回文件、弹完成反馈、记下已完成，刷新不再亮；
// Esc 跳过；第一次「不采纳」在那一段的建议上面嵌一句提示，?hints=off 不提；窄屏气泡不出屏
S.guide = async (c) => {
  const t = await setup('guide', c), { p, file, url } = t;
  const guide = () => p.ev('window.jcApp.guide()');
  const store = () => p.ev(`JSON.parse(localStorage.getItem('jc-guide') || '{}')`);
  const decisionOf = (id) => fieldOf(file, id, 'decision') || '';
  const look = () => p.ev(`(function(){var pop=document.querySelector('.jc-guide-pop'),path=document.querySelector('.jc-guide-overlay path');
    return {text:pop?pop.textContent:'', holes:path?(path.getAttribute('d').match(/M/g)||[]).length:0, next:!!(pop&&pop.querySelector('.jc-guide-next')),
      focus:document.activeElement&&document.activeElement.className, guiding:document.body.classList.contains('jc-guiding')};})()`);
  try {
    c.ok(!(await guide()), '不带参数打开：不亮');
    await p.go(url + '?guide=first-suggestion'); await waitReady(p);
    c.ok(await waitFor(() => guide(), 6000), '带 ?guide=first-suggestion 打开：亮起来', await guide());
    c.ok(await p.ev('location.search') === '', '读完就从地址里拿掉参数', await p.ev('location.href'));
    await sleep(300);
    const g = await guide(), st0 = await p.ev('jcApp.state()');
    c.ok(g && g.step === 0 && st0.activeSug === g.sug, '第 1 步：亮的是当前那条建议', { g, active: st0.activeSug });
    let l = await look();
    c.ok(l.text.includes('第 1 步，共 2 步') && l.text.includes('AI 的建议贴在要改的那句话旁边。') && l.text.includes('跳过') && l.next, '第 1 步气泡：第几步、那一句、跳过、下一步', l);
    c.ok(l.holes >= 3 && !!(await p.ev(`!!document.querySelector('.mine-back [data-k=${q(g.sug)}]')`)), '第 1 步：暗层上挖出建议卡和它贴着的原句', l);
    c.ok(/jc-guide-next/.test(l.focus) && l.guiding, '焦点在「下一步」上', l);
    const seg0 = await p.ev('jcApp.state().seg');
    await p.key('r', 'KeyR', 0, 82); await p.key('j', 'KeyJ', 0, 74); await sleep(400);
    c.ok(decisionOf(g.sug) === '' && (await p.ev('jcApp.state().seg')) === seg0 && (await guide()).step === 0, '按 R、J：不采纳、换段都不响应');
    await p.key('ArrowRight', 'ArrowRight', 0, 39); await sleep(500);
    l = await look();
    c.ok((await guide()).step === 1 && l.text.includes('第 2 步，共 2 步') && l.text.includes('觉得这样改更好，就点「采纳」。') && !l.next, '按 →：到第 2 步，没有「下一步」，要亲手点', l);
    c.ok(l.holes === 2 && /jc-guide-yes/.test(l.focus), '第 2 步：只亮「采纳」，焦点在它上面', l);
    c.ok((await store()).first.step === 1, '走到第几步记在浏览器里', await store());
    await p.go(url); await waitReady(p);
    c.ok(await waitFor(async () => { const x = await guide(); return x && x.step === 1; }, 6000), '刷新：接着亮第 2 步', await guide());
    // 先把「采纳」滚到眼前、等亮的地方跟上，再像用户一样点它
    await p.ev(`document.querySelector('.card[data-sug=${q(g.sug)}] .yes').scrollIntoView({block:'center'})`); await sleep(500);
    await p.click(`document.querySelector('.card[data-sug=${q(g.sug)}] .yes')`);
    c.ok(await waitFor(() => decisionOf(g.sug) === '采纳', 6000), '点「采纳」：决定存回文件');
    c.ok(await waitFor(() => p.ev(`!!document.querySelector('.jc-guide-pop.is-done')`), 4000), '弹完成反馈');
    c.ok((await p.ev(`document.querySelector('.jc-guide-pop').textContent`)).includes('漂亮，这条已经存回你的稿子。'), '完成反馈的字', await p.ev(`document.querySelector('.jc-guide-pop').textContent`));
    c.ok((await store()).first.status === 'done', '记下已完成', await store());
    c.ok(!(await p.ev(`document.body.classList.contains('jc-guiding')`)), '暗层撤掉，页面又能点了');
    await p.click(`document.querySelector('.jc-guide-ok')`);
    c.ok(!(await p.ev(`!!document.querySelector('.jc-guide-pop')`)), '点「好的」收起');
    await p.go(url); await waitReady(p); await sleep(900);
    c.ok(!(await guide()), '刷新以后不再亮');

    // 第一次「不采纳」：在那一段的修改建议上面嵌一句提示，只出一次
    const rejectFirstPending = () => p.ev(`(function(){var b=[].slice.call(document.querySelectorAll('.card.is-pending')).filter(function(e){return e.offsetParent;})[0];
      if(!b)return null;b.querySelector('.card-actions button:nth-child(2)').click();return b.getAttribute('data-sug');})()`);
    let rid = null;
    for (let i = 0; i < 3 && !rid; i++) { rid = await rejectFirstPending(); if (!rid) { await p.ev(`jcApp.goSeg(${i + 1}, false)`); await sleep(300); } }
    c.ok(!!rid && await waitFor(() => decisionOf(rid) === '不采纳', 6000), '点了一条「不采纳」', rid);
    c.ok(await waitFor(() => p.ev(`!!document.querySelector('.sugs .jc-hint')`), 3000), '第一次不采纳：嵌在那一段修改建议上面提一句（不浮着）');
    c.ok((await p.ev(`document.querySelector('.jc-hint').textContent`)).includes('不采纳也没关系，AI 不会换个说法再提。') && (await p.ev(`document.querySelector('.jc-hint').textContent`)).includes('不再显示这类提示'),
      '提示的字和总开关', await p.ev(`document.querySelector('.jc-hint').textContent`));
    await p.click(`document.querySelector('.jc-hint .btn')`);
    c.ok(!(await p.ev(`!!document.querySelector('.jc-hint')`)), '点「知道了」收起');

    // Esc 跳过：记成跳过，说清在哪重看
    await p.ev(`localStorage.removeItem('jc-guide')`);
    await p.go(url + '?guide=first-suggestion'); await waitReady(p);
    c.ok(await waitFor(() => guide(), 6000), '重新带参数打开：又亮起来（换了下一条待确认的）', await guide());
    await p.key('Escape', 'Escape', 0, 27); await sleep(300);
    c.ok(!(await guide()) && !(await p.ev(`document.body.classList.contains('jc-guiding')`)), 'Esc：撤掉');
    c.ok((await store()).first.status === 'skipped', '记成跳过', await store());
    c.ok((await p.ev(`document.querySelector('.toast').textContent`)).includes('随时能在工作台左下角「新手指引」重看。'), '跳过时说清在哪重看', await p.ev(`document.querySelector('.toast').textContent`));

    // 工作台关了提示：?hints=off，不采纳也不提
    await p.ev(`localStorage.removeItem('jc-guide')`);
    await p.go(url + '?hints=off'); await waitReady(p); await sleep(500);
    rid = null;
    for (let i = 0; i < 3 && !rid; i++) { rid = await rejectFirstPending(); if (!rid) { await p.ev(`jcApp.goSeg(${i}, false)`); await sleep(300); } }
    if (rid) {
      await waitFor(() => decisionOf(rid) === '不采纳', 6000); await sleep(600);
      c.ok(!(await p.ev(`!!document.querySelector('.jc-hint')`)), '?hints=off：不采纳也不提示');
    } else c.note('没有剩下待确认的建议，跳过「关了提示」这一项');

    // 窄屏：气泡不出屏
    await p.ev(`localStorage.removeItem('jc-guide')`);
    await p.viewport(390, 844, true);
    await p.go(url + '?guide=first-suggestion'); await waitReady(p);
    if (await waitFor(() => guide(), 6000)) {
      await sleep(500);
      const box = await p.ev(`(function(){var r=document.querySelector('.jc-guide-pop').getBoundingClientRect();return {l:r.left,r:r.right,t:r.top,b:r.bottom,w:innerWidth,h:innerHeight,sw:document.documentElement.scrollWidth};})()`);
      c.ok(box.l >= 0 && box.r <= box.w && box.t >= 0 && box.b <= box.h && box.sw <= box.w, '390 宽：气泡整个在屏幕里，页面不横向滚动', box);
      await p.shot(path.join(t.dir, '新手指引_390.png'));
    } else c.note('没有剩下待确认的建议，跳过窄屏这一项');
    c.ok(p.errors.length === 0 && p.logs.length === 0, '页面没有脚本报错', p.errors.concat(p.logs));
  } finally { await teardown(t); }
};

const name = process.argv[2];
if (!name || !S[name]) { console.log('场景：' + Object.keys(S).join('、')); process.exit(name ? 2 : 0); }
const c = checker();
const timer = setTimeout(() => { console.log(c.lines.join('\n') + '\n  失败：超时'); process.exit(3); }, 180000);
try { await S[name](c); } catch (e) { c.ok(false, '场景出错：' + (e && e.stack || e)); }
clearTimeout(timer);
console.log(`场景 ${name}：${c.fails.length ? '有失败' : '全部通过'}\n` + c.lines.join('\n'));
process.exit(c.fails.length ? 1 : 0);
