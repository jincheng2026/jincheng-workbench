import type { Metadata } from 'next';
import { Suspense } from 'react';
import MainLayout from '@/components/layout/main-layout';
import WorksBoard from '@/components/workbench/works-board';

export const metadata: Metadata = { title: '内容' };

// 「内容」栏：选题、在做两个页签（地址里的 ?tab=）
export default function ContentPage() {
   return (
      <MainLayout>
         <Suspense fallback={null}>
            <WorksBoard />
         </Suspense>
      </MainLayout>
   );
}
