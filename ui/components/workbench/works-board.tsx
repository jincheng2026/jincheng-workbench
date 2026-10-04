'use client';

// 「内容」栏首页：每个 T 编号一张卡，分两个页签。
// 「选题」是还没开始写的：接下来要做、暂缓（默认收起）；
// 「在做」是正在写的（大卡，有创作页的直接「打开创作页」，没有的「接着写」）、录完还没发的，最下面收着做完的。
// 数据全部由 /api/works 从文件现算，页面只记住上次看的是哪个页签；页签就是地址里的 ?tab=。
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChevronRight, Copy, FolderOpen, PenLine, Search, SquarePen, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useAppInfo } from '@/components/jc/app-info';
import { ColumnHeader } from '@/components/jc/column';
import { PlaceButton } from '@/components/jc/place-button';
import { TourCard, TourHint, useTourBoard, useTourCardOpen, useTourReload } from '@/components/jc/tour';
import {
   Card,
   EmptyState,
   LinkButton,
   NextStepBlock,
   PrimaryButton,
   SecondaryButton,
   SemBadge,
   SemBanner,
   copyText,
   fmtClock,
} from '@/components/jc/ui';
import { errorText } from '@/lib/api';
import { askAddTopic } from '@/lib/ask-ai';
import { askInfo } from '@/lib/app-info';
import {
   ApiError,
   changedAgo,
   deferredLine,
   fetchWorks,
   openWorkTarget,
   planIsPast,
   restoreOverview,
   resumeWork,
   type Work,
   type WorksResult,
} from '@/lib/works';
import { TOUR_WORK } from '@/lib/tour-steps';

type Tab = 'topics' | 'doing';
const isTab = (v: string | null | undefined): v is Tab => v === 'topics' || v === 'doing';
const TAB_INTRO: Record<Tab, string> = {
   topics: '还没开始写的选题。定了拍摄顺序就按顺序排；暂缓的在最下面，默认收起。',
   doing: '正在写的，和录完还没发的。有创作页的点「打开创作页」接着改；没有的点「接着写」，或者进详情让 AI 生成创作页。',
};
const TAB_KEY = 'workbench-content-tab';

