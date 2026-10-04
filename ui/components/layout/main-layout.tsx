import React from 'react';
import { JcShell } from '@/components/jc/shell';

// 每个页面自己包一层外框：换到另一个栏目时外框重新挂载，左边菜单的底色和整页淡入才有动效。
export default function MainLayout({ children }: { children: React.ReactNode }) {
   return <JcShell>{children}</JcShell>;
}
