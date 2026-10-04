'use client';

// 「内容」栏的「封面」页（1.1 加，原作者 2026-10-04 定：封面放进「内容」栏；工作台在封面上主要管拆封面、管理风格和封面 VI）：
//   风格：对标账号拆出的、你放进来的几组图拆出的，都列在这里（默认的在前）；能看拆解、设默认、改默认参考哪几张构图。
//   拆一个新风格：对标账号里点一下、贴主页链接（抖音、小红书用 TikHub 拉最近 20 张）、把几张图拖进来（同一种风格 3 张以上，10 张左右最好）；
//     还没拆的对标账号能一次全拆。拆都交给 Codex 桌面版（一键打开，话已经填好），用别的 AI 工具的复制去发。
//   我的封面：每条内容一组，只放 AI 给它出的封面（收来参考的别人的封面不算）；也能按风格看；能筛只看视频或只看文章的。
//   我的照片：角上一块，换成你的脸用；不分组，放一张或几张，出封面时都用上。
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ImagePlus, Images, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAppInfo } from '@/components/jc/app-info';
import { OpenInAi } from '@/components/jc/open-in-ai';
import { Card, DangerButton, SecondaryButton, SemBadge } from '@/components/jc/ui';
import { CompositionPicker, Lightbox, type ViewItem } from '@/components/workbench/cover-parts';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { errorText } from '@/lib/api';
import { askInfo } from '@/lib/app-info';
import { askCoverVi, askCoverViBatch, askCoverViImages, askCoverViLink } from '@/lib/ask-ai';
import {
   coverUrl,
   createImageStyle,
   defaultCompositions,
   fetchCoverInfo,
   fetchCoverLibrary,
   groupByStyle,
   kIds,
   photoUrl,
   saveCompositions,
   setDefaultStyle,
   styleImageUrl,
   styleName,
   styleSource,
   trashImageStyle,
   trashPhoto,
   uploadPhoto,
   uploadStyleImage,
   type CoverInfo,
   type LibraryGroup,
   type Style,
} from '@/lib/covers';
import { fetchSources, reportViewHref } from '@/lib/research';

const IMAGE_TYPES = 'image/png,image/jpeg,image/webp';
const isImage = (file: File) => /^image\/(png|jpeg|webp)$/.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
type GroupBy = 'content' | 'style';
type Form = 'all' | '视频' | '文章';

export default function CoversBoard({ reloadKey = 0 }: { reloadKey?: number }) {
   const { info: app } = useAppInfo();
   const [info, setInfo] = useState<CoverInfo | null>(null);
   const [library, setLibrary] = useState<LibraryGroup[] | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [tikhub, setTikhub] = useState<boolean | null>(null);

   const load = useCallback(async () => {
      try {
         const [nextInfo, nextLibrary] = await Promise.all([fetchCoverInfo(), fetchCoverLibrary()]);
         setInfo(nextInfo);
         setLibrary(nextLibrary.groups);
         setError(null);
         if (nextInfo.research) {
            fetchSources()
               .then((s) => setTikhub(Boolean(s.tikhub.configured)))
               .catch(() => setTikhub(null));
         }
      } catch (err) {
         setError(errorText(err));
      }
   }, []);
   useEffect(() => {
      void load();
      // AI 拆完 VI、出完封面，切回来就看到
      const onFocus = () => void load();
      window.addEventListener('focus', onFocus);
      return () => window.removeEventListener('focus', onFocus);
   }, [load, reloadKey]);

   if (!info || !library) {
      return error ? (
         <Card className="p-4 text-[13px]" style={{ color: 'var(--jc-err)' }}>
            封面没读到：{error}
            <div className="mt-2">
               <SecondaryButton size="small" onClick={() => void load()}>
                  重试
               </SecondaryButton>
            </div>
         </Card>
      ) : null;
   }

   const cover = askInfo(app, 'cover');
   const done = info.styles.filter((s) => s.done);
   const todoAccounts = info.styles.filter((s) => s.kind === 'account' && !s.done);

   return (
      <div className="jc-covers-page">
         <div className="min-w-0">
            {/* 风格 */}
            <section className="mb-8" aria-labelledby="cover-styles">
               <div className="jc-section-heading">
                  <h2 id="cover-styles">
                     风格
                     {done.length > 0 && <span className="jc-section-count">{done.length}</span>}
                  </h2>
                  {todoAccounts.length > 1 && (
                     <OpenInAi
                        text={askCoverViBatch(
                           todoAccounts.map((s) => ({ accountName: s.accountName ?? s.folder, platform: s.platform ?? null })),
                           cover
                        )}
                        action={`把还没拆的 ${todoAccounts.length} 个对标都拆了`}
                        what="一次全拆的话"
                        variant="link"
                     />
                  )}
               </div>
               {info.styles.length === 0 ? (
                  <Card className="p-4 text-[12.5px] leading-relaxed" style={{ color: 'var(--jc-muted)' }}>
                     还没有风格。在下面「拆一个新风格」里拆一个：拆好的风格会列在这里，出封面时照它的样子来。
                  </Card>
               ) : (
                  <div className="jc-style-grid">
                     {info.styles.map((style) => (
                        <StyleCard key={style.id} style={style} onChanged={() => void load()} setInfo={setInfo} />
                     ))}
                  </div>
               )}
            </section>

            {/* 拆一个新风格 */}
            <section className="mb-8" aria-labelledby="cover-new-style">
               <div className="jc-section-heading">
                  <h2 id="cover-new-style">拆一个新风格</h2>
               </div>
               <div className="jc-new-style">
                  <FromAccount info={info} />
                  <FromLink research={info.research} tikhub={tikhub} />
                  <FromImages onDone={() => void load()} />
               </div>
            </section>

            {/* 我的封面 */}
            <MyCovers groups={library} styles={info.styles} />
         </div>

         {/* 我的照片：角上一块 */}
         <aside className="min-w-0">
            <MyPhotos info={info} onChanged={() => void load()} />
         </aside>
      </div>
   );
}

