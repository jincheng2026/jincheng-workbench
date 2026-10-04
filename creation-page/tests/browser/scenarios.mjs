// 浏览器场景测试：每个场景自己建测试页、起服务（临时端口）、开无头 Chrome，测完全部关掉。
// 由同步实验的 tests/browser/scenarios.mjs 迁来：测的是保存服务和 kit 的通用行为（用 tests/fixtures 的两个通用测试页）。
// 用法：node tests/browser/scenarios.mjs <场景名>      列出场景：node tests/browser/scenarios.mjs
// 退出码 0 = 全部通过，1 = 有断言失败，2 = 场景名不对，3 = 超时
import fs from 'node:fs';
import path from 'node:path';
import {
  APP, KIT, PY, py, sleep, freshDir, freePort, launchChrome, startServer, stopServer, buildPages, docOf, fieldOf, aiEdit, ta, fileUrl,
  waitFor, waitReady, checker,
} from './cdp.mjs';

const S = {};

// 基本回归：写回、AI 改别的格后页面在停笔后自动重新加载并显示 AI 的版本、光标放回原格
S.basic = async (c) => {
  const dir = freshDir('basic'), root = path.join(dir, 'brain'), port = await freePort();
  const pg = buildPages(root).T999, [i0, i1] = pg.doc.items;
  const srv = await startServer(root, port), br = await launchChrome('basic'), p = br.first;
  try {
    await p.go(`http://127.0.0.1:${port}/p/${pg.page_id}`); await waitReady(p);
    c.ok(await p.ev(`${ta(i0.id)}.readOnly === false && !document.querySelector('.jc-wait')`), 'kit 就绪后格子解锁、「正在启动」提示消失');
    await p.focusEnd(ta(i0.id)); await p.type('【用户加的】');
    c.ok(await waitFor(() => fieldOf(pg.path, i0.id, '改写').endsWith('【用户加的】'), 6000), '停笔 1 秒后写回文件');
    c.ok(await waitFor(async () => (await p.bar()).state === 'green', 4000), '状态条变绿', await p.bar());
    await p.ev('window.__marker = 1');
    aiEdit(root, 'T999', i1.id, '改写', 'AI 改了第二条');
    const reloaded = await waitFor(async () => (await p.ev('window.__marker')) === undefined && await p.ev('!!(window.jcKit && jcKit.ready)'), 12000);
    c.ok(reloaded, 'AI 改了别的格：停笔 3 秒后页面自动重新加载');
    c.ok((await p.ev(`${ta(i1.id)}.value`)) === 'AI 改了第二条', '重新加载后显示 AI 的版本');
    c.ok(await p.ev(`document.activeElement === ${ta(i0.id)}`), '重新加载后光标放回原来那一格');
    c.ok(fieldOf(pg.path, i0.id, '改写').endsWith('【用户加的】'), '用户的改动还在文件里');
  } finally { br.close(); await stopServer(srv); }
};