/** 「2026-01-05」→「1 月 5 日」；不是标准日期的原样返回 */
function spacedDate(value: string | null | undefined): string {
   const m = String(value ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
   return m ? `${Number(m[2])} 月 ${Number(m[3])} 日` : String(value ?? '').trim();
}

/** 接下来要做那一行右边的一句：有安排写安排，没有安排就不写，免得每行都是「选题总览：待写」 */
function nextLine(work: Work): string {
   if (work.deferred) return deferredLine(work.deferred);
   if (work.plan?.text) {
      const text = [...work.plan.text];
      const clip = text.length > 26 ? `${text.slice(0, 26).join('')}…` : work.plan.text;
      return `${spacedDate(work.plan.date)}安排：${clip}`;
   }
   return /待写|还没开始/.test(work.stageReason) ? '' : work.stageReason;
}

function timeOf(value: string | null | undefined) {
   if (!value) return 0;
   const t = Date.parse(value);
   return Number.isNaN(t) ? 0 : t;
}

/** 「今天 20:04 改过」「昨天 22:10 改过」，更早的用「3 天前改过」 */
function changedWhen(iso: string | null | undefined, now: number): string | null {
   const t = timeOf(iso);
   if (!t) return null;
   const d = new Date(t);
   const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
   const day = (x: number) => new Date(x).toDateString();
   if (day(t) === day(now)) return `今天 ${clock} 改过`;
   if (day(t) === day(now - 86_400_000)) return `昨天 ${clock} 改过`;
   return changedAgo(iso, now);
}

/** 标了 ✅ 还没发布：录完了，等发 */
const shotNotPublished = (w: Work) =>
   w.stage === 'done' && w.recorded && w.overviewStatus !== '已发布' && !w.publishDate;

/** 搜索：输入编号（T001、t1、1）只按编号找；其他文字搜标题和选题总览里的说明。 */
function matcher(query: string) {
   const needle = query.trim().toLocaleLowerCase();
   if (!needle) return () => true;
   const numeric = needle.match(/^t?(\d+)$/);
   if (numeric) {
      // 边输边筛：「T00」留下 T001 到 T009，输完「T001」就只剩这一张
      return (work: Work) =>
         work.number === Number(numeric[1]) || work.id.toLocaleLowerCase().startsWith(`t${numeric[1]}`);
   }
   return (work: Work) =>
      work.id.toLocaleLowerCase().includes(needle) ||
      work.title.toLocaleLowerCase().includes(needle) ||
      work.summary.toLocaleLowerCase().includes(needle);
}

const detailHref = (work: Work) => `/content/${encodeURIComponent(work.id)}`;

function IdLine({ work, children }: { work: Work; children?: React.ReactNode }) {
   return (
      <div className="flex min-w-0 items-center gap-2 text-[11px]">
         <span className="shrink-0 font-mono font-semibold tabular-nums" style={{ color: 'var(--jc-muted)' }}>
            {work.id}
         </span>
         {work.type && <SemBadge tone="gray">{work.type}</SemBadge>}
         {children}
      </div>
   );
}

function OrderBadge({ order, extra }: { order?: number | null; extra?: string | null }) {
   if (!order) return null;
   return (
      <SemBadge tone="accent">
         接下来第 {order} 条拍{extra ? ` · ${extra}` : ''}
      </SemBadge>
   );
}

/** 用一个按钮打开这条内容的某个文件或文件夹 */
function useOpen(work: Work) {
   const [busy, setBusy] = useState<string | null>(null);
   const run = async (key: string, job: () => Promise<{ message: string }>) => {
      setBusy(key);
      try {
         toast.success((await job()).message);
      } catch (error) {
         toast.error(`没能打开：${errorText(error)}`);
      } finally {
         setBusy(null);
      }
   };
   return {
      busy,
      resume: () => run('resume', () => resumeWork(work.id)),
      folder: () => work.draftDir && run('folder', () => openWorkTarget(work.id, work.draftDir!.ref, 'finder')),
      card: () => work.card && run('card', () => openWorkTarget(work.id, work.card!.ref, 'default')),
   };
}

/** 正在写：大卡。有创作页就直接「打开创作页」（稿子以它为准），没有就「接着写」 */
function WritingCard({ work, now }: { work: Work; now: number }) {
   const open = useOpen(work);
   const creation = work.creation;
   const r = creation ? null : work.resume;
   const plan = work.plan && !planIsPast(work.plan.date, now) ? spacedDate(work.plan.date) : null;
   return (
      <Card className="flex min-w-0 flex-col gap-2.5 p-4" work={work.id}>
         <IdLine work={work}>
            <span className="ml-auto shrink-0">
               <OrderBadge order={work.order} extra={plan} />
            </span>
         </IdLine>
         <h3 className="line-clamp-2 text-[15px] leading-snug font-semibold">{work.title}</h3>
         <p className="flex min-w-0 items-center gap-1.5 text-[12px]" style={{ color: 'var(--jc-muted)' }}>
            {creation ? (
               <>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--jc-ok)' }} aria-hidden="true" />
                  <span className="truncate" title={creation.name}>
                     创作页 {changedWhen(creation.modifiedAt, now)}
                  </span>
               </>
            ) : r ? (
               <>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--jc-ok)' }} aria-hidden="true" />
                  <span className="truncate" title={r.name}>
                     {r.label}「{r.name}」{changedWhen(r.modifiedAt, now)}
                  </span>
               </>
            ) : (
               <span>{work.draftDir ? '草稿文件夹里还没有稿子' : work.stageReason}</span>
            )}
         </p>
         <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
            {creation && (
               <LinkButton href={creation.url} primary size="small" title={`在新标签页打开「${creation.name}」，改的字自动存回这个文件`}>
                  <SquarePen size={14} />
                  打开创作页
               </LinkButton>
            )}
            {r && (
               <PrimaryButton size="small" busy={open.busy === 'resume'} onClick={() => void open.resume()} title={`用默认程序打开「${r.name}」`}>
                  <PenLine size={14} />
                  接着写
               </PrimaryButton>
            )}
            {work.draftDir && (
               <SecondaryButton size="small" busy={open.busy === 'folder'} onClick={() => void open.folder()}>
                  <FolderOpen size={14} />
                  草稿文件夹
               </SecondaryButton>
            )}
            <Link href={detailHref(work)} className="ml-auto inline-flex items-center text-[12.5px] font-medium" style={{ color: 'var(--jc-accent)' }}>
               详情
               <ChevronRight size={14} />
            </Link>
         </div>
      </Card>
   );
}

