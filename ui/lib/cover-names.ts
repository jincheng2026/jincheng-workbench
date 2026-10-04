// 封面页上几处纯计算（不引别的模块，页面和测试 tests/covers.test.mjs 都直接用）。
import type { CoverSettings } from '@/lib/covers';

/** 下一张批注图叫什么：没有就是 封面-03-批注.png，有了接着 -2、-3（和后台起名的规矩一样） */
export function nextNoteName(no: string, latest: string | null): string {
   if (!latest) return `封面-${no}-批注.png`;
   const k = Number(latest.match(/-批注-(\d+)\.png$/)?.[1] ?? 1);
   return `封面-${no}-批注-${k + 1}.png`;
}

/** 「封面设置.json」里的照片是相对封面素材的路径（我的照片/xxx.jpg），页面上只要文件名 */
export function photoName(settings: CoverSettings | null | undefined): string | null {
   const photo = settings?.photo;
   if (!photo) return null;
   const parts = photo.split('/');
   return parts.length === 2 && parts[0] === '我的照片' ? parts[1] : null;
}

/** 自检那句：全过写「通过」；只出了提示词；其余是问题 */
export function checkTone(check: string | null): 'ok' | 'warn' | 'gray' {
   if (!check) return 'gray';
   if (/^通过/.test(check)) return 'ok';
   if (/只出了提示词/.test(check)) return 'gray';
   return 'warn';
}
