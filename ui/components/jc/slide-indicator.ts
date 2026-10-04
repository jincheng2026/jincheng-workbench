'use client';

// 滑动指示：左边菜单的选中底色、栏目页签下面的蓝线，切换时从上一个位置滑到新位置。
// 换页时整个页面会重新挂载，所以上一个位置记在模块变量里（按 store 分开记），挂载时先摆回旧位置再滑过去。
// 系统打开「减少动态效果」时直接跳到新位置。
import { useLayoutEffect, type RefObject } from 'react';

type Rect = { x: number; y: number; w: number; h: number };
const last: Record<string, Rect> = {};

export function useSlideIndicator(
   container: RefObject<HTMLElement | null>,
   indicator: RefObject<HTMLElement | null>,
   store: string,
   dep: unknown
) {
   useLayoutEffect(() => {
      const box = container.current;
      const ind = indicator.current;
      if (!box || !ind) return;

      const measure = (): Rect | null => {
         const active = box.querySelector<HTMLElement>('[aria-current="page"]');
         if (!active || box.offsetWidth === 0) return null;
         const b = box.getBoundingClientRect();
         const a = active.getBoundingClientRect();
         return { x: a.left - b.left + box.scrollLeft, y: a.top - b.top + box.scrollTop, w: a.width, h: a.height };
      };
      const apply = (r: Rect) => {
         ind.style.transform = `translate(${r.x}px, ${r.y}px)`;
         ind.style.width = `${r.w}px`;
         ind.style.height = `${r.h}px`;
      };
      // 先显示出来（data-slide=on）再摆位置：隐藏着的元素量不到起点，浏览器不会给它播过渡
      const place = (r: Rect) => {
         box.dataset.slide = 'on';
         ind.style.transition = 'none';
         apply(r);
         void ind.offsetWidth;
         ind.style.transition = '';
      };

      const next = measure();
      if (!next) {
         box.dataset.slide = 'off';
         return;
      }
      const prev = last[store];
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prev && !reduce && (prev.x !== next.x || prev.y !== next.y || prev.w !== next.w)) {
         place(prev);
         apply(next);
      } else {
         place(next);
      }
      last[store] = next;

      // 窗口变宽变窄、字体晚到撑宽了页签：跟着挪，不播动画
      // ResizeObserver 开始观察时会先报一次当前尺寸，那一次跳过，免得打断正在播的滑动
      let first = true;
      const follow = () => {
         if (first) {
            first = false;
            return;
         }
         const r = measure();
         if (!r) return;
         place(r);
         last[store] = r;
      };
      const observer = new ResizeObserver(follow);
      observer.observe(box);
      return () => observer.disconnect();
   }, [container, indicator, store, dep]);
}
