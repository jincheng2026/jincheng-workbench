'use client';

// 工作台通用组件：按钮、卡片、徽章、提示条、空白时的样子。视觉沿用原工作台（macOS 风格浅色）。
import { toast } from 'sonner';
import type { CSSProperties, ReactNode } from 'react';
import { useTildify } from '@/components/jc/app-info';

/* 页头：标题和一句说明 */
export function PageHeader({
   title,
   description,
   right,
}: {
   title: string;
   description: ReactNode;
   right?: ReactNode;
}) {
   return (
      <header className="jc-page-header">
         <div className="min-w-0">
            <h1>{title}</h1>
            <p className="jc-page-description">{description}</p>
         </div>
         {right && <div className="jc-page-actions">{right}</div>}
      </header>
   );
}

/* ── 卡片 ── */
export function Card({
   id,
   children,
   className = '',
   large = false,
   style,
   work,
}: {
   id?: string;
   children: ReactNode;
   className?: string;
   large?: boolean;
   style?: CSSProperties;
   /** 这张卡是哪条内容（data-work，新手指引找示例选题用） */
   work?: string;
}) {
   return (
      <section id={id} className={`jc-card ${large ? 'jc-card-large' : ''} ${className}`} style={style} data-work={work}>
         {children}
      </section>
   );
}

/* ── 转圈：12–15px 圆环 ── */
export function Spinner({ size = 14, className = '' }: { size?: number; className?: string }) {
   return (
      <span
         className={`inline-block shrink-0 rounded-full align-[-2px] ${className}`}
         role="status"
         aria-label="处理中"
         style={{
            width: size,
            height: size,
            border: '2px solid var(--jc-soft)',
            borderTopColor: 'var(--jc-accent)',
            animation: 'jcspin .7s linear infinite',
         }}
      />
   );
}

/* ── 正在读取：数据还没到时放在内容的位置（小转圈加一行字）。0.3 秒内就到了就不出现，免得一闪 ── */
export function LoadingLine({ text = '正在读取……', className = '' }: { text?: string; className?: string }) {
   return (
      <p className={`jc-loading ${className}`} role="status">
         <span className="inline-flex" aria-hidden="true">
            <Spinner size={14} />
         </span>
         {text}
      </p>
   );
}

/* ── 按钮：蓝色主操作 / 白底次操作 / 危险确认；busy 时自带转圈并禁用 ── */
type BtnProps = {
   children: ReactNode;
   onClick?: () => void;
   disabled?: boolean;
   busy?: boolean;
   size?: 'hero' | 'primary' | 'regular' | 'small';
   className?: string;
   title?: string;
   /** 给新手指引找按钮用的记号（data-tour），见 lib/tour-steps.ts */
   tour?: string;
};

const BTN_H = { hero: 44, primary: 40, regular: 37, small: 33 } as const;
const BTN_FS = { hero: 14.5, primary: 14, regular: 13, small: 12.5 } as const;

