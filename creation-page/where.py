#!/usr/bin/env python3
"""告诉 AI 东西都在哪：工作台仓库、设置文件、工作文件夹、内容草稿、写稿方法、保存服务在不在。
还说这个对话打开的文件夹（运行这条命令时所在的文件夹）是不是工作文件夹、这个对话能不能读写工作文件夹。
给了内容编号，再说这条内容的草稿文件夹和创作页在哪、页面链接是什么。

  python3 where.py            # 各个位置和保存服务
  python3 where.py T001       # 再加上 T001 的草稿文件夹和创作页
  python3 where.py T001 --json

不改任何文件。看能不能写时，在工作文件夹里建一个以点开头的临时小文件，马上删掉。
位置都从工作台的设置文件里读（和工作台用的是同一个）。
"""
import argparse, json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import creation_doc as cd  # noqa: E402

bs = cd.bs


def creation_pages(folder, content_id):
    """草稿文件夹里这条内容的创作页（往下最多看三层，不进以点开头的文件夹）。"""
    found = []
    base = folder.rstrip(os.sep).count(os.sep)
    for dp, dns, fns in os.walk(folder):
        dns[:] = sorted(n for n in dns if not n.startswith('.') and dp.count(os.sep) - base < 2)
        for fn in sorted(fns):
            if not fn.endswith('.html') or fn.startswith('.'):
                continue
            p = os.path.join(dp, fn)
            try:
                doc = bs.parse_page(bs.read_page(p)[0])[1]
            except (OSError, bs.PageError):
                continue
            if doc.get('kind') == cd.PAGE_KIND and doc.get('content_id') == content_id:
                found.append({'path': p, 'page_id': doc['page_id']})
    return found


def folder_relation(here, work):
    """这个对话打开的文件夹和工作文件夹是什么关系：'same' 就是它，'inside' 在它里面，'outside' 别处（包括它的上一层）。
    先消解软链接再比（/tmp 和 /private/tmp 算同一个）。"""
    if os.path.realpath(here) == os.path.realpath(work):
        return 'same'
    return 'inside' if cd.is_under(here, work) else 'outside'


def access_problem(folder):
    """这个对话能不能读写这个文件夹：先列一下里面的东西，再建一个以点开头的临时小文件、马上删掉。
    能读能写返回空字符串，不然返回「读不了（原因）」或「写不了（原因）」。
    Codex 的沙箱只许写打开的那个文件夹；macOS 没给 AI 工具「文稿」文件夹的权限时连读都读不了：这两种都在这里查出来。"""
    try:
        os.listdir(folder)
    except OSError as e:
        return '读不了（%s）' % (e.strerror or e)
    try:
        fd, probe = tempfile.mkstemp(prefix='.jc-write-check-', dir=folder)
        os.close(fd)
        os.remove(probe)
    except OSError as e:
        return '写不了（%s）' % (e.strerror or e)
    return ''


def collect(content_id=None, here=None):
    """here：这个对话打开的文件夹，不给就是运行这条命令时所在的文件夹。"""
    try:
        s = cd.workbench_settings()
        problem = ''
    except cd.SettingsError as e:
        s, problem = None, str(e)
    out = {'repo': cd.REPO, 'settings_problem': problem}
    if s is None:
        return out
    out.update({'settings_file': s['file'], 'settings_exists': s['exists'], 'work_folder': s['work_folder'],
                'work_folder_exists': os.path.isdir(s['work_folder']), 'drafts': s['drafts'],
                'writing_method': s['writing_method'], 'trash': s['trash'], 'save_port': s['save_port']})
    if here is None:
        try:
            here = os.getcwd()
        except OSError:  # 所在的文件夹已经被删了
            here = ''
    out['here'] = {'path': here, 'relation': folder_relation(here, s['work_folder']) if here else 'unknown'}
    # 读写：工作文件夹；内容草稿在设置里改到了工作文件夹外面时，它也查
    problems = []
    if out['work_folder_exists']:
        p = access_problem(s['work_folder'])
        if p:
            problems.append('工作文件夹' + p)
        if os.path.isdir(s['drafts']) and not cd.is_under(s['drafts'], s['work_folder']):
            p = access_problem(s['drafts'])
            if p:
                problems.append('内容草稿' + p)
    out['access'] = {'checked': out['work_folder_exists'], 'problems': problems}
    svc = cd.find_service(s['work_folder']) if os.path.isdir(s['work_folder']) else None
    # 找不到时分两种：真的没开；这个终端连本机端口被拒绝了（AI 工具的沙箱），查不了
    out['service'] = {'running': True, 'origin': svc['origin'], 'port': svc['port']} if svc else {'running': False, 'blocked': cd.LOCAL_BLOCKED}
    if content_id:
        dirs = cd.draft_dirs(content_id, s['drafts'])
        item = {'id': content_id, 'draft_dirs': dirs, 'page_path': os.path.join(dirs[0], cd.page_name(content_id)) if len(dirs) == 1 else None}
        pages = [pg for d in dirs for pg in creation_pages(d, content_id)]
        for pg in pages:
            pg['url'] = '%s/p/%s' % (svc['origin'] if svc else 'http://127.0.0.1:%d' % s['save_port'], pg['page_id'])
        item['pages'] = pages
        out['content'] = item
    return out


