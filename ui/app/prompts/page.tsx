import type { Metadata } from 'next';
import { Suspense } from 'react';
import MainLayout from '@/components/layout/main-layout';
import PromptsDashboard from '@/components/workbench/prompts-dashboard';

export const metadata: Metadata = { title: '提示词' };

export default function PromptsPage() {
   return (
      <MainLayout>
         <Suspense fallback={null}>
            <PromptsDashboard />
         </Suspense>
      </MainLayout>
   );
}
