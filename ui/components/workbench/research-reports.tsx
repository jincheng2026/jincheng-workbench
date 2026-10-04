'use client';

// 调研报告：上面是三种调研（评论洞察、视频拆解、账号研究），都显示，缺东西的那张变灰，写一句缺什么、要几分钟、约花多少钱，按钮就在旁边；
// 下面按日期列出「市场调研/调研报告/」里 AI 做好的报告，能按类型筛，点开在工作台里看（报告网页放在隔开的环境里打开）。
// 改自原作者自己用的工作台的调研报告页，去掉了只在他那里有的分类和别的网页。
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ArrowLeft, Copy, ExternalLink } from 'lucide-react';
import { useAppInfo } from '@/components/jc/app-info';
import { Card, EmptyState, SecondaryButton, SemBadge, SemBanner, copyText } from '@/components/jc/ui';
import { askResearch, type ResearchKind } from '@/lib/ask-ai';
import { askInfo } from '@/lib/app-info';
import { REPORT_TYPES, relatedReports, reportsEmpty, researchCards, type CostEstimate, type ResearchCard } from '@/lib/research-guide';
import { reportFileUrl, reportViewHref, type Account, type Report } from '@/lib/research';

function shortDate(date: string | null): string {
   const m = String(date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
   return m ? `${Number(m[2])} 月 ${Number(m[3])} 日` : '';
}

function ResearchCards({
   cards,
   onGo,
}: {
   cards: ResearchCard[];
   onGo: (which: 'tikhub' | 'social') => void;
}) {
   const { info } = useAppInfo();
   return (
      <section className="mb-8" aria-label="做一份新调研">
         <h2 className="mb-2.5 text-[15px] font-semibold">做一份新调研</h2>
         <div className="grid gap-3 min-[961px]:grid-cols-2 min-[1280px]:grid-cols-4">
            {cards.map((card) => (
               <Card
                  key={card.kind}
                  className="flex flex-col gap-2 p-4"
                  // 缺东西的那张变灰
                  style={card.ready ? undefined : { background: 'var(--jc-softer)', boxShadow: 'none' }}
               >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                     <h3 className="text-[14.5px] font-semibold" style={{ color: card.ready ? 'var(--jc-ink)' : 'var(--jc-muted)' }}>
                        {card.title}
                     </h3>
                     {!card.ready && <SemBadge tone="gray">{card.action === 'tikhub' ? '还缺 TikHub' : '还缺评论'}</SemBadge>}
                  </div>
                  <p className="text-[12.5px] leading-relaxed" style={{ color: card.ready ? 'var(--jc-body)' : 'var(--jc-muted)' }}>
                     {card.what}
                  </p>
                  <p className="text-[12px] leading-relaxed" style={{ color: card.ready ? 'var(--jc-muted)' : 'var(--jc-warn)' }}>
                     {card.line}
                  </p>
                  <div className="mt-auto pt-1">
                     {card.action === 'covers' ? (
                        <Link href="/content?tab=covers" className="jc-button jc-button-secondary inline-flex h-[33px] items-center justify-center gap-2 px-3.5 text-[12.5px] font-medium no-underline hover:no-underline" style={{ color: 'var(--jc-body)' }}>
                           {card.actionLabel}
                        </Link>
                     ) : card.action === 'copy' ? (
                        <SecondaryButton
                           size="small"
                           onClick={() =>
                              void copyText(askResearch(card.kind as ResearchKind, askInfo(info, 'research')), '给 AI 的话')
                           }
                           title="复制一段话，粘贴给 Codex 或 Claude Code"
                        >
                           <Copy size={14} /> {card.actionLabel}
                        </SecondaryButton>
                     ) : (
                        <SecondaryButton size="small" onClick={() => onGo(card.action === 'tikhub' ? 'tikhub' : 'social')}>
                           {card.actionLabel}
                        </SecondaryButton>
                     )}
                  </div>
               </Card>
            ))}
         </div>
      </section>
   );
}

function ReportCard({ report }: { report: Report }) {
   const [main, ...rest] = report.pages;
   const sourceIsLink = /^https?:\/\//.test(report.source ?? '');
   return (
      <Card className="flex min-w-0 flex-col gap-2 p-4">
         <div className="flex items-center justify-between gap-3">
            <SemBadge tone={REPORT_TYPES.includes(report.type as (typeof REPORT_TYPES)[number]) ? 'accent' : 'gray'}>{report.type}</SemBadge>
            <span className="shrink-0 text-[11.5px] tabular-nums" style={{ color: 'var(--jc-ghost)' }}>
               {shortDate(report.date)}
            </span>
         </div>
         <Link href={reportViewHref(report.id, main.file)} className="text-[15px] leading-snug font-semibold no-underline hover:underline" style={{ color: 'var(--jc-ink)' }}>
            {report.title}
         </Link>
         {main.subtitle && (
            <p className="line-clamp-2 text-[12px]" style={{ color: 'var(--jc-muted)' }}>
               {main.subtitle}
            </p>
         )}
         {report.problem && (
            <p className="text-[11.5px]" style={{ color: 'var(--jc-warn)' }}>
               {report.problem}
            </p>
         )}
         <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1 text-[12.5px]">
            <Link
               href={reportViewHref(report.id, main.file)}
               className="jc-button jc-button-secondary inline-flex h-[33px] items-center px-3 text-[12.5px] font-medium no-underline hover:no-underline"
               style={{ color: 'var(--jc-body)' }}
            >
               打开{report.pages.length > 1 ? `「${main.title}」` : ''}
            </Link>
            {rest.map((page) => (
               <Link key={page.file} href={reportViewHref(report.id, page.file)}>
                  {page.title}
               </Link>
            ))}
            {report.source &&
               (sourceIsLink ? (
                  <a href={report.source} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-[12px]" style={{ color: 'var(--jc-muted)' }}>
                     原视频或账号 <ExternalLink size={12} aria-hidden="true" />
                  </a>
               ) : (
                  <span className="ml-auto truncate text-[12px]" style={{ color: 'var(--jc-ghost)' }} title={report.source}>
                     来源：{report.source}
                  </span>
               ))}
         </div>
      </Card>
   );
}

/** 在工作台里看一份报告 */
export function ReportViewer({ report, file }: { report: Report; file: string }) {
   const page = report.pages.find((p) => p.file === file) ?? report.pages[0];
   const src = reportFileUrl(report.id, page.file);
   return (
      <div>
         <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <Link
               href="/research?tab=reports"
               className="inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium no-underline hover:no-underline"
               style={{ background: 'var(--jc-surface)', border: '1px solid var(--jc-border)', color: 'var(--jc-body)' }}
            >
               <ArrowLeft size={14} aria-hidden="true" /> 返回调研报告
            </Link>
            <a href={src} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-[12.5px]">
               在新标签页打开 <ExternalLink size={13} aria-hidden="true" />
            </a>
         </div>
         <div className="mb-2 flex flex-wrap items-center gap-2">
            <SemBadge tone="accent">{report.type}</SemBadge>
            <span className="text-[12px]" style={{ color: 'var(--jc-ghost)' }}>
               {shortDate(report.date)}
            </span>
         </div>
         <h2 className="mb-3 text-[20px] leading-snug font-bold tracking-[-0.02em]">{report.title}</h2>
         {report.pages.length > 1 && (
            <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="这份报告里的网页">
               {report.pages.map((p) => {
                  const active = p.file === page.file;
                  return (
                     <Link
                        key={p.file}
                        href={reportViewHref(report.id, p.file)}
                        scroll={false}
                        aria-current={active ? 'page' : undefined}
                        className="rounded-full border px-3 py-1 text-[12.5px] font-medium no-underline hover:no-underline"
                        style={{
                           borderColor: active ? 'var(--jc-accent)' : 'var(--jc-border)',
                           background: active ? 'var(--jc-accent-bg)' : 'var(--jc-surface)',
                           color: active ? 'var(--jc-accent)' : 'var(--jc-body)',
                        }}
                     >
                        {p.title}
                     </Link>
                  );
               })}
            </div>
         )}
         <iframe
            key={src}
            src={src}
            title={`${report.title}：${page.title}`}
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            className="w-full rounded-xl border"
            style={{ borderColor: 'var(--jc-border)', background: '#fff', height: 'max(520px, calc(100vh - 300px))' }}
         />
      </div>
   );
}

export function ResearchReports({
   reports,
   accounts,
   accountFilter,
   tikhubReady,
   importedComments,
   cost,
   onGo,
}: {
   reports: Report[];
   accounts: Account[];
   accountFilter: string | null;
   tikhubReady: boolean;
   importedComments: number;
   cost: CostEstimate;
   onGo: (which: 'tikhub' | 'social') => void;
}) {
   const [type, setType] = useState('全部');
   const account = accountFilter ? accounts.find((a) => a.name === accountFilter) ?? null : null;
   const scoped = useMemo(() => (account ? relatedReports(account, reports) : reports), [reports, account]);
   const types = useMemo(() => {
      const extra = [...new Set(scoped.map((r) => r.type))].filter((t) => !REPORT_TYPES.includes(t as (typeof REPORT_TYPES)[number]));
      return [...REPORT_TYPES, ...extra].map((t) => ({ type: t, n: scoped.filter((r) => r.type === t).length }));
   }, [scoped]);
   const shown = type === '全部' ? scoped : scoped.filter((r) => r.type === type);
   const { info } = useAppInfo();
   const cards = researchCards({ tikhubReady, importedComments, cost });
   const empty = reportsEmpty(cards.some((c) => c.ready));

   return (
      <div>
         <ResearchCards cards={cards} onGo={onGo} />
         <section aria-label="调研报告">
            <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
               <h2 className="text-[15px] font-semibold">
                  做好的报告
                  <span className="jc-section-count">{reports.length}</span>
               </h2>
               <span className="text-[12px]" style={{ color: 'var(--jc-ghost)' }}>
                  按日期排，新的在前
               </span>
            </div>
            {account && (
               <SemBanner tone="accent" className="mb-3">
                  <span className="inline-flex flex-wrap items-center gap-2">
                     只看和「{account.accountName}」有关的 {scoped.length} 份。
                     <Link href="/research?tab=reports">看全部报告</Link>
                  </span>
               </SemBanner>
            )}
            {reports.length === 0 ? (
               <EmptyState
                  text={empty.text}
                  hint={empty.hint}
                  actions={
                     empty.copy ? (
                        <SecondaryButton size="small" onClick={() => void copyText(askResearch('comments', askInfo(info, 'research')), '给 AI 的话')} title="复制一段话，粘贴给 Codex 或 Claude Code">
                           <Copy size={14} /> 复制给 AI 的话
                        </SecondaryButton>
                     ) : undefined
                  }
               />
            ) : (
               <>
                  <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="按类型筛选">
                     {[{ type: '全部', n: scoped.length }, ...types].map((c) => {
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
                                 color: active ? 'var(--jc-accent)' : c.n ? 'var(--jc-body)' : 'var(--jc-ghost)',
                              }}
                           >
                              {c.type}{' '}
                              <span className="tabular-nums" style={{ color: active ? 'var(--jc-accent)' : 'var(--jc-ghost)' }}>
                                 {c.n}
                              </span>
                           </button>
                        );
                     })}
                  </div>
                  {shown.length === 0 ? (
                     <EmptyState
                        text={`还没有「${type}」的报告`}
                        hint="上面那张同名的卡片里有「复制给 AI 的话」。"
                        actions={
                           <SecondaryButton size="small" onClick={() => setType('全部')}>
                              看全部
                           </SecondaryButton>
                        }
                     />
                  ) : (
                     <div className="grid gap-3 min-[961px]:grid-cols-2">
                        {shown.map((r) => (
                           <ReportCard key={r.id} report={r} />
                        ))}
                     </div>
                  )}
               </>
            )}
         </section>
      </div>
   );
}
