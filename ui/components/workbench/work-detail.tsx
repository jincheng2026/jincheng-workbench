'use client';

// 一条内容的详情：编号、标题、做到哪一步、对不上的地方，创作页，拿去拍的稿子（一键复制全文），草稿文件夹里的其他文件。
// 每个按钮都接后台真实动作（/api/works/*）：文件用这台 Mac 的默认程序打开，文件夹在访达里打开；
// 创作页是保存服务给的网页链接，在新标签页打开，页面上改的字自动存回文件。还没有创作页时，这里有一句交给 AI 的话，点一下就复制。
// data-tour 记号给新手指引找按钮用（lib/tour-steps.ts）。
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, FolderOpen, FolderPlus, PenLine, SquarePen } from 'lucide-react';
import { toast } from 'sonner';
import { useAppInfo } from '@/components/jc/app-info';
import { TourHint, useTourDetail, useTourReload } from '@/components/jc/tour';
import {
   Card,
   EmptyState,
   LinkButton,
   LoadingLine,
   NextStepBlock,
   PrimaryButton,
   SecondaryButton,
   SemBadge,
   SemBanner,
   copyText,
   fmtDateTime,
} from '@/components/jc/ui';
import { errorText } from '@/lib/api';
import {
   ApiError,
   FILE_KIND_LABEL,
   STAGE_LABEL,
   askAiText,
   changedAgo,
   fetchWorkDetail,
   fetchWorkText,
   openDraftFolder,
   openWorkTarget,
   resumeWork,
   shortDate,
   type WorkDetail,
   type WorkFile,
   type WorkOpenAs,
   type WorkStage,
} from '@/lib/works';

const STAGE_TONE: Record<WorkStage, 'accent' | 'gray' | 'ok'> = { doing: 'accent', todo: 'gray', done: 'ok' };
const SHOOT_KINDS = new Set(['teleprompter', 'final']);
// 拿去拍：提词器版排最前，然后是定稿，同一类里再按改动时间
const SHOOT_RANK: Record<string, number> = { teleprompter: 0, final: 1 };
const OTHER_PREVIEW = 8;
const REFRESH_GAP = 15000; // 切回窗口时最多每 15 秒重读一次

