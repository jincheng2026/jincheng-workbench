// 封面页上几处纯计算（只引类型，不引别的模块，页面和测试 tests/cover-names.test.mjs 都直接用）。
import type { LibraryCover, LibraryGroup, Style } from '@/lib/covers';

/** 自检那句：全过写「通过」；只出了提示词；其余是问题 */
export function checkTone(check: string | null): 'ok' | 'warn' | 'gray' {
   if (!check) return 'gray';
   if (/^通过/.test(check)) return 'ok';
   if (/只出了提示词/.test(check)) return 'gray';
   return 'warn';
}

/** 风格原图里的 K 编号（K01.jpg → K01），按数字排；还没拆、没改名的图不算 */
export function kIds(images: string[]): string[] {
   return images
      .map((name) => name.match(/^(K\d{2,3})\.(png|jpe?g|webp)$/i)?.[1]?.toUpperCase() ?? null)
      .filter((x): x is string => !!x)
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** 出一批时默认参考哪几张构图：风格里存的默认构图（只留还在的）；没有就取前 5 张 */
export function defaultCompositions(style: Pick<Style, 'images' | 'compositions'> | null): string[] {
   if (!style) return [];
   const have = kIds(style.images);
   const saved = (style.compositions?.ids ?? []).filter((id) => have.includes(id));
   return saved.length ? saved : have.slice(0, 5);
}

/** 「2026-10-04_8张」→「10 月 4 日放的」；认不出就是 null */
function droppedOn(folder: string): string | null {
   const m = folder.match(/^\d{4}-(\d{2})-(\d{2})_/);
   return m ? `${Number(m[1])} 月 ${Number(m[2])} 日放的` : null;
}

/** 风格叫什么：拆好了用风格名；还没拆的说清是谁、几张 */
export function styleName(style: Pick<Style, 'name' | 'kind' | 'accountName' | 'folder' | 'covers'>): string {
   if (style.name) return style.name;
   return style.kind === 'account' ? `「${style.accountName ?? style.folder}」还没拆` : `还没拆的 ${style.covers} 张图`;
}

/** 风格从哪来：对标账号「某某」（抖音）／你放进来的 8 张图（10 月 4 日放的） */
export function styleSource(style: Pick<Style, 'kind' | 'accountName' | 'platform' | 'folder' | 'covers'>): string {
   if (style.kind === 'account') return `对标账号「${style.accountName ?? style.folder}」${style.platform ? `（${style.platform}）` : ''}`;
   const day = droppedOn(style.folder);
   return `你放进来的 ${style.covers} 张图${day ? `（${day}）` : ''}`;
}

export type StyleGroup = { key: string; style: string | null; styleName: string | null; covers: (LibraryCover & { id: string; title: string })[] };

/** 「我的封面」按风格看：同一个风格出的封面放一组（不知道照哪个风格出的放最后一组），组里新的在前 */
export function groupByStyle(groups: LibraryGroup[]): StyleGroup[] {
   const map = new Map<string, StyleGroup>();
   for (const group of groups) {
      for (const cover of group.covers) {
         const key = cover.style ?? '';
         if (!map.has(key)) map.set(key, { key, style: cover.style, styleName: cover.styleName, covers: [] });
         const entry = map.get(key)!;
         if (!entry.styleName && cover.styleName) entry.styleName = cover.styleName;
         entry.covers.push({ ...cover, id: group.id, title: group.title });
      }
   }
   const list = [...map.values()];
   for (const entry of list) entry.covers.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
   const latest = (g: StyleGroup) => g.covers[0]?.modifiedAt ?? '';
   return list.sort((a, b) => Number(!a.style) - Number(!b.style) || latest(b).localeCompare(latest(a)));
}
