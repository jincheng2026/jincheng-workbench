'use client';

// 对标账号：一面图片墙，靠脸认账号。点卡片的图打开他的主页；卡上能直接打开和他有关的调研报告。
// 数据来自「市场调研/对标账号/」（一个账号一个文件夹：档案.json + 图片），页面上能添加、编辑、加图片、挪进回收站，写完读回来核对。
// 改自原作者自己用的工作台的对标账号页，去掉了只在他那里有的东西。
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { Copy, ImageIcon, Images, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useAppInfo } from '@/components/jc/app-info';
import { OpenInAi } from '@/components/jc/open-in-ai';
import { Card, DangerButton, EmptyState, PrimaryButton, SecondaryButton, SemBadge, SemBanner, copyText } from '@/components/jc/ui';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { errorText } from '@/lib/api';
import { askAddAccount, askCoverVi } from '@/lib/ask-ai';
import { setDefaultStyle } from '@/lib/covers';
import { askInfo } from '@/lib/app-info';
import { accountsEmpty, followersText, relatedReports } from '@/lib/research-guide';
import {
   accountImageUrl,
   reportViewHref,
   saveAccount,
   trashAccount,
   uploadAccountImage,
   type Account,
   type Report,
} from '@/lib/research';

const IMAGE_RE = /\.(jpe?g|png|webp|gif)$/i;

