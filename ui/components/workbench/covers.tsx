'use client';

// 详情页的「封面」（1.1 加，照学员版「内容工作台」的封面页搬过来）：
//   出封面用的照片和对标 → 复制给 AI 出一批（张数、构图参考可选）→ 按批次看候选，每张能放大、勾选、写备注、收藏、删除
//   → 勾一张「就用这张」，勾几张「并排对比」后在里面定一张；定了能取消。
// 出图、按备注改交给 AI（复制的话在 lib/ask-ai.ts）；选定、删除、收藏、存批注图、放照片这些不用 AI，页面直接调后台（lib/covers.ts）。
// AI 出图时一张一张存进封面候选：页面每 5 秒问一次，出一张亮一张。
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, Copy, FolderOpen, Heart, ImagePlus, MessageSquarePlus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAppInfo } from '@/components/jc/app-info';
import { OpenInAi } from '@/components/jc/open-in-ai';
import { Card, PrimaryButton, SecondaryButton, SemBadge, copyText } from '@/components/jc/ui';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { errorText } from '@/lib/api';
import { askInfo } from '@/lib/app-info';
import { askMakeCovers, askReviseCover } from '@/lib/ask-ai';
import {
   checkTone,
   coverUrl,
   favoriteCover,
   favoriteUrl,
   fetchCoverInfo,
   fetchTopicCovers,
   nextNoteName,
   openCoverFolder,
   photoName,
   photoUrl,
   saveAnnotation,
   selectCover,
   trashCover,
   unselectCover,
   uploadPhoto,
   type CoverInfo,
   type CoverItem,
   type TopicCovers,
} from '@/lib/covers';

const POLL_MS = 5000;
const COUNTS = [3, 5, 10];
const TRASH_QUIET_KEY = 'workbench-cover-trash-quiet'; // 「这次不再提醒」：记在这个标签页里，关掉就忘
const AFTER_COPY = '粘贴给 Codex 或 Claude Code，发出去。';

type Shown = CoverItem & { batch: number | null };

function useCovers(id: string) {
   const [covers, setCovers] = useState<TopicCovers | null>(null);
   const [info, setInfo] = useState<CoverInfo | null>(null);
   const [error, setError] = useState<string | null>(null);
   const load = useCallback(
      async (withInfo = false) => {
         try {
            const [next, nextInfo] = await Promise.all([fetchTopicCovers(id), withInfo ? fetchCoverInfo() : Promise.resolve(null)]);
            setCovers(next);
            if (nextInfo) setInfo(nextInfo);
            setError(null);
         } catch (err) {
            setError(errorText(err));
         }
      },
      [id]
   );
   useEffect(() => {
      void load(true);
      // AI 出图时一张一张存进来：页面开着就隔一会儿问一次；切回窗口时连照片、对标一起重读
      const timer = window.setInterval(() => {
         if (document.visibilityState === 'visible') void load(false);
      }, POLL_MS);
      const onFocus = () => void load(true);
      window.addEventListener('focus', onFocus);
      return () => {
         window.clearInterval(timer);
         window.removeEventListener('focus', onFocus);
      };
   }, [load]);
   return { covers, setCovers, info, setInfo, error, reload: load };
}

