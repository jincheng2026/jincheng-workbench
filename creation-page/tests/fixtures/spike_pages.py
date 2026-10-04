#!/usr/bin/env python3
"""测试用：生成同步实验的两个通用测试页（由实验的 make_pages.py 迁来），测保存服务和 kit 的通用行为。
T999_测试稿/对照页.html、T998_审稿测试/审稿页.html。

页面身份号、条目身份号、口令都是随机短码（不用位置编号）；页面内容只从 jc-doc 数据块渲染，
保存脚本（kit/kit.js，可用环境变量 JC_KIT_FILE 换成别的文件）整段嵌进 <!--jc-kit:start--> 与 <!--jc-kit:end--> 之间。
用法：/usr/bin/python3 spike_pages.py --root <目录>
"""
import argparse, html, json, os, secrets, sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(APP, 'server'))
import brain_save as server  # noqa: E402

ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'
SERVICE = 'http://127.0.0.1:18998'  # 测试页里写的服务地址；浏览器测试会把它换成临时端口
KIT_FILE = os.environ.get('JC_KIT_FILE') or os.path.join(APP, 'kit', 'kit.js')


def short(n=8):
    return ''.join(secrets.choice(ALPHABET) for _ in range(n))


COMPARE_ITEMS = [
    ({'标题': '开头钩子', '参考原文': '很多人以为 AI 写稿就是一键生成，其实真正花时间的是改。'},
     {'改写': '别再指望 AI 一键出稿了，真正决定质量的是你改的那几遍。'}),
    ({'标题': '核心观点', '参考原文': '把 AI 当实习生，而不是当作者：你负责判断，它负责铺量。'},
     {'改写': 'AI 是实习生，不是作者。判断归你，铺量归它。'}),
    ({'标题': '结尾行动', '参考原文': '今天就挑一篇旧稿，让 AI 按你的口吻重写一遍，对比看看差在哪。'},
     {'改写': '今晚挑一篇旧稿，让 AI 用你的口吻重写，再逐句对照差在哪。'}),
]
REVIEW_ITEMS = [
    ({'标题': '第 1 处', '原句': '这个工具非常非常好用，强烈推荐大家都去试一试。', '建议': '删掉重复的「非常」，改成具体场景：「写周报时省了一半时间」。'},
     {'采纳': '', '批注': ''}),
    ({'标题': '第 2 处', '原句': '首先，其次，最后，我们来总结一下。', '建议': '去掉套话式连接词，直接给三个结论。'},
     {'采纳': '', '批注': ''}),
    ({'标题': '第 3 处', '原句': '如果你也有同样的困扰，欢迎在评论区留言。', '建议': '改成具体提问：「你现在用 AI 最卡的是哪一步？」'},
     {'采纳': '', '批注': ''}),
]
PAGES = [
    ('T999_测试稿', '对照页.html', 'T999', 'compare', 'T999 测试稿 · 对照页',
     '上面灰底是参考原文（不能改），下面的「改写」可以直接改。改动会自动写回文件。', COMPARE_ITEMS),
    ('T998_审稿测试', '审稿页.html', 'T998', 'review', 'T998 审稿测试 · 审稿页',
     '逐条选「采纳 / 不采纳 / 空」，需要时写批注。改动会自动写回文件。', REVIEW_ITEMS),
]

