'use client';

// 选题页面的「封面」（1.1 加）：上面是出一批的设置（人物参考图片、风格、参考构图、封面上的字、尺寸、出几张），设好点「在 Codex 里出一批封面」；
// 下面是这条选题出过的封面，只看（选定的排第一，点开放大）。
// 原作者 2026-10-04 定：挑一张、改一张都在 Codex 桌面版里做（点开图切到 Canvas，用 Comment 标出要改的地方；定了跟它说「就用 03」），
// 工作台这里不再有写备注、并排对比、收藏、「就用这张」、删除。AI 出图时一张一张存进封面候选：页面每 5 秒问一次，出一张亮一张。
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Copy, FolderOpen, ImagePlus } from 'lucide-react';
import { toast } from 'sonner';
import { useAppInfo } from '@/components/jc/app-info';
import { OpenInAi } from '@/components/jc/open-in-ai';
import { Card, SecondaryButton, SemBadge, copyText } from '@/components/jc/ui';
import { CompositionPicker, Lightbox, type ViewItem } from '@/components/workbench/cover-parts';
import { errorText } from '@/lib/api';
import { askInfo } from '@/lib/app-info';
import { askMakeCovers } from '@/lib/ask-ai';
import {
   checkTone,
   coverUrl,
   defaultCompositions,
   fetchCoverInfo,
   fetchTopicCovers,
   kIds,
   openCoverFolder,
   photoUrl,
   saveCompositions,
   styleImageUrl,
   styleName,
   styleSource,
   type CoverInfo,
   type CoverItem,
   type CoverSize,
   type TopicCovers,
} from '@/lib/covers';

const POLL_MS = 5000;
const COUNTS = [3, 5, 10];
const SIZES: CoverSize[] = ['竖版 3:4', '横版 2.35:1', '方形 1:1'];
const SIZE_HINT: Record<CoverSize, string> = { '竖版 3:4': '适合视频封面、小红书图文', '横版 2.35:1': '适合公众号头图', '方形 1:1': '适合公众号次图、朋友圈' };

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
      // AI 出图时一张一张存进来：页面开着就隔一会儿问一次；切回窗口时连照片、风格一起重读
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
   return { covers, info, setInfo, error, reload: load };
}

function Segmented<T extends string | number>({ label, options, value, onChange, hint }: { label: string; options: T[]; value: T; onChange: (v: T) => void; hint?: (v: T) => string }) {
   return (
      <div className="jc-cover-counts" role="radiogroup" aria-label={label}>
         {options.map((option) => (
            <button key={String(option)} type="button" role="radio" aria-checked={value === option} title={hint?.(option)} onClick={() => onChange(option)}>
               {option}
            </button>
         ))}
      </div>
   );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
   return (
      <div className="jc-make-row">
         <span className="jc-make-label">{label}</span>
         <div className="min-w-0">{children}</div>
      </div>
   );
}

