import type { Metadata } from 'next';
import { Toaster } from '@/components/ui/sonner';
import { AppInfoProvider } from '@/components/jc/app-info';
import { APP_NAME, APP_TAGLINE } from '@/lib/app-info';
import { loadAppInfo } from '@/lib/app-info-server';
import './globals.css';

// 每次打开都现读设置（开了哪些栏目、工作文件夹在哪），不在编译时写死。
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
   title: { template: `%s | ${APP_NAME}`, default: APP_NAME },
   description: APP_TAGLINE || '本机运行的锦成工作台',
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
   const { info, reachable } = await loadAppInfo();
   return (
      <html lang="zh-CN">
         <body className="antialiased">
            <AppInfoProvider info={info} reachable={reachable}>
               {children}
            </AppInfoProvider>
            <Toaster position="top-right" duration={3800} />
         </body>
      </html>
   );
}