// 必须修 1：按「后退」回到页面，浏览器不能把离开前的旧文字填回格子
S.back = async (c) => {
  const dir = freshDir('back'), root = path.join(dir, 'brain'), port = await freePort();
  const pages = buildPages(root), pg = pages.T999, rv = pages.T998, [i0, i1] = pg.doc.items, r0 = rv.doc.items[0];
  const srv = await startServer(root, port), br = await launchChrome('back'), p = br.first;
  const away = () => p.go(`http://127.0.0.1:${port}/healthz`);
  try {
    // 对照页
    await p.go(`http://127.0.0.1:${port}/p/${pg.page_id}`); await waitReady(p);
    await p.focusEnd(ta(i0.id)); await p.type('【用户加的】');
    c.ok(await waitFor(() => fieldOf(pg.path, i0.id, '改写').endsWith('【用户加的】'), 6000), '对照页：先正常写回');
    await p.ev('window.__before_leave = 1');
    await away(); await sleep(800);
    aiEdit(root, 'T999', i0.id, '改写', 'AI 整句重写的新版本');
    await p.ev('history.back()'); await sleep(300); await waitReady(p); await sleep(600);
    c.note('后退回来是' + ((await p.ev('window.__before_leave')) === 1 ? '从前进后退缓存恢复（靠 pageshow 立刻核对指纹）' : '重新加载（靠启动时按 jc-doc 重设格子）'));
    const cell = await p.ev(`${ta(i0.id)}.value`);
    c.ok(cell === 'AI 整句重写的新版本', '后退回来：格子显示 AI 的版本，不是离开前的旧文字', cell);
    await p.focusEnd(ta(i0.id)); await p.type('再加一句');
    const ok = await waitFor(() => fieldOf(pg.path, i0.id, '改写') === 'AI 整句重写的新版本再加一句', 6000);
    c.ok(ok, '接着打字：文件是 AI 的版本加上新打的字，AI 的改动没被盖掉', fieldOf(pg.path, i0.id, '改写'));
    c.ok((await p.state()).conflicts === 0, '没有冲突');
    // 审稿页单选
    await p.go(`http://127.0.0.1:${port}/p/${rv.page_id}`); await waitReady(p);
    await p.ev(`document.querySelector('input[data-item="${r0.id}"][value="采纳"]').click()`);
    c.ok(await waitFor(() => fieldOf(rv.path, r0.id, '采纳') === '采纳', 6000), '审稿页：点「采纳」写回');
    await away(); await sleep(800);
    aiEdit(root, 'T998', r0.id, '采纳', '不采纳');
    await p.ev('history.back()'); await sleep(300); await waitReady(p); await sleep(600);
    const picked = await p.ev(`(document.querySelector('input[data-item="${r0.id}"]:checked')||{}).value`);
    c.ok(picked === '不采纳', '后退回来：单选显示文件里的「不采纳」', picked);
    // 旧模板生成的页面（格子既没有 autocomplete="off"，也没有「就绪前只读」）：靠 kit 自己关恢复、自己锁、自己纠正
    fs.writeFileSync(pg.path, fs.readFileSync(pg.path, 'utf8').replace(' hold(t);', '').replace(' hold(r);', ''));
    await p.go(`http://127.0.0.1:${port}/p/${pg.page_id}`);
    c.ok(await waitFor(() => p.ev(`${ta(i1.id)}.hasAttribute('data-jc-wait') || !!(window.jcKit && jcKit.ready)`), 5000), '旧模板页面：kit 一执行就锁住格子（或已就绪）');
    await waitReady(p);
    c.ok(await p.ev(`${ta(i1.id)}.readOnly === false && ${ta(i1.id)}.getAttribute('autocomplete') === 'off'`), '旧模板页面：就绪后解锁，格子的 autocomplete 被 kit 关掉');
    await p.focusEnd(ta(i1.id)); await p.type('【用户加的第二条】');
    c.ok(await waitFor(() => fieldOf(pg.path, i1.id, '改写').endsWith('【用户加的第二条】'), 6000), '旧模板页面：先正常写回');
    await away(); await sleep(800);
    aiEdit(root, 'T999', i1.id, '改写', 'AI 重写的第二条');
    await p.ev('history.back()'); await sleep(300); await waitReady(p); await sleep(600);
    const cell2 = await p.ev(`${ta(i1.id)}.value`);
    c.ok(cell2 === 'AI 重写的第二条', '旧模板页面后退回来也显示 AI 的版本', cell2);
    // 别的浏览器可能真的从前进后退缓存恢复页面：pageshow（persisted）时要立刻问一次文件指纹，而不是等下一轮 3 秒轮询
    await p.ev(`window.__meta = 0; (function(){var f = window.fetch; window.fetch = function(u){ if (String(u).indexOf('/meta') >= 0) window.__meta++; return f.apply(this, arguments); };})()`);
    const n = await p.ev(`window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); window.__meta`);
    c.ok(n >= 1, '从缓存恢复时立刻核对文件指纹', n);
  } finally { br.close(); await stopServer(srv); }
};

// 必须修 2：输入法选字停顿超过 1 秒，拼音不能写进文件；选字途中不能整页重新加载
S.ime = async (c) => {
  const dir = freshDir('ime'), root = path.join(dir, 'brain'), port = await freePort();
  const pg = buildPages(root).T999, [i0, i1, i2] = pg.doc.items;
  const srv = await startServer(root, port), br = await launchChrome('ime'), p = br.first;
  try {
    await p.go(`http://127.0.0.1:${port}/p/${pg.page_id}`); await waitReady(p);
    await p.focusEnd(ta(i1.id));
    await p.compose('jin tian');
    c.ok((await p.ev(`${ta(i1.id)}.value`)).endsWith('jin tian'), '组字中格子里是拼音（模拟成功）');
    await sleep(2500);
    const f1 = fieldOf(pg.path, i1.id, '改写');
    c.ok(!f1.includes('jin'), '选字停顿 2.5 秒：拼音没写进文件', f1.slice(-10));
    c.ok(!JSON.stringify((await p.state()).stash).includes('jin'), '暂存里也没有拼音');
    await p.type('今天');
    c.ok(await waitFor(() => fieldOf(pg.path, i1.id, '改写').endsWith('今天'), 6000), '选字上屏后写回「今天」', fieldOf(pg.path, i1.id, '改写').slice(-6));
    // AI 改了第三条，用户正在选字
    await p.ev('window.__marker = 1');
    aiEdit(root, 'T999', i2.id, '改写', 'AI 改了第三条');
    await p.focusEnd(ta(i1.id));
    await p.compose('ming tian');
    await sleep(7000);
    let marker; try { marker = await p.ev('window.__marker'); } catch (e) { marker = 'err'; }
    c.ok(marker === 1, '选字 7 秒途中页面没有整页重新加载', marker);
    c.ok(!fieldOf(pg.path, i1.id, '改写').includes('ming'), '拼音没写进文件', fieldOf(pg.path, i1.id, '改写').slice(-10));
    c.ok(await p.ev(`document.activeElement === ${ta(i1.id)}`), '焦点还在格子上');
    await p.type('明天');
    c.ok(await waitFor(() => fieldOf(pg.path, i1.id, '改写').endsWith('今天明天'), 6000), '上屏后写回「今天明天」', fieldOf(pg.path, i1.id, '改写').slice(-8));
    const reloaded = await waitFor(async () => (await p.ev('window.__marker')) === undefined && await p.ev('!!(window.jcKit && jcKit.ready)'), 12000);
    c.ok(reloaded, '停笔后页面才重新加载，跟上 AI 的改动');
    c.ok((await p.ev(`${ta(i2.id)}.value`)) === 'AI 改了第三条', '重新加载后显示 AI 改的第三条');
    c.ok((await p.ev(`${ta(i1.id)}.value`)).endsWith('今天明天'), '用户的字都在');
  } finally { br.close(); await stopServer(srv); }
};

