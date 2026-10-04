'use client';

// 提示词页。它解决的是「我记得有一条，但想不起来叫什么」：
// - 卡片大字是名字，下面小字是「什么时候用」的处境话，搜索先匹配这两样；
// - 位置固定，以拖动为准（写回目录 _排序.md），不按用量重排，用量只做信号；
// - 键盘：打开即可输入，↑↓ 移动，回车复制或打开，Esc 逐级清空（含只看收藏）；
// - 用量给两个出口：30 天用得多提示做成 Skill，长期没碰提示沉睡可删；
// - 星标是纯人工判断「这条好」，跟用量无关：点星标收藏，工具栏「只看收藏」筛选。
// 提示词文件夹里的 md 文件说了算，页面不新增、不改正文；写操作只有记使用、记收藏、存顺序、删除（挪进回收站）。
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Copy, Flame, FolderOpen, GripVertical, Moon, Search, Sparkles, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTildify } from '@/components/jc/app-info';
import { PlaceButton } from '@/components/jc/place-button';
import { TourHint } from '@/components/jc/tour';
import { CopyPath, DangerButton, EmptyState, PageHeader, PrimaryButton, SecondaryButton, SemBanner, Spinner, fmtDate } from '@/components/jc/ui';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ApiError, errorText, postJson, request } from '@/lib/api';

type Variable = { name: string; hint: string };
type Prompt = {
   id: string;
   title: string;
   when: string;
   category: string;
   summary: string;
   tags: string[];
   source: string;
   file: string;
   body: string;
   variables: Variable[];
   useCount: number;
   useCount30: number;
   lastUsedAt: string | null;
   addedAt: string;
   starred: boolean;
};
type Library = {
   dir: string;
   eventsFile: string;
   categoryOrderFile: string;
   manualOrderFile: string;
   formatFile: string;
   manualOrdered: number;
   prompts: Prompt[];
   categories: { name: string; note: string; count: number }[];
   totalPrompts: number;
   totalCopies: number;
   totalStarred: number;
   issues: string[];
};
type Menu = { id: string; x: number; y: number };

const VARIABLE_RE = /\{\{\s*([^{}|\n]+?)\s*(?:\|([^{}\n]*))?\}\}/g;
const SKILL_THRESHOLD = 5; // 30 天内用到这个次数，提示可做成 Skill
const DORMANT_DAYS = 60;

function fill(body: string, values: Record<string, string>) {
   return body.replace(VARIABLE_RE, (whole, name: string) => {
      const value = values[name.trim()];
      return value ? value : whole;
   });
}

function daysSince(iso: string | null | undefined, now: number) {
   if (!iso) return Infinity;
   const t = new Date(iso).valueOf();
   return Number.isNaN(t) ? Infinity : (now - t) / 86400000;
}

function signal(prompt: Prompt, now: number): { kind: 'skill' | 'dormant' | null; text: string } {
   if (prompt.useCount30 >= SKILL_THRESHOLD) return { kind: 'skill', text: `30 天用了 ${prompt.useCount30} 次，可考虑做成 Skill` };
   if (daysSince(prompt.lastUsedAt, now) > DORMANT_DAYS && daysSince(prompt.addedAt, now) > DORMANT_DAYS) {
      return { kind: 'dormant', text: `超过 ${DORMANT_DAYS} 天没用，沉睡中，可考虑删除` };
   }
   return { kind: null, text: '' };
}

function usageMeta(prompt: Prompt) {
   if (!prompt.useCount) return '还没用过';
   const recent = prompt.useCount30 ? `30 天 ${prompt.useCount30} 次 · ` : '';
   return `${recent}共 ${prompt.useCount} 次 · ${fmtDate(prompt.lastUsedAt)}`;
}

type LibraryResult = { library?: Library; prompt?: Prompt; ids?: string[]; deleted?: { id: string }[]; trashDir?: string };

/** 复制正文并记一次使用；返回是否复制成功。记录失败只提示，不撤回复制。 */
async function copyAndRecord(prompt: Prompt, text: string, onLibrary: (library: Library) => void) {
   try {
      await navigator.clipboard.writeText(text);
   } catch {
      toast.error('复制失败，请打开后手动选择复制');
      return false;
   }
   try {
      const result = await postJson<LibraryResult>('/api/prompts/use', { id: prompt.id });
      if (result.prompt?.id !== prompt.id || !result.library?.prompts) throw new Error('使用记录尚未回读一致');
      onLibrary(result.library as Library);
      toast.success(`已复制「${prompt.title}」，第 ${result.prompt?.useCount ?? 1} 次使用`);
   } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      toast.warning(`已复制，但这次使用没有记上：${message}`);
   }
   return true;
}

/** 星标 = 收藏；乐观更新，失败时把卡片状态改回来，不假装成功。 */
async function setStar(prompt: Prompt, starred: boolean, onLibrary: (library: Library) => void) {
   try {
      const result = await postJson<LibraryResult>('/api/prompts/star', { id: prompt.id, starred });
      if (result.prompt?.id !== prompt.id || result.prompt?.starred !== starred || !result.library?.prompts) {
         throw new Error('收藏状态尚未回读一致');
      }
      onLibrary(result.library as Library);
   } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      toast.error(`没有${starred ? '收藏' : '取消收藏'}成功：${message}`);
   }
}

