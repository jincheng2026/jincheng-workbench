import { redirect } from 'next/navigation';
import { COLUMNS } from '@/lib/columns';
import { loadAppInfo } from '@/lib/app-info-server';

// 首页：跳到设置里打开的第一个栏目
export default async function Home() {
   const { info } = await loadAppInfo();
   const first = info.columns.find((key) => key in COLUMNS) ?? 'content';
   redirect(COLUMNS[first].href);
}