// 必须修 3：file:// 打开的是副本或工作文件夹以外的文件时，不跳转也不写
S.dupfile = async (c) => {
  const dir = freshDir('dupfile'), root = path.join(dir, 'brain'), port = await freePort();
  const pg = buildPages(root, port).T999, i0 = pg.doc.items[0];
  const v2 = path.join(path.dirname(pg.path), '对照页_v2.html');
  fs.copyFileSync(pg.path, v2);
  const origBytes = fs.readFileSync(pg.path);
  const srv = await startServer(root, port), br = await launchChrome('dupfile'), p = br.first;
  try {
    await p.go(fileUrl(v2)); await waitReady(p);
    const red = await waitFor(async () => { const b = await p.bar(); return b.state === 'red' && b.msg.includes('2 份文件'); }, 8000);
    c.ok(red, '打开同号副本：状态条变红并说明有 2 份文件', await p.bar());
    await p.focusEnd(ta(i0.id)); await p.type('【在 v2 里改的】');
    await sleep(4500);
    c.ok(await p.ev('location.protocol') === 'file:', '没有跳到服务版');
    c.ok(!fs.readFileSync(pg.path, 'utf8').includes('在 v2 里改的') && !fs.readFileSync(v2, 'utf8').includes('在 v2 里改的'), '两份文件都没被写');
    c.ok((await p.state()).pending === 1, '改动留在浏览器暂存里');
    // 工作文件夹以外的副本（不算重复，但不是服务认的那份）
    fs.renameSync(v2, path.join(dir, '移走的v2.html'));
    const outside = path.join(dir, '别处', '对照页.html');
    fs.mkdirSync(path.dirname(outside)); fs.copyFileSync(pg.path, outside);
    const p2 = await br.newPage();
    await p2.go(fileUrl(outside)); await waitReady(p2);
    const red2 = await waitFor(async () => { const b = await p2.bar(); return b.state === 'red' && b.msg.includes('不是保存服务使用的那一份'); }, 8000);
    c.ok(red2, '打开工作文件夹以外的副本：状态条变红，说明不是服务认的那一份', await p2.bar());
    await p2.focusEnd(ta(i0.id)); await p2.type('【在别处副本里改的】');
    await sleep(4500);
    c.ok(await p2.ev('location.protocol') === 'file:', '没有跳到服务版');
    c.ok(fs.readFileSync(pg.path).equals(origBytes), '正本一个字节都没变');
    c.ok((await p2.state()).selfOk === false, 'kit 记下了「不是这一份」');
  } finally { br.close(); await stopServer(srv); }
};

// 建议修 4：file:// 页面在用户打字途中不自动跳走
S.filetyping = async (c) => {
  const dir = freshDir('filetyping'), root = path.join(dir, 'brain'), port = await freePort();
  const pg = buildPages(root, port).T999, i0 = pg.doc.items[0], orig = i0.fields['改写'];
  const br = await launchChrome('filetyping'), p = br.first;
  let srv;
  try {
    await p.go(fileUrl(pg.path)); await waitReady(p);
    await p.focusEnd(ta(i0.id));
    const navBefore = p.navs.length;
    let typed = '';
    for (let k = 0; k < 28; k++) {
      if (k === 6) srv = await startServer(root, port);
      const ch = String.fromCharCode(0x4e00 + k);
      await p.type(ch); typed += ch;
      await sleep(250);
    }
    c.ok(p.navs.length === navBefore, '打字的 7 秒里页面没有跳走（服务第 6 个字时就起来了）', p.navs.slice(navBefore));
    c.ok(await waitFor(() => fieldOf(pg.path, i0.id, '改写') === orig + typed, 6000), '打的字全部写回文件', fieldOf(pg.path, i0.id, '改写').slice(orig.length));
    c.ok(await waitFor(async () => { const b = await p.bar(); return b.go && b.state === 'green'; }, 4000), '状态条变绿并给出「切到服务版」按钮', await p.bar());
    c.ok(p.navs.length === navBefore, '焦点还在格子里时不自动跳');
    await p.ev('document.activeElement.blur()');
    const went = await waitFor(() => p.navs.some(n => n.url.startsWith('http://127.0.0.1:' + port + '/p/')), 10000);
    c.ok(went, '离开格子、停笔 3 秒后自动切到服务版');
    await waitReady(p);
    c.ok((await p.ev(`${ta(i0.id)}.value`)) === orig + typed, '服务版页面上字一个不少');
  } finally { br.close(); await stopServer(srv); }
};