function StarButton({ starred, onClick, size = 13 }: { starred: boolean; onClick: (event: React.MouseEvent) => void; size?: number }) {
   return (
      <button
         type="button"
         onClick={onClick}
         title={starred ? '取消收藏' : '收藏'}
         aria-label={starred ? '取消收藏' : '收藏'}
         aria-pressed={starred}
         className="jc-button jc-button-secondary inline-flex h-7 w-7 items-center justify-center rounded-md p-0"
      >
         <Star size={size} fill={starred ? 'currentColor' : 'none'} style={{ color: starred ? 'var(--jc-accent)' : undefined }} />
      </button>
   );
}

function Chip({
   name,
   count,
   active,
   onClick,
   title,
   disabled = false,
}: {
   name: string;
   count?: number;
   active: boolean;
   onClick: () => void;
   title?: string;
   disabled?: boolean;
}) {
   return (
      <button
         type="button"
         title={disabled ? '当前筛选下没有这类条目' : title}
         aria-pressed={active}
         disabled={disabled}
         onClick={onClick}
         className="rounded-full border px-3 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45"
         style={{
            borderColor: active ? 'var(--jc-accent)' : 'var(--jc-border)',
            background: active ? 'var(--jc-accent-bg)' : 'var(--jc-surface)',
            color: active ? 'var(--jc-accent)' : 'var(--jc-body)',
         }}
      >
         {name}
         {count !== undefined && <span className="ml-1" style={{ color: 'var(--jc-ghost)' }}>{count}</span>}
      </button>
   );
}

function PromptDialog({
   prompt,
   onClose,
   onLibrary,
}: {
   prompt: Prompt | null;
   onClose: () => void;
   onLibrary: (library: Library) => void;
}) {
   const [values, setValues] = useState<Record<string, string>>({});
   const [busy, setBusy] = useState(false);
   useEffect(() => setValues({}), [prompt?.id]);
   const filled = useMemo(() => (prompt ? fill(prompt.body, values) : ''), [prompt, values]);
   if (!prompt) return null;
   const missing = prompt.variables.filter((v) => !values[v.name]?.trim()).map((v) => v.name);

   const copy = async () => {
      if (busy) return;
      if (missing.length) {
         toast.warning(`先填好：${missing.join('、')}`);
         return;
      }
      setBusy(true);
      const ok = await copyAndRecord(prompt, filled, onLibrary);
      setBusy(false);
      if (ok) onClose();
   };

   return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
         <DialogContent
            className="jc-card flex max-h-[calc(100dvh-48px)] w-[min(880px,calc(100%-24px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[880px]"
            style={{ background: 'var(--jc-surface)', borderColor: 'var(--jc-border)' }}
            onKeyDown={(event) => {
               if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void copy();
               }
            }}
         >
            <div className="border-b px-6 pt-5 pb-4" style={{ borderColor: 'var(--jc-border)' }}>
               <div className="flex flex-wrap items-center gap-2 pr-8">
                  <DialogTitle className="text-[17px] font-bold">{prompt.title}</DialogTitle>
                  <span
                     className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                     style={{ background: 'var(--jc-accent-bg)', color: 'var(--jc-accent)' }}
                  >
                     {prompt.category}
                  </span>
                  {prompt.tags.map((tag) => (
                     <span key={tag} className="text-[11px]" style={{ color: 'var(--jc-ghost)' }}>#{tag}</span>
                  ))}
                  <span className="ml-auto">
                     <StarButton starred={prompt.starred} onClick={() => void setStar(prompt, !prompt.starred, onLibrary)} size={15} />
                  </span>
               </div>
               <DialogDescription className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--jc-muted)' }}>
                  {prompt.when && <span style={{ color: 'var(--jc-ink)' }}>{prompt.when}。</span>}
                  {prompt.summary || usageMeta(prompt)}
               </DialogDescription>
            </div>
            <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-6 py-4">
               {prompt.variables.length > 0 && (
                  <div className="grid gap-3 min-[721px]:grid-cols-2">
                     {prompt.variables.map((variable, index) => (
                        <label key={variable.name} className="grid gap-1 text-[12px] font-medium">
                           <span>{variable.name}</span>
                           <textarea
                              autoFocus={index === 0}
                              className="jc-input min-h-[38px] resize-y px-3 py-2 text-[13px] font-normal"
                              rows={1}
                              placeholder={variable.hint || `填写${variable.name}`}
                              value={values[variable.name] ?? ''}
                              onChange={(event) => setValues((prev) => ({ ...prev, [variable.name]: event.target.value }))}
                           />
                        </label>
                     ))}
                  </div>
               )}
               <pre
                  className="whitespace-pre-wrap rounded-xl border p-4 text-[12.5px] leading-relaxed"
                  style={{ borderColor: 'var(--jc-border)', background: 'var(--jc-soft)', fontFamily: 'inherit' }}
               >
                  {filled}
               </pre>
            </div>
            <div
               className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3"
               style={{ borderColor: 'var(--jc-border)', background: 'var(--jc-soft)' }}
            >
               <div className="grid min-w-0 gap-0.5 text-[11px]" style={{ color: 'var(--jc-ghost)' }}>
                  <span>{usageMeta(prompt)}{prompt.source && ` · 来源：${prompt.source}`}</span>
                  <CopyPath path={prompt.file} />
               </div>
               <div className="flex items-center gap-2">
                  <SecondaryButton size="small" onClick={onClose}>关闭</SecondaryButton>
                  <PrimaryButton size="small" busy={busy} onClick={() => void copy()} title="⌘ + 回车">
                     <Copy size={14} />
                     {prompt.variables.length ? '填好后复制' : '复制'}
                  </PrimaryButton>
               </div>
            </div>
         </DialogContent>
      </Dialog>
   );
}