// —— 风格卡片 ——————————————————————————————

function StyleCard({ style, onChanged, setInfo }: { style: Style; onChanged: () => void; setInfo: (fn: (old: CoverInfo | null) => CoverInfo | null) => void }) {
   const { info: app } = useAppInfo();
   const [busy, setBusy] = useState<string | null>(null);
   const [picking, setPicking] = useState(false);
   const [zoom, setZoom] = useState<string | null>(null);
   const [trashing, setTrashing] = useState(false);
   const cover = askInfo(app, 'cover');
   const comps = defaultCompositions(style);
   const views: ViewItem[] = style.images.map((file) => ({ key: file, src: styleImageUrl(style.id, file), title: file.replace(/\.[^.]+$/, ''), sub: styleName(style) }));

   const run = async (key: string, task: () => Promise<{ message: string }>) => {
      setBusy(key);
      try {
         toast.success((await task()).message);
         onChanged();
         return true;
      } catch (err) {
         toast.error(errorText(err));
         return false;
      } finally {
         setBusy(null);
      }
   };
   const saveDefault = async (ids: string[]) => {
      setBusy('comps');
      try {
         const result = await saveCompositions(style.id, ids);
         toast.success(result.message);
         setInfo((old) => (old ? { ...old, styles: old.styles.map((s) => (s.id === style.id ? { ...s, compositions: result.compositions } : s)) } : old));
         setPicking(false);
      } catch (err) {
         toast.error(errorText(err));
      } finally {
         setBusy(null);
      }
   };

   return (
      <section className="jc-card jc-style-card" data-style={style.id} data-done={style.done || undefined}>
         <button type="button" className="jc-style-thumbs" onClick={() => style.images[0] && setZoom(style.images[0])} aria-label={`看「${styleName(style)}」的原图`} disabled={!style.images.length}>
            {style.images.slice(0, 4).map((file) => (
               // eslint-disable-next-line @next/next/no-img-element
               <img key={file} src={styleImageUrl(style.id, file)} alt="" loading="lazy" />
            ))}
            {!style.images.length && (
               <span className="jc-style-empty">
                  <Images size={18} />
                  {style.kind === 'account' ? 'AI 拆的时候去拉封面' : '还没有图'}
               </span>
            )}
         </button>
         <div className="min-w-0 px-3.5 pb-3.5 pt-3">
            <p className="flex flex-wrap items-center gap-1.5 text-[14px] font-semibold" style={{ color: style.done ? 'var(--jc-ink)' : 'var(--jc-muted)' }}>
               {styleName(style)}
               {style.isDefault && <SemBadge tone="ok">默认</SemBadge>}
            </p>
            <p className="mt-0.5 text-[12px]" style={{ color: 'var(--jc-muted)' }}>
               {styleSource(style)}
            </p>
            {style.done ? (
               <>
                  <p className="mt-1.5 text-[12px]" style={{ color: 'var(--jc-muted)' }}>
                     原图 {style.covers} 张 · 默认参考构图 {comps.length} 张
                     {kIds(style.images).length > 0 && (
                        <button type="button" className="ml-1.5 font-medium" style={{ color: 'var(--jc-accent)' }} onClick={() => setPicking(true)}>
                           改
                        </button>
                     )}
                  </p>
                  <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
                     {style.report && (
                        <Link href={reportViewHref(style.report.id, style.report.page)} className="font-medium">
                           看拆解
                        </Link>
                     )}
                     {!style.isDefault && (
                        <button type="button" className="font-medium" style={{ color: 'var(--jc-accent)' }} disabled={busy === 'default'} onClick={() => void run('default', () => setDefaultStyle(style.id))}>
                           {busy === 'default' ? '正在设……' : '设为默认'}
                        </button>
                     )}
                  </p>
               </>
            ) : (
               <p className="mt-2 text-[12.5px]">
                  <OpenInAi
                     text={style.kind === 'account' ? askCoverVi({ accountName: style.accountName ?? style.folder, platform: style.platform ?? null }, cover) : askCoverViImages({ id: style.id, covers: style.covers }, cover)}
                     action={style.kind === 'account' ? '拆封面 VI' : '拆这组图'}
                     what="拆封面 VI 的话"
                     variant="link"
                  />
               </p>
            )}
            {style.kind === 'images' && (
               <button type="button" className="mt-2 inline-flex items-center gap-1 text-[11.5px]" style={{ color: 'var(--jc-ghost)' }} onClick={() => setTrashing(true)}>
                  <Trash2 size={12} /> 拿掉这组图
               </button>
            )}
         </div>
         {zoom && <Lightbox items={views} current={zoom} onMove={setZoom} onClose={() => setZoom(null)} />}
         {picking && <CompositionPicker style={style} value={comps} busy={busy === 'comps'} onClose={() => setPicking(false)} onSaveDefault={(ids) => void saveDefault(ids)} />}
         {trashing && (
            <Dialog open onOpenChange={(open) => !open && setTrashing(false)}>
               <DialogContent className="max-w-[440px] rounded-2xl p-5" style={{ background: 'var(--jc-surface)' }}>
                  <DialogTitle className="text-[16px] font-bold">拿掉「{styleName(style)}」这组图？</DialogTitle>
                  <DialogDescription className="text-[12.5px] leading-relaxed" style={{ color: 'var(--jc-muted)' }}>
                     整组图和拆出来的东西一起挪进工作文件夹的回收站，不会永久删除。已经照它出过的封面不受影响。
                  </DialogDescription>
                  <div className="mt-2 flex justify-end gap-2">
                     <SecondaryButton size="small" onClick={() => setTrashing(false)}>
                        先不拿
                     </SecondaryButton>
                     <DangerButton size="small" busy={busy === 'trash'} onClick={() => void run('trash', () => trashImageStyle(style.id)).then((ok) => ok && setTrashing(false))}>
                        挪进回收站
                     </DangerButton>
                  </div>
               </DialogContent>
            </Dialog>
         )}
      </section>
   );
}