// 建议修 5：同一格两个元素、没登记在 jc-doc 里的字段
S.cells = async (c) => {
  const dir = freshDir('cells'), root = path.join(dir, 'brain'), port = await freePort();
  const pages = buildPages(root), pg = pages.T999, rv = pages.T998, [, i1, i2] = pg.doc.items, r0 = rv.doc.items[0];
  // 审稿页文件里直接放一个没登记的格子，测启动时就能发现
  fs.writeFileSync(rv.path, fs.readFileSync(rv.path, 'utf8').replace('<div id="jc-items">',
    `<textarea id="stray" data-item="${r0.id}" data-field="备注">页面上写死的备注</textarea><div id="jc-items">`));
  const srv = await startServer(root, port), br = await launchChrome('cells'), p = br.first;
  try {
    await p.go(`http://127.0.0.1:${port}/p/${pg.page_id}`); await waitReady(p);
    await p.ev(`(function(){var a=${ta(i1.id)};var b=a.cloneNode(true);b.value=a.value;b.id='dup';a.parentNode.appendChild(b);})()`);
    await p.focusEnd('document.getElementById("dup")'); await p.type('【在第二个元素里改的】');
    c.ok(await waitFor(() => fieldOf(pg.path, i1.id, '改写').endsWith('【在第二个元素里改的】'), 6000), '改同一格的第二个元素：写回文件');
    c.ok((await p.ev(`${ta(i1.id)}.value`)).endsWith('【在第二个元素里改的】'), '第一个元素跟着同步');
    c.ok((await p.bar()).state === 'green', '状态条是绿的');
    // 页面加载之后才冒出来的没登记字段
    await p.ev(`(function(){var b=document.createElement('textarea');b.id='memo';b.setAttribute('data-item','${i2.id}');b.setAttribute('data-field','备注');${ta(i2.id)}.parentNode.appendChild(b);})()`);
    await p.focusEnd('document.getElementById("memo")'); await p.type('写在没登记的字段里');
    await sleep(2500);
    const b = await p.bar();
    c.ok(b.state === 'red' && b.msg.includes('没有登记在页面数据里'), '状态条变红，说明有格子没登记', b);
    c.ok(await p.ev('!!document.querySelector("#memo + .jc-kit-unreg-hint")'), '格子旁边挂了红字');
    c.ok(await p.ev('document.getElementById("memo").readOnly'), '格子被锁住，免得接着打字白打');
    c.ok(!fs.readFileSync(pg.path, 'utf8').includes('写在没登记的字段里'), '文件没被写');
    c.ok((await p.ev('jcKit.markdown()')).includes('写在没登记的字段里'), '「复制我的改动」里带上了这段字');
    // 审稿页：启动时就发现写死的没登记格子；同一格两组单选
    await p.go(`http://127.0.0.1:${port}/p/${rv.page_id}`); await waitReady(p);
    const b2 = await p.bar();
    c.ok(b2.state === 'red' && b2.msg.includes('1 个输入框'), '打开页面时就报出没登记的格子', b2);
    c.ok(await p.ev('document.getElementById("stray").readOnly'), '没登记的格子一打开就是锁住的');
    await p.ev(`(function(){var g=document.querySelector('input[data-item="${r0.id}"]').closest('.radios');var h=g.cloneNode(true);h.querySelectorAll('input').forEach(function(i){i.name='second-group';i.checked=false;});g.parentNode.appendChild(h);h.querySelector('input[value="不采纳"]').click();})()`);
    c.ok(await waitFor(() => fieldOf(rv.path, r0.id, '采纳') === '不采纳', 6000), '点第二组单选：写回「不采纳」');
    c.ok(await p.ev(`document.querySelector('.radios input[data-item="${r0.id}"]:checked').value`) === '不采纳', '第一组单选跟着同步');
  } finally { br.close(); await stopServer(srv); }
};

