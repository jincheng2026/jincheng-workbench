import type { Metadata } from 'next';
import MainLayout from '@/components/layout/main-layout';
import { WorkDetailPage } from '@/components/workbench/work-detail';

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
   const { id } = await params;
   return { title: decodeURIComponent(id) };
}

// 一条内容的详情：整页打开，手机上可以返回
export default async function WorkDetailRoute({ params }: Params) {
   const { id } = await params;
   return (
      <MainLayout>
         <WorkDetailPage id={decodeURIComponent(id)} />
      </MainLayout>
   );
}