/** 列表里的一行：编号、类型、选题名，右边一句安排或要核对的地方 */
function WorkRow({ work, right }: { work: Work; right?: React.ReactNode }) {
   const line = right ?? nextLine(work);
   return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2.5 last:border-b-0" style={{ borderColor: 'var(--jc-border)' }} data-work={work.id}>
         <Link
            href={detailHref(work)}
            className="flex min-w-0 flex-1 basis-[300px] items-center gap-3 no-underline hover:no-underline"
            style={{ color: 'var(--jc-ink)' }}
         >
            <span className="w-[42px] shrink-0 font-mono text-[11.5px] font-semibold tabular-nums" style={{ color: 'var(--jc-muted)' }}>
               {work.id}
            </span>
            {work.type && (
               <span className="shrink-0">
                  <SemBadge tone="gray">{work.type}</SemBadge>
               </span>
            )}
            <span className="truncate text-[13.5px] font-medium" title={work.title}>
               {work.title}
            </span>
         </Link>
         {line && (
            <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2 text-[12px]" style={{ color: 'var(--jc-muted)' }}>
               {line}
            </div>
         )}
      </div>
   );
}

/** 录完还没发：对不上的地方直接写出来，旁边就能打开选题卡改 */
function ShotRow({ work }: { work: Work }) {
   const open = useOpen(work);
   const issue = work.issues[0] ?? null;
   return (
      <WorkRow
         work={work}
         right={
            issue ? (
               <>
                  <span className="inline-flex items-center gap-1" style={{ color: 'var(--jc-warn)' }} title={work.issues.join('\n')}>
                     <TriangleAlert size={13} aria-hidden="true" />
                     {issue}
                  </span>
                  {work.card && (
                     <SecondaryButton size="small" busy={open.busy === 'card'} onClick={() => void open.card()}>
                        打开选题卡改
                     </SecondaryButton>
                  )}
               </>
            ) : (
               work.stageReason
            )
         }
      />
   );
}

function Section({ title, count, note, children }: { title: string; count: number; note?: React.ReactNode; children: React.ReactNode }) {
   return (
      <section className="mb-7" aria-label={title}>
         <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-[15px] font-semibold">
               {title}
               <span className="jc-section-count">{count}</span>
            </h2>
            {note && (
               <span className="text-[12px]" style={{ color: 'var(--jc-ghost)' }}>
                  {note}
               </span>
            )}
         </div>
         {children}
      </section>
   );
}

/** 「复制给 AI：加选题」：复制加选题的那句话（lib/ask-ai.ts 的 askAddTopic），提示粘贴给谁、后面写什么 */
function AddTopicButton({ primary = false }: { primary?: boolean }) {
   const { info } = useAppInfo();
   const Button = primary ? PrimaryButton : SecondaryButton;
   return (
      <Button
         size="small"
         title="复制一段话，粘贴给 Codex 或 Claude Code，在后面写上你的选题"
         onClick={() => void copyText(askAddTopic(askInfo(info, 'write')), '加选题的话', { next: '粘贴给 Codex 或 Claude Code，在后面写上你的选题，发出去。' })}
      >
         <Copy size={14} /> 复制给 AI：加选题
      </Button>
   );
}

/** 刚开始用、选题总览里最多只有一条（多半是示例）时，告诉他怎么加自己的选题 */
function AddTopicTip() {
   return (
      <NextStepBlock className="mb-6">
         加你自己的选题。点「复制给 AI：加选题」，粘贴给 Codex 或 Claude Code，在后面写上想做的选题发出去，一条或几条都行；AI 会编好号、加进选题总览，切回这里就能看到。也可以自己在选题总览对应类型的「待做」表里加一行，再在选题库里放一张同编号的选题卡。
         <div className="mt-2.5 flex flex-wrap gap-2">
            <AddTopicButton primary />
            <PlaceButton place="overview">打开选题总览</PlaceButton>
            <PlaceButton place="topics">
               <FolderOpen size={14} /> 在访达中打开选题库
            </PlaceButton>
         </div>
      </NextStepBlock>
   );
}