// 建议修 7：kit.js 写坏时页面不能照样让人打字
S.brokenkit = async (c) => {
  const dir = freshDir('brokenkit'), root = path.join(dir, 'brain'), port = await freePort();
  const pg = buildPages(root).T999, i0 = pg.doc.items[0];
  const kit = fs.readFileSync(KIT, 'utf8');
  const broken = path.join(dir, 'kit-broken.js');
  fs.writeFileSync(broken, kit.slice(0, 20000) + '\n/* jc-kit:eof */\n'); // 带结束标记但语法是坏的：服务会照样注入
  const before = fs.readFileSync(pg.path);
  let srv = await startServer(root, port, { JC_KIT: broken });
  const br = await launchChrome('brokenkit'), p = br.first;
  try {
    await p.go(`http://127.0.0.1:${port}/p/${pg.page_id}`);
    await sleep(800);
    c.ok(p.errors.some(e => /Unexpected end of input|SyntaxError/.test(e)), 'kit 确实报了语法错误', p.errors.slice(0, 2));
    c.ok(await p.ev(`${ta(i0.id)}.readOnly`), '启动前格子是只读的');
    c.ok(await p.ev('!!document.querySelector(".jc-wait")'), '有「正在启动」黄条');
    const red = await waitFor(() => p.ev('!!document.querySelector(".jc-wait-bad") && document.querySelector(".jc-wait-bad").textContent.includes("保存脚本没有运行")'), 7000);
    c.ok(red, '4 秒后变成红条「保存脚本没有运行」');
    await p.focusEnd(ta(i0.id)); await p.type('【坏 kit 下打的字】');
    c.ok(!(await p.ev(`${ta(i0.id)}.value`)).includes('坏 kit'), '格子一直锁着，打不进字');
    await sleep(1500);
    c.ok(fs.readFileSync(pg.path).equals(before), '文件没变');
    // kit.js 被截断（没有结束标记）：服务改用页面自带的 kit，页面照常能存
    await stopServer(srv);
    fs.writeFileSync(broken, kit.slice(0, 20000));
    srv = await startServer(root, port, { JC_KIT: broken });
    await p.go(`http://127.0.0.1:${port}/p/${pg.page_id}`); await waitReady(p);
    await p.focusEnd(ta(i0.id)); await p.type('【截断时照样能存】');
    c.ok(await waitFor(() => fieldOf(pg.path, i0.id, '改写').endsWith('【截断时照样能存】'), 6000), 'kit.js 截断时服务改用页面自带的 kit，照样写回');
    c.ok(srv.logs().includes('改用文件里自带的 kit'), '服务日志记了一行带时间的说明');
  } finally { br.close(); await stopServer(srv); }
};

// 建议修 8：浏览器断开暂存数据库连接后，改动照样写回，「复制我的改动」不漏
S.idb = async (c) => {
  const dir = freshDir('idb'), root = path.join(dir, 'brain'), port = await freePort();
  const pg = buildPages(root).T999, [i0, i1, i2] = pg.doc.items;
  let srv = await startServer(root, port);
  const br = await launchChrome('idb'), p = br.first, origin = `http://127.0.0.1:${port}`;
  const clear = () => p.send('Storage.clearDataForOrigin', { origin, storageTypes: 'indexeddb' });
  try {
    await p.go(`${origin}/p/${pg.page_id}`); await waitReady(p);
    await p.focusEnd(ta(i0.id)); await p.type('【第一次改】');
    c.ok(await waitFor(() => fieldOf(pg.path, i0.id, '改写').endsWith('【第一次改】'), 6000), '正常写回');
    await clear(); await sleep(500);
    await p.focusEnd(ta(i1.id)); await p.type('【连接断开之后改的】');
    c.ok(await waitFor(() => fieldOf(pg.path, i1.id, '改写').endsWith('【连接断开之后改的】'), 8000), '连接被断开后再改：重开暂存，照样写回');
    const st1 = await p.state(), b1 = await p.bar();
    c.ok(b1.state !== 'red' && st1.storeKind === 'idb', '状态条不红，暂存重开成功', { bar: b1, kind: st1.storeKind });
    // 让重开也失败：换成内存暂存继续干
    await p.ev("indexedDB.open = function () { throw new Error('测试：假装 IndexedDB 打不开'); }");
    await clear(); await sleep(500);
    await p.focusEnd(ta(i2.id)); await p.type('【内存暂存时改的】');
    c.ok(await waitFor(() => fieldOf(pg.path, i2.id, '改写').endsWith('【内存暂存时改的】'), 8000), '重开失败后换成内存暂存，改动直接写回');
    const st2 = await p.state();
    c.ok(st2.storeKind === 'memory' && !st2.storeError, '暂存换成内存，没有报「暂存出错」', { kind: st2.storeKind, err: st2.storeError });
    c.ok(await waitFor(async () => { const b = await p.bar(); return b.state === 'green' && b.msg.includes('暂存不可用'); }, 5000), '写回后变绿，并提示暂存不可用', await p.bar());
    await stopServer(srv);
    await p.focusEnd(ta(i2.id)); await p.type('【服务停着时改的】');
    await sleep(2500);
    const b3 = await p.bar();
    c.ok(b3.state === 'yellow' && b3.msg.includes('暂存不可用'), '服务停着：黄条说明暂存不可用、要等变绿', b3);
    c.ok((await p.ev('jcKit.markdown()')).includes('【服务停着时改的】'), '「复制我的改动」里有这次改的内容');
    srv = await startServer(root, port);
    c.ok(await waitFor(() => fieldOf(pg.path, i2.id, '改写').endsWith('【服务停着时改的】'), 10000), '服务回来后自动补写');
    c.ok(await waitFor(async () => (await p.bar()).state === 'green', 5000), '补写后变绿', await p.bar());
  } finally { br.close(); await stopServer(srv); }
};