function DeleteDialog({
   prompts,
   onClose,
   onDeleted,
}: {
   prompts: Prompt[];
   onClose: () => void;
   onDeleted: (library: Library) => void;
}) {
   const [busy, setBusy] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const tildify = useTildify();
   if (!prompts.length) return null;
   const run = async () => {
      setBusy(true);
      setError(null);
      try {
         const result = await postJson<LibraryResult>('/api/prompts/delete', { ids: prompts.map((p) => p.id) });
         if (!result.library?.prompts || result.deleted?.length !== prompts.length) throw new Error('删除以后读回来对不上');
         onDeleted(result.library as Library);
         toast.success(`已挪进回收站 ${result.deleted.length} 条：${tildify(result.trashDir ?? '')}`);
         onClose();
      } catch (cause) {
         setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
         setBusy(false);
      }
   };
   return (
      <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
         <DialogContent
            className="jc-card flex max-h-[calc(100dvh-48px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[520px]"
            style={{ background: 'var(--jc-surface)', borderColor: 'var(--jc-border)' }}
         >
            <div className="border-b px-6 pt-5 pb-4" style={{ borderColor: 'var(--jc-border)' }}>
               <DialogTitle className="text-[16px] font-bold">删除 {prompts.length} 条提示词？</DialogTitle>
               <DialogDescription className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--jc-muted)' }}>
                  文件会挪到工作文件夹的「回收站」，文件名前面加上日期和分类，不会永久删除；页面上不再显示。
               </DialogDescription>
            </div>
            <ul className="grid min-h-0 flex-1 gap-1.5 overflow-y-auto px-6 py-4 text-[13px]">
               {prompts.map((p) => (
                  <li key={p.id} className="flex items-baseline gap-2">
                     <span className="shrink-0 text-[11px]" style={{ color: 'var(--jc-ghost)' }}>{p.category}</span>
                     <span className="font-medium">{p.title}</span>
                  </li>
               ))}
            </ul>
            {error && <div className="px-6 pb-3"><SemBanner tone="err">{error}</SemBanner></div>}
            <div className="flex items-center justify-end gap-2 border-t px-6 py-3" style={{ borderColor: 'var(--jc-border)', background: 'var(--jc-soft)' }}>
               <SecondaryButton size="small" onClick={onClose} disabled={busy}>取消</SecondaryButton>
               <DangerButton size="small" busy={busy} onClick={() => void run()}>
                  <Trash2 size={14} /> 挪进回收站
               </DangerButton>
            </div>
         </DialogContent>
      </Dialog>
   );
}

