'use client';

// 「数据来源」：TikHub、社媒助手两张卡片，放在市场调研页顶部。还差几步时展开，两样都配好以后收成一行状态（随时能展开）。
// TikHub：注册 → 拿 key → 粘贴、「检测并保存」（用免费的查余额接口检测，通过才存进钥匙串）；出错说人话，按钮就在旁边。
// 社媒助手：建一个小号专用的 Chrome 个人资料 → 装插件 → 小号登录 → 导出评论 → 拖进来（认出是评论表才存），第一次导入成功就算配好。
// key 只在「检测并保存」时发给后台一次；页面上只有后四位和余额。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Copy, ExternalLink, FolderOpen, KeyRound, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { useAppInfo } from '@/components/jc/app-info';
import { PlaceButton } from '@/components/jc/place-button';
import { Card, DangerButton, LinkButton, PrimaryButton, SecondaryButton, SemBadge, SemBanner, copyText } from '@/components/jc/ui';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { errorText } from '@/lib/api';
import { askCommentReport } from '@/lib/ask-ai';
import { askInfo } from '@/lib/app-info';
import { balanceText, checkAdvice, sourcesLine, type TikhubCheck } from '@/lib/research-guide';
import {
   checkTikhub,
   connectTikhub,
   deleteTikhubKey,
   importCommentTable,
   type Sources,
} from '@/lib/research';

export type SourcesFocus = { which: 'tikhub' | 'social'; n: number } | null;
type SetSources = (update: (current: Sources) => Sources) => void;