/** 选题总览被删掉或挪走了：说清楚，旁边就能重新建一份 */
function OverviewMissing({ message, onDone }: { message: string; onDone: () => void }) {
   const [busy, setBusy] = useState(false);
   const restore = async () => {
      setBusy(true);
      try {
         toast.success((await restoreOverview()).message);
         onDone();
      } catch (error) {
         toast.error(`没能重新建：${errorText(error)}`);
      } finally {
         setBusy(false);
      }
   };
   return (
      <SemBanner tone="warn">
         {message}。可能被移走或删掉了：找回来放回原处，或者在这里重新建一份空白的（不会动选题库里的选题卡）。
         <div className="mt-2 flex flex-wrap gap-2">
            <PrimaryButton size="small" busy={busy} onClick={() => void restore()}>
               重新建一份空白的选题总览
            </PrimaryButton>
            <PlaceButton place="topics">
               <FolderOpen size={14} /> 在访达中打开选题库
            </PlaceButton>
         </div>
      </SemBanner>
   );
}

export default function WorksBoard() {
   const [data, setData] = useState<WorksResult | null>(null);
   const [error, setError] = useState<{ text: string; code: string | null } | null>(null);
   const [loading, setLoading] = useState(false);
   const [query, setQuery] = useState('');
   const params = useSearchParams();
   const urlTab = params.get('tab');
   const [savedTab, setSavedTab] = useState<Tab | null>(null);
   const [type, setType] = useState<string>('all');
   const [deferredOpen, setDeferredOpen] = useState(false);
   const generation = useRef(0);

   // 地址里带 ?tab= 时以地址为准，并记下来；从左边菜单点进来（不带 tab）就打开上次看的那个页签
   useEffect(() => {
      if (isTab(urlTab)) {
         try {
            window.localStorage.setItem(TAB_KEY, urlTab);
         } catch {
            /* 记不住也不影响使用 */
         }
         return;
      }
      try {
         const saved = window.localStorage.getItem(TAB_KEY);
         setSavedTab(isTab(saved) ? saved : 'topics');
      } catch {
         setSavedTab('topics');
      }
   }, [urlTab]);
   const tab: Tab = isTab(urlTab) ? urlTab : (savedTab ?? 'topics');

   const load = useCallback(async () => {
      const current = ++generation.current;
      setLoading(true);
      try {
         const result = await fetchWorks();
         if (current !== generation.current) return;
         setData(result);
         setError(null);
      } catch (err) {
         if (current !== generation.current) return;
         setError({ text: errorText(err), code: err instanceof ApiError ? err.code : null });
      } finally {
         if (current === generation.current) setLoading(false);
      }
   }, []);

   // 打开页面读一次；从别的程序（编辑器、访达）切回来再读一次，新加的选题和新放进去的稿子就会出现。
   useEffect(() => {
      void load();
      const onFocus = () => void load();
      window.addEventListener('focus', onFocus);
      return () => {
         window.removeEventListener('focus', onFocus);
         generation.current += 1;
      };
   }, [load]);

   const match = useMemo(() => matcher(query), [query]);
   const searching = query.trim().length > 0;
   const works = data?.works ?? [];
   // 新手指引：数据到齐了再出顶部那张卡、再亮按钮；告诉它示例选题在哪个页签、有没有创作页、采纳过没有（清单按这些打勾）；
   // 新手指引等到创作页时让这里重新读一次
   const tabSettled = isTab(urlTab) || savedTab !== null;
   const example = works.find((w) => w.id === TOUR_WORK);
   useTourBoard({
      ready: data !== null && tabSettled,
      tab,
      example: {
         exists: !!example,
         tab: example && example.stage !== 'todo' ? 'doing' : 'topics',
         creation: !!example?.creation,
         adopted: (example?.creation?.adopted ?? 0) > 0,
      },
   });
   useTourReload(load);
   const now = Date.now();

   // 两个页签各自的范围：还没开始的在「选题」，其余（正在写、录完没发、做完的）在「在做」
   const tabOf = (w: Work): Tab => (w.stage === 'todo' ? 'topics' : 'doing');
   const found = works.filter(match);
   const inTab = found.filter((w) => tabOf(w) === tab);
   const shown = type === 'all' ? inTab : inTab.filter((w) => w.type === type);

   const byOrder = (a: Work, b: Work) =>
      (a.order ?? 999) - (b.order ?? 999) || timeOf(b.lastModified) - timeOf(a.lastModified) || a.number - b.number;
   const writing = shown.filter((w) => w.stage === 'doing').sort(byOrder);
   const shot = shown.filter(shotNotPublished).sort((a, b) => a.number - b.number);
   const finished = shown.filter((w) => w.stage === 'done' && !shotNotPublished(w)).sort((a, b) => b.number - a.number);
   const nextRank = (w: Work) => (w.order ? 0 : w.plan && !planIsPast(w.plan.date, now) ? 1 : 2);
   const next = shown
      .filter((w) => w.stage === 'todo' && !w.deferred)
      .sort((a, b) => nextRank(a) - nextRank(b) || (a.order ?? 999) - (b.order ?? 999) || a.number - b.number);
   const deferred = shown.filter((w) => w.stage === 'todo' && w.deferred).sort((a, b) => a.number - b.number);

   // 刚开始用、选题总览里最多只有一条（多半是示例）时，在「选题」最上面告诉他怎么加自己的选题；
   // 新手指引的开场卡摊开着时先不出（走完引导或点了「我自己看」再出），免得两个「下一步」抢
   const tourCardOpen = useTourCardOpen();
   const fresh = tab === 'topics' && data !== null && works.length <= 1 && !searching;
   const showTip = fresh && !tourCardOpen;
   // 「在做」是空的时，下面的空白引导里已经有「在访达中打开内容草稿」，页头不再放第二个
   const emptyDoing = tab === 'doing' && data !== null && works.length > 0 && !searching && type === 'all' && inTab.length === 0;
   // 「选题」空了（全都在写或做完了）时，下面的空白引导里放「复制给 AI：加选题」和「打开选题总览」，页头也不放第二个
   const emptyTopics = tab === 'topics' && data !== null && works.length > 0 && !searching && type === 'all' && inTab.length === 0 && !fresh;
   const schedule = data?.schedule ?? null;
   const scheduleNote = schedule ? <span title={schedule.text}>按 {spacedDate(schedule.date)}定的拍摄顺序排</span> : null;

   const header = (
      <ColumnHeader
         column="content"
         tab={tab}
         ready={data !== null || error !== null}
         description={TAB_INTRO[tab]}
         right={
            <>
               {data && (
                  <span className="text-[12px]" style={{ color: 'var(--jc-ghost)' }}>
                     读取于 {fmtClock(data.generatedAt)}
                  </span>
               )}
               {tab === 'topics' ? (
                  // 下面的「下一步」或空白引导里已经有这两个按钮时，这里不再放第二个
                  data &&
                  !showTip &&
                  !emptyTopics && (
                     <>
                        <AddTopicButton />
                        <PlaceButton place="overview" title="用默认程序打开选题总览，改完切回这里">
                           打开选题总览
                        </PlaceButton>
                     </>
                  )
               ) : (
                  !emptyDoing && (
                     <PlaceButton place="drafts" title="在访达中打开内容草稿文件夹">
                        <FolderOpen size={14} /> 内容草稿
                     </PlaceButton>
                  )
               )}
               <SecondaryButton size="small" busy={loading} onClick={() => void load()}>
                  重新读取
               </SecondaryButton>
            </>
         }
      />
   );

   if (!data) {
      return (
         <div>
            {header}
            {error?.code === 'overview-missing' ? (
               <OverviewMissing message={error.text} onDone={() => void load()} />
            ) : error ? (
               <SemBanner tone="err">
                  选题暂时读不出来：{error.text}
                  <div className="mt-2">
                     <SecondaryButton size="small" busy={loading} onClick={() => void load()}>
                        重试
                     </SecondaryButton>
                  </div>
               </SemBanner>
            ) : null /* 还没读到：页头下面那一行「正在读取……」由 ColumnHeader 放 */}
         </div>
      );
   }

   const typeCounts = data.types.map((name) => ({ type: name, label: name, n: inTab.filter((w) => w.type === name).length }));

   return (
      <div>
         {header}
         {error && (
            <SemBanner tone="warn" className="mb-4">
               这次没有读到最新的，下面是 {fmtClock(data.generatedAt)} 读到的。原因：{error.text}
            </SemBanner>
         )}
         {data.notices.length > 0 && (
            <SemBanner tone="warn" className="mb-4">
               {data.notices.map((notice) => (
                  <p key={notice}>{notice}</p>
               ))}
            </SemBanner>
         )}
         <TourHint />
         <TourCard />
         {showTip && <AddTopicTip />}

         {works.length > 0 && (
            <>
               <div className="mb-3 flex flex-wrap items-center gap-3">
                  <label
                     className="jc-search flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border px-3 min-[961px]:max-w-md"
                     style={{ borderColor: 'var(--jc-border)', background: 'var(--jc-surface)' }}
                  >
                     <Search size={16} aria-hidden="true" style={{ color: 'var(--jc-muted)' }} />
                     <input
                        aria-label="搜索选题"
                        placeholder="按编号或选题名搜，例如 T001"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                     />
                     {query && (
                        <button type="button" onClick={() => setQuery('')} className="text-[11px]" style={{ color: 'var(--jc-ghost)' }}>
                           清空
                        </button>
                     )}
                  </label>
               </div>
               <div className="mb-6 flex flex-wrap items-center gap-2" role="group" aria-label="按类型筛选">
                  {[{ type: 'all', label: '全部', n: inTab.length }, ...typeCounts].map((c) => {
                     const active = type === c.type;
                     return (
                        <button
                           key={c.type}
                           type="button"
                           aria-pressed={active}
                           onClick={() => setType(c.type)}
                           className="rounded-full border px-3 py-1 text-[12.5px] font-medium"
                           style={{
                              borderColor: active ? 'var(--jc-accent)' : 'var(--jc-border)',
                              background: active ? 'var(--jc-accent-bg)' : 'var(--jc-surface)',
                              color: active ? 'var(--jc-accent)' : 'var(--jc-body)',
                           }}
                        >
                           {c.label}{' '}
                           <span className="tabular-nums" style={{ color: active ? 'var(--jc-accent)' : 'var(--jc-ghost)' }}>
                              {c.n}
                           </span>
                        </button>
                     );
                  })}
               </div>
            </>
         )}

         {works.length === 0 ? (
            // 「选题」页签上面的「下一步」已经说了怎么加、放了按钮，这里只指过去；「在做」页签上没有，就把按钮放这里
            <EmptyState
               text="选题总览里还没有选题"
               hint={
                  showTip
                     ? '照上面的「下一步」加第一条，加好切回这里就能看到。'
                     : '点「复制给 AI：加选题」，粘贴给 Codex 或 Claude Code，在后面写上你的选题发出去；加好切回这里就能看到。'
               }
               actions={
                  showTip ? undefined : (
                     <>
                        <AddTopicButton primary />
                        <PlaceButton place="overview">打开选题总览</PlaceButton>
                     </>
                  )
               }
            />
         ) : shown.length === 0 ? (
            searching || type !== 'all' ? (
               <EmptyState
                  text={`「${tab === 'topics' ? '选题' : '在做'}」里没有对得上的`}
                  hint={`也去「${tab === 'topics' ? '在做' : '选题'}」看看，那边也能按编号和选题名搜。`}
                  actions={
                     <SecondaryButton
                        size="small"
                        onClick={() => {
                           setQuery('');
                           setType('all');
                        }}
                     >
                        清空搜索和筛选
                     </SecondaryButton>
                  }
               />
            ) : tab === 'topics' ? (
               fresh ? (
                  // 刚开始用（多半是示例 T001 开始写了）：告诉他选题去哪了；怎么加自己的选题由上面的「下一步」说（引导走着时先不说）
                  <EmptyState
                     text="没有还没开始的选题了"
                     hint="开始写的选题挪到了「在做」，在那边接着写。"
                     actions={
                        <Link
                           href="/content?tab=doing"
                           className="jc-button jc-button-secondary inline-flex h-[33px] items-center px-4 text-[12.5px] font-medium no-underline hover:no-underline"
                           style={{ color: 'var(--jc-body)' }}
                        >
                           去「在做」看看
                        </Link>
                     }
                  />
               ) : (
                  <EmptyState
                     text="没有还没开始的选题了"
                     hint="全部选题都已经在写或者做完了。想加新的，点「复制给 AI：加选题」，粘贴给 Codex 或 Claude Code，在后面写上选题发出去。"
                     actions={
                        <>
                           <AddTopicButton primary />
                           <PlaceButton place="overview">打开选题总览</PlaceButton>
                        </>
                     }
                  />
               )
            ) : (
               <EmptyState
                  text="还没有在写的内容"
                  hint="去「选题」点开一条，把详情页上那句话复制给 AI，它写好第一版就会出现在这里。自己写也行：在详情页点「建草稿文件夹」，把稿子放进去（文件名带「工作稿」「初稿」或「逐字稿」）。"
                  actions={
                     <>
                        <Link
                           href="/content?tab=topics"
                           className="jc-button jc-button-primary inline-flex h-[33px] items-center px-4 text-[12.5px] font-semibold no-underline hover:no-underline"
                           style={{ color: '#fff' }}
                        >
                           去「选题」挑一条
                        </Link>
                        <PlaceButton place="drafts">
                           <FolderOpen size={14} /> 在访达中打开内容草稿
                        </PlaceButton>
                     </>
                  }
               />
            )
         ) : (
            <>
               {writing.length > 0 && (
                  <Section title="正在写" count={writing.length} note={scheduleNote}>
                     <div className="grid gap-3 min-[961px]:grid-cols-2">
                        {writing.map((w) => (
                           <WritingCard key={w.id} work={w} now={now} />
                        ))}
                     </div>
                  </Section>
               )}
               {shot.length > 0 && (
                  <Section title="录完还没发" count={shot.length}>
                     <Card className="overflow-hidden">
                        {shot.map((w) => (
                           <ShotRow key={w.id} work={w} />
                        ))}
                     </Card>
                  </Section>
               )}
               {next.length > 0 && (
                  <Section title="接下来要做" count={next.length} note={scheduleNote}>
                     <Card className="overflow-hidden">
                        {next.map((w) => (
                           <WorkRow key={w.id} work={w} right={w.order ? <OrderBadge order={w.order} /> : undefined} />
                        ))}
                     </Card>
                  </Section>
               )}
               {deferred.length > 0 && (
                  <section className="mb-7" aria-label="暂缓">
                     <button
                        type="button"
                        onClick={() => setDeferredOpen((v) => !v)}
                        aria-expanded={deferredOpen || searching}
                        className="text-[12.5px] font-medium"
                        style={{ color: 'var(--jc-accent)' }}
                     >
                        {deferredOpen || searching ? `收起暂缓的 ${deferred.length} 条` : `展开暂缓的 ${deferred.length} 条`}
                     </button>
                     {(deferredOpen || searching) && (
                        <Card className="mt-2.5 overflow-hidden">
                           {deferred.map((w) => (
                              <WorkRow key={w.id} work={w} />
                           ))}
                        </Card>
                     )}
                  </section>
               )}
               {finished.length > 0 && (
                  <details className="mb-7" open={searching || undefined}>
                     <summary className="text-[13px]" style={{ color: 'var(--jc-muted)' }}>
                        做完的 {finished.length} 条（已发布，或者选题总览里放在「已做」）
                     </summary>
                     <Card className="mt-2.5 overflow-hidden">
                        {finished.map((w) => (
                           <WorkRow key={w.id} work={w} right={w.stageReason} />
                        ))}
                     </Card>
                  </details>
               )}
               {writing.length === 0 && shot.length === 0 && tab === 'doing' && (
                  <p className="mb-7 text-[12.5px]" style={{ color: 'var(--jc-muted)' }}>
                     现在没有正在写的。去「选题」点开一条，点「建草稿文件夹」就能开始。
                  </p>
               )}
            </>
         )}
      </div>
   );
}