// 建议修 9：一个标签替另一个补写后，另一个标签接着写同一格不算冲突
S.tabs = async (c) => {
  const dir = freshDir('tabs'), root = path.join(dir, 'brain'), port = await freePort();
  const pg = buildPages(root).T999, i0 = pg.doc.items[0], url = `http://127.0.0.1:${port}/p/${pg.page_id}`;
  let srv = await startServer(root, port);
  const br = await launchChrome('tabs'), B = br.first;
  const setVis = (pgx, v) => pgx.ev(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return '${v}'; } })`);
  try {
    await B.go(url); await waitReady(B);
    await stopServer(srv);
    await B.ev(`${ta(i0.id)}.value = ''`);
    await B.focusEnd(ta(i0.id)); await B.type('B 标签写的第一句');
    await sleep(2500);
    c.ok((await B.state()).pending === 1, '服务停着：B 的改动进了暂存');
    await setVis(B, 'hidden'); // 只为让 B 接下来几秒不轮询，稳定复现「B 下一次轮询之前」这个时间窗
    srv = await startServer(root, port);
    const A = await br.newPage();
    await A.go(url); await waitReady(A);
    c.ok(await waitFor(() => fieldOf(pg.path, i0.id, '改写') === 'B 标签写的第一句', 6000), 'A 打开后替 B 补写了 B 的暂存');
    await sleep(300);
    await B.focusEnd(ta(i0.id)); await B.type('，B 标签接着写第二句');
    await setVis(B, 'visible');
    c.ok(await waitFor(() => fieldOf(pg.path, i0.id, '改写') === 'B 标签写的第一句，B 标签接着写第二句', 8000), 'B 接着写的内容写回文件', fieldOf(pg.path, i0.id, '改写'));
    await sleep(3500);
    const st = await B.state(), b = await B.bar();
    c.ok(st.conflicts === 0, 'B 没有冲突', b);
    c.ok(b.state === 'green', 'B 的状态条是绿的', b);
  } finally { br.close(); await stopServer(srv); }
};

// ---------- 创作页新增：整组提交、AI 写回复不冲突、生成的页面不发外部请求 ----------

// 整组提交：页面用 jcKit.edit 一次改两格（像「采纳」同时写稿子和决定），同组全成或全不成
S.group = async (c) => {
  const dir = freshDir('group'), root = path.join(dir, 'brain'), port = await freePort();
  const pages = buildPages(root), rv = pages.T998, pg = pages.T999, r0 = rv.doc.items[0], [i0, i1] = pg.doc.items;
  const srv = await startServer(root, port), br = await launchChrome('group'), p = br.first;
  const setVis = v => p.ev(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return '${v}'; } })`);
  try {
    await p.go(`http://127.0.0.1:${port}/p/${pg.page_id}`); await waitReady(p);
    const r = await p.ev(`jcKit.edit([{item:'${i0.id}', field:'改写', value:'组里第一格'}, {item:'${i1.id}', field:'改写', value:'组里第二格'}], {group:'adopt-ok'})`);
    c.ok(r && r.ok && r.group === 'adopt-ok', 'jcKit.edit 接受同组的两格', r);
    c.ok(await waitFor(() => fieldOf(pg.path, i0.id, '改写') === '组里第一格' && fieldOf(pg.path, i1.id, '改写') === '组里第二格', 6000), '两格一起写回文件');
    const log = await (await fetch(`http://127.0.0.1:${port}/p/${pg.page_id}/changes`, { headers: { Host: `127.0.0.1:${port}` } })).json();
    c.ok(log.changes.length === 2 && log.changes.every(x => x.group === 'adopt-ok'), '改动记录里两格带同一个组号', log.changes.map(x => x.group));
    // 审稿页：AI 先改了其中一格，页面整组提交：两格都不写，整组摆成冲突
    await p.go(`http://127.0.0.1:${port}/p/${rv.page_id}`); await waitReady(p);
    await setVis('hidden'); // 让页面这几秒不轮询，稳定复现「AI 改了、页面还没跟上」这个时间窗
    aiEdit(root, 'T998', r0.id, '批注', 'AI 抢先写的批注');
    const r2 = await p.ev(`jcKit.edit([{item:'${r0.id}', field:'采纳', value:'采纳'}, {item:'${r0.id}', field:'批注', value:'用户的批注'}], {group:'adopt-bad'})`);
    c.ok(r2 && r2.ok, '页面把两格交给 kit', r2);
    c.ok(await waitFor(async () => (await p.state()).conflicts === 2, 8000), '整组回来都是冲突（2 处）', await p.state());
    c.ok(fieldOf(rv.path, r0.id, '采纳') === '' && fieldOf(rv.path, r0.id, '批注') === 'AI 抢先写的批注', '文件里一格都没写：采纳还是空，批注是 AI 的', { 采纳: fieldOf(rv.path, r0.id, '采纳'), 批注: fieldOf(rv.path, r0.id, '批注') });
    const md = await p.ev('jcKit.markdown()');
    c.ok(md.includes('用户的批注') && md.includes('adopt-bad'), '「复制我的改动」里带着两格和组号');
    await setVis('visible');
  } finally { br.close(); await stopServer(srv); }
};

