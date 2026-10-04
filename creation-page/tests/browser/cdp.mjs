// 浏览器测试用的极简驱动：无头 Chrome + DevTools 协议，node 24 自带 WebSocket 和 fetch，不装任何依赖。
// 由同步实验的 tests/browser/cdp.mjs 迁来。所有临时文件（测试页、Chrome 配置目录）都放在系统临时目录下的
// jc-creation-page-tests/browser 里（环境变量 JC_TEST_TMP 可以换），不写别处。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP = path.resolve(HERE, '..', '..'); // creation-page/
export const FIXTURES = path.join(APP, 'tests', 'fixtures');
export const KIT = process.env.JC_KIT_FILE || path.join(APP, 'kit', 'kit.js');
export const TMP = path.join(process.env.JC_TEST_TMP || path.join(os.tmpdir(), 'jc-creation-page-tests'), 'browser');
export const CHROME = process.env.JC_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const PY = process.env.JC_PYTHON || 'python3';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const py = args => execFileSync(PY, args, { encoding: 'utf8' });

export function freshDir(name) {
  const d = path.join(TMP, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}
export function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

class Conn {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pend = new Map(); this.listeners = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pend.has(m.id)) {
        const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id);
        if (m.error) rej(new Error(m.error.message + ' ' + (m.error.data || ''))); else res(m.result);
      } else this.listeners.forEach(f => f(m));
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      const id = ++this.id; this.pend.set(id, { res, rej });
      const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }
}

class Page {
  constructor(conn, sessionId) {
    this.conn = conn; this.sessionId = sessionId; this.navs = []; this.errors = [];
    conn.listeners.push(m => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) this.navs.push({ url: m.params.frame.url, at: Date.now() });
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
  }
  send(method, params) { return this.conn.send(method, params, this.sessionId); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  go(url) { return this.send('Page.navigate', { url }); }
  type(text) { return this.send('Input.insertText', { text }); }
  compose(text) { return this.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }); }
  focusEnd(sel) { return this.ev(`(function(){var t=${sel};t.focus();t.setSelectionRange(t.value.length,t.value.length);return document.activeElement===t;})()`); }
  bar() {
    return this.ev(`(function(){var b=document.querySelector('.jc-kit-bar');if(!b)return null;return {state:b.getAttribute('data-state'),msg:b.querySelector('.jc-kit-msg').textContent,conf:b.querySelector('.jc-kit-conf').textContent,go:!!(b.querySelector('.jc-kit-go')&&!b.querySelector('.jc-kit-go').hidden)};})()`);
  }
  state() { return this.ev('window.jcKit.state()'); }
}

export async function launchChrome(name) {
  const ud = path.join(TMP, 'chrome-' + name);
  fs.rmSync(ud, { recursive: true, force: true });
  fs.mkdirSync(ud, { recursive: true });
  // --use-mock-keychain：不碰 macOS 钥匙串（Chrome 默认要读写「Chrome Safe Storage」；在临时家目录里跑测试时会一直卡住）
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + ud, '--no-first-run', '--no-default-browser-check', '--use-mock-keychain',
    '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults', 'about:blank'],
  { stdio: 'ignore', env: { ...process.env, TMPDIR: TMP + '/' } });
  let port, wsPath;
  for (let i = 0; i < 200 && !port; i++) {
    await sleep(100);
    try { [port, wsPath] = fs.readFileSync(path.join(ud, 'DevToolsActivePort'), 'utf8').split('\n'); } catch (e) { /* 还没写出来 */ }
  }
  if (!port) { proc.kill('SIGKILL'); throw new Error('Chrome 没起来'); }
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const conn = new Conn(ws);
  async function attach(targetId) {
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    const pg = new Page(conn, sessionId);
    await pg.send('Page.enable'); await pg.send('Runtime.enable');
    await pg.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return pg;
  }
  const { targetInfos } = await conn.send('Target.getTargets');
  const first = await attach(targetInfos.find(t => t.type === 'page').targetId);
  return {
    first, conn,
    async newPage() { const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' }); return attach(targetId); },
    close() { try { ws.close(); } catch (e) { /* 已关 */ } proc.kill('SIGKILL'); },
  };
}

export async function startServer(root, port, env = {}) {
  const p = spawn(PY, [path.join(HERE, 'run_srv.py'), root, String(port)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let err = '';
  p.stderr.on('data', d => { err += d; });
  await new Promise((res, rej) => {
    p.stdout.on('data', d => { if (String(d).includes('ready')) res(); });
    p.on('exit', c => rej(new Error('服务没起来，退出码 ' + c + '：' + err)));
  });
  p.logs = () => err;
  return p;
}
export async function stopServer(p) {
  if (!p || p.exitCode !== null || p.signalCode) return;
  const done = new Promise(r => p.once('exit', r));
  p.kill('SIGKILL');
  await done;
}

// ---------- 测试页 ----------
export function docOf(file) {
  const t = fs.readFileSync(file, 'utf8');
  return JSON.parse(t.match(/<script\b[^>]*\bid=["']jc-doc["'][^>]*>([\s\S]*?)<\/script>/)[1]);
}
export function fieldOf(file, itemId, field) {
  const it = docOf(file).items.find(x => x.id === itemId);
  return it ? it.fields[field] : undefined;
}
// 生成两个通用测试页（tests/fixtures/spike_pages.py）；给了 port 就把页面里写的服务地址（jc-doc 的 service_origin）换成测试端口
export function buildPages(root, port) {
  const code = `import sys,json;sys.path.insert(0,${JSON.stringify(FIXTURES)});import spike_pages;print(json.dumps(spike_pages.build(${JSON.stringify(root)})))`;
  const info = JSON.parse(py(['-c', code]));
  const out = {};
  for (const p of info) {
    if (port) fs.writeFileSync(p.path, fs.readFileSync(p.path, 'utf8').replaceAll('http://127.0.0.1:18998', 'http://127.0.0.1:' + port));
    out[p.content_id] = { ...p, doc: docOf(p.path) };
  }
  return out;
}
export function aiEdit(root, cid, item, field, value) {
  py([path.join(FIXTURES, 'simulate_ai.py'), '--root', root, 'edit', cid, '--item', item, '--field', field, '--value', value]);
}
export const ta = id => `document.querySelector('textarea[data-item="${id}"]')`;
export const fileUrl = p => 'file://' + p;

export async function waitFor(fn, ms = 8000, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true; } catch (e) { /* 页面可能正在导航 */ }
    await sleep(step);
  }
  return false;
}
export async function waitReady(pg, ms = 10000) {
  const expr = '!!(window.jcKit && window.jcKit.ready)';
  if (!await waitFor(() => pg.ev(expr), ms, 100)) throw new Error('页面的 kit 没有就绪');
}

// ---------- 断言 ----------
export function checker() {
  const lines = [], fails = [];
  return {
    ok(cond, msg, detail) {
      lines.push((cond ? '  通过：' : '  失败：') + msg + (detail === undefined ? '' : ' ｜ ' + JSON.stringify(detail)));
      if (!cond) fails.push(msg);
      return cond;
    },
    note(msg) { lines.push('  说明：' + msg); },
    lines, fails,
  };
}
