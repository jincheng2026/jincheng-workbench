'use client';

// 栏目页头：栏目名、一排页签（每个页签是一个地址）、当前页签的一句说明和操作。栏目本身登记在 lib/columns.ts。
// 切页签时：蓝线从上一个页签滑过来，页签下面的内容淡入并微微上浮（栏目名和页签不动）。
// 页签上的 data-tour="tab-<页签>" 给新手指引找位置用（lib/tour-steps.ts）。
import Link from 'next/link';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useSlideIndicator } from '@/components/jc/slide-indicator';
import { LoadingLine } from '@/components/jc/ui';
import { COLUMNS, type ColumnKey } from '@/lib/columns';

export { COLUMNS, type ColumnKey };

function replay(el: HTMLElement | null | undefined, cls: string) {
   if (!el) return;
   el.classList.remove(cls);
   void el.offsetWidth;
   el.classList.add(cls);
}

export function ColumnHeader({
   column,
   tab,
   description,
   right,
   ready = true,
   loadingText = '正在读取……',
}: {
   column: ColumnKey;
   tab: string;
   description: ReactNode;
   right?: ReactNode;
   /**
    * 页面数据到齐了没有。没到齐时页签下面只放一行「正在读取……」（0.3 秒内就到了就不出现），
    * 页面自己这时不放内容；到齐那一刻内容一次浮上来，免得一块块蹦出来把下面挤走。
    */
   ready?: boolean;
   /** 没到齐时那一行写什么 */
   loadingText?: string;
}) {
   const def = COLUMNS[column];
   const tabsRef = useRef<HTMLElement>(null);
   const lineRef = useRef<HTMLSpanElement>(null);
   useSlideIndicator(tabsRef, lineRef, `tabs:${column}`, tab);

   // 换页签：说明那一行上浮一次（同一个页面里换页签也会重播）
   useLayoutEffect(() => {
      replay(tabsRef.current?.parentElement, 'jc-intro-enter');
   }, [tab]);
   // 下面的内容：到齐那一刻整体浮上来（换页签也重播）
   useLayoutEffect(() => {
      if (ready) replay(tabsRef.current?.parentElement, 'jc-content-enter');
   }, [tab, ready]);

   return (
      <>
         <header className="jc-page-header jc-column-header">
            <div className="min-w-0">
               <h1>{def.title}</h1>
            </div>
         </header>
         <nav ref={tabsRef} className="jc-column-tabs" aria-label={`${def.title}的页签`}>
            <span ref={lineRef} className="jc-column-tabs-line" aria-hidden="true" />
            {def.tabs.map((t) => (
               <Link key={t.key} href={t.href} aria-current={t.key === tab ? 'page' : undefined} scroll={false} data-tour={`tab-${t.key}`}>
                  {t.label}
               </Link>
            ))}
         </nav>
         <div className="jc-column-intro">
            <p className="jc-page-description">{description}</p>
            {right && <div className="jc-page-actions">{right}</div>}
         </div>
         {!ready && <LoadingLine text={loadingText} />}
      </>
   );
}
