'use client';

// 交给 AI 的一组按钮：这台 Mac 上有 Codex 桌面版，就放「在 Codex 里……」，点了新开一个对话（开在工作文件夹里），
// 要说的话已经填好，按回车就行；没有 Codex、有 Claude Code 的，放「在 Claude Code 里……」。旁边一直留「复制给 AI」，用别的 AI 工具的人复制去发。
// 链接的写法、这台 Mac 上有没有程序接这种链接，和新手指引第 3 步是同一套（lib/tour-steps.ts 的 AI_LINKS、availableAiLinks）。
// 原作者 2026-10-04 定：拆封面 VI 这类要看图的活，尽量直接调 Codex 桌面版（命令行很多人看不明白，看图片、视频也不方便）。
import { AppWindow, Copy, SquareTerminal } from 'lucide-react';
import { useAppInfo } from '@/components/jc/app-info';
import { copyText } from '@/components/jc/ui';
import { availableAiLinks, type AiLink } from '@/lib/tour-steps';

const AFTER_COPY = '粘贴给 Codex 或 Claude Code，发出去。';

/** {路径} 换成工作文件夹、{话} 换成要说的话，都按网址编码；工作文件夹不知道时不给链接 */
export function aiLinkUrl(app: AiLink, folder: string, text: string) {
   if (!folder) return '';
   return app.url.replaceAll('{路径}', encodeURIComponent(folder)).replaceAll('{话}', encodeURIComponent(text));
}

/** 只放一个打开按钮：Codex 在前（原作者 10-03 定：大部分人用的是 Codex），没有 Codex 再放 Claude Code */
export function useOpenLink(text: string): { app: AiLink; url: string } | null {
   const { info, reachable } = useAppInfo();
   const folder = reachable ? info.workFolder : '';
   for (const app of availableAiLinks(info.aiLinks)) {
      const url = aiLinkUrl(app, folder, text);
      if (url) return { app, url };
   }
   return null;
}

export function OpenInAi({
   text,
   action,
   what,
   size = 'small',
   variant = 'button',
   tour,
}: {
   /** 要交给 AI 的那句话 */
   text: string;
   /** 按钮上写的动作，比如「拆封面 VI」：按钮写成「在 Codex 里拆封面 VI」「复制给 AI：拆封面 VI」 */
   action: string;
   /** 复制成功时的提示里叫它什么，比如「拆封面 VI 的话」 */
   what: string;
   size?: 'regular' | 'small';
   /** link：卡片里一行小字那种，写成两个蓝色的字链接，不占按钮的高度 */
   variant?: 'button' | 'link';
   tour?: string;
}) {
   const link = useOpenLink(text);
   if (variant === 'link') {
      return (
         <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1" data-tour={tour}>
            {link && (
               <a href={link.url} className="font-medium" style={{ color: 'var(--jc-accent)' }} title={link.app.note} data-open-in={link.app.id}>
                  在 {link.app.name} 里{action}
               </a>
            )}
            <button
               type="button"
               className="font-medium"
               style={{ color: 'var(--jc-accent)' }}
               title="复制一段话，粘贴给 Codex 或 Claude Code"
               onClick={() => void copyText(text, what, { next: AFTER_COPY })}
            >
               {link ? '复制给 AI 的话' : `复制给 AI：${action}`}
            </button>
         </span>
      );
   }
   const height = size === 'small' ? 33 : 37;
   const fontSize = size === 'small' ? 12.5 : 13;
   const copy = () => void copyText(text, what, { next: AFTER_COPY });
   return (
      <span className="inline-flex flex-wrap items-center gap-2" data-tour={tour}>
         {link && (
            <a
               href={link.url}
               className="jc-button jc-button-primary inline-flex items-center justify-center gap-2 px-4 font-semibold no-underline hover:no-underline"
               style={{ height, fontSize, color: '#fff' }}
               title={link.app.note}
               data-open-in={link.app.id}
            >
               {link.app.app === 'terminal' ? <SquareTerminal size={14} aria-hidden="true" /> : <AppWindow size={14} aria-hidden="true" />}
               在 {link.app.name} 里{action}
            </a>
         )}
         <button
            type="button"
            onClick={copy}
            title="复制一段话，粘贴给 Codex 或 Claude Code"
            className={`jc-button ${link ? 'jc-button-secondary px-3.5 font-medium' : 'jc-button-primary px-4 font-semibold'} inline-flex items-center justify-center gap-2`}
            style={{ height, fontSize }}
         >
            <Copy size={14} aria-hidden="true" />
            {link ? '复制给 AI 的话' : `复制给 AI：${action}`}
         </button>
      </span>
   );
}