function Step({ n, title, children, action }: { n: number; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
   return (
      <li className="jc-step">
         <span className="jc-step-num" aria-hidden="true">
            {n}
         </span>
         <div className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
               <span className="jc-step-title">{title}</span>
               {action && <span className="flex flex-wrap gap-2">{action}</span>}
            </div>
            {children && <div className="jc-step-note">{children}</div>}
         </div>
      </li>
   );
}

/** 外面的网页：在新标签页打开 */
function OutLink({ href, children, primary = false }: { href: string; children: ReactNode; primary?: boolean }) {
   return (
      <LinkButton href={href} size="small" primary={primary}>
         {children}
         <ExternalLink size={13} aria-hidden="true" />
      </LinkButton>
   );
}

function CardHead({ title, what, badge }: { title: string; what: string; badge: { tone: 'ok' | 'warn' | 'gray'; text: string } }) {
   return (
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
         <div className="min-w-0">
            <h3 className="text-[15px] font-semibold">{title}</h3>
            <p className="mt-0.5 text-[12.5px]" style={{ color: 'var(--jc-muted)' }}>
               {what}
            </p>
         </div>
         <SemBadge tone={badge.tone}>{badge.text}</SemBadge>
      </div>
   );
}

/* ── TikHub ── */

function CheckBanner({
   check,
   links,
   onRetry,
   busy,
}: {
   check: TikhubCheck;
   links: { keys: string; addCredit: string };
   onRetry: () => void;
   busy: boolean;
}) {
   const advice = checkAdvice(check, links);
   return (
      <SemBanner tone={advice.tone} className="mt-3">
         <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{check.message}</span>
            {advice.action &&
               (advice.action.href ? (
                  <OutLink href={advice.action.href}>{advice.action.label}</OutLink>
               ) : (
                  <SecondaryButton size="small" busy={busy} onClick={onRetry}>
                     {advice.action.label}
                  </SecondaryButton>
               ))}
         </div>
      </SemBanner>
   );
}

function TikhubCard({
   sources,
   setSources,
   checking,
   flash,
   inputRef,
}: {
   sources: Sources;
   setSources: SetSources;
   checking: boolean;
   flash: boolean;
   inputRef: React.RefObject<HTMLInputElement | null>;
}) {
   const t = sources.tikhub;
   const [key, setKey] = useState('');
   const [busy, setBusy] = useState<'connect' | 'check' | 'delete' | null>(null);
   const [result, setResult] = useState<TikhubCheck | null>(null);
   const [problem, setProblem] = useState<string | null>(null);
   const [editing, setEditing] = useState(false);
   const [confirming, setConfirming] = useState(false);
   const last = useRef<'connect' | 'check'>('connect');

   const connect = async () => {
      last.current = 'connect';
      if (!key.trim()) {
         setProblem('先把 TikHub 的 key 粘贴进来。');
         inputRef.current?.focus();
         return;
      }
      setBusy('connect');
      setProblem(null);
      try {
         const answer = await connectTikhub(key);
         setResult(answer);
         if (answer.saved) {
            setKey('');
            setEditing(false);
            toast.success('TikHub 接好了，key 存进了这台 Mac 的钥匙串。');
         }
         setSources((s) => ({
            ...s,
            tikhub: { ...s.tikhub, ...answer.status, check: answer.saved ? answer : s.tikhub.check, cost: answer.cost },
         }));
      } catch (error) {
         setResult(null);
         setProblem(errorText(error));
      } finally {
         setBusy(null);
      }
   };

   const check = async () => {
      last.current = 'check';
      setBusy('check');
      setProblem(null);
      try {
         const answer = await checkTikhub();
         setResult(answer);
         setSources((s) => ({ ...s, tikhub: { ...s.tikhub, ...answer.status, check: answer, cost: answer.cost } }));
      } catch (error) {
         setProblem(errorText(error));
      } finally {
         setBusy(null);
      }
   };

   const remove = async () => {
      setBusy('delete');
      try {
         const answer = await deleteTikhubKey();
         toast.success(answer.message);
         setResult(null);
         setConfirming(false);
         setSources((s) => ({ ...s, tikhub: { ...s.tikhub, ...answer.status, check: null } }));
      } catch (error) {
         toast.error(`没删掉：${errorText(error)}`);
      } finally {
         setBusy(null);
      }
   };

   const shown = result ?? t.check;
   const balance = balanceText(t.check);
   const failed = Boolean(shown && shown.result !== 'ok');
   // 检测没通过，或者通过了但余额是 0（要提醒充值）：在下面放一条提示和按钮
   const showBanner = Boolean(shown && (failed || checkAdvice(shown, t.links).action));
   const pasteRow = (
      <div className="mt-2">
         <div className="flex flex-wrap gap-2">
            <label className="jc-search flex min-w-[200px] flex-1 items-center gap-2 rounded-lg border px-3" style={{ borderColor: 'var(--jc-border)', background: 'var(--jc-surface)' }}>
               <KeyRound size={15} aria-hidden="true" style={{ color: 'var(--jc-muted)' }} />
               <input
                  ref={inputRef}
                  type="password"
                  name="tikhub-api-key"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="TikHub 的 API key"
                  placeholder="粘贴 TikHub 的 API key"
                  value={key}
                  onChange={(event) => {
                     setKey(event.target.value);
                     setProblem(null);
                  }}
                  onKeyDown={(event) => {
                     if (event.key === 'Enter') void connect();
                  }}
                  className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
               />
            </label>
            <PrimaryButton busy={busy === 'connect'} disabled={busy !== null && busy !== 'connect'} onClick={() => void connect()}>
               检测并保存
            </PrimaryButton>
            {editing && (
               <SecondaryButton
                  onClick={() => {
                     setEditing(false);
                     setKey('');
                     setProblem(null);
                  }}
               >
                  不换了
               </SecondaryButton>
            )}
         </div>
         {problem && (
            <SemBanner tone="err" className="mt-2">
               {problem}
            </SemBanner>
         )}
      </div>
   );

   return (
      <Card id="tikhub-card" className={`p-5 ${flash ? 'jc-flash' : ''}`}>
         <CardHead
            title="TikHub"
            what="自动拉博主的资料、作品和数据，也能采少量评论"
            badge={!t.configured ? { tone: 'gray', text: '还没接' } : failed ? { tone: 'warn', text: '要处理' } : { tone: 'ok', text: '已接好' }}
         />
         {t.configured ? (
            <>
               <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--jc-ink)' }}>
                  {failed ? 'key 存着，但这次检测没通过：' : balance ? `已接好，${balance}。` : checking ? '已接好，正在查余额……' : '已接好。'}
               </p>
               <p className="mt-1 text-[12px]" style={{ color: 'var(--jc-muted)' }}>
                  {t.source === 'env'
                     ? `用的是环境变量 TIKHUB_API_KEY 里的 key（尾号 ${t.last4}）。`
                     : `key 尾号 ${t.last4}，存在这台 Mac 的钥匙串里，不在任何文件里。`}
               </p>
               {shown && showBanner && (
                  <CheckBanner check={shown} links={t.links} busy={busy !== null} onRetry={() => void (last.current === 'connect' && key ? connect() : check())} />
               )}
               {editing ? (
                  pasteRow
               ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                     <SecondaryButton size="small" busy={busy === 'check'} disabled={busy !== null && busy !== 'check'} onClick={() => void check()}>
                        重新检测
                     </SecondaryButton>
                     <SecondaryButton
                        size="small"
                        disabled={busy !== null}
                        onClick={() => {
                           setEditing(true);
                           setResult(null);
                           window.setTimeout(() => inputRef.current?.focus(), 0);
                        }}
                     >
                        换一个 key
                     </SecondaryButton>
                     {t.source !== 'env' && (
                        <SecondaryButton size="small" disabled={busy !== null} onClick={() => setConfirming(true)}>
                           删除 key
                        </SecondaryButton>
                     )}
                  </div>
               )}
            </>
         ) : (
            <>
               <p className="mb-4 text-[12.5px] leading-relaxed" style={{ color: 'var(--jc-body)' }}>
                  付费的数据接口：用你自己的账号和 key，按调用次数扣钱，没有月费。接好以后，AI 能自动拉博主的资料、作品和播放点赞这些数据，也能快速采少量评论；要完整的评论区，用社媒助手导出。
               </p>
               <ol className="jc-steps">
                  <Step n={1} title="注册 TikHub" action={<OutLink href={t.links.register}>去注册</OutLink>}>
                     要验证邮箱。新号送 {t.newCredit} 美元，只够试抖音；小红书的接口不能用送的额度，做小红书要先充 {t.minTopUp} 美元。
                  </Step>
                  <Step n={2} title="拿 API key" action={<OutLink href={t.links.keys}>去拿 key</OutLink>}>
                     登录后在「API 密钥」页点「创建」，权限范围全部勾上（不勾会用不了），创建好点「复制」。
                  </Step>
                  <Step n={3} title="粘贴到这里，检测通过就存好">
                     先用免费的查余额接口试一下，通过了才存进这台 Mac 的钥匙串，不写进任何文件。
                     {pasteRow}
                     {result && <CheckBanner check={result} links={t.links} busy={busy !== null} onRetry={() => void connect()} />}
                  </Step>
               </ol>
            </>
         )}

         <details className="mt-4 text-[12.5px]" open={!t.configured || undefined}>
            <summary style={{ color: 'var(--jc-muted)' }}>
               大概花多少钱（按 TikHub {t.cost.live ? '刚查到的' : `${Number(t.cost.checkedOn?.slice(5, 7))} 月 ${Number(t.cost.checkedOn?.slice(8, 10))} 日的`}官方单价）
            </summary>
            <ul className="mt-2 grid gap-1 pl-4 leading-relaxed" style={{ color: 'var(--jc-body)', listStyle: 'disc' }}>
               {t.cost.lines.map((line) => (
                  <li key={line}>{line}</li>
               ))}
            </ul>
            <p className="mt-1.5 flex flex-wrap items-center gap-2" style={{ color: 'var(--jc-muted)' }}>
               {t.cost.note}要做小红书或者拉得多，先充值（最低 {t.minTopUp} 美元）。
               <OutLink href={t.links.addCredit}>去充值</OutLink>
            </p>
         </details>

         <Dialog open={confirming} onOpenChange={(open) => !open && busy !== 'delete' && setConfirming(false)}>
            <DialogContent className="max-w-[420px] rounded-2xl p-6" style={{ background: 'var(--jc-surface)' }}>
               <DialogTitle className="text-[16px] font-bold">从钥匙串里删掉 TikHub 的 key？</DialogTitle>
               <DialogDescription className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--jc-muted)' }}>
                  删掉以后 AI 就拉不了数据了；TikHub 账户和余额不受影响，要用时回 TikHub 复制 key 再接一次。
               </DialogDescription>
               <div className="mt-4 flex justify-end gap-2">
                  <SecondaryButton onClick={() => setConfirming(false)} disabled={busy === 'delete'}>
                     不删
                  </SecondaryButton>
                  <DangerButton busy={busy === 'delete'} onClick={() => void remove()}>
                     删除 key
                  </DangerButton>
               </div>
            </DialogContent>
         </Dialog>
      </Card>
   );
}