/* ── 添加 / 编辑 ── */
function AccountDialog({
   account,
   platforms,
   onClose,
   onSaved,
}: {
   account: Account | null;
   platforms: string[];
   onClose: () => void;
   onSaved: (message: string) => void;
}) {
   const [platform, setPlatform] = useState(account?.platform ?? platforms[0] ?? '抖音');
   const [accountName, setAccountName] = useState(account?.accountName ?? '');
   const [url, setUrl] = useState(account?.url ?? '');
   const [note, setNote] = useState(account?.note ?? '');
   const [tagsText, setTagsText] = useState((account?.tags ?? []).join('，'));
   const [files, setFiles] = useState<File[]>([]);
   const [over, setOver] = useState(false);
   const [busy, setBusy] = useState<'save' | 'trash' | null>(null);
   const [problem, setProblem] = useState<string | null>(null);
   const [confirmTrash, setConfirmTrash] = useState(false);
   // 已经存好档案、只是图片没传完时，再点保存按编辑处理，不会建出第二个账号
   const savedName = useRef<string | null>(account?.name ?? null);
   const fileRef = useRef<HTMLInputElement>(null);

   const addFiles = (list: FileList | File[] | null) => {
      if (!list) return;
      const all = [...list];
      const picked = all.filter((f) => IMAGE_RE.test(f.name));
      if (picked.length < all.length) toast.error('只收 jpg、png、webp、gif 图片');
      setFiles((prev) => [...prev, ...picked]);
   };

   const save = async () => {
      if (!accountName.trim()) {
         setProblem('账号名要填。');
         return;
      }
      setBusy('save');
      setProblem(null);
      try {
         const result = await saveAccount({
            name: savedName.current ?? undefined,
            platform,
            accountName,
            url,
            note,
            tags: tagsText
               .split(/[,，、;；\s]+/)
               .map((t) => t.trim())
               .filter(Boolean),
         });
         savedName.current = result.name;
         let left = [...files];
         for (const file of files) {
            await uploadAccountImage(result.name, file);
            left = left.slice(1);
            setFiles(left);
         }
         onSaved(result.message);
      } catch (error) {
         setProblem(errorText(error));
         setBusy(null);
      }
   };

   const trash = async () => {
      if (!account) return;
      setBusy('trash');
      try {
         onSaved((await trashAccount(account.name)).message);
      } catch (error) {
         setProblem(errorText(error));
         setBusy(null);
      }
   };

   const field = 'jc-input mt-1.5 h-10 w-full px-3 text-[14px]';
   const label = 'text-[12px] font-semibold';

   return (
      <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
         <DialogContent className="max-h-[calc(100vh-2rem)] max-w-[560px] overflow-y-auto rounded-2xl p-5 min-[721px]:p-6" style={{ background: 'var(--jc-surface)' }}>
            <DialogTitle className="text-[17px] font-bold">{account ? '编辑对标账号' : '添加对标账号'}</DialogTitle>
            <DialogDescription className="text-[12.5px]" style={{ color: 'var(--jc-muted)' }}>
               存进「市场调研/对标账号」里这个账号的文件夹（档案.json 和图片），AI 也读得到。
            </DialogDescription>
            <div className="grid gap-3.5">
               <div className="grid grid-cols-[118px_1fr] gap-2.5">
                  <label className="block">
                     <span className={label}>平台</span>
                     <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={`${field} px-2.5`}>
                        {[...new Set([...platforms, ...(account?.platform ? [account.platform] : [])])].map((p) => (
                           <option key={p} value={p}>
                              {p}
                           </option>
                        ))}
                     </select>
                  </label>
                  <label className="block">
                     <span className={label}>
                        账号名 <span style={{ color: 'var(--jc-err)' }}>*</span>
                     </span>
                     <input value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="对方的账号昵称" className={field} />
                  </label>
               </div>
               <label className="block">
                  <span className={label}>主页链接</span>
                  <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…（从浏览器地址栏复制）" className={field} inputMode="url" />
               </label>
               <label className="block">
                  <span className={label}>为什么对标（备注）</span>
                  <textarea
                     value={note}
                     onChange={(e) => setNote(e.target.value)}
                     rows={3}
                     placeholder="他哪里做得好、学什么、注意什么"
                     className="jc-input mt-1.5 w-full resize-y p-3 text-[14px] leading-[1.7]"
                  />
               </label>
               <label className="block">
                  <span className={label}>标签（用逗号隔开）</span>
                  <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="口播，教程，低粉爆款" className={field} />
               </label>
               <div
                  role="button"
                  tabIndex={0}
                  onClick={() => fileRef.current?.click()}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
                  onDragOver={(e) => {
                     e.preventDefault();
                     setOver(true);
                  }}
                  onDragLeave={() => setOver(false)}
                  onDrop={(e) => {
                     e.preventDefault();
                     setOver(false);
                     addFiles(e.dataTransfer.files);
                  }}
                  className="jc-dropzone cursor-pointer"
                  data-over={over ? 'true' : undefined}
               >
                  <span className="text-[13px] font-medium" style={{ color: 'var(--jc-body)' }}>
                     头像、主页截图、代表作封面（可以多张）
                  </span>
                  <span>
                     {files.length
                        ? `要传的 ${files.length} 张图：${files.map((f) => f.name).join('、')}`
                        : account?.images.length
                          ? `已经有 ${account.images.length} 张图，点这里或拖进来再加`
                          : '点这里选，或者把截图拖进来。以后靠这张图认出他'}
                  </span>
                  <input
                     ref={fileRef}
                     type="file"
                     accept=".jpg,.jpeg,.png,.webp,.gif"
                     multiple
                     className="hidden"
                     onChange={(e) => {
                        addFiles(e.target.files);
                        e.target.value = '';
                     }}
                  />
               </div>
               {problem && <SemBanner tone="err">{problem}</SemBanner>}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
               {account && !confirmTrash && (
                  <button type="button" className="mr-auto text-[12.5px]" style={{ color: 'var(--jc-err)' }} onClick={() => setConfirmTrash(true)} disabled={busy !== null}>
                     不对标了，挪进回收站
                  </button>
               )}
               {account && confirmTrash && (
                  <span className="mr-auto flex flex-wrap items-center gap-2 text-[12.5px]" style={{ color: 'var(--jc-body)' }}>
                     整个文件夹挪进回收站？
                     <DangerButton size="small" busy={busy === 'trash'} onClick={() => void trash()}>
                        挪进回收站
                     </DangerButton>
                     <SecondaryButton size="small" onClick={() => setConfirmTrash(false)} disabled={busy !== null}>
                        不挪
                     </SecondaryButton>
                  </span>
               )}
               <SecondaryButton onClick={onClose} disabled={busy !== null}>
                  取消
               </SecondaryButton>
               <PrimaryButton busy={busy === 'save'} disabled={busy === 'trash'} onClick={() => void save()}>
                  保存
               </PrimaryButton>
            </div>
         </DialogContent>
      </Dialog>
   );
}