// —— 拆一个新风格：三种给法 ——————————————————————————————

function WayCard({ no, title, children }: { no: number; title: string; children: ReactNode }) {
   return (
      <Card className="jc-way-card">
         <p className="text-[13.5px] font-semibold">
            <span className="jc-way-no">{no}</span>
            {title}
         </p>
         <div className="mt-2 grid gap-2 text-[12.5px] leading-relaxed">{children}</div>
      </Card>
   );
}

function FromAccount({ info }: { info: CoverInfo }) {
   const { info: app } = useAppInfo();
   const todo = info.styles.filter((s) => s.kind === 'account' && !s.done);
   const accounts = info.styles.filter((s) => s.kind === 'account');
   const [pick, setPick] = useState<string>('');
   const chosen = todo.find((s) => s.id === pick) ?? todo[0] ?? null;
   return (
      <WayCard no={1} title="对标账号里的博主">
         {!info.research ? (
            <p style={{ color: 'var(--jc-muted)' }}>「市场调研」这一栏关着，用不了对标账号。用旁边两种办法也能拆。</p>
         ) : !accounts.length ? (
            <p style={{ color: 'var(--jc-muted)' }}>
               还没有对标账号。
               <Link href="/research?tab=accounts" className="font-medium">
                  去「市场调研」加一个
               </Link>
               ，或者直接用旁边贴主页链接。
            </p>
         ) : !chosen ? (
            <p style={{ color: 'var(--jc-muted)' }}>对标账号都拆过了，拆好的都在上面「风格」里。</p>
         ) : (
            <>
               <select aria-label="拆哪个对标账号" className="jc-input h-9 w-full px-2.5 text-[13px]" value={chosen.id} onChange={(e) => setPick(e.target.value)}>
                  {todo.map((s) => (
                     <option key={s.id} value={s.id}>
                        {s.accountName ?? s.folder}
                        {s.platform ? `（${s.platform}）` : ''}
                     </option>
                  ))}
               </select>
               <OpenInAi text={askCoverVi({ accountName: chosen.accountName ?? chosen.folder, platform: chosen.platform ?? null }, askInfo(app, 'cover'))} action="拆封面 VI" what="拆封面 VI 的话" />
            </>
         )}
      </WayCard>
   );
}

