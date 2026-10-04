'use client';

// 左边菜单「市场调研」旁的「还差 2 步」：打开页面时用后台给的数（/api/app 的 research.missing），
// 在市场调研页上接好 TikHub、导入评论表以后，页面把新的数告诉这里，菜单马上跟着变，换到别的栏目也是新的。
import { useSyncExternalStore } from 'react';

let latest: number | null = null;
const listeners = new Set<() => void>();

export function setResearchMissing(n: number) {
   if (latest === n) return;
   latest = n;
   for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
   listeners.add(listener);
   return () => listeners.delete(listener);
}

export function useResearchMissing(initial: number): number {
   return useSyncExternalStore(
      subscribe,
      () => latest ?? initial,
      () => initial
   );
}
