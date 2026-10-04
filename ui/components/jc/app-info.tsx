'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { fallbackAppInfo, tildify, type AppInfo } from '@/lib/app-info';

const AppInfoContext = createContext<{ info: AppInfo; reachable: boolean }>({
   info: fallbackAppInfo(),
   reachable: false,
});

export function AppInfoProvider({
   info,
   reachable,
   children,
}: {
   info: AppInfo;
   reachable: boolean;
   children: ReactNode;
}) {
   return <AppInfoContext.Provider value={{ info, reachable }}>{children}</AppInfoContext.Provider>;
}

export function useAppInfo() {
   return useContext(AppInfoContext);
}

/** 把本机路径写成 ~/… 的样子 */
export function useTildify() {
   const { info } = useAppInfo();
   return (target: string) => tildify(target, info.home);
}