/* ── 社媒助手 ── */

type ImportLine = { name: string; ok: boolean; text: string };

function SocialCard({ sources, setSources, flash }: { sources: Sources; setSources: SetSources; flash: boolean }) {
   const { info } = useAppInfo();
   const social = sources.social;
   const imports = social.imports;
   const [over, setOver] = useState(false);
   const [busy, setBusy] = useState(false);
   const [lines, setLines] = useState<ImportLine[]>([]);
   const fileRef = useRef<HTMLInputElement>(null);

   // 文件拖到页面别处松手时，浏览器会直接打开那个文件、离开工作台：拦下来
   useEffect(() => {
      const stop = (event: DragEvent) => {
         if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
      };
      window.addEventListener('dragover', stop);
      window.addEventListener('drop', stop);
      return () => {
         window.removeEventListener('dragover', stop);
         window.removeEventListener('drop', stop);
      };
   }, []);

   const upload = async (files: File[]) => {
      if (!files.length) return;
      setBusy(true);
      for (const file of files) {
         try {
            const answer = await importCommentTable(file);
            setLines((old) => [{ name: answer.file, ok: true, text: answer.message }, ...old].slice(0, 6));
            setSources((s) => ({ ...s, social: { ...s.social, imports: answer.imports } }));
         } catch (error) {
            setLines((old) => [{ name: file.name, ok: false, text: `「${file.name}」${errorText(error)}` }, ...old].slice(0, 6));
         }
      }
      setBusy(false);
   };

   const imported = lines.filter((l) => l.ok).map((l) => l.name);
   const tables = imported.length ? imported : imports.tables.filter((t) => t.ok).map((t) => t.name);
   const commentsFolder = info.paths.commentImports ? `「${info.paths.commentImports.split('/').slice(-2).join('/')}」` : '「市场调研/评论导入」';

   const howTo = (
      <ol className="jc-steps">
         <Step n={1} title="建一个小号专用的 Chrome 个人资料">
            Chrome 右上角的头像 → 添加，起名「采集小号」。插件用登录的账号去采，采多了这个账号可能被平台限制，别用你发内容的大号。
         </Step>
         <Step
            n={2}
            title="在这个个人资料里装社媒助手"
            action={
               <>
                  <OutLink href={social.storeUrl}>去 Chrome 商店装</OutLink>
                  <OutLink href={social.downloadUrl}>商店打不开：官网下载</OutLink>
               </>
            }
         >
            装好后点浏览器右上角的拼图图标，把社媒助手固定到工具栏。
         </Step>
         <Step n={3} title="用小号登录小红书、抖音" action={<OutLink href={social.safetyUrl}>官方安全建议</OutLink>}>
            官方建议：小红书一个号每天不超过 200 篇、每次间隔 30 到 60 秒；连续多天触发风控，账号可能被限流甚至封号。
         </Step>
         <Step n={4} title="导出评论">
            打开插件侧边栏的「批量采集」，选「评论」，粘贴笔记或视频链接（一行一个），导出 Excel（CSV、TSV 也行）。
         </Step>
      </ol>
   );

   const dropzone = (
      <div
         className="jc-dropzone"
         data-over={over ? 'true' : undefined}
         onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
         }}
         onDragLeave={() => setOver(false)}
         onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            void upload([...event.dataTransfer.files]);
         }}
      >
         <span className="inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: over ? 'var(--jc-accent)' : 'var(--jc-body)' }}>
            <Upload size={15} aria-hidden="true" />
            {busy ? '正在读这份表……' : imports.configured ? '把新导出的表拖到这里' : '把导出的表拖到这里'}
         </span>
         <span>
            或者{' '}
            <SecondaryButton size="small" disabled={busy} onClick={() => fileRef.current?.click()}>
               选择文件
            </SecondaryButton>
         </span>
         <span className="text-[11.5px]">
            存进{commentsFolder}，认出是评论表才算导入（Excel、CSV、TSV 都行）
         </span>
         <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.csv,.tsv,.json"
            multiple
            className="hidden"
            onChange={(event) => {
               const picked = [...(event.target.files ?? [])];
               event.target.value = '';
               void upload(picked);
            }}
         />
      </div>
   );

   return (
      <Card id="social-card" className={`p-5 ${flash ? 'jc-flash' : ''}`}>
         <CardHead
            title="社媒助手"
            what="用浏览器插件把评论导出成表，再拖进这里"
            badge={imports.configured ? { tone: 'ok', text: '已导入' } : { tone: 'gray', text: '还没导入' }}
         />
         {imports.configured ? (
            <p className="mb-3 text-[13.5px]" style={{ color: 'var(--jc-ink)' }}>
               {imports.line}（{imports.recognized} 份表）。
            </p>
         ) : (
            <p className="mb-4 text-[12.5px] leading-relaxed" style={{ color: 'var(--jc-body)' }}>
               第三方浏览器插件（{social.maker}出品），用你在浏览器里登录的账号批量采评论，免费版就能导出 Excel。要完整的评论区就用它导出：不花钱，也比 TikHub 拉得全。
            </p>
         )}
         {imports.configured ? (
            <details className="mb-3 text-[12.5px]">
               <summary style={{ color: 'var(--jc-muted)' }}>社媒助手怎么用</summary>
               <div className="mt-3">{howTo}</div>
            </details>
         ) : (
            <div className="mb-4">{howTo}</div>
         )}
         <div className={imports.configured ? '' : 'jc-step'}>
            {!imports.configured && (
               <span className="jc-step-num" aria-hidden="true">
                  5
               </span>
            )}
            <div className="min-w-0">
               {!imports.configured && <p className="jc-step-title mb-2">把导出的表拖进来</p>}
               {dropzone}
               {lines.map((line) => (
                  <SemBanner key={`${line.name}:${line.text}`} tone={line.ok ? 'ok' : 'err'} className="mt-2">
                     {line.text}
                  </SemBanner>
               ))}
               {imports.configured && (
                  <div className="mt-3 flex flex-wrap gap-2">
                     <SecondaryButton size="small" onClick={() => void copyText(askCommentReport(askInfo(info, 'research'), tables), '给 AI 的话')} title="复制一段话，粘贴给 Codex 或 Claude Code">
                        <Copy size={14} /> 复制给 AI：生成评论报告
                     </SecondaryButton>
                     <PlaceButton place="commentImports">
                        <FolderOpen size={14} /> 在访达中打开
                     </PlaceButton>
                  </div>
               )}
            </div>
         </div>
         <p className="mt-4 text-[11.5px] leading-relaxed" style={{ color: 'var(--jc-ghost)' }}>
            社媒助手是第三方插件，用你登录的账号去采，所以要用小号；用不用、采多少，风险你自己评估。工作台本身不采集任何平台，只读你导出的表。
         </p>
      </Card>
   );
}