function FromLink({ research, tikhub }: { research: boolean; tikhub: boolean | null }) {
   const { info: app } = useAppInfo();
   const [link, setLink] = useState('');
   return (
      <WayCard no={2} title="贴博主的主页链接">
         <input aria-label="博主的主页链接" className="jc-input h-9 w-full px-2.5 text-[13px]" placeholder="https://www.douyin.com/user/…" value={link} onChange={(e) => setLink(e.target.value)} />
         <p style={{ color: 'var(--jc-muted)' }}>抖音、小红书的主页，AI 用 TikHub 拉他最近 20 张封面：抖音拉一次约 1 到 2 分钱；小红书每次请求约 0.07 元，会先问你。</p>
         {research && tikhub === false && (
            <p style={{ color: 'var(--jc-warn)' }}>
               还没接 TikHub。
               <Link href="/research?tab=accounts&connect=tikhub" className="font-medium">
                  去接 TikHub
               </Link>
               （约 5 分钟），或者用旁边拖图的办法。
            </p>
         )}
         <OpenInAi text={askCoverViLink(askInfo(app, 'cover'), link)} action="拆封面 VI" what="拆封面 VI 的话" />
      </WayCard>
   );
}

function FromImages({ onDone }: { onDone: () => void }) {
   const input = useRef<HTMLInputElement>(null);
   const [over, setOver] = useState(false);
   const [busy, setBusy] = useState<string | null>(null);
   const upload = async (files: File[]) => {
      const list = files.filter(isImage);
      if (!list.length) {
         toast.error('只收 PNG、JPEG、WebP 的图（HEIC 先导出成 JPEG）。');
         return;
      }
      setBusy(`正在放 0/${list.length}……`);
      try {
         const created = await createImageStyle(list.length);
         let ok = 0;
         for (const file of list) {
            try {
               await uploadStyleImage(created.id, file);
               ok += 1;
               setBusy(`正在放 ${ok}/${list.length}……`);
            } catch (err) {
               toast.error(`${file.name}：${errorText(err)}`);
            }
         }
         toast.success(`放好了 ${ok} 张，在上面「风格」里点「在 Codex 里拆这组图」。`);
         onDone();
      } catch (err) {
         toast.error(errorText(err));
      } finally {
         setBusy(null);
         if (input.current) input.current.value = '';
      }
   };
   return (
      <WayCard no={3} title="把几张封面图拖进来">
         <button
            type="button"
            className="jc-dropzone"
            data-over={over || undefined}
            disabled={!!busy}
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
               e.preventDefault();
               setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
               e.preventDefault();
               setOver(false);
               void upload([...e.dataTransfer.files]);
            }}
         >
            <Upload size={18} />
            <span>{busy ?? '拖进来，或者点这里选图'}</span>
         </button>
         <input ref={input} type="file" multiple accept={IMAGE_TYPES} className="hidden" aria-label="选几张封面图" onChange={(e) => void upload([...(e.target.files ?? [])])} />
         <p style={{ color: 'var(--jc-muted)' }}>同一种风格的封面放 3 张以上，10 张左右最好；哪个平台的都行，不花钱。不是同一个博主的也行，AI 看出是两种风格会分开拆。</p>
      </WayCard>
   );
}

