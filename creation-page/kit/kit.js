/* jc-kit：创作页的保存脚本（由同步实验的 kit 0.2.0 升级）。
 * 普通 script，不是 module。生成页面时整段嵌进 HTML（jc-kit:start 与 jc-kit:end 两个注释标记之间），
 * 保存服务用 /p/<page_id> 打开页面时会换成当前最新版。最后一行必须是结束标记，服务靠它判断 kit.js 没被截断。
 * 约定：可编辑元素带 data-item（条目身份号）和 data-field（字段名）；改前值只取自 jc-doc 数据块，不从页面元素读。
 * 流程：改动先进 IndexedDB 暂存箱 → 停笔 1 秒补写到服务 → 服务回执 ok 才删暂存；冲突一律保留，由人决定。
 * 页面模板在 kit 就绪前把格子设成只读（data-jc-wait），kit 启动成功后才解锁；kit 没跑起来，页面就一直锁着并报红。
 *
 * 升级内容（相对实验版）：
 * - 保存服务地址从 jc-doc 的 service_origin 读（file:// 打开时用它）；
 * - 条目指纹不算 locked.ai_state（与保存服务 brain_save.item_fp 一致），AI 写回复不让正在改的格子冲突；
 * - 程序化接口：jcKit.edit(条目, 字段, 值, {group}) 或 jcKit.edit([{item, field, value}…], {group})，同组一起提交、全成或全不成；
 *   jcKit.subscribe(fn) 在状态变化、格子的值变化（写回、别的标签写回、冲突处理）时回调；jcKit.doc() 给当前 jc-doc（fields 为页面当前值）；
 * - 页面里有 [data-jc-kit-bar] 时状态条画进去（不再钉在页面最上面），有 [data-jc-kit-gone] 时「找不到格子的冲突」画进去；
 * - 同组改动冲突时整组一起摆出、一起换回或一起放弃。
 * 实验版修过的防护全部保留：后退回填、拼音组字、同号副本、file:// 打字跳走、暂存只在 ok 回执后删、两个标签不误报冲突等。
 */