TEMPLATE = '''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="jc:content-id" content="__CID__">
<title>__TITLE__</title>
<style>
body{margin:0;padding:24px 16px 80px;background:#f7f7f5;color:#1c1c1e;font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
main{max-width:760px;margin:0 auto}
h1{font-size:22px;margin:8px 0 4px}
.hint{color:#5f6368;font-size:14px;margin:0 0 20px}
.card{background:#fff;border:1px solid #e3e3e0;border-radius:10px;padding:14px 16px;margin:0 0 16px}
.card-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.card h2{font-size:17px;margin:0 0 8px}
.item-id{font:12px ui-monospace,Menlo,monospace;color:#9aa0a6}
.label{font-size:13px;color:#5f6368;margin:8px 0 2px}
.locked .text{background:#f1f1ef;border-radius:6px;padding:6px 10px;white-space:pre-wrap}
textarea{width:100%;box-sizing:border-box;font:inherit;line-height:1.6;padding:8px 10px;border:1px solid #c9c9c5;border-radius:6px;resize:vertical}
.radios{display:flex;gap:18px;flex-wrap:wrap}
.radios label{cursor:pointer}
.static-warn{background:#fff3c4;border:1px solid #e0a800;border-radius:8px;padding:10px 14px}
.jc-wait{background:#fff3c4;border:1px solid #e0a800;border-radius:8px;padding:8px 14px;margin:0 0 16px;font-size:14px}
.jc-wait-bad{position:fixed;top:0;left:0;right:0;z-index:2147483600;margin:0;border-radius:0;background:#fddcd8;border:0;border-bottom:1px solid #d93025;font-weight:600}
textarea[readonly],input:disabled{background:#f1f1ef;color:#666}
</style>
</head>
<body>
<main>
<h1>__TITLE__</h1>
<p class="hint">__HINT__</p>
<div id="jc-items"><p class="static-warn">页面脚本没有运行，这里只是静态快照，不能编辑也不能保存。内容以文件里的 jc-doc 数据块为准；要编辑请用 __SERVICE__/p/__PID__ 打开。</p></div>
</main>
<script id="jc-doc" type="application/json">__DOC__</script>
<script id="jc-view">
/* 页面渲染：只从 jc-doc 数据块生成条目；可编辑元素带 data-item / data-field，交给 kit 保存。
 * 格子一律 autocomplete="off"（前进后退时浏览器不把旧文字填回来），并且在 kit 就绪前只读（data-jc-wait）：
 * kit 启动成功后才解锁；4 秒后还没有 kit，就报红并一直锁着，免得改了存不上。 */
(function () {
  var doc = JSON.parse(document.getElementById('jc-doc').textContent);
  var box = document.getElementById('jc-items');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function hold(e) { e.setAttribute('autocomplete', 'off'); e.setAttribute('data-jc-wait', ''); if (e.type === 'radio') e.disabled = true; else e.readOnly = true; }
  box.textContent = '';
  var wait = el('div', 'jc-wait', '保存脚本正在启动，启动完成前暂时不能编辑…');
  box.parentNode.insertBefore(wait, box);
  doc.items.forEach(function (it) {
    var card = el('section', 'card'), head = el('div', 'card-head'), locked = it.locked || {}, fields = it.fields || {};
    head.appendChild(el('h2', null, locked['标题'] || '（无标题）'));
    head.appendChild(el('span', 'item-id', '#' + it.id));
    card.appendChild(head);
    Object.keys(locked).forEach(function (k) {
      if (k === '标题') return;
      var row = el('div', 'locked');
      row.appendChild(el('div', 'label', k));
      row.appendChild(el('div', 'text', String(locked[k])));
      card.appendChild(row);
    });
    Object.keys(fields).forEach(function (k) {
      var wrap = el('div', 'jc-field'), v = fields[k] == null ? '' : String(fields[k]);
      wrap.appendChild(el('div', 'label', k + '（可改）'));
      if (doc.kind === 'review' && k === '采纳') {
        var group = el('div', 'radios');
        [['采纳', '采纳'], ['不采纳', '不采纳'], ['', '空（未定）']].forEach(function (o) {
          var lab = el('label'), r = document.createElement('input');
          r.type = 'radio'; r.name = 'jc-' + it.id + '-' + k; r.value = o[0]; r.checked = v === o[0];
          r.setAttribute('data-item', it.id); r.setAttribute('data-field', k); hold(r);
          lab.appendChild(r); lab.appendChild(document.createTextNode(' ' + o[1]));
          group.appendChild(lab);
        });
        wrap.appendChild(group);
      } else {
        var t = document.createElement('textarea');
        t.setAttribute('data-item', it.id); t.setAttribute('data-field', k); hold(t);
        t.value = v; t.rows = Math.max(2, v.split('\\n').length + 1);
        wrap.appendChild(t);
      }
      card.appendChild(wrap);
    });
    box.appendChild(card);
  });
  var t0 = Date.now();
  (function check() {
    var kit = window.jcKit;
    if (kit && (kit.ready || kit.failed)) return; // kit 的状态条接管
    var late = Date.now() - t0;
    if (!kit && late >= 4000) return bad('保存脚本没有运行，改动不会保存，所以页面锁住了。多半是 kit.js 写坏了或没加载上（浏览器控制台里有报错），请告诉 AI。');
    if (kit && late >= 12000) return bad('保存脚本启动了，但 12 秒还没准备好，改动不会保存，所以页面锁住了。请刷新一次；还不行就告诉 AI。');
    setTimeout(check, 500);
  })();
  function bad(msg) { wait.className = 'jc-wait jc-wait-bad'; wait.setAttribute('role', 'alert'); wait.textContent = msg; }
})();
</script>
<!--jc-kit:start--><script>
__KIT__
</script><!--jc-kit:end-->
</body>
</html>
'''