/* ── 看大图 ── */
function ImagesDialog({ account, onClose }: { account: Account; onClose: () => void }) {
   return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
         <DialogContent className="max-h-[calc(100vh-2rem)] max-w-[760px] overflow-y-auto rounded-2xl p-5" style={{ background: 'var(--jc-surface)' }}>
            <DialogTitle className="text-[16px] font-bold">
               {account.platform ? `${account.platform} · ` : ''}
               {account.accountName}
            </DialogTitle>
            <DialogDescription className="sr-only">这个账号的全部图片</DialogDescription>
            <div className="grid gap-3">
               {account.images.map((img) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={img} src={accountImageUrl(account.name, img)} alt={`${account.accountName}：${img}`} className="w-full rounded-xl border object-contain" style={{ borderColor: 'var(--jc-border)' }} />
               ))}
            </div>
         </DialogContent>
      </Dialog>
   );
}

/** 封面 VI（1.1 加）：拆过的写风格名、是不是默认对标、看拆解；没拆过给一句「复制给 AI：拆封面 VI」 */
function ViLine({ a, onChanged }: { a: Account; onChanged: () => void }) {
   const { info } = useAppInfo();
   const [busy, setBusy] = useState(false);
   const vi = a.vi;
   if (!vi) return null;
   const makeDefault = async () => {
      setBusy(true);
      try {
         toast.success((await setDefaultStyle(a.name)).message);
         onChanged();
      } catch (err) {
         toast.error(errorText(err));
      } finally {
         setBusy(false);
      }
   };
   if (!vi.done) {
      return (
         <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--jc-muted)' }} data-vi="none">
            封面 VI：还没拆。
            <OpenInAi text={askCoverVi(a, askInfo(info, 'cover'))} action="拆封面 VI" what="拆封面 VI 的话" variant="link" />
         </p>
      );
   }
   return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]" style={{ color: 'var(--jc-muted)' }} data-vi="done">
         <span>
            封面 VI：<b style={{ color: 'var(--jc-ink)' }}>{vi.style ?? '已拆'}</b>
         </span>
         {vi.isDefault ? (
            <SemBadge tone="ok">默认风格</SemBadge>
         ) : (
            <button type="button" className="font-medium" style={{ color: 'var(--jc-accent)' }} disabled={busy} onClick={() => void makeDefault()}>
               {busy ? '正在设成默认……' : '设为默认风格'}
            </button>
         )}
         {vi.report && (
            <Link href={reportViewHref(vi.report.id, vi.report.page)} className="font-medium">
               看拆解
            </Link>
         )}
      </p>
   );
}