function PromptTile({
   prompt,
   now,
   selected,
   selecting,
   highlighted,
   draggable,
   dragging,
   dropBefore,
   onOpen,
   onToggle,
   onMenu,
   onLibrary,
   onDragStart,
   onDragOver,
   onDrop,
   onDragEnd,
}: {
   prompt: Prompt;
   now: number;
   selected: boolean;
   selecting: boolean;
   highlighted: boolean;
   draggable: boolean;
   dragging: boolean;
   dropBefore: boolean;
   onOpen: () => void;
   onToggle: () => void;
   onMenu: (x: number, y: number) => void;
   onLibrary: (library: Library) => void;
   onDragStart: () => void;
   onDragOver: (event: React.DragEvent) => void;
   onDrop: () => void;
   onDragEnd: () => void;
}) {
   const [busy, setBusy] = useState(false);
   const ref = useRef<HTMLDivElement>(null);
   useEffect(() => {
      if (highlighted) ref.current?.scrollIntoView({ block: 'nearest' });
   }, [highlighted]);
   const quickCopy = async (event: React.MouseEvent) => {
      event.stopPropagation();
      if (prompt.variables.length) {
         onOpen();
         return;
      }
      setBusy(true);
      await copyAndRecord(prompt, prompt.body, onLibrary);
      setBusy(false);
   };
   const activate = (event: React.MouseEvent | React.KeyboardEvent) => {
      if (selecting || event.metaKey || event.ctrlKey) onToggle();
      else onOpen();
   };
   const sig = signal(prompt, now);
   const showCheck = selecting || selected;
   return (
      <div
         ref={ref}
         role="button"
         tabIndex={-1}
         aria-pressed={selected}
         draggable={draggable}
         onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', prompt.id);
            onDragStart();
         }}
         onDragOver={onDragOver}
         onDrop={(event) => {
            event.preventDefault();
            onDrop();
         }}
         onDragEnd={onDragEnd}
         onClick={activate}
         onContextMenu={(event) => {
            event.preventDefault();
            onMenu(event.clientX, event.clientY);
         }}
         className="jc-card jc-content-card relative flex min-h-[112px] cursor-pointer flex-col p-3.5 text-left outline-none transition-opacity"
         style={{
            opacity: dragging ? 0.4 : 1,
            borderColor: selected || highlighted ? 'var(--jc-accent)' : undefined,
            boxShadow: selected ? '0 0 0 2px var(--jc-accent-bg)' : highlighted ? '0 0 0 3px var(--jc-accent-bg)' : undefined,
            outline: dropBefore ? '2px dashed var(--jc-accent)' : undefined,
            outlineOffset: dropBefore ? '2px' : undefined,
         }}
         aria-label={`${selected ? '已选中 ' : ''}${prompt.title}`}
      >
         {showCheck && (
            <span
               className="absolute top-3 left-3 flex h-5 w-5 items-center justify-center rounded-full border"
               style={{
                  borderColor: selected ? 'var(--jc-accent)' : 'var(--jc-border)',
                  background: selected ? 'var(--jc-accent)' : 'var(--jc-surface)',
                  color: '#fff',
               }}
               aria-hidden="true"
            >
               {selected && <Check size={12} strokeWidth={3} />}
            </span>
         )}
         <div className={`flex items-start justify-between gap-2 ${showCheck ? 'pl-7' : ''}`}>
            <h2 className="line-clamp-2 min-w-0 pt-1 text-[14px] leading-snug font-bold">{prompt.title}</h2>
            <div className="flex shrink-0 items-center gap-1">
               {draggable && (
                  <span className="cursor-grab" style={{ color: 'var(--jc-ghost)' }} title="拖动调整位置" aria-hidden="true">
                     <GripVertical size={14} />
                  </span>
               )}
               <StarButton
                  starred={prompt.starred}
                  onClick={(event) => {
                     event.stopPropagation();
                     void setStar(prompt, !prompt.starred, onLibrary);
                  }}
               />
               <button
                  type="button"
                  onClick={(event) => void quickCopy(event)}
                  disabled={busy}
                  title={prompt.variables.length ? `要先填 ${prompt.variables.length} 项，点开填写` : '直接复制'}
                  aria-label={prompt.variables.length ? '填变量并复制' : '复制'}
                  className="jc-button jc-button-secondary inline-flex h-7 w-7 items-center justify-center rounded-md p-0 disabled:opacity-60"
               >
                  {busy ? <Spinner size={12} /> : <Copy size={13} />}
               </button>
            </div>
         </div>
         <p className={`mt-1 line-clamp-3 text-[12px] leading-snug ${showCheck ? 'pl-7' : ''}`} style={{ color: 'var(--jc-muted)' }}>
            {prompt.when || prompt.summary}
         </p>
         <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-2.5 text-[11px]" style={{ color: 'var(--jc-ghost)' }}>
            <span className="rounded-full px-2 py-0.5 font-medium" style={{ background: 'var(--jc-accent-bg)', color: 'var(--jc-accent)' }}>
               {prompt.category}
            </span>
            <span>{usageMeta(prompt)}</span>
            {prompt.variables.length > 0 && <span>· 填 {prompt.variables.length} 项</span>}
            {sig.kind === 'skill' && (
               <span className="ml-auto inline-flex items-center gap-1 font-medium" style={{ color: 'var(--jc-accent)' }} title={sig.text}>
                  <Sparkles size={12} /> 可做成 Skill
               </span>
            )}
            {sig.kind === 'dormant' && (
               <span className="ml-auto inline-flex items-center gap-1" style={{ color: 'var(--jc-warn)' }} title={sig.text}>
                  <Moon size={12} /> 沉睡
               </span>
            )}
         </div>
      </div>
   );
}

function ContextMenu({
   menu,
   prompt,
   selected,
   selectedCount,
   shownCount,
   onClose,
   onToggle,
   onSelectAll,
   onClear,
   onDeleteOne,
   onDeleteSelected,
}: {
   menu: Menu;
   prompt: Prompt;
   selected: boolean;
   selectedCount: number;
   shownCount: number;
   onClose: () => void;
   onToggle: () => void;
   onSelectAll: () => void;
   onClear: () => void;
   onDeleteOne: () => void;
   onDeleteSelected: () => void;
}) {
   useEffect(() => {
      const close = () => onClose();
      const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
      window.addEventListener('click', close);
      window.addEventListener('scroll', close, true);
      window.addEventListener('resize', close);
      window.addEventListener('keydown', onKey);
      return () => {
         window.removeEventListener('click', close);
         window.removeEventListener('scroll', close, true);
         window.removeEventListener('resize', close);
         window.removeEventListener('keydown', onKey);
      };
   }, [onClose]);
   const width = 220;
   const left = Math.min(menu.x, (typeof window === 'undefined' ? 9999 : window.innerWidth) - width - 8);
   const top = Math.min(menu.y, (typeof window === 'undefined' ? 9999 : window.innerHeight) - 220);
   const items: { label: string; onClick: () => void; danger?: boolean; hidden?: boolean }[] = [
      { label: selected ? '取消选中' : '选中这条', onClick: onToggle },
      { label: `全选当前 ${shownCount} 条`, onClick: onSelectAll, hidden: shownCount <= 1 },
      { label: '清除选择', onClick: onClear, hidden: selectedCount === 0 },
      { label: '删除这条…', onClick: onDeleteOne, danger: true },
      { label: `删除已选 ${selectedCount} 条…`, onClick: onDeleteSelected, danger: true, hidden: selectedCount === 0 },
   ];
   return (
      <div
         role="menu"
         aria-label={`「${prompt.title}」的操作`}
         className="jc-card fixed z-50 grid gap-0.5 p-1.5 text-[13px]"
         style={{ left, top, width, boxShadow: '0 8px 28px rgba(39, 56, 86, 0.16)' }}
         onClick={(event) => event.stopPropagation()}
      >
         <p className="truncate px-2.5 pt-1 pb-1.5 text-[11px] font-medium" style={{ color: 'var(--jc-ghost)' }}>{prompt.title}</p>
         {items.filter((item) => !item.hidden).map((item) => (
            <button
               key={item.label}
               type="button"
               role="menuitem"
               onClick={() => {
                  onClose();
                  item.onClick();
               }}
               className="rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--jc-soft)]"
               style={{ color: item.danger ? 'var(--jc-err)' : 'var(--jc-ink)' }}
            >
               {item.label}
            </button>
         ))}
      </div>
   );
}

