'use client';

// 每一栏现在开着哪个页签：页面（jc/column.tsx 的 ColumnHeader）知道，左边菜单的子菜单要用它标出选中的那一项。
// 地址里不一定带 ?tab=（从左边点栏目进来时打开的是上次看的页签），所以由页面告诉菜单，不让菜单自己去猜。
import { useSyncExternalStore } from 'react';

const current: Record<string, string> = {};
const listeners = new Set<() => void>();

export function setActiveTab(column: string, tab: string) {
   if (current[column] === tab) return;
   current[column] = tab;
   for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
   listeners.add(listener);
   return () => listeners.delete(listener);
}

/** 这一栏现在开着的页签；页面还没告诉过是 null */
export function useActiveTab(column: string): string | null {
   return useSyncExternalStore(
      subscribe,
      () => current[column] ?? null,
      () => null
   );
}