function AccountCard({ a, reports, onEdit, onZoom, onChanged }: { a: Account; reports: Report[]; onEdit: () => void; onZoom: () => void; onChanged: () => void }) {
   const cover = a.images[0] ?? null;
   const followers = followersText(a.followers);
   const main = reports[0] ?? null;
   const coverInner = cover ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={accountImageUrl(a.name, cover)} alt={a.accountName} loading="lazy" className="h-full w-full object-cover" />
   ) : (
      <span className="grid h-full w-full place-items-center px-3 text-center text-[12px]" style={{ color: 'var(--jc-ghost)' }}>
         <span>
            <ImageIcon size={22} className="mx-auto mb-1.5" aria-hidden="true" />
            还没有图片，点「编辑」加一张
         </span>
      </span>
   );
   const coverStyle = { background: 'var(--jc-soft)', aspectRatio: '3 / 4' } as const;
   return (
      <Card className="flex flex-col overflow-hidden p-0">
         {a.url ? (
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="block" style={coverStyle} title={`打开「${a.accountName}」的主页`}>
               {coverInner}
            </a>
         ) : (
            <button type="button" className="block w-full border-0 p-0" style={coverStyle} onClick={onEdit} title="还没存主页链接，点这里补上">
               {coverInner}
            </button>
         )}
         <div className="flex flex-1 flex-col gap-1.5 p-3">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
               {a.platform && <SemBadge tone="accent">{a.platform}</SemBadge>}
               {a.url ? (
                  <a
                     href={a.url}
                     target="_blank"
                     rel="noopener noreferrer"
                     className="min-w-0 flex-1 truncate text-[13.5px] font-semibold no-underline hover:underline"
                     style={{ color: 'var(--jc-ink)' }}
                     title={a.accountName}
                  >
                     {a.accountName}
                  </a>
               ) : (
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold" title={a.accountName}>
                     {a.accountName}
                  </span>
               )}
            </div>
            {followers && (
               <p className="text-[11.5px]" style={{ color: 'var(--jc-muted)' }}>
                  {followers}
               </p>
            )}
            {(a.note || a.bio) && (
               <p className="line-clamp-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--jc-muted)' }} title={a.note ?? a.bio ?? ''}>
                  {a.note ?? a.bio}
               </p>
            )}
            {a.tags.length > 0 && (
               <div className="flex flex-wrap gap-1">
                  {a.tags.map((t) => (
                     <SemBadge key={t} tone="gray">
                        {t}
                     </SemBadge>
                  ))}
               </div>
            )}
            <ViLine a={a} onChanged={onChanged} />
            {a.problem && a.problem !== '还没有 档案.json' && (
               <p className="text-[11.5px]" style={{ color: 'var(--jc-warn)' }}>
                  {a.problem}
               </p>
            )}
            <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5 text-[12px] font-medium">
               {main &&
                  (reports.length === 1 ? (
                     <Link href={reportViewHref(main.id, main.pages[0].file)} title={main.title}>
                        看报告
                     </Link>
                  ) : (
                     <Link href={`/research?tab=reports&account=${encodeURIComponent(a.name)}`}>看 {reports.length} 份报告</Link>
                  ))}
               {a.images.length > 1 && (
                  <button type="button" onClick={onZoom} className="inline-flex items-center gap-1" style={{ color: 'var(--jc-accent)' }}>
                     <Images size={13} aria-hidden="true" />
                     看 {a.images.length} 张图
                  </button>
               )}
               <button type="button" onClick={onEdit} className="ml-auto" style={{ color: 'var(--jc-muted)' }}>
                  编辑
               </button>
            </div>
         </div>
      </Card>
   );
}