(function () {
  'use strict';
  var KIT_VERSION = '1.0.0';
  var DEFAULT_SERVICE = 'http://127.0.0.1:18977'; // jc-doc 里没有 service_origin 时用工作台保存服务的默认端口
  var TIMEOUT_MS = 5000, DEBOUNCE_MS = 1000, POLL_MS = 3000, RED_AFTER_MS = 30000, IDLE_MS = 3000;
  var REASON_LONG = {
    changed: '这处内容在文件里已被修改（可能是 AI，也可能是其他窗口），输入框里现在显示的是文件里的版本。',
    item_changed: '这一条的标题或原文已被修改，你的改动可能已经对不上，输入框里现在显示的是文件里的版本。',
    field_gone: '文件里这一条已经没有这项内容了。',
    item_gone: '这一条已经从文件里删掉了。',
    group_conflict: '这处内容本身没有问题，但它和其他内容是一起保存的（比如采纳建议会同时修改稿子和决定），另一处对不上，所以这处也没有保存。'
  };
  var REASON_SHORT = { changed: '文件里这处已被修改', item_changed: '标题或原文已修改', field_gone: '这项内容已不存在', item_gone: '这一条已被删除', group_conflict: '一起保存的另一处对不上，都没有保存' };
  function reasonText(r, long) { var t = (long ? REASON_LONG : REASON_SHORT)[r]; return t || ('没有保存（' + r + '）'); }

  // ---------- 小工具 ----------
  function normS(v) { return String(v == null ? '' : v).replace(/\r\n?/g, '\n').normalize('NFC'); }
  function isText(v) { return v == null || typeof v === 'string'; }
  function eq(a, b) { return isText(a) && isText(b) ? normS(a) === normS(b) : JSON.stringify(a) === JSON.stringify(b); }
  function newId() {
    var a = new Uint8Array(10), s = '', abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    crypto.getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += abc[a[i] & 31];
    return s;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(t) { var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function mk(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(text, fn) { var b = mk('button', null, text); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function withTimeout(p, ms, what) { return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error(what || '超时')); }, ms); })]); }
  function errText(e) { return (e && e.message) || String(e); }
  function copyJson(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  // ---------- 条目指纹：locked 去掉 ai_state 后规范化 JSON 的 sha256 前 12 位（与 brain_save.item_fp 一致） ----------
  var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function ror(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256hex(str) {
    var bytes = new TextEncoder().encode(str), len = bytes.length;
    var m = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    m.set(bytes); m[len] = 0x80;
    var dv = new DataView(m.buffer), bits = len * 8;
    dv.setUint32(m.length - 4, bits >>> 0); dv.setUint32(m.length - 8, Math.floor(bits / 4294967296));
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], W = new Uint32Array(64);
    for (var i = 0; i < m.length; i += 64) {
      var t;
      for (t = 0; t < 16; t++) W[t] = dv.getUint32(i + t * 4);
      for (t = 16; t < 64; t++) {
        var x = W[t - 15], y = W[t - 2];
        W[t] = (W[t - 16] + (ror(x, 7) ^ ror(x, 18) ^ (x >>> 3)) + W[t - 7] + (ror(y, 17) ^ ror(y, 19) ^ (y >>> 10))) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) >>> 0;
        var t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map(function (v) { return ('0000000' + v.toString(16)).slice(-8); }).join('');
  }
  function canon(v) {
    if (typeof v === 'string') return JSON.stringify(normS(v));
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') {
      var ps = Object.keys(v).map(function (k) { return [normS(k), v[k]]; });
      ps.sort(function (p, q) { return p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0; });
      return '{' + ps.map(function (p) { return JSON.stringify(p[0]) + ':' + canon(p[1]); }).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  function itemFp(it) {
    var lk = it.locked || {}, o = {};
    Object.keys(lk).forEach(function (k) { if (k !== 'ai_state') o[k] = lk[k]; }); // AI 写的状态不算进指纹
    return sha256hex(canon(o)).slice(0, 12);
  }

  // ---------- 读基线（只信 jc-doc 数据块） ----------
  var docEl = document.getElementById('jc-doc'), doc = null, fatal = '';
  try {
    doc = JSON.parse(docEl ? docEl.textContent : '');
    if (!doc || !doc.page_id || !Array.isArray(doc.items)) throw new Error('缺少页面标识或条目');
  } catch (e) {
    doc = null;
    fatal = docEl ? '页面数据读不出来（' + e.message + '），这个页面无法保存' : '找不到页面数据，这个页面无法保存';
  }
  var PID = doc ? doc.page_id : '', TOKEN = doc ? doc.token : '';
  // 直接打开文件（file://）时找这个地址：jc-doc 里写的 service_origin，只认本机 127.0.0.1
  var SERVICE = doc && typeof doc.service_origin === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(doc.service_origin) ? doc.service_origin : DEFAULT_SERVICE;
  var served = window.JC_SERVED || null; // 只有经保存服务 /p/ 打开时才有
  var MODE = served && /^https?:$/.test(location.protocol) ? 'http' : 'file';
  var MODE_LABEL = MODE === 'http' ? 'http' : (location.protocol === 'file:' ? 'file://' : '外部地址');
  var MODE_TEXT = { 'http': '页面链接', 'file://': '直接打开的文件' }; // 只用于显示；MODE_LABEL 在第 793 行被比较、info() 对外给出，值不改
  var API = MODE === 'http' ? '' : SERVICE;
  var SELF_PATH = ''; // file:// 打开时自己的文件路径；补写和跳转前先让服务核对「是不是它认的那一份」
  if (MODE === 'file' && location.protocol === 'file:') { try { SELF_PATH = decodeURIComponent(location.pathname); } catch (e) { SELF_PATH = location.pathname; } }

  var base = {}, fps = {}, titles = {};
  if (doc) doc.items.forEach(function (it) {
    if (!it || !it.id) return;
    base[it.id] = Object.assign({}, it.fields || {});
    fps[it.id] = itemFp(it);
    var lk = it.locked || {};
    titles[it.id] = lk['标题'] || lk.title || '';
  });
  function isRegistered(item, field) { return !!base[item] && Object.prototype.hasOwnProperty.call(base[item], field); }
  // 冲突框和「复制我的改动」里怎么称呼一格：页面可以用 jcKit.setDescriber 换成大白话
  var describer = null;
  function describe(item, field) {
    if (describer) { try { var s = describer(item, field); if (s) return String(s); } catch (e) { /* 用默认说法 */ } }
    return '条目 ' + item + (titles[item] ? '「' + titles[item] + '」' : '') + ' · 字段「' + field + '」';
  }

  // ---------- 页面上的格子 ----------
  function allCells() { return Array.prototype.slice.call(document.querySelectorAll('[data-item][data-field]')); }
  function cells(item, field) {
    return allCells().filter(function (el) { return el.getAttribute('data-item') === item && el.getAttribute('data-field') === field; });
  }
  function cellOf(t) { return t && t.closest ? t.closest('[data-item][data-field]') : null; }
  function isRadio(el) { return el.tagName === 'INPUT' && el.type === 'radio'; }
  function isForm(el) { return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT'; }
  // 同一格可以有多个元素（响应式、双栏）：文本框读触发事件的那个，单选读被选中的那个
  function getVal(els, src) {
    if (!els.length) return undefined;
    if (isRadio(els[0])) {
      if (src && isRadio(src) && src.checked) return src.value;
      for (var i = 0; i < els.length; i++) if (els[i].checked) return els[i].value;
      return '';
    }
    var el = src && els.indexOf(src) >= 0 ? src : els[0];
    return isForm(el) ? el.value : el.innerText;
  }
  function setVal(els, v) {
    v = v == null ? '' : String(v);
    els.forEach(function (el) { if (isRadio(el)) el.checked = el.value === v; else if (isForm(el)) el.value = v; else el.textContent = v; });
  }
  function lockEl(el, on) { if (isRadio(el)) el.disabled = on; else if (isForm(el)) el.readOnly = on; else el.contentEditable = on ? 'false' : 'true'; }
  function setLocked(els, on) { els.forEach(function (el) { lockEl(el, on); el.classList.toggle('jc-kit-locked', on); }); }
  function resetCells() { // 所有登记过的格子一律设成 jc-doc 里的值
    allCells().forEach(function (el) {
      var item = el.getAttribute('data-item'), field = el.getAttribute('data-field');
      if (isRegistered(item, field)) setVal([el], base[item][field]);
    });
  }
  // 浏览器前进、后退时会把表单框恢复成离开前的样子（可能是 AI 改之前的旧文字）。
  // kit 一执行就关掉这些格子的表单恢复，并把格子设成 jc-doc 里的值；启动完成时再设一次，然后才放回暂存的改动。
  // 同时把还没锁的格子锁上（旧模板生成的页面没有 data-jc-wait）：启动完成前打的字记不下来，还会被上面的重设冲掉。
  // 创作页的格子由页面脚本在 kit 之后画出来，画的时候自己带 autocomplete="off" 和 data-jc-wait，这里碰不到也没关系。
  if (doc) {
    allCells().forEach(function (el) {
      if (isForm(el)) el.setAttribute('autocomplete', 'off');
      var editable = isForm(el) ? !el.readOnly && !el.disabled : el.isContentEditable;
      if (editable && !el.hasAttribute('data-jc-wait')) { el.setAttribute('data-jc-wait', ''); lockEl(el, true); }
    });
    resetCells();
  }

  // ---------- 暂存箱：IndexedDB，库名按 page_id ----------
  // 连接被浏览器断开（清站点数据、存储被回收）时先重开一次；再失败就换成内存暂存继续工作，改动照样直接写回文件。
  var inner = null, store = null, storeKind = 'idb', storeNote = '', storeError = '', recs = [];
  function openIdb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('这个浏览器不支持暂存'));
      var r;
      try { r = indexedDB.open('jc-stash-' + PID, 1); } catch (e) { return reject(e); }
      r.onupgradeneeded = function () { r.result.createObjectStore('changes', { keyPath: 'key' }); };
      r.onerror = function () { reject(r.error); };
      r.onblocked = function () { reject(new Error('暂存被另一个标签页占用')); };
      r.onsuccess = function () {
        var db = r.result, closed = false;
        db.onclose = function () { closed = true; };
        db.onversionchange = function () { closed = true; db.close(); };
        function tx(mode) { if (closed) throw new Error('暂存连接已被浏览器断开'); return db.transaction('changes', mode); }
        resolve({
          all: function () {
            return new Promise(function (res, rej) {
              var t = tx('readonly'), q = t.objectStore('changes').getAll();
              t.oncomplete = function () { res(q.result || []); };
              t.onerror = t.onabort = function () { rej(t.error || new Error('暂存读取被中止')); };
            });
          },
          // fn(旧记录) 返回新记录=写入，null=删除，undefined=不动；读和写在同一个事务里
          modify: function (key, fn) {
            return new Promise(function (res, rej) {
              var t = tx('readwrite'), s = t.objectStore('changes'), g = s.get(key);
              g.onsuccess = function () { var nx = fn(g.result); if (nx === null) s.delete(key); else if (nx) s.put(nx); };
              t.oncomplete = function () { res(); };
              t.onerror = t.onabort = function () { rej(t.error || new Error('暂存写入被中止')); };
            });
          }
        });
      };
    });
  }
  function memStore(seed) {
    var m = {};
    (seed || []).forEach(function (r) { m[r.key] = copyJson(r); });
    return {
      all: function () { return Promise.resolve(Object.keys(m).map(function (k) { return copyJson(m[k]); })); },
      modify: function (key, fn) { var nx = fn(copyJson(m[key])); if (nx === null) delete m[key]; else if (nx) m[key] = copyJson(nx); return Promise.resolve(); }
    };
  }
  function withStore(op) {
    return Promise.resolve().then(function () { return op(inner); }).catch(function (e1) {
      if (storeKind === 'memory') throw e1;
      return withTimeout(openIdb(), 3000, '打开暂存超时').then(function (s) {
        inner = s;
        return s.all().then(function (list) { // 库被清空了：把断开前看到的暂存放回去
          if (list.length || !recs.length) return;
          var snap = recs.slice();
          return Promise.all(snap.map(function (r) { return s.modify(r.key, function (cur) { return cur ? undefined : r; }); }));
        });
      }).then(function () { return op(inner); }).catch(function (e2) {
        inner = memStore(recs); storeKind = 'memory'; storeNote = errText(e2 || e1);
        return op(inner);
      });
    });
  }
  var robustStore = {
    all: function () { return withStore(function (s) { return s.all(); }); },
    modify: function (key, fn) { return withStore(function (s) { return s.modify(key, fn); }); }
  };
  function refresh() { return store.all().then(function (list) { recs = list; paint(); }); }
  function pending() { return recs.filter(function (r) { return !r.conflict; }); }
  function conflicts() { return recs.filter(function (r) { return !!r.conflict; }); }
  function queue(p) { return p.then(refresh).catch(function (e) { storeError = errText(e); paint(); }); }
  function recOf(key) { for (var i = 0; i < recs.length; i++) if (recs[i].key === key) return recs[i]; return null; }

  // ---------- 订阅：状态变化、格子的值变化时通知页面 ----------
  var subs = [], lastSig = '';
  function emit(type, detail) {
    var ev = Object.assign({ type: type }, detail || {});
    subs.slice().forEach(function (fn) { try { fn(ev); } catch (e) { if (window.console) console.error('jcKit 订阅回调出错', e); } });
  }
  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    subs.push(fn);
    return function () { var i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); };
  }

  // ---------- 状态 ----------
  var online = null, offlineSince = 0, lastOkAt = 0, lastSavedAt = Number(ss('jc-saved-' + PID)) || 0;
  var saveRefused = '', metaProblem = '', flashMsg = '', flashUntil = 0, persisted = null, kitFailed = '';
  var known = served ? served.fingerprint : null, gen = 0, needReload = false, selfOk = null, offerServed = false;
  var debounceTimer = null, flushing = false, flushAgain = false, busy = false, reloading = false, redirecting = false;
  var composing = false, lastInputAt = 0, ready = false, unreg = [], inflight = {}, status = { state: 'grey', msg: '' };
  function markOnline() { online = true; offlineSince = 0; lastOkAt = Date.now(); }
  function markOffline() { if (online !== false) { online = false; offlineSince = Date.now(); } offerServed = false; }
  function writeAllowed() { return MODE === 'http' || !SELF_PATH || selfOk === true; } // file:// 页面要先确认是服务认的那一份
  function idle() { return !debounceTimer && !composing && Date.now() - lastInputAt >= IDLE_MS; }

  function req(method, url, body) {
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS); // 5 秒硬超时
    return fetch(API + url, {
      method: method, signal: ctl.signal, cache: 'no-store', credentials: 'omit',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = {};
        try { data = JSON.parse(txt); } catch (e) { data = {}; }
        return { ok: res.ok, status: res.status, data: data || {} };
      });
    }).finally(function () { clearTimeout(timer); });
  }
  function metaError(r) {
    if (r.status === 404) {
      return MODE === 'http' ? '保存服务找不到这个页面（页面标识 ' + PID + '），可能已被删除或移出了工作文件夹，请把这段话转告 AI'
        : '保存服务已连接，但工作文件夹里找不到这个页面（页面标识 ' + PID + '），改动先暂存在这个浏览器，请把这段话转告 AI';
    }
    if (r.status === 409) return r.data.error || '这个页面有多份文件，保存服务已暂停打开和保存，请让 AI 处理多余的副本';
    return '无法查询文件状态（错误代码 ' + r.status + '）' + (r.data.error ? '：' + r.data.error : '');
  }

  // ---------- 没登记在 jc-doc 里的格子：锁住、挂红字，状态条变红 ----------
  function markUnreg(el) {
    if (el.classList.contains('jc-kit-unreg')) return;
    var item = el.getAttribute('data-item'), field = el.getAttribute('data-field');
    el.classList.add('jc-kit-unreg');
    lockEl(el, true);
    unreg.push({ el: el, item: item, field: field });
    var text = '这个输入框（条目 ' + item + ' · 字段「' + field + '」）没有登记在页面数据里，改动无法保存，已锁定。请让 AI 把这项内容登记进页面数据，或者让这个输入框不再参与保存。';
    var host = isRadio(el) ? (el.closest('.jc-field') || el.parentNode) : null;
    if (host) { if (!host.querySelector('.jc-kit-unreg-hint')) host.appendChild(mk('div', 'jc-kit-unreg-hint', text)); }
    else el.insertAdjacentElement('afterend', mk('div', 'jc-kit-unreg-hint', text));
    paint();
  }
  function unregKeys() {
    var seen = {}, out = [];
    unreg.forEach(function (u) { var k = u.item + '|' + u.field; if (!seen[k]) { seen[k] = true; out.push(u); } });
    return out;
  }

  // ---------- 记下改动 ----------
  // 同一格的暂存记录：改前值一直是「第一次改时文件里的值」，写回成功才换
  function stashFn(item, field, after, group) {
    return function (rec) {
      if (rec && rec.conflict) return undefined;
      var before = rec ? rec.before : base[item][field], now = Date.now();
      if (eq(after, before)) return null; // 改回原样就不用存了
      return {
        key: item + '|' + field, change_id: newId(), item_id: item, field: field, before: before, after: after,
        item_fp: rec ? rec.item_fp : fps[item], title: titles[item] || '',
        group: group !== undefined ? group : (rec ? rec.group || null : null),
        created: rec ? rec.created : now, updated: now, conflict: null
      };
    };
  }
  function onEdit(e) {
    var el = cellOf(e.target);
    if (!el || !store) return;
    lastInputAt = Date.now();
    if (e.isComposing) { if (!composing) { composing = true; paint(); } return; } // 输入法选字中：拼音不算改动，等上屏
    if (e.type === 'input') composing = false;
    if (el.classList.contains('jc-kit-locked') || el.classList.contains('jc-kit-unreg')) return;
    var item = el.getAttribute('data-item'), field = el.getAttribute('data-field');
    if (!isRegistered(item, field)) { markUnreg(el); return; }
    var els = cells(item, field), after = getVal(els, el), key = item + '|' + field;
    setVal(els.filter(function (x) { return x !== el; }), after); // 同一格的其他元素跟着变
    queue(store.modify(key, stashFn(item, field, after)));
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { debounceTimer = null; flush(); }, DEBOUNCE_MS);
    paint();
  }
  function onCompStart(e) { if (cellOf(e.target)) { composing = true; lastInputAt = Date.now(); paint(); } }
  function onCompEnd(e) { if (cellOf(e.target)) { composing = false; onEdit(e); } } // 上屏后补记一次
  function onFocusOut(e) { if (composing && cellOf(e.target)) { composing = false; paint(); } }

  // ---------- 程序化改动：jcKit.edit ----------
  // 一次改一格或几格；给了 group（或一次改好几格）时这几格同组提交，保存服务保证全成或全不成。
  // 返回 Promise<{ok, group, reason, message}>：ok 表示已进暂存并马上开始写回，写回结果看状态条或订阅。
  function edit(a, b, c, d) {
    var list, opts;
    if (Array.isArray(a)) { list = a; opts = b || {}; } else { list = [{ item: a, field: b, value: c }]; opts = d || {}; }
    function no(reason, message) { return Promise.resolve({ ok: false, reason: reason, message: message }); }
    if (fatal || kitFailed) return no('failed', fatal || kitFailed);
    if (!ready || !store) return no('not_ready', '保存功能启动中，请稍后再试');
    if (!list.length) return Promise.resolve({ ok: true, group: null });
    var keys = {}, i, x;
    for (i = 0; i < list.length; i++) {
      x = list[i];
      if (!x || !isRegistered(x.item, x.field)) return no('unregistered', '这处内容没有登记在页面数据里，无法保存：' + (x ? describe(x.item, x.field) : '空'));
      var r0 = recOf(x.item + '|' + x.field);
      if (r0 && r0.conflict) return no('conflict', describe(x.item, x.field) + '有冲突还没处理，先在冲突框里选好要哪一版');
      if (keys[x.item + '|' + x.field]) return no('duplicate', '同一处内容在一次操作里出现了两次');
      keys[x.item + '|' + x.field] = true;
    }
    var group = typeof opts.group === 'string' && opts.group ? opts.group : (opts.group || list.length > 1 ? newId() : null);
    var oldGroups = {};
    list.forEach(function (x) {
      var r = recOf(x.item + '|' + x.field);
      if (group && r && r.group && r.group !== group) oldGroups[r.group] = true; // 并进新组：旧组剩下的格子也跟着换组，免得拆开提交
      var v = x.value == null ? '' : String(x.value);
      setVal(cells(x.item, x.field), v);
      inflight[x.item + '|' + x.field] = v;
    });
    var jobs = list.map(function (x) { return store.modify(x.item + '|' + x.field, stashFn(x.item, x.field, x.value == null ? '' : String(x.value), group)); });
    return queue(Promise.all(jobs)).then(function () {
      var more = recs.filter(function (r) { return r.group && oldGroups[r.group] && !keys[r.key] && !r.conflict; });
      if (!more.length) return;
      return queue(Promise.all(more.map(function (r) {
        return store.modify(r.key, function (cur) { return cur && !cur.conflict ? Object.assign({}, cur, { group: group }) : undefined; });
      })));
    }).then(function () {
      list.forEach(function (x) { delete inflight[x.item + '|' + x.field]; });
      emit('values', { reason: 'edit', edits: list.map(function (x) { return { item: x.item, field: x.field }; }), group: group });
      if (storeError) return { ok: false, reason: 'store', message: '暂存出错：' + storeError };
      clearTimeout(debounceTimer); debounceTimer = null;
      if (opts.flush !== false) setTimeout(flush, 0); // 同一轮里接连几次 edit 一起发
      paint();
      return { ok: true, group: group };
    });
  }
  // 页面当前的值：有格子读格子，没有格子（例如「决定」）读暂存，否则是文件里的值
  function value(item, field) {
    if (!isRegistered(item, field)) return undefined;
    var key = item + '|' + field, els = cells(item, field);
    if (els.length && ready) return getVal(els);
    if (Object.prototype.hasOwnProperty.call(inflight, key)) return inflight[key];
    var r = recOf(key);
    if (r && !r.conflict) return r.after;
    return base[item][field];
  }
  function fileValue(item, field) { return isRegistered(item, field) ? base[item][field] : undefined; }
  function currentDoc() {
    if (!doc) return null;
    var out = copyJson(doc);
    out.items.forEach(function (it) {
      if (!it || !it.id || !it.fields) return;
      Object.keys(it.fields).forEach(function (f) { var v = value(it.id, f); if (v !== undefined) it.fields[f] = v; });
    });
    return out;
  }

  // ---------- 补写：同一浏览器同一页只让一个标签在补写 ----------
  function flush() {
    if (!store) return Promise.resolve();
    if (flushing) { flushAgain = true; return Promise.resolve(); }
    flushing = true; paint();
    function run(lock) {
      if (lock === null) { setTimeout(flush, 1500); return; } // 别的标签页正在补写，稍后再试
      return doFlush();
    }
    var p = navigator.locks && navigator.locks.request
      ? navigator.locks.request('jc-flush-' + PID, { ifAvailable: true }, run) : run(true);
    return Promise.resolve(p).catch(function (e) { storeError = errText(e); }).then(function () {
      flushing = false; paint();
      if (flushAgain) { flushAgain = false; return flush(); }
      afterFlush();
    });
  }
  function doFlush() {
    var sent;
    if (!writeAllowed()) return refresh(); // file:// 页面还没确认是服务认的那一份：先不发
    return store.all().then(function (list) {
      recs = list;
      sent = list.filter(function (r) { return !r.conflict; });
      if (!sent.length) return null;
      return req('POST', '/save', {
        page_id: PID, token: TOKEN, self_path: SELF_PATH || undefined,
        changes: sent.map(function (r) {
          var ch = { change_id: r.change_id, item_id: r.item_id, field: r.field, before: r.before, after: r.after, item_fp: r.item_fp };
          if (r.group) ch.group = r.group;
          return ch;
        })
      }).then(function (r) {
        markOnline();
        if (!r.ok) { saveRefused = r.data.error || ('错误代码 ' + r.status); return null; }
        saveRefused = '';
        return applyResults(sent, r.data);
      }, function () { markOffline(); return null; });
    }).then(refresh).then(decorate);
  }
  function applyResults(sent, data) {
    var byId = {}, jobs = [], anyOk = false, writes = [], bad = [];
    (data.results || []).forEach(function (r) { byId[r.change_id] = r; });
    sent.forEach(function (s) {
      var r = byId[s.change_id];
      if (!r) return;
      if (r.status === 'ok') {
        anyOk = true;
        if (base[s.item_id]) base[s.item_id][s.field] = s.after;
        writes.push({ item: s.item_id, field: s.field, value: s.after });
        // 只有回执 ok 才按 change_id 删；补写途中又改过的，改前值换成刚写进去的值，继续留着
        jobs.push(store.modify(s.key, function (rec) {
          if (!rec) return undefined;
          if (rec.change_id === s.change_id || eq(rec.after, s.after)) return null;
          return Object.assign({}, rec, { before: s.after });
        }));
      } else {
        if ('current' in r && base[s.item_id]) base[s.item_id][s.field] = r.current;
        if (r.item_fp) fps[s.item_id] = r.item_fp;
        bad.push({ item: s.item_id, field: s.field, reason: r.reason || 'changed', group: s.group || null });
        jobs.push(store.modify(s.key, function (rec) {
          if (!rec) return undefined;
          return Object.assign({}, rec, { conflict: { reason: r.reason || 'changed', current: 'current' in r ? r.current : null, at: Date.now() } });
        }));
      }
    });
    if (anyOk) { lastSavedAt = Date.now(); ss('jc-saved-' + PID, String(lastSavedAt)); }
    gen++;
    if (MODE === 'http') {
      if (known && data.base_fingerprint && data.base_fingerprint !== known) needReload = true; // 期间文件被别人改过
      if (data.fingerprint) known = data.fingerprint;
    }
    if (writes.length) tellPeers({ type: 'written', page_id: PID, writes: writes, base_fingerprint: data.base_fingerprint, fingerprint: data.fingerprint });
    return Promise.all(jobs).then(function () {
      if (writes.length || bad.length) emit('values', { reason: 'saved', writes: writes, conflicts: bad });
    });
  }
  function afterFlush() {
    if (MODE === 'http') return maybeReload();
    offerServed = !!online && !pending().length && !conflicts().length && !saveRefused && !metaProblem && writeAllowed();
    // 编辑中不自动跳走（跳转途中打的字会丢）：停笔 3 秒、没在选字、焦点也不在格子里才跳；否则状态条上给按钮
    if (offerServed && idle() && !flushing && !cellOf(document.activeElement)) goServed();
    paint();
  }
  function maybeReload() {
    if (MODE !== 'http' || !needReload || reloading || flushing || pending().length || !idle()) return;
    reloading = true;
    emit('reload', {});
    saveFocus();
    ss('jc-scroll-' + PID, String(window.scrollY));
    location.reload();
  }
  function goServed() {
    if (redirecting) return;
    redirecting = true; paint();
    location.replace(SERVICE + '/p/' + encodeURIComponent(PID));
  }
  function saveFocus() { // 整页重新加载前记住光标在哪一格，加载完放回去
    var el = cellOf(document.activeElement);
    if (!el) return;
    var item = el.getAttribute('data-item'), field = el.getAttribute('data-field');
    var f = { item: item, field: field, idx: cells(item, field).indexOf(el) };
    try { f.s = el.selectionStart; f.e = el.selectionEnd; } catch (e) { /* 单选没有光标 */ }
    ss('jc-focus-' + PID, JSON.stringify(f));
  }
  function restoreFocus() {
    var raw = ss('jc-focus-' + PID);
    if (!raw) return;
    ss('jc-focus-' + PID, null);
    try {
      var f = JSON.parse(raw), el = cells(f.item, f.field)[f.idx];
      if (!el || el.readOnly || el.disabled) return;
      el.focus({ preventScroll: true });
      if (typeof f.s === 'number' && el.setSelectionRange) { var n = el.value.length; el.setSelectionRange(Math.min(f.s, n), Math.min(f.e, n)); }
    } catch (e) { /* 放不回去就算了 */ }
  }

  // ---------- 同一页面的其他标签：写回成功后广播，别的标签据此更新基线，免得接着写被误判成冲突 ----------
  var chan = null;
  function tellPeers(msg) { try { if (chan) chan.postMessage(msg); } catch (e) { /* 广播失败不影响保存 */ } }
  function onPeer(ev) {
    var m = ev && ev.data;
    if (!m || m.type !== 'written' || m.page_id !== PID || !ready) return;
    var allShown = true, shown = [];
    (m.writes || []).forEach(function (w) {
      if (!isRegistered(w.item, w.field)) return;
      var els = cells(w.item, w.field), key = w.item + '|' + w.field;
      if (!els.length || eq(getVal(els), w.value)) { base[w.item][w.field] = w.value; shown.push(w); return; }
      var mine = recs.some(function (r) { return r.key === key; });
      var editing = els.some(function (el) { return el === document.activeElement || el.contains(document.activeElement); });
      if (!mine && !editing) { setVal(els, w.value); base[w.item][w.field] = w.value; shown.push(w); return; }
      allShown = false; // 格子里是别的内容且正在改：基线不动，接着改会按冲突处理，停笔后整页重新加载对齐
    });
    gen++; // 作废路上的指纹检查
    if (MODE === 'http' && allShown && known && m.base_fingerprint === known && m.fingerprint) known = m.fingerprint;
    queue(Promise.resolve()).then(decorate).then(function () { if (shown.length) emit('values', { reason: 'peer', writes: shown }); }); // 重读暂存：别的标签可能刚删掉已写回的记录
  }

  // ---------- 盯文件：前台每 3 秒问一次指纹，切回页面立刻问 ----------
  function tick() {
    if (!store || busy || flushing || reloading || redirecting) return;
    busy = true;
    var g = gen, p;
    if (MODE === 'http') {
      p = req('GET', '/p/' + encodeURIComponent(PID) + '/meta').then(function (r) {
        markOnline();
        if (!r.ok) { metaProblem = metaError(r); return; }
        metaProblem = '';
        if (g !== gen || flushing) return; // 期间自己刚写过，这次结果作废
        if (!known) known = r.data.fingerprint; else if (r.data.fingerprint !== known) needReload = true;
        if (pending().length && !debounceTimer) return flush(); // 有暂存先补写，补写完再决定要不要重新加载
        maybeReload();
      });
    } else {
      p = req('GET', '/healthz').then(function (r) {
        if (!r.ok) throw new Error('healthz ' + r.status);
        markOnline();
        return req('GET', '/p/' + encodeURIComponent(PID) + '/meta' + (SELF_PATH ? '?file=' + encodeURIComponent(SELF_PATH) : ''));
      }).then(function (r) {
        if (!r.ok) { metaProblem = metaError(r); offerServed = false; return; }
        if (SELF_PATH) {
          selfOk = r.data.same_file === true;
          if (!selfOk) {
            metaProblem = '你打开的文件不是保存服务使用的那一份（保存服务使用的是工作文件夹里的 ' + r.data.path + '）。为了不写错文件，这里的改动只暂存在这个浏览器，不会保存到文件，也不会自动跳转。请点「复制未保存的改动」交给 AI，或者改用页面链接打开：' + SERVICE + '/p/' + PID;
            offerServed = false;
            return;
          }
        }
        metaProblem = '';
        if (pending().length) return flush(); // 带 token 补写成功后 afterFlush 决定要不要跳转
        afterFlush();
      });
    }
    p.catch(function () { markOffline(); }).then(function () { busy = false; paint(); });
  }

  // ---------- 冲突：格子里显示文件版本，旁边挂「你的版本（未采用）」；同组的改动一起摆、一起处理 ----------
  function fileValueOf(rec) {
    var b = base[rec.item_id];
    return b && rec.field in b ? b[rec.field] : (rec.conflict ? rec.conflict.current : null);
  }
  function isGone(rec) { return rec.conflict && (rec.conflict.reason === 'item_gone' || rec.conflict.reason === 'field_gone'); }
  function show(v) { return v == null || v === '' ? '（空）' : String(v); }
  function conflictBox(rec, inCell) {
    var box = mk('div', 'jc-kit-cbox');
    box.appendChild(mk('div', 'jc-kit-ctitle', '冲突：' + reasonText(rec.conflict.reason, inCell)));
    if (!inCell) box.appendChild(mk('div', 'jc-kit-cmeta', describe(rec.item_id, rec.field)));
    box.appendChild(mk('div', 'jc-kit-clabel', '你的版本（未保存）：'));
    box.appendChild(mk('pre', 'jc-kit-cmine', show(rec.after)));
    if (!inCell && !isGone(rec)) { box.appendChild(mk('div', 'jc-kit-clabel', '文件里现在是：')); box.appendChild(mk('pre', 'jc-kit-cfile', show(fileValueOf(rec)))); }
    var row = mk('div', 'jc-kit-cbtns');
    if (!isGone(rec)) row.appendChild(btn('换回我的', function () { useMine([rec]); }));
    row.appendChild(btn(inCell ? '用文件里的' : '放弃改动', function () { dropMine([rec]); }));
    box.appendChild(row);
    return box;
  }
  function groupBox(members) {
    var box = mk('div', 'jc-kit-cbox jc-kit-gbox'), anyGone = members.some(isGone);
    box.appendChild(mk('div', 'jc-kit-ctitle', '冲突：这 ' + members.length + ' 处内容是一起保存的（比如采纳建议会同时修改稿子和决定），其中有内容和文件对不上，所以这一组都没有保存'));
    members.forEach(function (m) {
      var part = mk('div', 'jc-kit-gpart');
      part.appendChild(mk('div', 'jc-kit-cmeta', describe(m.item_id, m.field) + '：' + reasonText(m.conflict.reason, false)));
      part.appendChild(mk('div', 'jc-kit-clabel', '你的版本（未保存）：'));
      part.appendChild(mk('pre', 'jc-kit-cmine', show(m.after)));
      if (!isGone(m)) { part.appendChild(mk('div', 'jc-kit-clabel', '文件里现在是：')); part.appendChild(mk('pre', 'jc-kit-cfile', show(fileValueOf(m)))); }
      box.appendChild(part);
    });
    var row = mk('div', 'jc-kit-cbtns');
    if (!anyGone) row.appendChild(btn('整组换回我的', function () { useMine(members); }));
    row.appendChild(btn('整组放弃改动（用文件里的）', function () { dropMine(members); }));
    box.appendChild(row);
    return box;
  }
  function hostOf(els) { return els[0].closest('.jc-field') || els[els.length - 1].parentNode; }
  function decorate() {
    var old = document.querySelectorAll('.jc-kit-cbox');
    for (var i = 0; i < old.length; i++) old[i].remove();
    setLocked(Array.prototype.slice.call(document.querySelectorAll('.jc-kit-locked')), false);
    var gone = [], groups = {}, done = {}, changed = false, confs = conflicts();
    confs.forEach(function (r) { if (r.group) (groups[r.group] = groups[r.group] || []).push(r); });
    confs.forEach(function (rec) {
      var members = rec.group && groups[rec.group].length > 1 ? groups[rec.group] : null;
      if (members) {
        if (done[rec.group]) return;
        done[rec.group] = true;
        if (members.every(function (m) { return !isGone(m) && eq(fileValueOf(m), m.after); })) { // 文件已经是我的版本：冲突自然消解
          members.forEach(function (m) { queue(store.modify(m.key, function () { return null; })); });
          return;
        }
        var host = null;
        members.forEach(function (m) {
          var els = cells(m.item_id, m.field);
          if (!els.length || isGone(m)) return;
          if (!eq(getVal(els), fileValueOf(m))) changed = true;
          setVal(els, fileValueOf(m)); setLocked(els, true);
          if (!host) host = hostOf(els);
        });
        if (host) host.appendChild(groupBox(members)); else gone.push(groupBox(members));
        return;
      }
      var els = cells(rec.item_id, rec.field);
      if (!els.length || isGone(rec)) { gone.push(conflictBox(rec, false)); return; }
      var fv = fileValueOf(rec);
      if (eq(fv, rec.after)) { queue(store.modify(rec.key, function () { return null; })); return; } // 文件已经是我的版本，冲突自然消解
      if (!eq(getVal(els), fv)) changed = true;
      setVal(els, fv); setLocked(els, true);
      hostOf(els).appendChild(conflictBox(rec, true));
    });
    gonePanel.textContent = '';
    gonePanel.hidden = !gone.length;
    if (gone.length) {
      gonePanel.appendChild(mk('div', 'jc-kit-gtitle', '下面这些改动没有保存到文件，页面上也找不到对应的输入框（对应内容已被删除，或者是按钮一类的操作），请先点「复制未保存的改动」留底，再决定怎么处理：'));
      gone.forEach(function (b) { gonePanel.appendChild(b); });
    }
    if (changed || confs.length) emit('values', { reason: 'conflict', conflicts: confs.length });
  }
  function useMine(list) {
    // 换回我的 = 发一条新改动，改前值用文件当前值；同组的一起换回，保持同组
    var jobs = list.map(function (rec) {
      var cur = fileValueOf(rec), fp = fps[rec.item_id] || rec.item_fp;
      return store.modify(rec.key, function (r) {
        return r ? Object.assign({}, r, { before: cur, item_fp: fp, change_id: newId(), conflict: null, updated: Date.now() }) : undefined;
      });
    });
    queue(Promise.all(jobs).then(function () {
      list.forEach(function (rec) { var els = cells(rec.item_id, rec.field); setLocked(els, false); setVal(els, rec.after); });
    })).then(decorate).then(function () { emit('values', { reason: 'use_mine' }); }).then(flush);
  }
  function dropMine(list) {
    queue(Promise.all(list.map(function (rec) { return store.modify(rec.key, function () { return null; }); }))).then(function () {
      list.forEach(function (rec) { var els = cells(rec.item_id, rec.field); setLocked(els, false); setVal(els, fileValueOf(rec)); });
      decorate();
      emit('values', { reason: 'drop_mine' });
    });
  }

  // ---------- 复制我的改动：整理成 AI 能读的 Markdown ----------
  // 除了暂存里的记录，还逐格比对页面当前值和基线：暂存出过问题时也不漏掉页面上改过的内容
  function fence(v) { var s = show(v), f = '```'; while (s.indexOf(f) >= 0) f += '`'; return f + 'text\n' + s + '\n' + f; }
  function unsavedCells() {
    var have = {}, seen = {}, out = [];
    recs.forEach(function (r) { have[r.key] = true; });
    allCells().forEach(function (el) {
      var item = el.getAttribute('data-item'), field = el.getAttribute('data-field'), key = item + '|' + field;
      if (seen[key] || have[key] || !isRegistered(item, field)) return;
      seen[key] = true;
      var v = getVal(cells(item, field));
      if (!eq(v, base[item][field])) out.push({ key: key, item_id: item, field: field, title: titles[item] || '', before: base[item][field], after: v });
    });
    return out;
  }
  function buildMarkdown() {
    if (!doc) return '# 这个页面没有可用的 jc-doc 数据块，没有可以导出的改动\n\n' + fatal;
    var extra = unsavedCells(), uk = unregKeys(), n = 0;
    var L = ['# 网页上还没写回文件的改动', '',
      '- 页面：' + (document.title.indexOf(doc.content_id || '') === 0 ? '' : (doc.content_id || '') + ' ') + document.title + '（page_id：' + PID + '）',
      '- 文件：' + (served && served.path ? served.path : SELF_PATH ? SELF_PATH + '（直接打开的文件）' : '未知（不是经保存服务打开的）'),
      '- 打开方式：' + MODE_LABEL + '，kit ' + KIT_VERSION + (storeKind === 'memory' ? '，浏览器暂存不可用（' + storeNote + '）' : ''),
      '- 导出时间：' + new Date().toLocaleString('zh-CN'), ''];
    if (!recs.length && !extra.length && !uk.length) L.push('没有未写回的改动。');
    recs.forEach(function (r) {
      L.push('## ' + (++n) + '. ' + describe(r.item_id, r.field) + '（条目 ' + r.item_id + ' · 字段 ' + r.field + '）', '',
        '- 状态：' + (r.conflict ? '冲突，' + reasonText(r.conflict.reason, false) : '暂存在浏览器，还没写回文件') + (r.group ? '（和同组的格子一起提交，组号 ' + r.group + '）' : ''),
        '- 改前（我改的时候文件里的值）：', fence(r.before), '- 我的版本：', fence(r.after));
      if (r.conflict && r.conflict.current != null) L.push('- 文件里现在是：', fence(r.conflict.current));
      L.push('');
    });
    extra.forEach(function (r) {
      L.push('## ' + (++n) + '. ' + describe(r.item_id, r.field) + '（条目 ' + r.item_id + ' · 字段 ' + r.field + '）', '',
        '- 状态：页面上改了，但暂存里没有记录（暂存出过问题），还没写回文件',
        '- 改前（页面记得的文件值）：', fence(r.before), '- 页面上现在是：', fence(r.after), '');
    });
    uk.forEach(function (u) {
      L.push('## ' + (++n) + '. 条目 ' + u.item + ' · 字段「' + u.field + '」（没有登记在 jc-doc 里，存不上）', '',
        '- 页面上现在是：', fence(getVal(cells(u.item, u.field))), '');
    });
    return L.join('\n');
  }
  function changeCount() { return recs.length + unsavedCells().length + unregKeys().length; }
  function flash(msg) { flashMsg = msg; flashUntil = Date.now() + 4000; paint(); }
  function copyChanges() {
    var text = buildMarkdown(), n = changeCount();
    function legacy() {
      var t = mk('textarea'); t.value = text; t.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(t); t.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      t.remove();
      return ok;
    }
    function done(ok) {
      if (ok) return flash('已复制 ' + n + ' 处改动，可以直接粘贴给 AI');
      flash('浏览器不允许自动复制，下方文本框里的内容已经全选，按 ⌘C 复制');
      var box = mk('div', 'jc-kit-manual'), ta = mk('textarea');
      ta.value = text; box.appendChild(ta); box.appendChild(btn('关闭', function () { box.remove(); }));
      document.body.appendChild(box); ta.focus(); ta.select();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacy()); });
    else done(legacy());
  }

  // ---------- 状态条 ----------
  // 页面里有 [data-jc-kit-bar] 就画进去（创作页的顶栏）；没有就像实验版一样钉在页面最上面
  var bar, dot, msgEl, confEl, flashEl, verEl, goBtn, gonePanel, inline = false;
  function buildUi() {
    var st = mk('style');
    st.textContent = [
      '.jc-kit-bar{position:fixed;top:0;left:0;right:0;z-index:2147483600;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:8px 14px;font:14px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;color:#1c1c1e;border-bottom:1px solid rgba(0,0,0,.12);box-shadow:0 1px 4px rgba(0,0,0,.06)}',
      '.jc-kit-bar[data-state=green]{background:#e6f4ea}.jc-kit-bar[data-state=yellow]{background:#fff3c4}.jc-kit-bar[data-state=red]{background:#fddcd8}.jc-kit-bar[data-state=grey]{background:#eef0f4}',
      '.jc-kit-bar.jc-kit-inline{position:static;z-index:auto;border:0;box-shadow:none;border-radius:10px;padding:5px 10px;gap:4px 8px;font-size:13px;line-height:1.4}',
      '.jc-kit-dot{width:10px;height:10px;border-radius:50%;flex:none;background:#8a8f98}',
      '[data-state=green] .jc-kit-dot{background:#1e8e3e}[data-state=yellow] .jc-kit-dot{background:#e0a800}[data-state=red] .jc-kit-dot{background:#d93025}',
      '.jc-kit-msg{flex:1 1 16em;font-weight:500}.jc-kit-inline .jc-kit-msg{flex:1 1 auto;min-width:0}.jc-kit-flash{color:#1a5fd0;font-size:13px}',
      '.jc-kit-conf{background:#d93025;color:#fff;border-radius:10px;padding:1px 9px;font-size:12px}',
      '.jc-kit-ver{font-size:12px;color:#5f6368;white-space:nowrap}.jc-kit-inline .jc-kit-ver{display:none}',
      '.jc-kit-bar button,.jc-kit-cbox button,.jc-kit-manual button{font:inherit;font-size:13px;padding:3px 10px;border:1px solid rgba(0,0,0,.22);border-radius:6px;background:#fff;color:#1c1c1e;cursor:pointer}',
      '.jc-kit-inline button{font-size:12px;padding:2px 8px}',
      '.jc-kit-gone{margin:0 0 16px;padding:10px 14px;border:1px solid #f0b400;border-radius:8px;background:#fffaf0;font:14px/1.6 -apple-system,"PingFang SC",sans-serif}',
      '.jc-kit-cbox{margin:8px 0 4px;padding:10px 12px;border:1px solid #f0b400;border-left:4px solid #d93025;border-radius:8px;background:#fffaf0;font:14px/1.6 -apple-system,"PingFang SC",sans-serif;color:#1c1c1e}',
      '.jc-kit-ctitle{font-weight:600;color:#b3261e}.jc-kit-cmeta{color:#5f6368;font-size:13px}.jc-kit-gpart{margin:6px 0;padding-top:6px;border-top:1px dashed #e6c870}',
      '.jc-kit-cbox pre{white-space:pre-wrap;word-break:break-word;margin:4px 0 8px;padding:6px 8px;background:#fff;border:1px dashed #d0a000;border-radius:6px;font:inherit}',
      '.jc-kit-cbtns{display:flex;flex-wrap:wrap;gap:8px}.jc-kit-locked,.jc-kit-unreg{background:#f1f1f1!important;color:#555!important}',
      '.jc-kit-unreg{outline:2px solid #d93025}.jc-kit-unreg-hint{margin:4px 0 8px;color:#b3261e;font:600 13px/1.5 -apple-system,"PingFang SC",sans-serif}',
      '.jc-kit-manual{position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483601;background:#fff;border:1px solid #999;border-radius:8px;padding:10px;box-shadow:0 4px 20px rgba(0,0,0,.2)}',
      '.jc-kit-manual textarea{width:100%;height:40vh;box-sizing:border-box;font:13px/1.5 ui-monospace,Menlo,monospace}'
    ].join('\n');
    document.head.appendChild(st);
    var slot = document.querySelector('[data-jc-kit-bar]');
    inline = !!slot;
    bar = mk('div', 'jc-kit-bar' + (inline ? ' jc-kit-inline' : '')); bar.setAttribute('role', 'status');
    dot = mk('span', 'jc-kit-dot'); msgEl = mk('span', 'jc-kit-msg'); confEl = mk('span', 'jc-kit-conf'); flashEl = mk('span', 'jc-kit-flash');
    verEl = mk('span', 'jc-kit-ver', '保存功能 ' + KIT_VERSION + ' · ' + (MODE_TEXT[MODE_LABEL] || MODE_LABEL));
    goBtn = btn('改用页面链接打开', function () { if (!pending().length) goServed(); });
    goBtn.className = 'jc-kit-go'; goBtn.hidden = true;
    bar.appendChild(dot); bar.appendChild(msgEl); bar.appendChild(confEl); bar.appendChild(flashEl);
    bar.appendChild(goBtn); bar.appendChild(btn('复制未保存的改动', copyChanges)); bar.appendChild(verEl);
    gonePanel = mk('div', 'jc-kit-gone'); gonePanel.hidden = true;
    var goneSlot = document.querySelector('[data-jc-kit-gone]');
    if (goneSlot) goneSlot.appendChild(gonePanel); else document.body.insertBefore(gonePanel, document.body.firstChild);
    if (inline) { slot.textContent = ''; slot.appendChild(bar); } else document.body.insertBefore(bar, document.body.firstChild);
  }
  function paint() {
    if (!bar) return;
    var now = Date.now(), pend = pending().length, conf = conflicts().length, state, msg, uk = unregKeys().length;
    var prefix = MODE === 'http' ? '' : (MODE_LABEL === 'file://' ? '直接打开的文件：' : '未通过保存服务打开：');
    if (fatal) { state = 'red'; msg = fatal; }
    else if (kitFailed) { state = 'red'; msg = '保存功能无法启动：' + kitFailed + '。页面已锁定，改动无法保存，请把这段话转告 AI'; }
    else if (storeError) { state = 'red'; msg = '暂存出错：' + storeError + '。请马上点「复制未保存的改动」留底'; }
    else if (saveRefused) { state = 'red'; msg = '保存被拒绝：' + saveRefused + '（改动还留在这个浏览器里）'; }
    else if (online === false) {
      var secs = Math.round((now - offlineSince) / 1000);
      msg = prefix + (storeKind === 'memory' ? (pend ? '保存服务未连接，' + pend + ' 处改动只保留在当前页面' : '保存服务未连接')
        : (pend ? '保存服务未连接，' + pend + ' 处改动已暂存在这个浏览器' : '保存服务未连接，改动会先暂存在这个浏览器'));
      state = now - offlineSince >= RED_AFTER_MS ? 'red' : 'yellow';
      if (state === 'red') msg += '（已断开 ' + (secs >= 60 ? Math.floor(secs / 60) + ' 分 ' + secs % 60 + ' 秒' : secs + ' 秒') + (pend ? '，建议点「复制未保存的改动」留底' : '，请告诉 AI 检查保存服务') + '）';
    }
    else if (metaProblem) { state = 'red'; msg = metaProblem; }
    else if (redirecting) { state = 'grey'; msg = '保存服务已连接，正在改用页面链接打开…'; }
    else if (composing) { state = 'grey'; msg = '输入法选字中，选定后停顿 1 秒自动保存'; }
    else if (debounceTimer) { state = 'grey'; msg = '正在编辑，停止输入 1 秒后自动保存'; }
    else if (flushing || pend) { state = 'grey'; msg = flushing ? '正在保存 ' + pend + ' 处改动…' : pend + ' 处改动待保存'; }
    else if (online === null || !ready) { state = 'grey'; msg = '正在连接保存服务…'; }
    else if (MODE !== 'http' && conf) { state = 'yellow'; msg = prefix + '处理完冲突后，会自动改用页面链接打开'; }
    else {
      state = 'green';
      msg = prefix + (lastSavedAt ? '已保存到文件 ' + hhmm(lastSavedAt) : '已连接保存服务，页面和文件一致 ' + hhmm(lastOkAt || now));
      if (offerServed) msg += '；保存服务已恢复，停止输入并离开输入框后，会自动改用页面链接打开';
    }
    if (storeKind === 'memory') {
      if (state === 'grey') state = 'yellow';
      msg += state === 'green' ? '（这个浏览器暂存不可用，之后的改动直接保存到文件，关闭页面前请确认状态是绿色）'
        : '。这个浏览器暂存不可用，关闭或刷新页面会丢失未保存的改动，请等状态变绿再关闭';
    }
    if (uk) { state = 'red'; msg = '页面上有 ' + uk + ' 个输入框没有登记在页面数据里，改动无法保存，已锁定（旁边有红字说明）。' + msg; }
    bar.setAttribute('data-state', state);
    msgEl.textContent = msg;
    confEl.textContent = conf ? conf + ' 处冲突待处理' : '';
    confEl.hidden = !conf;
    goBtn.hidden = !(offerServed && !redirecting && MODE !== 'http');
    flashEl.textContent = now < flashUntil ? flashMsg : '';
    verEl.title = '页面标识 ' + PID + (served && served.path ? '，文件 ' + served.path : '') + '；' + (storeKind === 'idb' ? '浏览器暂存可用' : '浏览器暂存不可用，改动只保留在当前页面（' + storeNote + '）') + (persisted === true ? '；浏览器已同意长期保留暂存' : persisted === false ? '；浏览器没有同意长期保留暂存' : '');
    bar.title = '保存功能 ' + KIT_VERSION + ' · 打开方式：' + (MODE_TEXT[MODE_LABEL] || MODE_LABEL) + ' · ' + verEl.title;
    if (!inline) {
      var h = bar.offsetHeight + 12 + 'px';
      if (document.body.style.paddingTop !== h) document.body.style.paddingTop = h;
    }
    status = { state: state, msg: msg, pending: pend, conflicts: conf, ready: ready, online: online };
    var sig = [state, msg, pend, conf, ready].join('|');
    if (sig !== lastSig) { lastSig = sig; emit('state', { status: status }); }
  }

  // ---------- 启动 ----------
  function removeWaitNotes() { var n = document.querySelectorAll('.jc-wait'); for (var i = 0; i < n.length; i++) n[i].remove(); }
  function unlockWaiting() { // 页面模板在 kit 就绪前把格子设成只读；到这里才解锁
    var w = document.querySelectorAll('[data-jc-wait]');
    for (var i = 0; i < w.length; i++) { w[i].removeAttribute('data-jc-wait'); lockEl(w[i], false); }
    removeWaitNotes();
  }
  function fail(msg) { // kit 没法工作：格子一律锁住（改了也存不上），状态条报红
    kitFailed = msg; window.jcKit.failed = msg;
    allCells().forEach(function (el) { lockEl(el, true); });
    removeWaitNotes(); paint();
    emit('failed', { message: msg });
  }
  function init() {
    buildUi();
    if (!doc) { fail(fatal); return; }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(function (ok) { persisted = ok; paint(); }, function () {}); } catch (e) { persisted = false; }
    withTimeout(openIdb(), 3000, '打开暂存超时').catch(function (e) { storeKind = 'memory'; storeNote = errText(e); return memStore([]); }).then(function (s) {
      inner = s; store = robustStore;
      return refresh();
    }).then(function () {
      allCells().forEach(function (el) { if (isForm(el)) el.setAttribute('autocomplete', 'off'); });
      resetCells(); // 再设一次：浏览器可能在 kit 执行之后才恢复表单
      pending().forEach(function (r) { var els = cells(r.item_id, r.field); if (els.length) setVal(els, r.after); }); // 把没写回的改动放回格子
      unlockWaiting();
      allCells().forEach(function (el) { if (!isRegistered(el.getAttribute('data-item'), el.getAttribute('data-field'))) markUnreg(el); });
      ready = true; window.jcKit.ready = true; // decorate 里要按「已就绪」读格子
      decorate();
      var y = ss('jc-scroll-' + PID);
      if (y !== null) { ss('jc-scroll-' + PID, null); window.scrollTo(0, Number(y) || 0); }
      restoreFocus();
      try { if (window.BroadcastChannel) { chan = new BroadcastChannel('jc-page-' + PID); chan.onmessage = onPeer; } } catch (e) { chan = null; }
      document.addEventListener('input', onEdit, true);
      document.addEventListener('change', onEdit, true);
      document.addEventListener('compositionstart', onCompStart, true);
      document.addEventListener('compositionend', onCompEnd, true);
      document.addEventListener('focusout', onFocusOut, true);
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') tick(); });
      window.addEventListener('pageshow', function (e) { // 从前进后退缓存里恢复：立刻核对文件指纹
        if (!e.persisted) return;
        reloading = false; redirecting = false; busy = false;
        tick();
      });
      window.addEventListener('online', tick);
      setInterval(function () { if (document.visibilityState === 'visible') tick(); }, POLL_MS);
      setInterval(paint, 1000);
      paint();
      emit('ready', { pending: pending().length, conflicts: conflicts().length });
      tick();
    }).catch(function (e) { fail(errText(e)); });
  }
  window.jcKit = { // 页面脚本用的接口；调试时也可以在浏览器控制台里看状态、手动补写
    version: KIT_VERSION, mode: MODE, ready: false, failed: '', pageId: PID, service: SERVICE,
    flush: flush, tick: tick, markdown: buildMarkdown, copyChanges: copyChanges,
    edit: edit, subscribe: subscribe, doc: currentDoc, value: value, fileValue: fileValue,
    isRegistered: isRegistered, itemFp: function (it) { return itemFp(it); },
    request: req,
    changes: function (item) { // 改动记录（保存服务 /changes），按时间正序
      return req('GET', '/p/' + encodeURIComponent(PID) + '/changes' + (item ? '?item=' + encodeURIComponent(item) : '')).then(function (r) {
        if (!r.ok) throw new Error(r.data.error || ('错误代码 ' + r.status));
        return Array.isArray(r.data.changes) ? r.data.changes : [];
      });
    },
    info: function () { return { mode: MODE, modeLabel: MODE_LABEL, pageId: PID, contentId: doc ? doc.content_id : '', path: served && served.path ? served.path : SELF_PATH, service: SERVICE, version: KIT_VERSION }; },
    setDescriber: function (fn) { describer = typeof fn === 'function' ? fn : null; },
    status: function () { return Object.assign({}, status); },
    state: function () {
      return { online: online, pending: pending().length, conflicts: conflicts().length, known: known, saveRefused: saveRefused, metaProblem: metaProblem,
        storeKind: storeKind, storeNote: storeNote, storeError: storeError, composing: composing, selfOk: selfOk, offerServed: offerServed,
        unregistered: unregKeys().length, ready: ready, stash: recs };
    }
  };
  // 页面脚本（app）紧跟在 kit 后面：解析期间 kit 等 DOMContentLoaded 再启动，app 已经把格子画好了；
  // 万一 kit 是在页面解析完之后才执行的，也推迟一拍，让后面的脚本先把格子画出来。
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else setTimeout(init, 0);
})();
/* jc-kit:eof */
