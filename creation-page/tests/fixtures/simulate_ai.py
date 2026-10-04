#!/usr/bin/env python3
"""测试用：模拟 AI 直接改页面（由实验的 simulate_ai.py 迁来）。只改 jc-doc 数据块，和保存服务用同一把文件锁、
同样的原子替换（brain_save.mutate）。测的是保存服务的通用规则，所以不经过 brain_page.py 的业务限制。

用法（<页面> 可以是文件路径、page_id 或 T 编号；<条目> 可以是条目身份号或从 1 开始的位置）：
  simulate_ai.py --root R edit T999 --item 1 --field 改写 --value 'AI 改的'      改某条某字段
  simulate_ai.py --root R edit T999 --item 1 --field 标题 --value '新标题' --locked   改不可编辑部分（指纹会变）
  simulate_ai.py --root R reorder T999 [--delete 条目] [--seed N]                最前插一条、删一条、打乱顺序
  simulate_ai.py --root R rename [--back]                                       T999_测试稿 ↔ T999_测试稿_改名
"""
import argparse, contextlib, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(APP, 'server'))
sys.path.insert(0, HERE)
import brain_save as server  # noqa: E402
from spike_pages import short  # noqa: E402

RENAME_FROM, RENAME_TO = 'T999_测试稿', 'T999_测试稿_改名'


class AiError(Exception):
    pass


def pages(root):
    for p in server.iter_html(root):
        try:
            yield p, server.parse_page(server.read_page(p)[0])[1]
        except (OSError, server.PageError):
            continue


def find_page(root, target):
    for p in (target, os.path.join(root, target)):
        if os.path.isfile(p):
            return os.path.abspath(p)
    hits = [p for p, doc in pages(root) if target in (doc.get('page_id'), doc.get('content_id'))]
    if len(hits) != 1:
        raise AiError('找不到唯一的页面「%s」（匹配到 %d 个）' % (target, len(hits)))
    return hits[0]


def pick(doc, item):
    items = doc['items']
    for it in items:
        if it.get('id') == item:
            return it
    if str(item).isdigit() and 1 <= int(item) <= len(items):
        return items[int(item) - 1]
    raise AiError('找不到条目「%s」' % item)


def mutate(root, target, fn):
    """同一个身份号有多份文件时拒绝修改（抛 PageError 409），不按顺序挑一份。返回 (路径, doc, 说明)。"""
    pid = server.page_id_of(server.read_page(find_page(root, target))[0])
    if not pid:
        raise AiError('页面的 jc-doc 读不出 page_id')
    try:
        return server.mutate(root, server.Index(root), pid, fn)
    except server.PageError as e:
        if e.code == 404:
            raise AiError('页面 %s 不见了' % pid)
        raise


def edit(root, target, item, field, value, locked=False):
    def fn(doc):
        it = pick(doc, item)
        part = it.setdefault('locked' if locked else 'fields', {})
        old, part[field] = part.get(field), value
        return '条目 %s 的%s「%s」：%r → %r' % (it['id'], '不可编辑字段' if locked else '字段', field, old, value)
    return mutate(root, target, fn)


def reorder(root, target, delete=None, seed=None):
    rnd = random.Random(seed)

    def fn(doc):
        items = doc['items']
        gone = pick(doc, delete) if delete else items[-1]
        rest = [it for it in items if it is not gone]
        order = [it['id'] for it in rest]
        rnd.shuffle(rest)
        if len(rest) > 1 and [it['id'] for it in rest] == order:
            rest.reverse()  # 保证顺序真的变了
        tmpl = items[0]
        new = {'id': short(), 'locked': {k: 'AI 新插入的条目' if k == '标题' else 'AI 新插入的内容' for k in tmpl.get('locked', {})},
               'fields': {k: '' for k in tmpl.get('fields', {})}}
        doc['items'] = [new] + rest
        return '最前插入 %s，删掉 %s，现在顺序：%s' % (new['id'], gone['id'], ' '.join(it['id'] for it in doc['items']))
    return mutate(root, target, fn)


def rename(root, src=RENAME_FROM, dst=RENAME_TO):
    a, b = os.path.join(root, src), os.path.join(root, dst)
    if not os.path.isdir(a):
        raise AiError('没有这个文件夹：%s' % a)
    if os.path.exists(b):
        raise AiError('目标已存在：%s' % b)
    pids = sorted({server.page_id_of(server.read_page(p)[0]) for p in server.iter_html(a)} - {None})
    with contextlib.ExitStack() as stack:
        for pid in pids:  # 按固定顺序拿锁，改名期间服务不会往旧路径写
            stack.enter_context(server.page_lock(root, pid))
        os.rename(a, b)
    return '已把 %s 改名为 %s（里面的页面：%s）' % (src, dst, ', '.join(pids) or '无')


def main():
    ap = argparse.ArgumentParser(description='模拟 AI 改测试页（只改 jc-doc 数据块）')
    ap.add_argument('--root', required=True)
    sub = ap.add_subparsers(dest='cmd', required=True)
    e = sub.add_parser('edit', help='改某条某字段')
    e.add_argument('page')
    e.add_argument('--item', required=True)
    e.add_argument('--field', required=True)
    e.add_argument('--value', required=True)
    e.add_argument('--locked', action='store_true', help='改不可编辑部分（标题、参考原文等）')
    r = sub.add_parser('reorder', help='最前插一条新条目、删掉一条、打乱顺序')
    r.add_argument('page')
    r.add_argument('--delete', help='要删的条目（默认删最后一条）')
    r.add_argument('--seed', type=int)
    n = sub.add_parser('rename', help='把 T999_测试稿 改名为 T999_测试稿_改名')
    n.add_argument('--back', action='store_true', help='改回原名')
    a = ap.parse_args()
    try:
        if a.cmd == 'edit':
            path, _, note = edit(a.root, a.page, a.item, a.field, a.value, a.locked)
        elif a.cmd == 'reorder':
            path, _, note = reorder(a.root, a.page, a.delete, a.seed)
        else:
            print(rename(a.root, RENAME_TO, RENAME_FROM) if a.back else rename(a.root))
            return
        print('%s\n文件：%s' % (note, path))
    except (AiError, server.PageError) as err:
        sys.exit('失败：%s' % err)


if __name__ == '__main__':
    main()