export function CoverBlock({ id }: { id: string }) {
   const { info: app } = useAppInfo();
   const { covers, setCovers, info, error, reload } = useCovers(id);
   const [checked, setChecked] = useState<string[]>([]);
   const [count, setCount] = useState<number | null>(null);
   const [refs, setRefs] = useState<string[]>([]);
   const [zoom, setZoom] = useState<string | null>(null);
   const [comparing, setComparing] = useState(false);
   const [noting, setNoting] = useState<string | null>(null);
   const [trashing, setTrashing] = useState<string | null>(null);
   const [busy, setBusy] = useState<string | null>(null);

   const shown: Shown[] = useMemo(() => (covers?.batches ?? []).flatMap((b) => b.items.map((item) => ({ ...item, batch: b.no }))), [covers]);
   const withImage = shown.filter((item) => item.image);
   const byNo = useMemo(() => new Map(shown.map((item) => [item.no, item])), [shown]);
   // 删掉了、不在了的勾选自动去掉
   useEffect(() => setChecked((list) => list.filter((no) => byNo.get(no)?.image)), [byNo]);

   const batchSize = count ?? covers?.settings.batchSize ?? 5;
   const askInfoCover = askInfo(app, 'cover');

   async function act(key: string, run: () => Promise<{ message: string; covers?: TopicCovers }>) {
      setBusy(key);
      try {
         const result = await run();
         if (result.covers) setCovers(result.covers);
         toast.success(result.message);
         return true;
      } catch (err) {
         toast.error(errorText(err));
         return false;
      } finally {
         setBusy(null);
      }
   }

   const pick = (no: string) => act(`select:${no}`, () => selectCover(id, no)).then((ok) => ok && (setChecked([]), setComparing(false)));
   const toggleFav = (item: CoverItem) => act(`fav:${item.no}`, () => favoriteCover(id, item.no, !item.favorite)).then((ok) => ok && void reload(true));
   const askTrash = (no: string) => {
      let quiet = false;
      try {
         quiet = window.sessionStorage.getItem(TRASH_QUIET_KEY) === '1';
      } catch {
         quiet = false;
      }
      if (quiet) void act(`trash:${no}`, () => trashCover(id, no));
      else setTrashing(no);
   };

   const makeText = askMakeCovers(id, askInfoCover, { count: batchSize, refs });

   if (!covers) {
      return (
         <section id="covers" className="mt-8">
            <div className="jc-section-heading">
               <h2>封面</h2>
            </div>
            <Card className="p-4 text-[12.5px]" style={{ color: 'var(--jc-muted)' }}>
               {error ? `封面没读到：${error}` : '正在读取封面……'}
            </Card>
         </section>
      );
   }

   const photo = photoName(covers.settings);
   const benchmark = info?.benchmarks.find((b) => b.name === covers.settings.benchmark) ?? null;
   const hasViAny = (info?.benchmarks ?? []).some((b) => b.vi.done);
   const favorites = info?.favorites ?? [];
   const selectedItem = covers.selected?.from ? byNo.get(covers.selected.from) ?? null : null;
   const total = withImage.length;
   const promptOnly = shown.length - total;
   const again = total > 0 || promptOnly > 0;

   return (
      <section id="covers" className="mt-8" data-tour="covers">
         <div className="jc-section-heading">
            <h2>
               封面
               {total > 0 && <span className="jc-section-count">{total}</span>}
            </h2>
            <span className="text-[12px]" style={{ color: 'var(--jc-ghost)' }}>
               {covers.selected ? `已选定${covers.selected.from ? `封面-${covers.selected.from}` : ''}` : total ? '还没选定' : ''}
            </span>
         </div>
         <Card className="overflow-hidden">
            {/* 出封面用的：照片、对标 */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b px-4 py-3" style={{ borderColor: 'var(--jc-border)' }}>
               <PhotoSlot photo={photo} onUploaded={() => void reload(true)} />
               <div className="min-w-0 flex-1 basis-[220px] text-[12.5px] leading-relaxed">
                  <span style={{ color: 'var(--jc-muted)' }}>对标：</span>
                  {benchmark ? (
                     <>
                        <b>{benchmark.vi.style ?? benchmark.accountName}</b>
                        <span style={{ color: 'var(--jc-muted)' }}>（{benchmark.accountName}）</span>{' '}
                        <Link href="/research?tab=accounts" className="text-[12px]">
                           换一个
                        </Link>
                     </>
                  ) : hasViAny ? (
                     <>
                        还没设默认对标。<Link href="/research?tab=accounts">去对标账号里点「设为默认」</Link>
                     </>
                  ) : (
                     <>
                        还没拆过对标博主的封面 VI。<Link href="/research?tab=accounts">去「市场调研」拆一个</Link>，出封面照他的风格来。
                     </>
                  )}
               </div>
               {covers.folder && (
                  <SecondaryButton size="small" busy={busy === 'open'} onClick={() => void act('open', () => openCoverFolder(id))}>
                     <FolderOpen size={14} /> 在访达中打开封面候选
                  </SecondaryButton>
               )}
            </div>

            {/* 选定的那张 */}
            {covers.selected && (
               <div className="flex flex-wrap items-center gap-4 border-b px-4 py-3" style={{ borderColor: 'var(--jc-border)', background: 'var(--jc-ok-bg)' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                     src={coverUrl(id, covers.selected.name, covers.selected.modifiedAt)}
                     alt="选定的封面"
                     className="h-[92px] w-[69px] cursor-zoom-in rounded-md object-cover"
                     style={{ border: '1px solid var(--jc-ok-bd)' }}
                     onClick={() => selectedItem?.image && setZoom(selectedItem.no)}
                  />
                  <div className="min-w-0 flex-1 text-[13px]">
                     <b style={{ color: 'var(--jc-ok)' }}>选定的封面</b>
                     <span style={{ color: 'var(--jc-muted)' }}>
                        {covers.selected.from ? `：封面-${covers.selected.from}` : ''}，存成了草稿文件夹里的「{covers.selected.name}」，发布时用它。
                     </span>
                  </div>
                  <SecondaryButton size="small" busy={busy === 'unselect'} onClick={() => void act('unselect', () => unselectCover(id))}>
                     取消选定
                  </SecondaryButton>
               </div>
            )}

            {/* 出一批 */}
            <div className="border-b px-4 py-3.5" style={{ borderColor: 'var(--jc-border)' }}>
               <p className="text-[13px] leading-relaxed">
                  <b style={{ color: 'var(--jc-accent)' }}>{again ? `再出一批（第 ${covers.next.batch} 批）：` : '出一批封面：'}</b>
                  交给 Codex 或 Claude Code。Codex 会直接出图，出一张这里亮一张；Claude Code 不能直接出图，会把每张的生图提示词写好，你拿去能生图的工具里生成。
                  {!photo && ' 还没放照片的话，AI 做到那一步会提醒你。'}
               </p>
               <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <span className="text-[12px]" style={{ color: 'var(--jc-muted)' }}>
                     这批几张
                  </span>
                  <div className="jc-cover-counts" role="radiogroup" aria-label="这批几张">
                     {COUNTS.map((n) => (
                        <button key={n} type="button" role="radio" aria-checked={batchSize === n} onClick={() => setCount(n)}>
                           {n}
                        </button>
                     ))}
                  </div>
                  <OpenInAi text={makeText} action={again ? '再出一批' : '出一批封面'} what="出一批封面的话" />
               </div>
               {favorites.length > 0 && (
                  <div className="mt-3">
                     <p className="text-[12px]" style={{ color: 'var(--jc-muted)' }}>
                        构图参考（可选）：勾几张你收藏的封面，这批里会有几张照它们的构图来。
                     </p>
                     <div className="mt-1.5 flex flex-wrap gap-2">
                        {favorites.slice(0, 12).map((fav) => {
                           const label = fav.name.replace(/\.[^.]+$/, '');
                           const on = refs.includes(label);
                           return (
                              <button
                                 key={fav.name}
                                 type="button"
                                 aria-pressed={on}
                                 title={label}
                                 className="jc-cover-ref"
                                 onClick={() => setRefs((list) => (on ? list.filter((x) => x !== label) : [...list, label]))}
                              >
                                 {/* eslint-disable-next-line @next/next/no-img-element */}
                                 <img src={favoriteUrl(fav.name)} alt={label} />
                                 {on && (
                                    <span className="jc-cover-ref-on" aria-hidden="true">
                                       <Check size={12} strokeWidth={3} />
                                    </span>
                                 )}
                              </button>
                           );
                        })}
                     </div>
                  </div>
               )}
            </div>

            {/* 一批一批的候选 */}
            {shown.length === 0 ? (
               <p className="px-4 py-5 text-[12.5px]" style={{ color: 'var(--jc-muted)' }}>
                  还没有封面候选。复制上面那句话发给 AI，出好的封面会一张一张出现在这里。
               </p>
            ) : (
               covers.batches.map((batch) => (
                  <div key={batch.no ?? 'loose'} className="border-b px-4 py-3.5 last:border-b-0" style={{ borderColor: 'var(--jc-border)' }}>
                     <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h3 className="text-[13.5px] font-semibold">{batch.no ? `第 ${batch.no} 批` : '还没登记的'}</h3>
                        <span className="text-[11.5px]" style={{ color: 'var(--jc-ghost)' }}>
                           {batch.no ? batch.info ?? '' : 'AI 还在登记，或者是你自己放进来的'}
                        </span>
                     </div>
                     <div className="jc-cover-grid">
                        {batch.items.map((item) => (
                           <CoverCard
                              key={item.no}
                              id={id}
                              item={item}
                              checked={checked.includes(item.no)}
                              busy={busy}
                              onZoom={() => setZoom(item.no)}
                              onCheck={() => setChecked((list) => (list.includes(item.no) ? list.filter((x) => x !== item.no) : [...list, item.no]))}
                              onNote={() => setNoting(item.no)}
                              onFav={() => void toggleFav(item)}
                              onTrash={() => askTrash(item.no)}
                           />
                        ))}
                     </div>
                  </div>
               ))
            )}
         </Card>

         {/* 勾了以后底部的浮条：一张「就用这张」，几张「并排对比」 */}
         {checked.length > 0 && (
            <div className="jc-cover-bar" role="region" aria-label="勾选的封面">
               <span>
                  已勾 <b className="tabular-nums">{checked.length}</b> 张
               </span>
               {checked.length === 1 ? (
                  <PrimaryButton size="small" busy={busy === `select:${checked[0]}`} onClick={() => void pick(checked[0])}>
                     就用这张
                  </PrimaryButton>
               ) : (
                  <PrimaryButton size="small" onClick={() => setComparing(true)}>
                     并排对比
                  </PrimaryButton>
               )}
               <button type="button" className="jc-cover-bar-clear" onClick={() => setChecked([])}>
                  清空
               </button>
            </div>
         )}

         {zoom && byNo.get(zoom)?.image && (
            <Lightbox
               id={id}
               items={withImage}
               current={zoom}
               onMove={setZoom}
               onClose={() => setZoom(null)}
               onPick={(no) => void pick(no).then(() => setZoom(null))}
               onNote={(no) => (setZoom(null), setNoting(no))}
               busy={busy}
            />
         )}
         {comparing && (
            <Compare id={id} items={checked.map((no) => byNo.get(no)).filter((x): x is Shown => !!x?.image)} onPick={(no) => void pick(no)} onClose={() => setComparing(false)} busy={busy} />
         )}
         {noting && byNo.get(noting)?.image && (
            <Annotate id={id} item={byNo.get(noting)!} onClose={() => setNoting(null)} onSaved={() => void reload(false)} />
         )}
         {trashing && (
            <TrashConfirm
               no={trashing}
               busy={busy === `trash:${trashing}`}
               onCancel={() => setTrashing(null)}
               onConfirm={(quiet) => {
                  if (quiet) {
                     try {
                        window.sessionStorage.setItem(TRASH_QUIET_KEY, '1');
                     } catch {
                        /* 记不住也不影响这一次 */
                     }
                  }
                  const no = trashing;
                  void act(`trash:${no}`, () => trashCover(id, no)).then(() => setTrashing(null));
               }}
            />
         )}
      </section>
   );
}

function PhotoSlot({ photo, onUploaded }: { photo: string | null; onUploaded: () => void }) {
   const input = useRef<HTMLInputElement>(null);
   const [busy, setBusy] = useState(false);
   const upload = async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      try {
         const result = await uploadPhoto(file);
         toast.success(result.message);
         onUploaded();
      } catch (err) {
         toast.error(errorText(err));
      } finally {
         setBusy(false);
         if (input.current) input.current.value = '';
      }
   };
   return (
      <div className="flex items-center gap-2.5">
         {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(photo)} alt="你的照片" className="h-11 w-11 rounded-full object-cover" style={{ border: '1px solid var(--jc-border)' }} />
         ) : (
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-full" style={{ background: 'var(--jc-soft)', color: 'var(--jc-ghost)' }}>
               <ImagePlus size={18} />
            </span>
         )}
         <div className="text-[12.5px] leading-snug">
            <p>
               <span style={{ color: 'var(--jc-muted)' }}>照片：</span>
               {photo ? photo : '还没放你的照片'}
            </p>
            <button type="button" className="text-[12px] font-medium" style={{ color: 'var(--jc-accent)' }} disabled={busy} onClick={() => input.current?.click()}>
               {busy ? '正在放……' : photo ? '换一张' : '放一张正脸照'}
            </button>
            <input
               ref={input}
               type="file"
               accept="image/png,image/jpeg,image/webp"
               className="hidden"
               aria-label="选一张你的正脸照"
               onChange={(e) => void upload(e.target.files?.[0])}
            />
         </div>
      </div>
   );
}