export function CoverBlock({ id }: { id: string }) {
   const { info: app } = useAppInfo();
   const { covers, info, setInfo, error, reload } = useCovers(id);
   const [styleId, setStyleId] = useState<string | null>(null);
   const [comps, setComps] = useState<string[] | null>(null);
   const [text, setText] = useState<string | null>(null);
   const [size, setSize] = useState<CoverSize | null>(null);
   const [count, setCount] = useState<number | null>(null);
   const [zoom, setZoom] = useState<string | null>(null);
   const [picking, setPicking] = useState(false);
   const [busy, setBusy] = useState<string | null>(null);

   const ready = (info?.styles ?? []).filter((s) => s.done);
   // 风格：用户在这里选的 → 这条内容上一批用的（还在、拆好了的）→ 设好的默认风格 → 第一个拆好的
   const lastStyle = [...(covers?.batches ?? [])].sort((a, b) => (b.no ?? 0) - (a.no ?? 0)).find((b) => b.style && ready.some((s) => s.id === b.style))?.style;
   const style =
      ready.find((s) => s.id === styleId) ?? ready.find((s) => s.id === lastStyle) ?? ready.find((s) => s.id === covers?.settings.benchmark) ?? ready[0] ?? null;
   const chosenComps = comps ?? defaultCompositions(style);
   const batchSize = count ?? covers?.settings.batchSize ?? 5;
   const sizeNow = size ?? covers?.defaults.size ?? '竖版 3:4';
   const textNow = text ?? covers?.defaults.text ?? '';

   const shown = useMemo(() => {
      const list = (covers?.batches ?? []).flatMap((b) => b.items.map((item) => ({ ...item, batch: b })));
      return list;
   }, [covers]);
   const withImage = shown.filter((item) => item.image);
   const views: ViewItem[] = useMemo(
      () =>
         [...withImage]
            .sort((a, b) => Number(b.selected) - Number(a.selected))
            .map((item) => ({ key: item.no, src: coverUrl(id, `封面候选/${item.image}`, item.modifiedAt), title: `封面-${item.no}${item.selected ? '（选定）' : ''}`, sub: item.change })),
      [withImage, id]
   );

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

   const photos = info?.photos ?? [];
   const total = withImage.length;
   const again = shown.length > 0;
   const makeText = askMakeCovers(id, askInfo(app, 'cover'), {
      count: batchSize,
      size: sizeNow,
      style: style ? { id: style.id, kind: style.kind, name: style.name } : null,
      compositions: style ? chosenComps : [],
      text: textNow,
   });
   const selectedItem = covers.selected?.from ? shown.find((item) => item.no === covers.selected?.from) ?? null : null;
   // 批次新的在前；选定的那张单独放最前面
   const batches = [...covers.batches].sort((a, b) => (b.no ?? 9999) - (a.no ?? 9999));

   const saveDefault = async (ids: string[]) => {
      if (!style) return;
      setBusy('default');
      try {
         const result = await saveCompositions(style.id, ids);
         toast.success(result.message);
         setInfo((old) => (old ? { ...old, styles: old.styles.map((s) => (s.id === style.id ? { ...s, compositions: result.compositions } : s)) } : old));
         setComps(ids);
         setPicking(false);
      } catch (err) {
         toast.error(errorText(err));
      } finally {
         setBusy(null);
      }
   };
   const openFolder = async () => {
      setBusy('open');
      try {
         toast.success((await openCoverFolder(id)).message);
      } catch (err) {
         toast.error(errorText(err));
      } finally {
         setBusy(null);
      }
   };

   return (
      <section id="covers" className="mt-8" data-tour="covers">
         <div className="jc-section-heading">
            <h2>
               封面
               {total > 0 && <span className="jc-section-count">{total}</span>}
            </h2>
            <span className="text-[12px]" style={{ color: 'var(--jc-ghost)' }}>
               {covers.selected ? (covers.selected.from ? `选定了封面-${covers.selected.from}` : '已经选定了一张封面') : total ? '还没选定用哪张' : ''}
            </span>
         </div>
         <Card className="overflow-hidden">
            {/* 出一批的设置 */}
            <div className="border-b px-4 py-4" style={{ borderColor: 'var(--jc-border)' }} data-cover-make>
               <p className="mb-3 text-[13.5px] font-semibold" style={{ color: 'var(--jc-accent)' }}>
                  {again ? `再出一批封面（第 ${covers.next.batch} 批）` : '出一批封面'}
               </p>
               <div className="jc-make-grid">
                  <Row label="人物">
                     {photos.length ? (
                        <span className="inline-flex flex-wrap items-center gap-2 text-[12.5px]">
                           <span className="inline-flex -space-x-2">
                              {photos.slice(0, 3).map((p) =>
                                 p.shown ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img key={p.name} src={photoUrl(p.name)} alt={p.name} className="h-8 w-8 rounded-full object-cover" style={{ border: '2px solid var(--jc-surface)' }} />
                                 ) : null
                              )}
                           </span>
                           <span>{photos.length} 张做封面的人物参考图片</span>
                           <Link href="/content?tab=covers#my-photos" className="text-[12px] font-medium">
                              换人物参考图片
                           </Link>
                        </span>
                     ) : (
                        <span className="text-[12.5px]" style={{ color: 'var(--jc-warn)' }}>
                           <ImagePlus size={14} className="mr-1 inline align-[-2px]" />
                           还没有做封面的人物参考图片，AI 要照着它把封面上的人换成你。
                           <Link href="/content?tab=covers#my-photos" className="ml-1 font-medium">
                              放人物参考图片
                           </Link>
                        </span>
                     )}
                  </Row>
                  <Row label="风格">
                     {ready.length ? (
                        <span className="flex flex-wrap items-center gap-2 text-[12.5px]">
                           <select
                              aria-label="照哪个风格出封面"
                              className="jc-input h-8 max-w-[260px] px-2 text-[13px]"
                              value={style?.id ?? ''}
                              onChange={(e) => {
                                 setStyleId(e.target.value);
                                 setComps(null);
                              }}
                           >
                              {ready.map((s) => (
                                 <option key={s.id} value={s.id}>
                                    {styleName(s)}
                                    {s.isDefault ? '（默认）' : ''}
                                 </option>
                              ))}
                           </select>
                           {style && <span style={{ color: 'var(--jc-muted)' }}>{styleSource(style)}</span>}
                        </span>
                     ) : (
                        <span className="text-[12.5px]" style={{ color: 'var(--jc-warn)' }}>
                           还没有拆好的风格，出封面要照着一个风格做。
                           <Link href="/content?tab=covers" className="ml-1 font-medium">
                              拆一个风格
                           </Link>
                        </span>
                     )}
                  </Row>
                  {style && (
                     <Row label="参考构图">
                        <span className="flex flex-wrap items-center gap-1.5">
                           {chosenComps.slice(0, 10).map((k) => {
                              const file = style.images.find((name) => name.replace(/\.[^.]+$/, '').toUpperCase() === k);
                              return file ? (
                                 // eslint-disable-next-line @next/next/no-img-element
                                 <img key={k} src={styleImageUrl(style.id, file)} alt={k} title={k} className="jc-comp-thumb" />
                              ) : null;
                           })}
                           <span className="text-[12px]" style={{ color: 'var(--jc-muted)' }}>
                              {comps ? `这一批挑的 ${chosenComps.length} 张` : style.compositions?.by === '你' ? `你定的默认 ${chosenComps.length} 张` : `默认的 ${chosenComps.length} 张`}
                           </span>
                           {kIds(style.images).length > 0 && (
                              <button type="button" className="text-[12px] font-medium" style={{ color: 'var(--jc-accent)' }} onClick={() => setPicking(true)}>
                                 换参考构图
                              </button>
                           )}
                        </span>
                     </Row>
                  )}
                  <Row label="封面上的字">
                     <span className="flex flex-wrap items-center gap-2">
                        <input
                           aria-label="封面上的字"
                           className="jc-input h-8 w-full max-w-[360px] px-2.5 text-[13px]"
                           value={textNow}
                           placeholder="不填就用创作页里定好的封面文字，没定就用选题名"
                           onChange={(e) => setText(e.target.value)}
                        />
                        <span className="text-[11.5px]" style={{ color: 'var(--jc-ghost)' }}>
                           {text !== null && text !== (covers.defaults.text ?? '')
                              ? '这一批用你刚写的'
                              : covers.defaults.text
                                ? `用的是创作页里${covers.defaults.textFrom ?? '定好的'}`
                                : '创作页里还没定'}
                        </span>
                     </span>
                  </Row>
                  <Row label="尺寸">
                     <span className="flex flex-wrap items-center gap-2">
                        <Segmented label="尺寸" options={SIZES} value={sizeNow} onChange={setSize} hint={(v) => SIZE_HINT[v]} />
                        <span className="text-[11.5px]" style={{ color: 'var(--jc-ghost)' }}>
                           {SIZE_HINT[sizeNow]}
                        </span>
                     </span>
                  </Row>
                  <Row label="出几张">
                     <Segmented label="这一批出几张" options={COUNTS} value={batchSize} onChange={setCount} />
                  </Row>
               </div>
               <div className="mt-3.5">
                  <OpenInAi text={makeText} action={again ? '再出一批封面' : '出一批封面'} what="出一批封面的话" size="regular" />
               </div>
               {/* 页面上只留一句；怎么挑、怎么改的几步点开才看（学 WorkBuddy：长的说明收起来，原作者 10-05 嫌字太长） */}
               <details className="jc-how mt-2.5 text-[12px] leading-relaxed" style={{ color: 'var(--jc-muted)' }}>
                  <summary>
                     挑哪张、改哪张都在 Codex 里做。
                     <span className="jc-how-toggle">
                        <span className="jc-how-more">看怎么做</span>
                        <span className="jc-how-less">收起</span>
                     </span>
                  </summary>
                  <ol>
                     <li>点开一张图，切到「Canvas」，能看到这一批的全部封面。</li>
                     <li>想改哪张，用「Comment」在那张图上标出要改的地方，写清怎么改，发给 Codex。</li>
                     <li>定下用哪张，跟 Codex 说「就用 03」。</li>
                  </ol>
                  <p>用 Claude Code 的话，它不能生图，只写好每张封面的生图提示词。</p>
               </details>
            </div>

            {/* 这条选题出过的封面：只看 */}
            <div className="px-4 py-3.5">
               <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <h3 className="text-[13.5px] font-semibold">这条选题的封面</h3>
                  <span className="text-[11.5px]" style={{ color: 'var(--jc-ghost)' }}>
                     这里只能看
                  </span>
                  <span className="flex-1" />
                  {covers.folder && (
                     <SecondaryButton size="small" busy={busy === 'open'} onClick={() => void openFolder()}>
                        <FolderOpen size={14} /> 在访达中打开封面候选文件夹
                     </SecondaryButton>
                  )}
               </div>
               {shown.length === 0 ? (
                  <p className="text-[12.5px]" style={{ color: 'var(--jc-muted)' }}>
                     还没有封面。设好上面几项交给 AI，出好的封面会一张张出现在这里。
                  </p>
               ) : (
                  <>
                     {covers.selected && selectedItem?.image && (
                        <div className="jc-cover-chosen" data-cover-selected={selectedItem.no}>
                           <button type="button" className="jc-cover-img" onClick={() => setZoom(selectedItem.no)} aria-label={`放大看选定的封面-${selectedItem.no}`}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={coverUrl(id, covers.selected.name, covers.selected.modifiedAt)} alt="选定的封面" />
                           </button>
                           <div className="text-[12.5px] leading-relaxed">
                              <SemBadge tone="ok">选定</SemBadge>
                              <p className="mt-1">
                                 选定的是封面-{selectedItem.no}，已经存成草稿文件夹里的「{covers.selected.name}」，发布时用这张。
                              </p>
                              <p style={{ color: 'var(--jc-muted)' }}>想换一张，在 Codex 里说「就用 05」这样的话就行。</p>
                           </div>
                        </div>
                     )}
                     {batches.map((batch) => (
                        <div key={batch.no ?? 'loose'} className="mt-3 first:mt-0">
                           <p className="mb-2 text-[12px]" style={{ color: 'var(--jc-muted)' }}>
                              <b style={{ color: 'var(--jc-ink)' }}>{batch.no ? `第 ${batch.no} 批` : '没登记批次的封面'}</b>
                              {batch.no ? [batch.styleName, batch.size].filter(Boolean).map((x) => ` · ${x}`).join('') : ' · AI 还在登记，或者是你自己放进来的'}
                           </p>
                           <div className="jc-cover-grid">
                              {batch.items.map((item) => (
                                 <CoverCard key={item.no} id={id} item={item} size={batch.size} onZoom={() => setZoom(item.no)} />
                              ))}
                           </div>
                        </div>
                     ))}
                  </>
               )}
            </div>
         </Card>

         {zoom && views.some((v) => v.key === zoom) && <Lightbox items={views} current={zoom} onMove={setZoom} onClose={() => setZoom(null)} />}
         {picking && style && (
            <CompositionPicker
               style={style}
               value={chosenComps}
               busy={busy === 'default'}
               onClose={() => setPicking(false)}
               onUse={(ids) => {
                  setComps(ids);
                  setPicking(false);
               }}
               onSaveDefault={(ids) => void saveDefault(ids)}
            />
         )}
      </section>
   );
}

function CoverCard({ id, item, size, onZoom }: { id: string; item: CoverItem; size: string | null; onZoom: () => void }) {
   const tone = checkTone(item.check);
   if (!item.image) {
      return (
         <div className="jc-cover-card is-prompt" data-cover={item.no} data-size={size ?? undefined}>
            <div className="jc-cover-prompt">
               <b>封面-{item.no}</b>
               <span>只写好了生图提示词，还没出图</span>
               {item.promptText && (
                  <SecondaryButton
                     size="small"
                     onClick={() =>
                        void copyText(item.promptText ?? '', `封面-${item.no} 的生图提示词`, {
                           next: `把提示词粘贴到能生图的工具里，出好的图存成「封面-${item.no}.png」，放进封面候选文件夹，就会出现在这里。`,
                        })
                     }
                  >
                     <Copy size={13} /> 复制生图提示词
                  </SecondaryButton>
               )}
            </div>
            {item.change && <p className="jc-cover-change">{item.change}</p>}
         </div>
      );
   }
   return (
      <div className="jc-cover-card" data-cover={item.no} data-size={size ?? undefined} data-selected={item.selected || undefined}>
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
      </div>
   );
}
