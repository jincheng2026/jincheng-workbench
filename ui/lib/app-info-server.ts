// 只在服务端用：每次打开页面时向接口要一次工作台的基本信息（同一次请求里只要一次）。
import { cache } from 'react';
import { fallbackAppInfo, type AppInfo } from '@/lib/app-info';

export const loadAppInfo = cache(async (): Promise<{ info: AppInfo; reachable: boolean }> => {
   const origin = (process.env.WORKBENCH_API_ORIGIN || 'http://127.0.0.1:18878').replace(/\/+$/, '');
   try {
      const response = await fetch(`${origin}/api/app`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { info: (await response.json()) as AppInfo, reachable: true };
   } catch {
      return { info: fallbackAppInfo(), reachable: false };
   }
});