function IconAction({ label, pressed, onClick, disabled, children }: { label: string; pressed?: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
   return (
      <button type="button" className="jc-cover-action" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
         {children}
      </button>
   );
}

function CoverCard({
   id,
   item,
   checked,
   busy,
   onZoom,
   onCheck,
   onNote,
   onFav,
   onTrash,
}: {
   id: string;
   item: CoverItem;
   checked: boolean;
   busy: string | null;
   onZoom: () => void;
   onCheck: () => void;
   onNote: () => void;
   onFav: () => void;
   onTrash: () => void;
}) {
   const tone = checkTone(item.check);
   if (!item.image) {
      return (
         <div className="jc-cover-card is-prompt" data-cover={item.no}>
            <div className="jc-cover-prompt">
               <b>封面-{item.no}</b>
               <span>只写好了生图提示词，还没出图</span>
               {item.promptText && (
                  <SecondaryButton size="small" onClick={() => void copyText(item.promptText ?? '', `封面-${item.no} 的生图提示词`, { next: '粘贴到能生图的工具里；出好的图存成同名的「封面-' + item.no + '.png」放进封面候选，就会出现在这里。' })}>
                     <Copy size={13} /> 复制提示词
                  </SecondaryButton>
               )}
            </div>
            {item.change && <p className="jc-cover-change">{item.change}</p>}
         </div>
      );
   }
   return (
      <div className="jc-cover-card" data-cover={item.no} data-checked={checked || undefined} data-selected={item.selected || undefined}>
         <button type="button" className="jc-cover-img" onClick={onZoom} aria-label={`放大看封面-${item.no}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={coverUrl(id, `封面候选/${item.image}`, item.modifiedAt)} alt={`封面-${item.no}`} loading="lazy" />
            {item.selected && <span className="jc-cover-picked">选定</span>}
         </button>
         <div className="jc-cover-meta">
            <b>封面-{item.no}</b>
            {item.check && (
               <span className="jc-cover-check" data-tone={tone} title={item.check}>
                  {item.check}
               </span>
            )}
         </div>
         {item.change && (
            <p className="jc-cover-change" title={item.change}>
               {item.change}
            </p>
         )}
         <div className="jc-cover-actions">
            <IconAction label={checked ? '取消勾选' : '勾选这张'} pressed={checked} onClick={onCheck}>
               <Check size={15} strokeWidth={2.6} />
            </IconAction>
            <IconAction label="写备注，交给 AI 改" onClick={onNote}>
               <MessageSquarePlus size={15} />
            </IconAction>
            <IconAction label={item.favorite ? '取消收藏' : '收藏'} pressed={item.favorite} onClick={onFav} disabled={busy === `fav:${item.no}`}>
               <Heart size={15} fill={item.favorite ? 'currentColor' : 'none'} />
            </IconAction>
            <IconAction label={item.selected ? '选定的封面不能删，先取消选定' : '挪进回收站'} onClick={onTrash} disabled={item.selected || busy === `trash:${item.no}`}>
               <Trash2 size={15} />
            </IconAction>
         </div>
      </div>
   );
}

function Lightbox({
   id,
   items,
   current,
   onMove,
   onClose,
   onPick,
   onNote,
   busy,
}: {
   id: string;
   items: Shown[];
   current: string;
   onMove: (no: string) => void;
   onClose: () => void;
   onPick: (no: string) => void;
   onNote: (no: string) => void;
   busy: string | null;
}) {
   const index = Math.max(0, items.findIndex((item) => item.no === current));
   const item = items[index];
   const go = useCallback((step: number) => onMove(items[(index + step + items.length) % items.length].no), [index, items, onMove]);
   useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
         if (e.key === 'Escape') onClose();
         else if (e.key === 'ArrowLeft') go(-1);
         else if (e.key === 'ArrowRight') go(1);
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
   }, [go, onClose]);
   if (!item) return null;
   return (
      <div className="jc-cover-overlay" role="dialog" aria-modal="true" aria-label={`封面-${item.no}`} onClick={onClose}>
         <div className="jc-cover-zoom" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={coverUrl(id, `封面候选/${item.image}`, item.modifiedAt)} alt={`封面-${item.no}`} />
            <div className="jc-cover-zoom-bar">
               <b>封面-{item.no}</b>
               {item.check && <SemBadge tone={checkTone(item.check) === 'ok' ? 'ok' : checkTone(item.check) === 'warn' ? 'warn' : 'gray'}>{item.check}</SemBadge>}
               <span className="flex-1" />
               {items.length > 1 && (
                  <>
                     <button type="button" className="jc-cover-nav" aria-label="上一张" onClick={() => go(-1)}>
                        <ChevronLeft size={18} />
                     </button>
                     <span className="tabular-nums text-[12px]" style={{ color: 'var(--jc-muted)' }}>
                        {index + 1}/{items.length}
                     </span>
                     <button type="button" className="jc-cover-nav" aria-label="下一张" onClick={() => go(1)}>
                        <ChevronRight size={18} />
                     </button>
                  </>
               )}
               <SecondaryButton size="small" onClick={() => onNote(item.no)}>
                  <MessageSquarePlus size={14} /> 写备注
               </SecondaryButton>
               {!item.selected && (
                  <PrimaryButton size="small" busy={busy === `select:${item.no}`} onClick={() => onPick(item.no)}>
                     就用这张
                  </PrimaryButton>
               )}
               <button type="button" className="jc-cover-nav" aria-label="关闭" onClick={onClose}>
                  <X size={18} />
               </button>
            </div>
         </div>
      </div>
   );
}

function Compare({ id, items, onPick, onClose, busy }: { id: string; items: Shown[]; onPick: (no: string) => void; onClose: () => void; busy: string | null }) {
   useEffect(() => {
      const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
   }, [onClose]);
   return (
      <div className="jc-cover-overlay" role="dialog" aria-modal="true" aria-label="并排对比" onClick={onClose}>
         <div className="jc-cover-compare" onClick={(e) => e.stopPropagation()}>
            <div className="jc-cover-compare-row">
               {items.map((item) => (
                  <figure key={item.no}>
                     {/* eslint-disable-next-line @next/next/no-img-element */}
                     <img src={coverUrl(id, `封面候选/${item.image}`, item.modifiedAt)} alt={`封面-${item.no}`} />
                     <figcaption>
                        <b>封面-{item.no}</b>
                        {item.selected ? (
                           <SemBadge tone="ok">已选定</SemBadge>
                        ) : (
                           <PrimaryButton size="small" busy={busy === `select:${item.no}`} onClick={() => onPick(item.no)}>
                              就用这张
                           </PrimaryButton>
                        )}
                     </figcaption>
                  </figure>
               ))}
            </div>
            <div className="mt-3 text-center">
               <SecondaryButton size="small" onClick={onClose}>
                  关掉对比
               </SecondaryButton>
            </div>
         </div>
      </div>
   );
}

type Mark = { x: number; y: number; text: string };

/** 在图上点位置写备注：点一下加一个编号，下面逐条写要怎么改；复制时把带编号的图存进 封面候选/批注/，话里写清每条 */
function Annotate({ id, item, onClose, onSaved }: { id: string; item: CoverItem; onClose: () => void; onSaved: () => void }) {
   const { info } = useAppInfo();
   const [marks, setMarks] = useState<Mark[]>([]);
   const [overall, setOverall] = useState('');
   const [busy, setBusy] = useState(false);
   const img = useRef<HTMLImageElement>(null);
   const src = coverUrl(id, `封面候选/${item.image}`, item.modifiedAt);
   const ready = marks.some((m) => m.text.trim()) || overall.trim();

   const addMark = (e: React.MouseEvent<HTMLDivElement>) => {
      const box = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - box.left) / box.width;
      const y = (e.clientY - box.top) / box.height;
      setMarks((list) => [...list, { x, y, text: '' }]);
   };

   // 把原图和编号画成一张 PNG（原图尺寸），存进封面候选/批注/
   async function drawPng(): Promise<Blob> {
      const image = img.current;
      if (!image) throw new Error('图还没加载好，稍等再试。');
      if (!image.complete) await new Promise((resolve) => image.addEventListener('load', resolve, { once: true }));
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('浏览器画不了批注图。');
      ctx.drawImage(image, 0, 0);
      const r = Math.max(14, Math.round(canvas.width * 0.028));
      marks.forEach((m, i) => {
         const cx = m.x * canvas.width;
         const cy = m.y * canvas.height;
         ctx.beginPath();
         ctx.arc(cx, cy, r, 0, Math.PI * 2);
         ctx.fillStyle = '#e5484d';
         ctx.fill();
         ctx.lineWidth = Math.max(2, r * 0.18);
         ctx.strokeStyle = '#ffffff';
         ctx.stroke();
         ctx.fillStyle = '#ffffff';
         ctx.font = `bold ${Math.round(r * 1.15)}px -apple-system, "PingFang SC", sans-serif`;
         ctx.textAlign = 'center';
         ctx.textBaseline = 'middle';
         ctx.fillText(String(i + 1), cx, cy + r * 0.05);
      });
      return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('批注图没画出来。'))), 'image/png'));
   }

   // 浏览器只许在点按钮的那一下复制（Safari 尤其严）：先复制话，再画图、存图；图存到话里写的那个位置
   async function submit() {
      const used = marks.filter((m) => m.text.trim());
      const noteName = used.length ? nextNoteName(item.no, item.note) : '';
      const markPath = noteName ? `封面候选/批注/${noteName}` : '';
      // 备注只写有字的那几条，编号照图上的
      const notes = marks.map((m, i) => (m.text.trim() ? `（图上 ${i + 1}）${m.text.trim()}` : '')).filter(Boolean);
      const text = askReviseCover(id, item.no, askInfo(info, 'cover'), { notes, overall: overall.trim(), markPath });
      const copied = copyText(text, '按备注改的话', { next: AFTER_COPY + '改好的新图会出现在这一批里。' });
      setBusy(true);
      try {
         if (noteName) {
            const saved = await saveAnnotation(id, item.no, await drawPng(), noteName);
            if (saved.name !== noteName) toast.warning(`批注图存成了「${saved.name}」，和复制的话里写的不一样；AI 找不到图时会按文字改。`);
         }
         if (await copied) {
            onSaved();
            onClose();
         }
      } catch (err) {
         toast.error(`批注图没存上：${errorText(err)}。复制的话还能用，AI 会按文字备注改。`);
      } finally {
         setBusy(false);
      }
   }

   return (
      <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
         <DialogContent className="max-h-[calc(100vh-2rem)] max-w-[760px] overflow-y-auto rounded-2xl p-5 sm:max-w-[760px]" style={{ background: 'var(--jc-surface)' }}>
            <DialogTitle className="text-[17px] font-bold">写备注：封面-{item.no}</DialogTitle>
            <DialogDescription className="text-[12.5px]" style={{ color: 'var(--jc-muted)' }}>
               在图上点要改的地方，会出现编号；在右边写这处要怎么改。写完点「复制给 AI：按备注改」，粘贴给 AI，它只改你点到的地方，存成新的一张，这张不动。
            </DialogDescription>
            <div className="grid gap-4 min-[721px]:grid-cols-[minmax(0,300px)_1fr]">
               <div className="jc-cover-annotate" onClick={addMark} role="button" aria-label="在图上点要改的地方" tabIndex={0}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img ref={img} src={src} alt={`封面-${item.no}`} draggable={false} />
                  {marks.map((m, i) => (
                     <span key={i} className="jc-cover-mark" style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}>
                        {i + 1}
                     </span>
                  ))}
               </div>
               <div className="flex flex-col gap-2.5">
                  {marks.length === 0 && (
                     <p className="text-[12.5px]" style={{ color: 'var(--jc-muted)' }}>
                        还没点。在左边的图上点一下要改的地方。
                     </p>
                  )}
                  {marks.map((m, i) => (
                     <label key={i} className="flex items-start gap-2 text-[13px]">
                        <span className="jc-cover-mark is-static">{i + 1}</span>
                        <input
                           className="jc-input min-w-0 flex-1"
                           value={m.text}
                           placeholder="这里要怎么改，比如「标题字再大一点」"
                           autoFocus={i === marks.length - 1}
                           onChange={(e) => setMarks((list) => list.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))}
                        />
                        <button type="button" aria-label={`删掉第 ${i + 1} 处`} className="jc-cover-nav" onClick={() => setMarks((list) => list.filter((_, k) => k !== i))}>
                           <X size={15} />
                        </button>
                     </label>
                  ))}
                  <textarea
                     className="jc-input min-h-[72px] text-[13px]"
                     value={overall}
                     placeholder="整体还想怎么改（可以不写）"
                     onChange={(e) => setOverall(e.target.value)}
                  />
                  <div className="mt-1 flex flex-wrap gap-2">
                     <PrimaryButton size="small" busy={busy} disabled={!ready} onClick={() => void submit()}>
                        <Copy size={14} /> 复制给 AI：按备注改
                     </PrimaryButton>
                     <SecondaryButton size="small" disabled={busy} onClick={onClose}>
                        取消
                     </SecondaryButton>
                  </div>
               </div>
            </div>
         </DialogContent>
      </Dialog>
   );
}

function TrashConfirm({ no, busy, onCancel, onConfirm }: { no: string; busy: boolean; onCancel: () => void; onConfirm: (quiet: boolean) => void }) {
   const [quiet, setQuiet] = useState(false);
   return (
      <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
         <DialogContent className="max-w-[420px] rounded-2xl p-5" style={{ background: 'var(--jc-surface)' }}>
            <DialogTitle className="text-[16px] font-bold">把封面-{no} 挪进回收站？</DialogTitle>
            <DialogDescription className="text-[12.5px]" style={{ color: 'var(--jc-muted)' }}>
               不会永久删除：它挪到工作文件夹里的「回收站」，想找回去那里拿。
            </DialogDescription>
            <label className="flex items-center gap-2 text-[12.5px]">
               <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
               这次不再提醒（关掉这个页面之前）
            </label>
            <div className="flex flex-wrap justify-end gap-2">
               <SecondaryButton size="small" disabled={busy} onClick={onCancel}>
                  取消
               </SecondaryButton>
               <PrimaryButton size="small" busy={busy} onClick={() => onConfirm(quiet)}>
                  挪进回收站
               </PrimaryButton>
            </div>
         </DialogContent>
      </Dialog>
   );
}
