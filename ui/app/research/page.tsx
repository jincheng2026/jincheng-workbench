import type { Metadata } from 'next';
import { Suspense } from 'react';
import MainLayout from '@/components/layout/main-layout';
import ResearchBoard from '@/components/workbench/research-board';

export const metadata: Metadata = { title: '市场调研' };

// 「市场调研」栏：对标账号、调研报告两个页签（地址里的 ?tab=），上面是数据来源（TikHub、社媒助手）
export default function ResearchPage() {
   return (
      <MainLayout>
         <Suspense fallback={null}>
            <ResearchBoard />
         </Suspense>
      </MainLayout>
   );
}