// —— 我的封面 ——————————————————————————————

function MyCovers({ groups, styles }: { groups: LibraryGroup[]; styles: Style[] }) {
   const [by, setBy] = useState<GroupBy>('content');
   const [form, setForm] = useState<Form>('all');
   const [zoom, setZoom] = useState<{ list: ViewItem[]; key: string } | null>(null);
   const shown = form === 'all' ? groups : groups.filter((g) => g.form === form);
   const byStyle = useMemo(() => groupByStyle(shown), [shown]);
   const label = (id: string | null, fallback: string | null) => {
      const style = styles.find((s) => s.id === id);
      return style ? styleName(style) : fallback ?? id ?? '不知道照哪个风格出的';
   };
   const count = shown.reduce((n, g) => n + g.covers.length, 0);
   return (
      <section aria-labelledby="my-covers">
         <div className="jc-section-heading">
            <h2 id="my-covers">
               我的封面
               {count > 0 && <span className="jc-section-count">{count}</span>}
            </h2>
            <span className="flex flex-wrap items-center gap-2">
               <span className="jc-cover-counts" role="radiogroup" aria-label="怎么排">
                  {(
                     [
                        ['content', '按内容'],
                        ['style', '按风格'],
                     ] as const
                  ).map(([key, text]) => (
                     <button key={key} type="button" role="radio" aria-checked={by === key} onClick={() => setBy(key)}>
                        {text}
                     </button>
                  ))}
               </span>
               <span className="jc-cover-counts" role="radiogroup" aria-label="只看">
                  {(['all', '视频', '文章'] as const).map((key) => (
                     <button key={key} type="button" role="radio" aria-checked={form === key} onClick={() => setForm(key)}>
                        {key === 'all' ? '全部' : key}
                     </button>
                  ))}
               </span>
            </span>
         </div>
         {shown.length === 0 ? (
            <Card className="p-4 text-[12.5px] leading-relaxed" style={{ color: 'var(--jc-muted)' }}>
               {groups.length ? `还没有${form}的封面。` : '还没有出过封面。在一条选题的页面里点「在 Codex 里出一批封面」，出好的会在这里按内容排好。'}
            </Card>
         ) : by === 'content' ? (
            <div className="grid gap-3">
               {shown.map((g) => {
                  const list: ViewItem[] = [...g.covers]
                     .sort((a, b) => Number(b.selected) - Number(a.selected))
                     .map((c) => ({ key: c.no, src: coverUrl(g.id, `封面候选/${c.image}`, c.modifiedAt), title: `${g.id} 封面-${c.no}${c.selected ? '（选定）' : ''}`, sub: c.styleName }));
                  return (
                     <section key={g.id} className="jc-card px-4 py-3" data-library-group={g.id}>
                        <p className="mb-2 flex flex-wrap items-baseline gap-x-2 text-[13px]">
                           <Link href={`/content/${g.id}#covers`} className="font-semibold">
                              {g.id} {g.title}
                           </Link>
                           <span style={{ color: 'var(--jc-ghost)' }}>
                              {g.form}
                              {g.type ? ` · ${g.type}` : ''} · {g.covers.length} 张{g.selected ? ' · 已选定' : ''}
                           </span>
                        </p>
                        <div className="jc-library-row">
                           {list.map((v, i) => (
                              <button
                                 key={v.key}
                                 type="button"
                                 className="jc-library-thumb"
                                 data-size={g.covers.find((c) => c.no === v.key)?.size ?? undefined}
                                 data-selected={g.covers.find((c) => c.no === v.key)?.selected || undefined}
                                 onClick={() => setZoom({ list, key: v.key })}
                                 aria-label={`放大看${v.title}`}
                              >
                                 {/* eslint-disable-next-line @next/next/no-img-element */}
                                 <img src={v.src} alt={v.title} loading={i > 8 ? 'lazy' : undefined} />
                                 {g.covers.find((c) => c.no === v.key)?.selected && <span className="jc-cover-picked">选定</span>}
                              </button>
                           ))}
                        </div>
                     </section>
                  );
               })}
            </div>
         ) : (
            <div className="grid gap-3">
               {byStyle.map((g) => {
                  const list: ViewItem[] = g.covers.map((c) => ({ key: `${c.id}-${c.no}`, src: coverUrl(c.id, `封面候选/${c.image}`, c.modifiedAt), title: `${c.id} 封面-${c.no}`, sub: c.title }));
                  const sizeOf = new Map(g.covers.map((c) => [`${c.id}-${c.no}`, c.size]));
                  return (
                     <section key={g.key || 'none'} className="jc-card px-4 py-3" data-library-style={g.style ?? ''}>
                        <p className="mb-2 text-[13px]">
                           <b>{label(g.style, g.styleName)}</b>
                           <span className="ml-2" style={{ color: 'var(--jc-ghost)' }}>
                              {g.covers.length} 张
                           </span>
                        </p>
                        <div className="jc-library-row">
                           {list.map((v, i) => (
                              <button key={v.key} type="button" className="jc-library-thumb" data-size={sizeOf.get(v.key) ?? undefined} onClick={() => setZoom({ list, key: v.key })} aria-label={`放大看${v.title}`}>
                                 {/* eslint-disable-next-line @next/next/no-img-element */}
                                 <img src={v.src} alt={v.title} loading={i > 8 ? 'lazy' : undefined} />
                                 <span className="jc-library-caption">{v.title.split(' ')[0]}</span>
                              </button>
                           ))}
                        </div>
                     </section>
                  );
               })}
            </div>
         )}
         {zoom && <Lightbox items={zoom.list} current={zoom.key} onMove={(key) => setZoom({ ...zoom, key })} onClose={() => setZoom(null)} />}
      </section>
   );
}