// AI 写回复（locked.ai_state）时用户正在改同一条：不算冲突，用户的字照样写回
S.aireply = async (c) => {
  const dir = freshDir('aireply'), root = path.join(dir, 'brain'), port = await freePort();
  const pg = buildPages(root).T999, i0 = pg.doc.items[0], orig = i0.fields['改写'];
  const srv = await startServer(root, port), br = await launchChrome('aireply'), p = br.first;
  try {
    await p.go(`http://127.0.0.1:${port}/p/${pg.page_id}`); await waitReady(p);
    await p.focusEnd(ta(i0.id)); await p.type('【用户正在打】');
    py([path.join(APP, 'tests', 'fixtures', 'simulate_ai.py'), '--root', root, 'edit', 'T999', '--item', i0.id, '--field', 'ai_state', '--value', 'AI 的回复', '--locked']);
    c.ok(await waitFor(() => fieldOf(pg.path, i0.id, '改写') === orig + '【用户正在打】', 6000), '用户的字写回文件（指纹不算 ai_state，没按冲突处理）', fieldOf(pg.path, i0.id, '改写'));
    c.ok(docOf(pg.path).items[0].locked.ai_state === 'AI 的回复', 'AI 的回复也在文件里');
    await sleep(1500);
    c.ok((await p.state()).conflicts === 0, '没有冲突', await p.state());
  } finally { br.close(); await stopServer(srv); }
};

// 用 template/ 的真界面生成创作页：file:// 和服务版打开都不向 127.0.0.1 以外发请求，kit 能就绪
S.builtpage = async (c) => {
  const dir = freshDir('builtpage'), root = path.join(dir, 'brain'), port = await freePort();
  if (!fs.existsSync(path.join(APP, 'template', 'shell.html'))) { c.note('template/shell.html 还没有，跳过'); return; }
  const data = path.join(dir, 'data.json'), out = path.join(root, '内容草稿', 'T901_样例', 'T901_创作页.html');
  py(['-c', `import sys,json;sys.path.insert(0,${JSON.stringify(path.join(APP, 'tests'))});import support;json.dump(support.sample(service_origin='http://127.0.0.1:${port}'),open(${JSON.stringify(data)},'w'),ensure_ascii=False)`]);
  py([path.join(APP, 'build_page.py'), data, '--out', out, '--root', root]);
  const pid = docOf(out).page_id;
  const br = await launchChrome('builtpage'), p = br.first, seen = [];
  br.conn.listeners.push(m => { if (m.method === 'Network.requestWillBeSent') seen.push(m.params.request.url); });
  await p.send('Network.enable');
  const foreign = () => seen.filter(u => !/^(file:|data:|blob:|about:|chrome|devtools:)/.test(u) && !u.startsWith(`http://127.0.0.1:${port}/`));
  let srv;
  try {
    await p.go(fileUrl(out)); await sleep(2500);
    c.ok(foreign().length === 0, 'file:// 打开（服务没开）：没有外部请求', foreign());
    srv = await startServer(root, port);
    await p.go(`http://127.0.0.1:${port}/p/${pid}`); await waitReady(p, 15000);
    await sleep(1500);
    c.ok(foreign().length === 0, '服务版打开：只请求 127.0.0.1 上的保存服务', foreign());
    c.ok(p.errors.length === 0, '页面没有脚本报错', p.errors.slice(0, 3));
  } finally { br.close(); await stopServer(srv); }
};