def show(info):
    L = ['工作台仓库：%s' % info['repo']]
    if info.get('settings_problem'):
        L.append('设置：%s' % info['settings_problem'])
        return '\n'.join(L)
    L.append('设置文件：%s%s' % (info['settings_file'], '' if info['settings_exists'] else '（还没有：工作台还没运行过，下面按默认值）'))
    L.append('工作文件夹：%s%s' % (info['work_folder'], '' if info['work_folder_exists'] else '（还没有：在后台启动一次工作台就会建好，pnpm --dir "%s" start --background）' % info['repo']))
    here = info.get('here') or {}
    relation = here.get('relation')
    if relation == 'same':
        L.append('当前打开的文件夹：%s（就是工作文件夹）' % here['path'])
    elif relation == 'inside':
        L.append('当前打开的文件夹：%s（在工作文件夹里面）' % here['path'])
    elif relation == 'outside':
        L.append('当前打开的文件夹：%s（不是工作文件夹。稿子、创作页都按这里打印的完整路径写进工作文件夹，不写进当前打开的文件夹）' % here['path'])
    else:
        L.append('当前打开的文件夹：读不到（所在的文件夹可能已经被删了）')
    access = info.get('access') or {}
    if access.get('checked'):
        problems = access['problems']
        said = '；'.join(problems)
        if not problems:
            L.append('读写：工作文件夹能读能写')
        elif relation == 'outside':
            L.append('读写：%s。这个对话开在别的文件夹，还没被允许写工作文件夹：先别写任何文件。先用你这个 AI 工具自己的办法申请写工作文件夹的权限（告诉用户等会儿点允许）；申请不了，再请用户新开一个对话，打开工作文件夹' % said)
        elif any('读不了' in p for p in problems):
            L.append('读写：%s。多半是这台 Mac 没允许这个 AI 工具访问这个文件夹：先别动手，请用户在「系统设置 → 隐私与安全性 → 文件与文件夹」里允许' % said)
        else:
            L.append('读写：%s。这个对话打开的就是工作文件夹，但现在只能读文件（Codex 里，没用 Git 管的文件夹默认只读）：先别写任何文件，用你这个 AI 工具自己的办法申请改文件的权限（告诉用户等会儿点允许）' % said)
    L.append('内容草稿：%s' % info['drafts'])
    L.append('写稿方法：%s' % info['writing_method'])
    L.append('回收站：%s' % info['trash'])
    svc = info['service']
    if svc['running']:
        L.append('保存服务：正在运行，%s（根目录就是工作文件夹）' % svc['origin'])
    elif svc.get('blocked'):
        L.append('保存服务：查不了。这个终端不让连本机端口（多半是 AI 工具的沙箱），不代表没在运行：用能连本机端口的权限再跑一次 where.py（Codex 里让这条命令申请提权）')
    else:
        L.append('保存服务：没在运行。直接在后台启动工作台，它会一起启动：pnpm --dir "%s" start --background（设置里的端口是 %d）' % (info['repo'], info['save_port']))
    c = info.get('content')
    if c:
        if not c['draft_dirs']:
            L.append('%s 的草稿文件夹：还没有。先在内容草稿里建「%s_选题名」文件夹（工作台详情页点「建草稿文件夹」也行）' % (c['id'], c['id']))
        elif len(c['draft_dirs']) > 1:
            L.append('%s 的草稿文件夹：有 %d 个，要先问用户用哪个：%s' % (c['id'], len(c['draft_dirs']), '、'.join(c['draft_dirs'])))
        else:
            L.append('%s 的草稿文件夹：%s' % (c['id'], c['draft_dirs'][0]))
        if not c['pages']:
            where = c['page_path'] or '（先定草稿文件夹）'
            L.append('%s 的创作页：还没有。build_page.py 不写 --out 时会生成到 %s' % (c['id'], where))
        for pg in c['pages']:
            L.append('%s 的创作页：%s（page_id %s）' % (c['id'], pg['path'], pg['page_id']))
            L.append('  页面链接：%s%s' % (pg['url'], '' if svc['running'] else '（保存服务查不了，见上面）' if svc.get('blocked') else '（保存服务没在运行：先在后台启动工作台，pnpm --dir "%s" start --background）' % info['repo']))
        if len(c['pages']) > 1:
            L.append('注意：%s 有 %d 个创作页，一条内容只该有一个，先问用户留哪个' % (c['id'], len(c['pages'])))
    return '\n'.join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description='工作台和创作页的各个位置、保存服务在不在（只读）')
    ap.add_argument('content', nargs='?', help='内容编号，例如 T001')
    ap.add_argument('--json', action='store_true', help='输出 JSON')
    a = ap.parse_args(argv)
    info = collect(a.content)
    print(json.dumps(info, ensure_ascii=False, indent=2) if a.json else show(info))
    return 1 if info.get('settings_problem') else 0


if __name__ == '__main__':
    sys.exit(main())