function Button({ children, onClick, disabled, busy, size = 'regular', className = '', title, tour, tone }: BtnProps & { tone: string }) {
   return (
      <button
         type="button"
         title={title}
         data-tour={tour}
         onClick={onClick}
         disabled={disabled || busy}
         aria-busy={busy || undefined}
         className={`jc-button ${tone} inline-flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
         style={{ height: BTN_H[size], fontSize: BTN_FS[size] }}
      >
         {busy && <Spinner size={13} />}
         {children}
      </button>
   );
}

export function PrimaryButton(props: BtnProps) {
   return <Button {...props} tone="jc-button-primary px-4 font-semibold" />;
}

export function SecondaryButton(props: BtnProps) {
   return <Button {...props} tone="jc-button-secondary px-3.5 font-medium" />;
}

export function DangerButton(props: BtnProps) {
   return <Button {...props} tone="jc-button-danger px-3.5 font-semibold" />;
}

/* 长得像按钮的链接：在新标签页打开一个网页（例如创作页）。点了直接打开，不经过后台，浏览器不会当成弹窗拦掉 */
export function LinkButton({
   href,
   children,
   primary = false,
   size = 'regular',
   title,
   tour,
}: {
   href: string;
   children: ReactNode;
   primary?: boolean;
   size?: 'primary' | 'regular' | 'small';
   title?: string;
   /** 给新手指引找按钮用的记号（data-tour），见 lib/tour-steps.ts */
   tour?: string;
}) {
   return (
      <a
         href={href}
         target="_blank"
         rel="noopener"
         title={title}
         data-tour={tour}
         className={`jc-button ${primary ? 'jc-button-primary px-4 font-semibold' : 'jc-button-secondary px-3.5 font-medium'} inline-flex items-center justify-center gap-2 no-underline hover:no-underline`}
         style={{ height: BTN_H[size], fontSize: BTN_FS[size], color: primary ? '#fff' : 'var(--jc-body)' }}
      >
         {children}
      </a>
   );
}

/* ── 徽章 ── */
export function SemBadge({ tone, children }: { tone: 'ok' | 'warn' | 'err' | 'accent' | 'gray'; children: ReactNode }) {
   const map = {
      ok: { bg: 'var(--jc-ok-bg)', fg: 'var(--jc-ok)' },
      warn: { bg: 'var(--jc-warn-bg)', fg: 'var(--jc-warn)' },
      err: { bg: 'var(--jc-err-bg)', fg: 'var(--jc-err)' },
      accent: { bg: 'var(--jc-accent-bg)', fg: 'var(--jc-accent)' },
      gray: { bg: 'var(--jc-soft)', fg: '#667085' },
   }[tone];
   return (
      <span
         className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap"
         style={{ background: map.bg, color: map.fg }}
      >
         {children}
      </span>
   );
}

/* ── 空白时的样子：说清现在是什么情况、下一步做什么，旁边就放能点的操作 ── */
export function EmptyState({ text, hint, actions }: { text: string; hint?: ReactNode; actions?: ReactNode }) {
   return (
      <div className="jc-empty-state">
         <p className="text-[14px] font-medium" style={{ color: 'var(--jc-body)' }}>
            {text}
         </p>
         {hint && (
            <p className="mx-auto mt-1.5 max-w-[520px] text-[12.5px] leading-relaxed" style={{ color: 'var(--jc-muted)' }}>
               {hint}
            </p>
         )}
         {actions && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
      </div>
   );
}

/* ── 提示条：出错 / 成功 / 提醒，就放在出事的地方 ── */
export function SemBanner({
   tone,
   children,
   className = '',
}: {
   tone: 'ok' | 'warn' | 'err' | 'accent';
   children: ReactNode;
   className?: string;
}) {
   const map = {
      ok: { bg: 'var(--jc-ok-bg)', fg: 'var(--jc-ok)', bd: 'var(--jc-ok-bd)' },
      warn: { bg: 'var(--jc-warn-bg)', fg: 'var(--jc-warn)', bd: 'var(--jc-warn-bd)' },
      err: { bg: 'var(--jc-err-bg)', fg: 'var(--jc-err)', bd: 'var(--jc-err-bd)' },
      accent: { bg: 'var(--jc-accent-bg)', fg: 'var(--jc-accent)', bd: 'var(--jc-accent-bd)' },
   }[tone];
   return (
      <div
         className={`rounded-[10px] px-3.5 py-2.5 text-[12.5px] leading-relaxed ${className}`}
         style={{ background: map.bg, color: map.fg, border: `1px solid ${map.bd}` }}
      >
         {children}
      </div>
   );
}

/* ── 浅蓝底「下一步」块（label 可以换成别的开头，比如「创作页：」） ── */
export function NextStepBlock({ children, className = '', label = '下一步：' }: { children: ReactNode; className?: string; label?: string }) {
   return (
      <div
         className={`rounded-[10px] px-3.5 py-3 text-[13px] leading-relaxed ${className}`}
         style={{ background: 'var(--jc-accent-bg)', border: '1px solid var(--jc-accent-bd)', color: 'var(--jc-ink)' }}
      >
         <b style={{ color: 'var(--jc-accent)' }}>{label}</b>
         {children}
      </div>
   );
}

/* ── 复制：单击复制并提示（quiet：按钮自己会显示「已复制」，成功时不再弹提示；失败照样提示。next：提示下面再说一句接下来做什么） ── */
export function copyText(text: string, label = '内容', { quiet = false, next }: { quiet?: boolean; next?: string } = {}) {
   return navigator.clipboard
      .writeText(text)
      .then(() => {
         if (!quiet) toast.success(`${label}已复制`, next ? { description: next } : undefined);
         return true;
      })
      .catch(() => {
         toast.error('复制没成功，请手动选中复制');
         return false;
      });
}

/* 路径：单击复制完整路径 */
export function CopyPath({ path, className = '' }: { path: string; className?: string }) {
   const tildify = useTildify();
   return (
      <button
         type="button"
         className={`inline-flex max-w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left font-mono text-[11px] transition-colors duration-150 hover:text-[var(--jc-accent)] ${className}`}
         style={{ color: 'var(--jc-ghost)' }}
         title={`${path}\n单击复制完整路径`}
         onClick={() => void copyText(path, '路径')}
      >
         <span className="truncate">{tildify(path)}</span>
      </button>
   );
}

export function fmtClock(iso: string | null | undefined): string {
   if (!iso) return '—';
   const d = new Date(iso);
   if (Number.isNaN(d.getTime())) return '—';
   const p = (n: number) => String(n).padStart(2, '0');
   return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDateTime(iso: string | null | undefined): string {
   if (!iso) return '—';
   const d = new Date(iso);
   if (Number.isNaN(d.getTime())) return String(iso);
   const p = (n: number) => String(n).padStart(2, '0');
   return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDate(iso: string | null | undefined): string {
   if (!iso) return '—';
   const d = new Date(iso);
   if (Number.isNaN(d.getTime())) return String(iso);
   return `${d.getMonth() + 1}月${d.getDate()}日`;
}