export function BenchmarkAccounts({
   accounts,
   platforms,
   reports,
   tikhubReady,
   editing,
   onEdit,
   onChanged,
}: {
   accounts: Account[];
   platforms: string[];
   reports: Report[];
   tikhubReady: boolean;
   editing: Account | 'new' | null;
   onEdit: (account: Account | 'new' | null) => void;
   onChanged: () => void;
}) {
   const { info } = useAppInfo();
   const [query, setQuery] = useState('');
   const [platform, setPlatform] = useState('全部');
   const [zoomed, setZoomed] = useState<Account | null>(null);

   const platformCounts = useMemo(() => {
      const counts = new Map<string, number>();
      for (const a of accounts) counts.set(a.platform ?? '其他', (counts.get(a.platform ?? '其他') ?? 0) + 1);
      return [...counts.entries()];
   }, [accounts]);

   const shown = useMemo(() => {
      const q = query.trim().toLowerCase();
      return accounts.filter((a) => {
         if (platform !== '全部' && (a.platform ?? '其他') !== platform) return false;
         if (!q) return true;
         return [a.accountName, a.note ?? '', a.bio ?? '', a.platform ?? '', ...a.tags].join(' ').toLowerCase().includes(q);
      });
   }, [accounts, query, platform]);

   const empty = accountsEmpty(tikhubReady);

   return (
      <div>
         {accounts.length === 0 ? (
            <EmptyState
               text={empty.text}
               hint={empty.hint}
               actions={
                  <>
                     <PrimaryButton size="small" onClick={() => onEdit('new')}>
                        <Plus size={14} /> 添加对标账号
                     </PrimaryButton>
                     <SecondaryButton size="small" onClick={() => void copyText(askAddAccount(askInfo(info, 'research')), '给 AI 的话')} title="复制一段话，粘贴给 Codex 或 Claude Code">
                        <Copy size={14} /> 复制给 AI 的话
                     </SecondaryButton>
                  </>
               }
            />
         ) : (
            <>
               <div className="mb-3 flex flex-wrap items-center gap-3">
                  <label
                     className="jc-search flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border px-3 min-[961px]:max-w-md"
                     style={{ borderColor: 'var(--jc-border)', background: 'var(--jc-surface)' }}
                  >
                     <Search size={16} aria-hidden="true" style={{ color: 'var(--jc-muted)' }} />
                     <input
                        aria-label="搜对标账号"
                        placeholder="按账号名、备注、标签搜"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                     />
                     {query && (
                        <button type="button" onClick={() => setQuery('')} className="text-[11px]" style={{ color: 'var(--jc-ghost)' }}>
                           清空
                        </button>
                     )}
                  </label>
               </div>
               {platformCounts.length > 1 && (
                  <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="按平台筛选">
                     {[['全部', accounts.length] as [string, number], ...platformCounts].map(([name, n]) => {
                        const active = platform === name;
                        return (
                           <button
                              key={name}
                              type="button"
                              aria-pressed={active}
                              onClick={() => setPlatform(name)}
                              className="rounded-full border px-3 py-1 text-[12.5px] font-medium"
                              style={{
                                 borderColor: active ? 'var(--jc-accent)' : 'var(--jc-border)',
                                 background: active ? 'var(--jc-accent-bg)' : 'var(--jc-surface)',
                                 color: active ? 'var(--jc-accent)' : 'var(--jc-body)',
                              }}
                           >
                              {name}{' '}
                              <span className="tabular-nums" style={{ color: active ? 'var(--jc-accent)' : 'var(--jc-ghost)' }}>
                                 {n}
                              </span>
                           </button>
                        );
                     })}
                  </div>
               )}
               {shown.length === 0 ? (
                  <EmptyState
                     text="没有对得上的账号"
                     hint="换个词，或者把平台切回「全部」。"
                     actions={
                        <SecondaryButton
                           size="small"
                           onClick={() => {
                              setQuery('');
                              setPlatform('全部');
                           }}
                        >
                           清空搜索和筛选
                        </SecondaryButton>
                     }
                  />
               ) : (
                  <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(190px, calc(50% - 6px)), 1fr))' }}>
                     {shown.map((a) => (
                        <AccountCard key={a.name} a={a} reports={relatedReports(a, reports)} onEdit={() => onEdit(a)} onZoom={() => setZoomed(a)} onChanged={onChanged} />
                     ))}
                  </div>
               )}
            </>
         )}

         {editing && (
            <AccountDialog
               account={editing === 'new' ? null : editing}
               platforms={platforms}
               onClose={() => {
                  onEdit(null);
                  // 档案存好了、图片没传完就关掉时，墙上也要出现这个账号：关掉表单就重读一次
                  onChanged();
               }}
               onSaved={(message) => {
                  toast.success(message);
                  onEdit(null);
                  onChanged();
               }}
            />
         )}
         {zoomed && <ImagesDialog account={zoomed} onClose={() => setZoomed(null)} />}
      </div>
   );
}
