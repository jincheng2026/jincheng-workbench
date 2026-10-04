// 界面自测用的极简驱动：无头 Chrome + DevTools 协议（node 自带 WebSocket 和 fetch，不装依赖）。
// 由同步实验 tests/browser/cdp.mjs 改来：服务换成 server/brain_save.py，页面用 tests/ui_mini_build.py 生成。
// 临时文件（测试页、Chrome 配置目录、截图）放在环境变量 JC_UI_TMP 指的目录，默认系统临时目录下的 jc-creation-ui-test。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP = path.resolve(HERE, '..', '..'); // creation-page/
export const TMP = process.env.JC_UI_TMP || path.join(os.tmpdir(), 'jc-creation-ui-test');
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
    this.conn = conn; this.sessionId = sessionId; this.errors = []; this.logs = [];
    conn.listeners.push(m => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.logs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    });
  }
  send(method, params) { return this.conn.send(method, params, this.sessionId); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  go(url) { return this.send('Page.navigate', { url }); }
  type(text) { return this.send('Input.insertText', { text }); }
  async key(key, code, mods = 0, keyCode = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers: mods, windowsVirtualKeyCode: keyCode });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: mods, windowsVirtualKeyCode: keyCode });
  }
  async click(sel) {
    const box = await this.ev(`(function(){var e=${sel};if(!e)return null;e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    if (!box) throw new Error('点不到：' + sel);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  async viewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  bar() {
    return this.ev(`(function(){var b=document.querySelector('.jc-kit-bar');if(!b)return null;return {state:b.getAttribute('data-state'),msg:b.querySelector('.jc-kit-msg').textContent,inline:b.classList.contains('jc-kit-inline')};})()`);
  }
}

export async function launchChrome(name) {
  const ud = path.join(TMP, 'chrome-' + name);
  fs.rmSync(ud, { recursive: true, force: true });
  fs.mkdirSync(ud, { recursive: true });
  // --use-mock-keychain：不碰 macOS 钥匙串（Chrome 默认要读写「Chrome Safe Storage」；在临时家目录里跑测试时会一直卡住）
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + ud, '--no-first-run', '--no-default-browser-check', '--use-mock-keychain',
    '--window-size=1440,900', '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults', 'about:blank'],
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
    async grantClipboard(origin) { await conn.send('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }); },
    close() { try { ws.close(); } catch (e) { /* 已关 */ } proc.kill('SIGKILL'); },
  };
}

export async function startServer(root, port, extra = []) { // extra：多给保存服务的参数，例如 ['--template-dir', 目录]
  const p = spawn(PY, [path.join(APP, 'server', 'brain_save.py'), '--root', root, '--port', String(port), ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', d => { err += d; });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (p.exitCode !== null) throw new Error('服务没起来：' + err);
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) break; } catch (e) { /* 还没起来 */ }
  }
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
export function buildPage(dataFile, outFile, port, extra = []) { // extra 给 ['--doc'] 时输入本身就是 jc-doc（模拟旧页面）
  return JSON.parse(py([path.join(APP, 'tests', 'ui_mini_build.py'), dataFile, outFile, '--port', String(port), ...extra]));
}
export function fileUrl(p) { return 'file://' + p.split('/').map(encodeURIComponent).join('/'); }
export async function waitFor(fn, ms = 8000, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true; } catch (e) { /* 页面可能正在导航 */ }
    await sleep(step);
  }
  return false;
}
export async function waitReady(pg, ms = 10000) {
  if (!await waitFor(() => pg.ev('!!(window.jcKit && window.jcKit.ready && window.jcApp)'), ms, 100)) throw new Error('页面的 kit 没有就绪');
}
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