// 来源隔离：/f/ 提供的没接入同步的页面在 localhost 这个来源上，它的脚本读不到口令、写不进接入同步页面的格子；
// 用 127.0.0.1 打开 /f/ 会被换到 localhost，用 localhost 打开 /p/ 被拒。真浏览器里跑，CORS 和跨源规则由 Chrome 自己判断
S.isolation = async (c) => {
  const dir = freshDir('isolation'), root = path.join(dir, 'brain'), port = await freePort();
  const pg = buildPages(root).T999, i0 = pg.doc.items[0], orig = i0.fields['改写'];
  const fp = py(['-c', `import sys;sys.path.insert(0,${JSON.stringify(path.join(APP, 'server'))});import brain_save as bs;` +
    `print(bs.item_fp(bs.parse_page(open(${JSON.stringify(pg.path)},'rb').read())[1]['items'][0]))`]).trim();
  // 一条完全对得上的改动（指纹、改前值都对），只差口令：说明挡住它的是来源和主机名
  const body = JSON.stringify({ page_id: pg.page_id, changes: [{ change_id: 'iso1', item_id: i0.id, field: '改写', before: orig, after: '外来页写的', item_fp: fp }] });
  const rel = ['交付物', '外来页', '外来.html'];
  fs.mkdirSync(path.join(root, ...rel.slice(0, -1)), { recursive: true });
  fs.writeFileSync(path.join(root, ...rel), `<!doctype html><meta charset="utf-8"><title>外来页</title><body><h1>外来页</h1><script>
window.__r = (async function () {
  var IP = 'http://127.0.0.1:${port}', PID = ${JSON.stringify(pg.page_id)}, BODY = ${JSON.stringify(body)}, out = {};
  async function t(name, url, opt) {
    try { var r = await fetch(url, opt); out[name] = r.type + ' ' + r.status; } catch (e) { out[name] = 'blocked'; }
  }
  await t('docCross', IP + '/p/' + PID + '/doc');
  await t('metaCross', IP + '/p/' + PID + '/meta');
  await t('docSame', '/p/' + PID + '/doc');
  await t('saveCross', IP + '/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: BODY });
  await t('saveNoCors', IP + '/save', { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: BODY });
  await t('saveSame', '/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: BODY });
  await t('health', '/healthz');
  var f = document.createElement('iframe'); f.src = IP + '/p/' + PID; document.body.appendChild(f);
  await new Promise(function (res) { f.onload = res; setTimeout(res, 5000); });
  try { out.frame = f.contentDocument ? 'readable' : 'null'; } catch (e) { out.frame = 'blocked'; }
  return out;
})();
</script></body>`);
  const fPath = '/f/' + rel.map(encodeURIComponent).join('/');
  const srv = await startServer(root, port), br = await launchChrome('isolation'), p = br.first;
  try {
    await p.go(`http://127.0.0.1:${port}${fPath}`);
    c.ok(await waitFor(async () => (await p.ev('location.href')) === `http://localhost:${port}${fPath}`, 6000), '用 127.0.0.1 打开 /f/：换到 localhost 的同一地址', await p.ev('location.href'));
    c.ok(await waitFor(() => p.ev('!!window.__r'), 6000), '外来页的脚本在 localhost 上跑起来了');
    const r = await p.ev('window.__r');
    c.ok(r.health === 'basic 200', '同源读 /healthz 可以（对照：脚本确实能发请求）', r);
    c.ok(r.docCross === 'blocked' && r.metaCross === 'blocked', '跨源读 127.0.0.1 上的 /doc、/meta：浏览器不给看（口令拿不到）', r);
    c.ok(r.docSame === 'basic 403', '同源读 localhost 上的 /doc：403', r);
    c.ok(r.saveCross === 'blocked', '跨源 POST /save（要先预检）：被拒', r);
    c.ok(r.saveNoCors === 'opaque 0', '不预检的写法也发得出去，但服务按来源拒绝（看下面文件没变）', r);
    c.ok(r.saveSame === 'basic 403', '同源 POST localhost 上的 /save：403', r);
    c.ok(r.frame === 'null', '把接入同步的页面嵌进框里，也读不到里面的内容', r);
    c.ok(fieldOf(pg.path, i0.id, '改写') === orig, '文件里这一格没变', fieldOf(pg.path, i0.id, '改写'));
    c.ok(!fs.existsSync(path.join(root, '.jc-changes')), '没有记任何改动');
    await p.go(`http://localhost:${port}/p/${pg.page_id}`); await sleep(800);
    const txt = await p.ev('document.body.innerText');
    c.ok(txt.includes(`http://127.0.0.1:${port}/p/${pg.page_id}`) && !(await p.ev('!!window.jcKit')), '用 localhost 打开 /p/：不给页面，告诉他换 127.0.0.1', txt.slice(0, 80));
    await p.go(`http://127.0.0.1:${port}/p/${pg.page_id}`); await waitReady(p);
    await p.focusEnd(ta(i0.id)); await p.type('【用户加的】');
    c.ok(await waitFor(() => fieldOf(pg.path, i0.id, '改写') === orig + '【用户加的】', 6000), '对照：127.0.0.1 上的固定网址照常写回');
  } finally { br.close(); await stopServer(srv); }
};

// ---------- 入口 ----------
const name = process.argv[2];
if (!S[name]) { console.log('可用场景：' + Object.keys(S).join(' ')); process.exit(2); }
const c = checker();
setTimeout(() => { console.log(c.lines.join('\n') + '\n  失败：场景超时'); process.exit(3); }, 170000).unref();
try { await S[name](c); } catch (e) { c.ok(false, '场景抛错：' + (e.stack || e)); }
console.log(`[${name}] ${c.fails.length ? '有 ' + c.fails.length + ' 项失败' : '全部通过'}\n` + c.lines.join('\n'));
process.exit(c.fails.length ? 1 : 0);
