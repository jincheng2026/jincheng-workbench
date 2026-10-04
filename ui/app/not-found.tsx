import { redirect } from 'next/navigation';

// 没有这个地址：回首页
export default function NotFound() {
   redirect('/');
}