def kit_source():
    with open(KIT_FILE, encoding='utf-8') as f:
        return f.read().replace('</script', '<\\/script')


def render(title, cid, hint, doc):
    kit = kit_source()
    out = TEMPLATE
    for k, v in (('__CID__', html.escape(cid)), ('__TITLE__', html.escape(title)), ('__HINT__', html.escape(hint)),
                 ('__SERVICE__', SERVICE), ('__PID__', doc['page_id']), ('__DOC__', '\n' + server.doc_json(doc) + '\n'), ('__KIT__', kit)):
        out = out.replace(k, v)
    return out


def build(root):
    """生成两个测试页，返回 [{path, page_id, content_id, kind, token}]。已存在就报错（测试每次用新目录）。"""
    out = []
    for folder, name, cid, kind, title, hint, items in PAGES:
        path = os.path.join(root, folder, name)
        if os.path.exists(path):
            raise FileExistsError('已存在：%s' % path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        doc = {'page_id': short(10), 'content_id': cid, 'kind': kind, 'schema': 1, 'token': secrets.token_urlsafe(18),
               'service_origin': SERVICE, 'items': [{'id': short(), 'locked': dict(lk), 'fields': dict(fd)} for lk, fd in items]}
        with open(path, 'w', encoding='utf-8') as f:
            f.write(render(title, cid, hint, doc))
        server.parse_page(server.read_page(path)[0])  # 生成后自检：jc-doc 能被服务读出来
        out.append({'path': path, 'page_id': doc['page_id'], 'content_id': cid, 'kind': kind, 'token': doc['token']})
    return out


def rerender(root):
    """按当前模板和 kit 重画 root 下的测试页，jc-doc（身份号、口令、已改的值）原样保留。返回更新过的文件。"""
    meta = {cid: (title, hint) for _f, _n, cid, _k, title, hint, _i in PAGES}
    done = []
    for p in server.iter_html(root):
        try:
            doc = server.parse_page(server.read_page(p)[0])[1]
        except (OSError, server.PageError):
            continue
        if doc.get('content_id') not in meta:
            continue
        title, hint = meta[doc['content_id']]
        with server.page_lock(root, doc['page_id']):
            data, st = server.read_page(p)
            doc = server.parse_page(data)[1]  # 锁里重读，拿最新的 jc-doc
            new = render(title, doc['content_id'], hint, doc).encode('utf-8')
            if new != data and server.commit(root, doc['page_id'], p, st, data, new):
                done.append(p)
    return done


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='生成两个通用测试页')
    ap.add_argument('--root', required=True)
    for p in build(ap.parse_args().root):
        print(json.dumps(p, ensure_ascii=False))
