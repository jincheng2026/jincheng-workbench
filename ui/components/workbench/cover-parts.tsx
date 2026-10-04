'use client';

// 封面两处页面（选题页面的「封面」、「内容」栏的「封面」页）共用的小部件：放大看图（只看，左右键翻）、挑参考构图的弹窗。
// 原作者 2026-10-04 定：挑一张、改一张都在 Codex 桌面版里做，所以放大看图这里只看，不放「就用这张」「写备注」。
import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { PrimaryButton, SecondaryButton } from '@/components/jc/ui';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { kIds, styleImageUrl, type Style } from '@/lib/covers';

export type ViewItem = { key: string; src: string; title: string; sub?: string | null };

/** 放大看图：Esc 关，左右键翻；点图外面也关 */
export function Lightbox({ items, current, onMove, onClose }: { items: ViewItem[]; current: string; onMove: (key: string) => void; onClose: () => void }) {
   const index = Math.max(0, items.findIndex((item) => item.key === current));
   const item = items[index];
   const go = useCallback((step: number) => onMove(items[(index + step + items.length) % items.length].key), [index, items, onMove]);
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
      <div className="jc-cover-overlay" role="dialog" aria-modal="true" aria-label={item.title} onClick={onClose}>
         <div className="jc-cover-zoom" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.src} alt={item.title} />
            <div className="jc-cover-zoom-bar">
               <b>{item.title}</b>
               {item.sub && (
                  <span className="min-w-0 truncate text-[12px]" style={{ color: 'var(--jc-muted)' }}>
                     {item.sub}
                  </span>
               )}
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
               <button type="button" className="jc-cover-nav" aria-label="关闭" onClick={onClose}>
                  <X size={18} />
               </button>
            </div>
         </div>
      </div>
   );
}

/**
 * 挑参考构图：把这个风格的原图（K01、K02……）都摆出来，点一下选上、再点取消。
 * 选题页面里是「这一批用哪几张」（onUse），还能顺手存成这个风格的默认构图（onSaveDefault）；「封面」页里只改默认构图。
 */
export function CompositionPicker({
   style,
   value,
   onClose,
   onUse,
   onSaveDefault,
   busy = false,
}: {
   style: Style;
   value: string[];
   onClose: () => void;
   onUse?: (ids: string[]) => void;
   onSaveDefault?: (ids: string[]) => void;
   busy?: boolean;
}) {
   const all = kIds(style.images);
   const [picked, setPicked] = useState<string[]>(() => value.filter((id) => all.includes(id)));
   const fileOf = (id: string) => style.images.find((name) => name.replace(/\.[^.]+$/, '').toUpperCase() === id) ?? null;
   const toggle = (id: string) => setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
   return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
         <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl p-5 sm:max-w-[760px] min-[721px]:p-6" style={{ background: 'var(--jc-surface)' }}>
            <DialogTitle className="text-[17px] font-bold">{onUse ? '这一批参考哪几张构图' : '默认参考哪几张构图'}</DialogTitle>
            <DialogDescription className="text-[12.5px]" style={{ color: 'var(--jc-muted)' }}>
               点一下选上，再点一下取消。每张封面照其中一张图的构图做；要出的封面比选的构图多，同一张构图会出几种不一样的。
            </DialogDescription>
            {all.length === 0 ? (
               <p className="text-[13px]" style={{ color: 'var(--jc-muted)' }}>
                  这个风格还没拆，没有能挑的原图。
               </p>
            ) : (
               <div className="jc-comp-grid" role="group" aria-label="原图">
                  {all.map((id) => {
                     const file = fileOf(id);
                     const on = picked.includes(id);
                     return (
                        <button key={id} type="button" className="jc-comp-item" aria-pressed={on} onClick={() => toggle(id)} title={id}>
                           {/* eslint-disable-next-line @next/next/no-img-element */}
                           {file && <img src={styleImageUrl(style.id, file)} alt={id} loading="lazy" />}
                           <span className="jc-comp-label">
                              {id}
                              {on && <b className="tabular-nums">第 {picked.indexOf(id) + 1} 张</b>}
                           </span>
                        </button>
                     );
                  })}
               </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2">
               <span className="text-[12.5px]" style={{ color: 'var(--jc-muted)' }}>
                  选了 <b className="tabular-nums" style={{ color: 'var(--jc-ink)' }}>{picked.length}</b> 张
               </span>
               <span className="flex-1" />
               {onUse && onSaveDefault && (
                  <SecondaryButton size="small" busy={busy} disabled={!picked.length} onClick={() => onSaveDefault(picked)}>
                     也存成这个风格的默认参考构图
                  </SecondaryButton>
               )}
               {onUse ? (
                  <PrimaryButton size="small" disabled={!picked.length} onClick={() => onUse(picked)}>
                     这一批就用这几张
                  </PrimaryButton>
               ) : (
                  onSaveDefault && (
                     <PrimaryButton size="small" busy={busy} disabled={!picked.length} onClick={() => onSaveDefault(picked)}>
                        存成默认参考构图
                     </PrimaryButton>
                  )
               )}
            </div>
         </DialogContent>
      </Dialog>
   );
}
