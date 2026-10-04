#!/usr/bin/env python3
"""界面自测用的最小生成脚本：把输入数据换成 jc-doc，用 build_page.py 的 render 套上 template/ 的当前模板，写出单文件 HTML。
只给 tests/browser/ui_scenarios.mjs 用，不做 build_page.py 的校验、重新生成保留旧值这些事（正式生成请用 build_page.py）。
用法：python3 tests/ui_mini_build.py <数据.json> <输出.html> [--port 端口] [--doc]
      --port 给了就把 service_origin 换成 http://127.0.0.1:<端口>（测试用临时端口）。打印 {path, page_id, token, ids}。
      --doc 表示输入本身就是一份 jc-doc（例如模拟缺了可选字段的旧页面），原样套模板，不做任何补全。"""
import argparse, json, os, secrets, sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
ABC = 'abcdefghijkmnpqrstuvwxyz23456789'


def short(n=8):
    return ''.join(secrets.choice(ABC) for _ in range(n))


def read(*p):
    with open(os.path.join(APP, *p), encoding='utf-8') as f:
        return f.read()


def make_doc(data, port=None):
    origin = 'http://127.0.0.1:%d' % port if port else data.get('service_origin') or 'http://127.0.0.1:18977'
    info = {'id': 'info-' + short(), 'kind': 'info',
            'locked': {'type': data['type'], 'stage': data['stage'], 'title': data['title'],
                       'narrative': data.get('narrative') or {}, 'speech_rate': data.get('speech_rate') or 4},
            'fields': {'overall_note': '', 'approved': '', 'recorded': ''}}
    segs = []
    for i, s in enumerate(data['segments']):
        segs.append({'id': s.get('id') or 'seg-' + short(), 'kind': 'segment',
                     'locked': {'order': i + 1, 'title': s['title'], 'role': s.get('role', ''), 'refs': s.get('refs') or [],
                                'baseline': s.get('baseline', s['mine'])},
                     'fields': {'mine': s['mine'], 'note': s.get('note', '')}})
    sugs = []
    for g in data.get('suggestions') or []:
        seg = g['segment']
        seg_id = segs[int(seg) - 1]['id'] if str(seg).isdigit() else seg
        sugs.append({'id': g.get('id') or 'sug-' + short(), 'kind': 'suggestion',
                     'locked': {'segment': seg_id, 'category': g['category'], 'source': g.get('source', 'AI'), 'original': g['original'],
                                'reason': g['reason'], 'basis': g.get('basis') or {}, 'verdict': g.get('verdict', '待你定')},
                     'fields': {'proposed': g['proposed'], 'decision': ''}})
    return {'page_id': short(10), 'content_id': data['content_id'], 'kind': '创作页', 'schema': 1,
            'token': secrets.token_urlsafe(18), 'service_origin': origin, 'items': [info] + segs + sugs}


def render(doc):
    """和正式生成一样套模板：样式、kit、界面脚本各用首尾标记包住，保存服务提供页面时会换成当前版本。"""
    sys.path.insert(0, APP)
    import build_page
    return build_page.render(doc, build_page.load_parts())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('data'); ap.add_argument('out'); ap.add_argument('--port', type=int); ap.add_argument('--doc', action='store_true')
    a = ap.parse_args()
    with open(a.data, encoding='utf-8') as f:
        data = json.load(f)
    if a.doc:
        doc = data
        if a.port: doc['service_origin'] = 'http://127.0.0.1:%d' % a.port
    else:
        doc = make_doc(data, a.port)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as f:
        f.write(render(doc))
    kind = lambda it: it.get('kind')
    print(json.dumps({'path': os.path.abspath(a.out), 'page_id': doc['page_id'], 'token': doc.get('token'),
                      'ids': {'info': next((it['id'] for it in doc['items'] if kind(it) == 'info'), ''),
                              'segs': [it['id'] for it in doc['items'] if kind(it) == 'segment'],
                              'sugs': [it['id'] for it in doc['items'] if kind(it) == 'suggestion']}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