export default function PromptsDashboard() {
   const params = useSearchParams();
   const [library, setLibrary] = useState<Library | null>(null);
   const [error, setError] = useState<{ text: string; code: string | null } | null>(null);
   const [query, setQuery] = useState('');
   const [category, setCategory] = useState<string>('全部');
   const [tag, setTag] = useState<string>('全部');
   const [onlyStarred, setOnlyStarred] = useState(false);
   const [openId, setOpenId] = useState<string | null>(params.get('prompt'));
   const [selected, setSelected] = useState<Set<string>>(() => new Set());
   const [menu, setMenu] = useState<Menu | null>(null);
   const [deleting, setDeleting] = useState<string[]>([]);
   const [cursor, setCursor] = useState(0);
   const [dragId, setDragId] = useState<string | null>(null);
   const [dropId, setDropId] = useState<string | null>(null);
   const [savingOrder, setSavingOrder] = useState(false);
   const searchRef = useRef<HTMLInputElement>(null);
   const closeMenu = useCallback(() => setMenu(null), []);
   const now = Date.now();

   useEffect(() => {
      let alive = true;
      request<Library>('/api/prompts')
         .then((result) => {
            if (alive) setLibrary(result);
         })
         .catch((err) => {
            if (alive) setError({ text: errorText(err), code: err instanceof ApiError ? err.code : null });
         });
      return () => {
         alive = false;
      };
   }, []);

   const needle = query.trim().toLocaleLowerCase();
   const matchRank = useCallback(
      (prompt: Prompt) => {
         if (!needle) return 0;
         const has = (text: string) => text.toLocaleLowerCase().includes(needle);
         if (has(prompt.when) || has(prompt.title)) return 1;
         if (has(prompt.summary) || prompt.tags.some(has) || has(prompt.category)) return 2;
         if (has(prompt.body)) return 3;
         return 0;
      },
      [needle]
   );
   const inCategory = (prompt: Prompt) => category === '全部' || prompt.category === category;
   const hasTag = (prompt: Prompt) => tag === '全部' || prompt.tags.includes(tag);
   const prompts = library?.prompts ?? [];
   const searched = prompts.filter((prompt) => (matchRank(prompt) > 0 || !needle) && (!onlyStarred || prompt.starred));
   const shown = useMemo(() => {
      const rows = searched.filter(inCategory).filter(hasTag);
      if (!needle) return rows; // 无搜索时严格按服务端顺序（手动顺序优先），位置固定
      return rows.map((p, i) => ({ p, i, r: matchRank(p) })).sort((a, b) => a.r - b.r || a.i - b.i).map((row) => row.p);
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [library, needle, category, tag, onlyStarred]);
   useEffect(() => setCursor(0), [needle, category, tag, onlyStarred]);

   const dragEnabled = !needle && category === '全部' && tag === '全部' && !onlyStarred && selected.size === 0 && !savingOrder;
   const byId = new Map(prompts.map((prompt) => [prompt.id, prompt]));
   const opened = openId ? (byId.get(openId) ?? null) : null;

   const act = useCallback(
      async (prompt: Prompt) => {
         if (prompt.variables.length) setOpenId(prompt.id);
         else await copyAndRecord(prompt, prompt.body, setLibrary);
      },
      []
   );

   // 键盘流：/ 聚焦搜索，↑↓ 移动，回车复制或打开，Esc 逐级清除
   useEffect(() => {
      const onKey = (event: KeyboardEvent) => {
         if (openId || deleting.length || menu) return;
         const target = event.target as HTMLElement | null;
         const typing = target && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target !== searchRef.current));
         if (typing) return;
         if (event.key === '/' && target !== searchRef.current) {
            event.preventDefault();
            searchRef.current?.focus();
            searchRef.current?.select();
         } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!shown.length) return;
            event.preventDefault();
            setCursor((c) => (event.key === 'ArrowDown' ? Math.min(c + 1, shown.length - 1) : Math.max(c - 1, 0)));
         } else if (event.key === 'Enter') {
            const prompt = shown[cursor];
            if (!prompt) return;
            event.preventDefault();
            void act(prompt);
         } else if (event.key === 'Escape') {
            if (query) setQuery('');
            else if (selected.size) setSelected(new Set());
            else if (category !== '全部' || tag !== '全部' || onlyStarred) {
               setCategory('全部');
               setTag('全部');
               setOnlyStarred(false);
            }
         }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
   }, [shown, cursor, openId, deleting.length, menu, query, selected.size, category, tag, onlyStarred, act]);

   const header = (
      <PageHeader
         title="提示词"
         description="打开就能输入，↑↓ 选、回车复制；卡片可以拖动，拖完就固定；点星标收藏，右键选中和删除。要加一条或改正文，直接改提示词文件夹里的 md 文件。"
         right={
            <>
               <PlaceButton place="prompts" title="在访达中打开提示词文件夹">
                  <FolderOpen size={14} /> 提示词文件夹
               </PlaceButton>
               <PlaceButton place="promptFormat" title="用默认程序打开格式说明">
                  怎么写
               </PlaceButton>
            </>
         }
      />
   );
   if (error) {
      return (
         <div>
            {header}
            <SemBanner tone={error.code === 'prompts-missing' ? 'warn' : 'err'}>
               {error.code === 'prompts-missing'
                  ? `${error.text}。可能被移走或删掉了：找回来放回原处，或者在设置文件里把 paths.prompts 改成它现在的位置，再重新运行 pnpm start。`
                  : `提示词暂时读不出来：${error.text}`}
            </SemBanner>
         </div>
      );
   }
   if (!library) {
      return (
         <div>
            {header}
            <p className="flex items-center gap-2 text-sm" style={{ color: 'var(--jc-muted)' }}>
               <Spinner /> 正在读取提示词……
            </p>
         </div>
      );
   }

   // 数量都按「另一维度的当前筛选」来算：分类数跟着标签走，标签数跟着分类走，避免点出空结果。
   const categoryCounts = new Map<string, number>();
   const tagCounts = new Map<string, number>();
   let tagTotal = 0;
   for (const prompt of searched) {
      if (hasTag(prompt)) categoryCounts.set(prompt.category, (categoryCounts.get(prompt.category) ?? 0) + 1);
      if (inCategory(prompt)) {
         tagTotal += 1;
         for (const t of prompt.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
   }
   const categories = library.categories.map((row) => ({ ...row, count: categoryCounts.get(row.name) ?? 0 }));
   const allTags = new Set<string>();
   for (const prompt of prompts) for (const t of prompt.tags) allTags.add(t);
   const tags = [...allTags]
      .map((name) => ({ name, count: tagCounts.get(name) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
   const pickCategory = (name: string) => {
      setCategory(name);
      if (tag !== '全部' && !searched.some((p) => (name === '全部' || p.category === name) && p.tags.includes(tag))) setTag('全部');
   };
   const pickTag = (name: string) => {
      setTag(name);
      if (category !== '全部' && !searched.some((p) => p.category === category && (name === '全部' || p.tags.includes(name)))) setCategory('全部');
   };
   const frequent = [...prompts]
      .filter((p) => p.useCount > 0)
      .sort((a, b) => b.useCount30 - a.useCount30 || b.useCount - a.useCount || (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))
      .slice(0, 5);
   const menuPrompt = menu ? (byId.get(menu.id) ?? null) : null;
   const deletingPrompts = deleting.map((id) => byId.get(id)).filter((p): p is Prompt => Boolean(p));

   const toggle = (id: string) =>
      setSelected((prev) => {
         const next = new Set(prev);
         if (next.has(id)) next.delete(id);
         else next.add(id);
         return next;
      });
   const afterDelete = (next: Library) => {
      setLibrary(next);
      setSelected(new Set());
      setDeleting([]);
   };

   // 拖动：本地先重排，再把整份顺序写回 _排序.md；写失败就恢复原顺序。
   const dropOn = async (targetId: string) => {
      if (!dragId || dragId === targetId || !dragEnabled) return;
      const ids = prompts.map((p) => p.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0) return;
      ids.splice(from, 1);
      ids.splice(to > from ? to - 1 : to, 0, dragId);
      const previous = library;
      const reordered = ids.map((id) => byId.get(id)).filter((p): p is Prompt => Boolean(p));
      setLibrary({ ...library, prompts: reordered });
      setSavingOrder(true);
      try {
         const result = await postJson<LibraryResult>('/api/prompts/order', { ids });
         if (!result.library?.prompts || JSON.stringify(result.ids) !== JSON.stringify(ids)) throw new Error('顺序写进去以后读回来对不上');
         setLibrary(result.library as Library);
      } catch (cause) {
         setLibrary(previous);
         toast.error(`顺序没有存上：${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
         setSavingOrder(false);
      }
   };

   return (
      <div>
         {header}
         <TourHint />
         <div className="mb-4 flex flex-wrap items-center gap-3">
            <label
               className="jc-search flex min-w-[240px] flex-1 items-center gap-2 rounded-lg border px-3 min-[721px]:max-w-md"
               style={{ borderColor: 'var(--jc-border)', background: 'var(--jc-surface)' }}
            >
               <Search size={16} aria-hidden="true" style={{ color: 'var(--jc-muted)' }} />
               <input
                  ref={searchRef}
                  autoFocus
                  aria-label="搜索提示词"
                  placeholder="用处境找：纠结、看不懂、怀疑、天赋…（回车复制第一条）"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
               />
               {query && (
                  <button type="button" onClick={() => setQuery('')} className="text-[11px]" style={{ color: 'var(--jc-ghost)' }}>
                     清空 Esc
                  </button>
               )}
            </label>
            <button
               type="button"
               onClick={() => setOnlyStarred((value) => !value)}
               aria-pressed={onlyStarred}
               title={onlyStarred ? '显示全部' : '只看收藏'}
               className="flex items-center gap-1 rounded-full border px-3 py-1 text-[12px] font-medium transition-colors"
               style={{
                  borderColor: onlyStarred ? 'var(--jc-accent)' : 'var(--jc-border)',
                  background: onlyStarred ? 'var(--jc-accent-bg)' : 'var(--jc-surface)',
                  color: onlyStarred ? 'var(--jc-accent)' : 'var(--jc-body)',
               }}
            >
               <Star size={12} fill={onlyStarred ? 'currentColor' : 'none'} /> 收藏 {library.totalStarred}
            </button>
            <span className="text-[12px]" style={{ color: 'var(--jc-ghost)' }}>
               共 {library.totalPrompts} 条 · 累计复制 {library.totalCopies} 次
               {savingOrder && ' · 正在保存顺序…'}
            </span>
         </div>
         {frequent.length > 0 && !needle && (
            <div className="mb-4 flex flex-wrap items-center gap-2" aria-label="最常用">
               <span className="inline-flex w-11 shrink-0 items-center gap-1 text-[11px] whitespace-nowrap" style={{ color: 'var(--jc-ghost)' }}>
                  <Flame size={12} aria-hidden="true" />
                  常用
               </span>
               {frequent.map((p) => (
                  <button
                     key={p.id}
                     type="button"
                     onClick={() => void act(p)}
                     title={`${p.when || p.summary}\n${usageMeta(p)}`}
                     className="jc-card jc-content-card flex items-center gap-2 px-3 py-1.5 text-[12px]"
                  >
                     <span className="font-medium">{p.title}</span>
                     <span style={{ color: 'var(--jc-ghost)' }}>{p.useCount30 ? `30 天 ${p.useCount30} 次` : `共 ${p.useCount} 次`}</span>
                     <Copy size={12} style={{ color: 'var(--jc-ghost)' }} />
                  </button>
               ))}
            </div>
         )}
         <div className="mb-2 flex flex-wrap items-center gap-2" role="group" aria-label="按分类筛选，从左到右是使用顺序">
            <span className="w-11 shrink-0 text-[11px] whitespace-nowrap" style={{ color: 'var(--jc-ghost)' }}>分类</span>
            <Chip name="全部" count={searched.filter(hasTag).length} active={category === '全部'} onClick={() => pickCategory('全部')} />
            <span className="mx-0.5 h-4 w-px" style={{ background: 'var(--jc-border)' }} aria-hidden="true" />
            {categories.map((row, index) => (
               <span key={row.name} className="flex items-center gap-2">
                  {index > 0 && <ChevronRight size={13} aria-hidden="true" style={{ color: 'var(--jc-ghost)' }} />}
                  <Chip
                     name={row.name}
                     count={row.count}
                     active={category === row.name}
                     disabled={row.count === 0 && category !== row.name}
                     onClick={() => pickCategory(row.name)}
                     title={row.note ? `第 ${index + 1} 步：${row.note}` : undefined}
                  />
               </span>
            ))}
         </div>
         {category !== '全部' && categories.find((row) => row.name === category)?.note && (
            <p className="mb-2 pl-10 text-[12px]" style={{ color: 'var(--jc-muted)' }}>
               {categories.find((row) => row.name === category)?.note}
            </p>
         )}
         {tags.length > 0 && (
            <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="按标签筛选">
               <span className="w-11 shrink-0 text-[11px] whitespace-nowrap" style={{ color: 'var(--jc-ghost)' }}>标签</span>
               <Chip name="全部" count={tagTotal} active={tag === '全部'} onClick={() => pickTag('全部')} />
               {tags.map((row) => (
                  <Chip
                     key={row.name}
                     name={`#${row.name}`}
                     count={row.count}
                     active={tag === row.name}
                     disabled={row.count === 0 && tag !== row.name}
                     onClick={() => pickTag(row.name)}
                  />
               ))}
            </div>
         )}
         {library.issues.length > 0 && (
            <SemBanner tone="warn" className="mb-4">
               有 {library.issues.length} 个文件没有列出：{library.issues.join('；')}
            </SemBanner>
         )}
         {selected.size > 0 && (
            <div
               className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border px-4 py-2.5 text-[13px]"
               style={{ borderColor: 'var(--jc-accent)', background: 'var(--jc-accent-bg)' }}
            >
               <span className="font-medium" style={{ color: 'var(--jc-accent)' }}>已选 {selected.size} 条</span>
               <span className="text-[12px]" style={{ color: 'var(--jc-muted)' }}>点卡片继续选，按 Esc 清除</span>
               <span className="ml-auto flex items-center gap-2">
                  {shown.some((p) => !selected.has(p.id)) && (
                     <SecondaryButton size="small" onClick={() => setSelected(new Set([...selected, ...shown.map((p) => p.id)]))}>
                        全选当前 {shown.length} 条
                     </SecondaryButton>
                  )}
                  <SecondaryButton size="small" onClick={() => setSelected(new Set())}>取消</SecondaryButton>
                  <DangerButton size="small" onClick={() => setDeleting([...selected])}>
                     <Trash2 size={13} /> 删除 {selected.size} 条…
                  </DangerButton>
               </span>
            </div>
         )}
         {shown.length === 0 ? (
            library.totalPrompts ? (
               <EmptyState
                  text="没有对得上的提示词"
                  hint="换个说法搜，或者清空搜索和筛选。"
                  actions={
                     <SecondaryButton
                        size="small"
                        onClick={() => {
                           setQuery('');
                           setCategory('全部');
                           setTag('全部');
                           setOnlyStarred(false);
                        }}
                     >
                        清空搜索和筛选
                     </SecondaryButton>
                  }
               />
            ) : (
               <EmptyState
                  text="提示词文件夹里还没有提示词"
                  hint="一条提示词就是一个 md 文件：放在哪个子文件夹里，就属于哪个分类。开头几行写名字和什么时候用，下面是正文，格式照「怎么写」里的说明。放好以后刷新这个页面。"
                  actions={
                     <>
                        <PlaceButton place="prompts" primary>
                           <FolderOpen size={14} /> 在访达中打开提示词文件夹
                        </PlaceButton>
                        <PlaceButton place="promptFormat">看看怎么写</PlaceButton>
                     </>
                  }
               />
            )
         ) : (
            <div className="grid gap-3 min-[560px]:grid-cols-2 min-[960px]:grid-cols-3 min-[1360px]:grid-cols-4 min-[1700px]:grid-cols-5">
               {shown.map((prompt, index) => (
                  <PromptTile
                     key={prompt.id}
                     prompt={prompt}
                     now={now}
                     selected={selected.has(prompt.id)}
                     selecting={selected.size > 0}
                     highlighted={index === cursor && (Boolean(needle) || cursor > 0)}
                     draggable={dragEnabled}
                     dragging={dragId === prompt.id}
                     dropBefore={dropId === prompt.id && dragId !== prompt.id}
                     onOpen={() => setOpenId(prompt.id)}
                     onToggle={() => toggle(prompt.id)}
                     onMenu={(x, y) => setMenu({ id: prompt.id, x, y })}
                     onLibrary={setLibrary}
                     onDragStart={() => setDragId(prompt.id)}
                     onDragOver={(event) => {
                        if (!dragId || !dragEnabled) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        if (dropId !== prompt.id) setDropId(prompt.id);
                     }}
                     onDrop={() => {
                        void dropOn(prompt.id);
                        setDragId(null);
                        setDropId(null);
                     }}
                     onDragEnd={() => {
                        setDragId(null);
                        setDropId(null);
                     }}
                  />
               ))}
            </div>
         )}
         {!dragEnabled && !savingOrder && library.totalPrompts > 1 && (
            <p className="mt-3 text-[11px]" style={{ color: 'var(--jc-ghost)' }}>
               {selected.size ? '清除选择后可拖动卡片调整位置。' : '清空搜索和筛选后可拖动卡片调整位置。'}
            </p>
         )}
         {menu && menuPrompt && (
            <ContextMenu
               menu={menu}
               prompt={menuPrompt}
               selected={selected.has(menuPrompt.id)}
               selectedCount={selected.size}
               shownCount={shown.length}
               onClose={closeMenu}
               onToggle={() => toggle(menuPrompt.id)}
               onSelectAll={() => setSelected(new Set([...selected, ...shown.map((p) => p.id)]))}
               onClear={() => setSelected(new Set())}
               onDeleteOne={() => setDeleting([menuPrompt.id])}
               onDeleteSelected={() => setDeleting([...selected])}
            />
         )}
         <PromptDialog prompt={opened} onClose={() => setOpenId(null)} onLibrary={setLibrary} />
         <DeleteDialog prompts={deletingPrompts} onClose={() => setDeleting([])} onDeleted={afterDelete} />
         <p className="mt-8 text-[11px]" style={{ color: 'var(--jc-ghost)' }}>
            提示词文件夹：<CopyPath path={library.dir} /> · 使用记录：<CopyPath path={library.eventsFile} /> · 卡片顺序：<CopyPath path={library.manualOrderFile} /> · 分类顺序：<CopyPath path={library.categoryOrderFile} />
         </p>
         <p className="mt-1 text-[11px]" style={{ color: 'var(--jc-ghost)' }}>
            想让 AI 帮你挑：把上面的提示词文件夹路径发给 Codex 或 Claude Code，说清你现在的处境就行。
         </p>
      </div>
   );
}