function fmtSize(bytes: number) {
   if (!Number.isFinite(bytes) || bytes < 0) return '';
   if (bytes < 1024) return `${bytes} B`;
   if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
   return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function byNewest(a: WorkFile, b: WorkFile) {
   return (Date.parse(b.modifiedAt) || 0) - (Date.parse(a.modifiedAt) || 0);
}

const isText = (name: string) => /\.(md|txt)$/i.test(name);

/** 交给 AI 的那句话：整句显示出来，点一下就复制，复制出去的就是看到的这句 */
function AskAiLine({ text }: { text: string }) {
   const [copied, setCopied] = useState(false);
   useEffect(() => {
      if (!copied) return;
      const timer = window.setTimeout(() => setCopied(false), 2400);
      return () => window.clearTimeout(timer);
   }, [copied]);
   return (
      <button
         type="button"
         className="jc-ask mt-2.5"
         data-tour="ask-ai"
         title="点一下复制，粘贴给 Codex 或 Claude Code"
         onClick={() => void copyText(text, '给 AI 的话', { quiet: true }).then((ok) => ok && setCopied(true))}
      >
         <span className="jc-ask-text">{text}</span>
         <span className="jc-ask-copy">
            {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            {copied ? '已复制' : '复制'}
         </span>
      </button>
   );
}

type Fact = { label: string; value: string };

function FactList({ rows, className = '' }: { rows: Fact[]; className?: string }) {
   return (
      <dl className={`grid gap-y-1.5 text-[12.5px] ${className}`}>
         {rows.map((row) => (
            <div key={row.label} className="flex min-w-0 gap-2">
               <dt className="shrink-0" style={{ color: 'var(--jc-ghost)' }}>
                  {row.label}
               </dt>
               <dd className="min-w-0 leading-relaxed break-words" style={{ color: 'var(--jc-body)' }}>
                  {row.value}
               </dd>
            </div>
         ))}
      </dl>
   );
}

function BackLink() {
   return (
      <Link
         href="/content"
         className="inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium no-underline transition-colors duration-150 hover:no-underline"
         style={{ background: 'var(--jc-surface)', border: '1px solid var(--jc-border)', color: 'var(--jc-body)' }}
      >
         ← 返回内容
      </Link>
   );
}

function Block({ id, title, count, note, children }: { id: string; title: string; count?: number; note?: string; children: ReactNode }) {
   return (
      <section id={id} className="mt-8">
         <div className="jc-section-heading">
            <h2>
               {title}
               {count !== undefined && <span className="jc-section-count">{count}</span>}
            </h2>
            {note && (
               <span className="text-[12px]" style={{ color: 'var(--jc-ghost)' }}>
                  {note}
               </span>
            )}
         </div>
         <Card className="overflow-hidden">{children}</Card>
      </section>
   );
}

function Row({ children }: { children: ReactNode }) {
   return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 last:border-b-0" style={{ borderColor: 'var(--jc-border)' }}>
         {children}
      </div>
   );
}

function FileName({ file }: { file: WorkFile }) {
   const size = fmtSize(file.size);
   return (
      <div className="min-w-0 flex-1 basis-[240px]">
         <p className="text-[13px] leading-snug font-medium break-all">
            {file.name}
            {file.latestVersion && (
               <span className="font-normal" style={{ color: 'var(--jc-muted)' }}>
                  （「版本」里最新的一份）
               </span>
            )}
         </p>
         <p className="mt-0.5 text-[11px]" style={{ color: 'var(--jc-ghost)' }}>
            {FILE_KIND_LABEL[file.kind] ?? '文件'} · {fmtDateTime(file.modifiedAt)} 改过
            {size && ` · ${size}`}
         </p>
      </div>
   );
}

export function WorkDetailPage({ id }: { id: string }) {
   const { info } = useAppInfo();
   const [detail, setDetail] = useState<WorkDetail | null>(null);
   const [error, setError] = useState<{ text: string; status: number } | null>(null);
   const [loading, setLoading] = useState(false);
   const [busy, setBusy] = useState<string | null>(null);
   const [showAllOthers, setShowAllOthers] = useState(false);
   const generation = useRef(0);
   const lastLoad = useRef(0);

   const load = useCallback(async () => {
      const current = ++generation.current;
      lastLoad.current = Date.now();
      setLoading(true);
      try {
         const next = await fetchWorkDetail(id);
         if (current !== generation.current) return;
         setDetail(next);
         setError(null);
      } catch (err) {
         if (current !== generation.current) return;
         setError({ text: errorText(err), status: err instanceof ApiError ? err.status : 0 });
      } finally {
         if (current === generation.current) setLoading(false);
      }
   }, [id]);

   useEffect(() => {
      setDetail(null);
      setError(null);
      void load();
      // 从编辑器、访达改完切回来时重读，新文件和新改动直接出现
      const onFocus = () => {
         if (Date.now() - lastLoad.current > REFRESH_GAP) void load();
      };
      window.addEventListener('focus', onFocus);
      return () => {
         window.removeEventListener('focus', onFocus);
         generation.current += 1;
      };
   }, [id, load]);

   // 新手指引：这一条的数据到齐了再亮按钮；新手指引等到创作页时重新读一次，「打开创作页」才会出来
   useTourDetail(id, detail !== null || error !== null, !!detail?.creation);
   useTourReload(load);

   const act = async (key: string, job: () => Promise<{ message: string }>, after?: () => void) => {
      setBusy(key);
      try {
         toast.success((await job()).message);
         after?.();
      } catch (err) {
         toast.error(`没能做到：${errorText(err)}`);
      } finally {
         setBusy(null);
      }
   };

   const openButton = (ref: string, as: WorkOpenAs, children: ReactNode) => {
      const key = `${as}:${ref}`;
      return (
         <SecondaryButton
            key={key}
            size="small"
            busy={busy === key}
            disabled={busy !== null && busy !== key}
            onClick={() => void act(key, () => openWorkTarget(id, ref, as))}
         >
            {children}
         </SecondaryButton>
      );
   };

   const copyFile = async (file: WorkFile) => {
      setBusy(`copy:${file.ref}`);
      try {
         const text = await fetchWorkText(id, file.ref);
         await copyText(text, `${FILE_KIND_LABEL[file.kind] ?? '稿子'}全文`);
      } catch (err) {
         toast.error(`没能读到正文：${errorText(err)}`);
      } finally {
         setBusy(null);
      }
   };

   if (!detail) {
      return (
         <div>
            <BackLink />
            {error ? (
               <SemBanner tone={error.status === 404 ? 'warn' : 'err'} className="mt-4">
                  {error.status === 404 ? `没有找到 ${id}：可能编号写错了，或者选题总览和选题库里都已经没有它。` : `${id} 暂时读不出来。`}
                  原因：{error.text}
                  <div className="mt-2 flex flex-wrap gap-2">
                     <SecondaryButton size="small" busy={loading} onClick={() => void load()}>
                        重试
                     </SecondaryButton>
                  </div>
               </SemBanner>
            ) : (
               <LoadingLine className="mt-6" />
            )}
         </div>
      );
   }

   const files = detail.files ?? [];
   const shoots = files
      .filter((f) => SHOOT_KINDS.has(f.kind))
      .sort((a, b) => (SHOOT_RANK[a.kind] ?? 9) - (SHOOT_RANK[b.kind] ?? 9) || byNewest(a, b));
   // 创作页在上面单独一行，这里不再列
   const others = files.filter((f) => !SHOOT_KINDS.has(f.kind) && f.kind !== 'creation').sort(byNewest);
   const shownOthers = showAllOthers ? others : others.slice(0, OTHER_PREVIEW);
   const versions = detail.counts?.versions ?? 0;
   const media = detail.counts?.media ?? 0;
   const countLine = [versions ? `${versions} 个旧版本（在「版本」文件夹里）` : '', media ? `${media} 个图片、视频或音频` : '']
      .filter(Boolean)
      .join('，');
   // 没有草稿文件夹时，最近改动只是选题卡的改动时间，容易被读成最近在做，不显示
   const ago = detail.draftDir ? changedAgo(detail.lastModified) : null;
   const done = detail.stage === 'done';
   const creation = detail.creation;

   const facts = (
      [
         detail.publishDate && !detail.stageReason.includes(detail.publishDate) ? { label: '发布日期', value: shortDate(detail.publishDate) } : null,
         detail.effect ? { label: '效果', value: detail.effect } : null,
         !done && detail.plan ? { label: '内容安排', value: `${shortDate(detail.plan.date)}：${detail.plan.text}` } : null,
         !done && detail.deferred
            ? {
                 label: /^\d{4}-\d{1,2}-\d{1,2}$/.test(detail.deferred.date?.trim() ?? '') ? '顺延' : '暂缓',
                 value: detail.deferred.date ? `${detail.deferred.text}，新日期：${shortDate(detail.deferred.date)}` : detail.deferred.text,
              }
            : null,
      ] as (Fact | null)[]
   ).filter((row): row is Fact => row !== null);

   // 其余选题卡信息默认收起，首屏不堆字
   const cardInfo = (
      [
         detail.summary && detail.summary !== detail.title ? { label: '选题总览里写的', value: detail.summary } : null,
         detail.cardStatus && detail.cardStatus !== detail.overviewStatus ? { label: '选题卡状态', value: detail.cardStatus } : null,
         detail.format ? { label: '形式', value: detail.format } : null,
         detail.priority ? { label: '制作优先级', value: detail.priority } : null,
         detail.source ? { label: '来源', value: detail.source } : null,
      ] as (Fact | null)[]
   ).filter((row): row is Fact => row !== null);

   return (
      <div>
         <BackLink />
         <TourHint />
         {error && (
            <SemBanner tone="warn" className="mt-3">
               这次没有读到最新的，下面是上一次读到的。原因：{error.text}
            </SemBanner>
         )}

         <Card large className="mt-4 p-5 min-[721px]:p-6">
            <div className="flex flex-wrap items-center gap-1.5">
               <span className="mr-1 font-mono text-[12px] font-semibold tabular-nums" style={{ color: 'var(--jc-muted)' }}>
                  {detail.id}
               </span>
               {detail.type && <SemBadge tone="gray">{detail.type}</SemBadge>}
               <SemBadge tone={STAGE_TONE[detail.stage] ?? 'gray'}>{STAGE_LABEL[detail.stage] ?? '不知道做到哪一步'}</SemBadge>
               {ago && (
                  <span className="text-[11px]" style={{ color: 'var(--jc-ghost)' }}>
                     {ago}
                  </span>
               )}
            </div>
            <h1 className="mt-2 text-[28px] leading-snug font-bold tracking-[-0.025em] break-words max-[720px]:text-[23px]">{detail.title}</h1>
            {detail.stageReason && (
               <p className="mt-1.5 text-[13px]" style={{ color: 'var(--jc-body)' }}>
                  {detail.stageReason}
               </p>
            )}
            {facts.length > 0 && <FactList rows={facts} className="mt-3" />}
            {detail.issues.length > 0 && (
               <SemBanner tone="warn" className="mt-4">
                  <b>要核对：</b>
                  {detail.issues.join('；')}
               </SemBanner>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
               {creation && (
                  <LinkButton href={creation.url} primary size="small" tour="open-creation" title={`在新标签页打开「${creation.name}」，改的字自动存回这个文件`}>
                     <SquarePen size={14} />
                     打开创作页
                  </LinkButton>
               )}
               {/* 有创作页时稿子以创作页为准，不再把旧的工作稿当成「接着写」（工作稿还在下面的文件里） */}
               {detail.resume && !creation && (
                  <PrimaryButton
                     size="small"
                     busy={busy === 'resume'}
                     disabled={busy !== null && busy !== 'resume'}
                     onClick={() => void act('resume', () => resumeWork(id))}
                     title={`用默认程序打开「${detail.resume.name}」`}
                  >
                     <PenLine size={14} />
                     接着写（{detail.resume.label}）
                  </PrimaryButton>
               )}
               {detail.card && openButton(detail.card.ref, 'default', '打开选题卡')}
               {detail.draftDir ? (
                  openButton(
                     detail.draftDir.ref,
                     'finder',
                     <>
                        <FolderOpen size={14} /> 在访达中打开草稿文件夹
                     </>
                  )
               ) : (
                  <PrimaryButton
                     size="small"
                     busy={busy === 'draft-folder'}
                     disabled={busy !== null && busy !== 'draft-folder'}
                     onClick={() => void act('draft-folder', () => openDraftFolder(id), () => void load())}
                     title={`在内容草稿里建「${detail.id}_选题名」文件夹，并在访达中打开`}
                  >
                     <FolderPlus size={14} /> 建草稿文件夹
                  </PrimaryButton>
               )}
            </div>
            {!detail.draftDir && (
               <p className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--jc-muted)' }}>
                  还没有草稿文件夹。点「建草稿文件夹」，会在内容草稿里建一个「{detail.id}_选题名」文件夹并在访达里打开；稿子放进去，切回这里就会出现。
               </p>
            )}
            {creation ? (
               <p className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--jc-muted)' }}>
                  创作页「{creation.name}」{changedAgo(creation.modifiedAt) ?? ''}。在页面上改的字会自动存回这个文件，AI 也直接读得到；改完回到 AI 那边说一声「改完了」。
               </p>
            ) : (
               !done && (
                  <NextStepBlock label="创作页：" className="mt-4">
                     还没有。把下面这句复制给 Codex 或 Claude Code 发出去，在哪个对话里发都行：AI 会用写稿 Skill 和你写出第一版，做成一个能直接改的网页（左边是参考，右边是你的稿，改的字自动存回文件）。没装好的，AI 会先装好。做好后这里会出现「打开创作页」。
                     <AskAiLine text={askAiText(detail, info.creation.skill)} />
                  </NextStepBlock>
               )
            )}
            {cardInfo.length > 0 && (
               <details className="mt-4 text-[12.5px]">
                  <summary style={{ color: 'var(--jc-muted)' }}>选题卡里的其他信息</summary>
                  <FactList rows={cardInfo} className="mt-2" />
               </details>
            )}
         </Card>

         {/* 上面已经有「在访达中打开草稿文件夹」，这里只说下一步，不再放第二个同样的按钮 */}
         {detail.draftDir && files.length === 0 && (
            <EmptyState
               text="草稿文件夹里还没有能显示的文件"
               hint="点上面的「在访达中打开草稿文件夹」，把稿子放进去：文件名带「工作稿」「初稿」或「逐字稿」的算正在写的稿子，带「定稿」或「提词器」的可以在这里一键复制全文。放好切回这个窗口就会出现。"
            />
         )}

         {/* 拿去拍：提词器版和定稿，一键复制全文 */}
         {shoots.length > 0 && (
            <Block id="shoot" title="拿去拍" count={shoots.length}>
               {shoots.map((file, index) => {
                  const teleprompter = file.kind === 'teleprompter';
                  // 只有排在最前的提词器版用蓝色主按钮，按钮上写清复制的是哪一份
                  const CopyButton = teleprompter && index === 0 ? PrimaryButton : SecondaryButton;
                  return (
                     <Row key={file.ref}>
                        <FileName file={file} />
                        <div className="flex flex-wrap gap-2">
                           {isText(file.name) && (
                              <CopyButton
                                 size="small"
                                 busy={busy === `copy:${file.ref}`}
                                 disabled={busy !== null && busy !== `copy:${file.ref}`}
                                 onClick={() => void copyFile(file)}
                              >
                                 <Copy size={14} /> {teleprompter ? '复制提词器版' : '复制全文'}
                              </CopyButton>
                           )}
                           {openButton(file.ref, 'default', '打开')}
                        </div>
                     </Row>
                  );
               })}
            </Block>
         )}

         {others.length === 0 && countLine && (
            <p className="mt-8 text-[12.5px]" style={{ color: 'var(--jc-muted)' }}>
               草稿文件夹里另有 {countLine}。
            </p>
         )}
         {others.length > 0 && (
            <Block id="files" title="草稿文件夹里的其他文件" count={others.length} note={countLine ? `另有 ${countLine}` : undefined}>
               <>
                  {shownOthers.map((file) => (
                     <Row key={file.ref}>
                        <FileName file={file} />
                        <div className="flex flex-wrap gap-2">
                           {openButton(file.ref, 'default', '打开')}
                           {openButton(file.ref, 'finder', '在访达中显示')}
                        </div>
                     </Row>
                  ))}
                  {others.length > OTHER_PREVIEW && (
                     <div className="px-4 py-2.5">
                        <button
                           type="button"
                           onClick={() => setShowAllOthers((v) => !v)}
                           aria-expanded={showAllOthers}
                           className="text-[12px] font-medium"
                           style={{ color: 'var(--jc-accent)' }}
                        >
                           {showAllOthers ? `收起，只看最近 ${OTHER_PREVIEW} 个` : `展开其余 ${others.length - OTHER_PREVIEW} 个文件`}
                        </button>
                     </div>
                  )}
               </>
            </Block>
         )}
      </div>
   );
}