// —— 我的照片 ——————————————————————————————

function MyPhotos({ info, onChanged }: { info: CoverInfo; onChanged: () => void }) {
   const input = useRef<HTMLInputElement>(null);
   const [busy, setBusy] = useState<string | null>(null);
   const upload = async (files: File[]) => {
      const list = files.filter(isImage);
      if (!list.length) {
         toast.error('照片要是 PNG、JPEG 或 WebP（iPhone 的 HEIC 照片先在「照片」App 里导出成 JPEG）。');
         return;
      }
      setBusy('upload');
      try {
         let last = '';
         for (const file of list) last = (await uploadPhoto(file)).message;
         toast.success(last);
         onChanged();
      } catch (err) {
         toast.error(errorText(err));
      } finally {
         setBusy(null);
         if (input.current) input.current.value = '';
      }
   };
   const remove = async (name: string) => {
      setBusy(name);
      try {
         toast.success((await trashPhoto(name)).message);
         onChanged();
      } catch (err) {
         toast.error(errorText(err));
      } finally {
         setBusy(null);
      }
   };
   return (
      <Card className="jc-photos-card px-4 py-3.5" id="my-photos">
         <p className="text-[13.5px] font-semibold">我的照片</p>
         <p className="mt-0.5 text-[12px] leading-relaxed" style={{ color: 'var(--jc-muted)' }}>
            AI 照着它把封面上的人换成你。放一张或几张都行，出封面时都用上。
         </p>
         {info.photos.length > 0 && (
            <div className="jc-photo-grid mt-2.5">
               {info.photos.map((p) => (
                  <div key={p.name} className="jc-photo" title={p.name}>
                     {p.shown ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={photoUrl(p.name)} alt={p.name} />
                     ) : (
                        <span className="jc-style-empty">HEIC</span>
                     )}
                     {p.main && <span className="jc-photo-main">先用</span>}
                     <button type="button" className="jc-photo-remove" aria-label={`拿掉 ${p.name}`} disabled={busy === p.name} onClick={() => void remove(p.name)}>
                        <X size={12} />
                     </button>
                  </div>
               ))}
            </div>
         )}
         <SecondaryButton size="small" className="mt-2.5" busy={busy === 'upload'} onClick={() => input.current?.click()}>
            <ImagePlus size={14} /> {info.photos.length ? '再放几张' : '放照片'}
         </SecondaryButton>
         <input ref={input} type="file" multiple accept={IMAGE_TYPES} className="hidden" aria-label="选几张你的照片" onChange={(e) => void upload([...(e.target.files ?? [])])} />
      </Card>
   );
}