/* ── 整块 ── */

export function DataSources({
   sources,
   setSources,
   open,
   onOpenChange,
   focus,
   checking,
}: {
   sources: Sources;
   setSources: SetSources;
   open: boolean;
   onOpenChange: (open: boolean) => void;
   focus: SourcesFocus;
   checking: boolean;
}) {
   const keyRef = useRef<HTMLInputElement>(null);
   const boxRef = useRef<HTMLElement>(null);
   const [flash, setFlash] = useState<'tikhub' | 'social' | null>(null);
   const summary = sourcesLine({
      tikhubReady: sources.tikhub.configured,
      balanceText: balanceText(sources.tikhub.check),
      importsLine: sources.social.imports.line,
   });

   // 下面的「去接 TikHub」「去导出评论」：展开、滚到那张卡片、闪一下；TikHub 的直接把光标放进粘贴框
   useEffect(() => {
      if (!focus) return;
      const card = document.getElementById(focus.which === 'tikhub' ? 'tikhub-card' : 'social-card');
      card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setFlash(focus.which);
      const timer = window.setTimeout(() => {
         if (focus.which === 'tikhub') keyRef.current?.focus({ preventScroll: true });
         setFlash(null);
      }, 700);
      return () => window.clearTimeout(timer);
   }, [focus]);

   if (!open) {
      return (
         <Card className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <span className="text-[13px] font-semibold">数据来源</span>
            <span className="min-w-0 flex-1 text-[12.5px]" style={{ color: 'var(--jc-muted)' }}>
               {summary.parts.join(' · ')}
            </span>
            <SecondaryButton size="small" onClick={() => onOpenChange(true)}>
               展开 <ChevronDown size={14} />
            </SecondaryButton>
         </Card>
      );
   }

   return (
      <section ref={boxRef} className="mb-7" aria-label="数据来源">
         <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-[15px] font-semibold">
               数据来源
               {summary.missing > 0 && <span className="jc-section-count">还差 {summary.missing} 步</span>}
            </h2>
            <button type="button" className="text-[12.5px] font-medium" style={{ color: 'var(--jc-accent)' }} onClick={() => onOpenChange(false)}>
               {summary.missing > 0 ? '先不配，收起来' : '收起来'}
            </button>
         </div>
         {summary.missing > 0 && (
            <p className="mb-3 text-[12.5px] leading-relaxed" style={{ color: 'var(--jc-muted)' }}>
               两样都没配也能用：手动加对标账号、看报告都不受影响。配好 TikHub 以后，AI 能自动拉博主的作品和数据；导入评论表以后，AI 能分析评论区。
            </p>
         )}
         <div className="grid items-start gap-3 min-[1180px]:grid-cols-2">
            <TikhubCard sources={sources} setSources={setSources} checking={checking} flash={flash === 'tikhub'} inputRef={keyRef} />
            <SocialCard sources={sources} setSources={setSources} flash={flash === 'social'} />
         </div>
         <p className="mt-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--jc-ghost)' }}>
            抖音、小红书的用户协议都限制自动抓取。TikHub 和社媒助手都是第三方服务，用它们的风险请你自己评估。
         </p>
      </section>
   );
}
