// 封面的几个固定名字和「内容」栏卡片上要的一点点封面信息。单独一个文件，lib/works.mjs 和 lib/covers.mjs 都用，免得两边互相引用。
// 文件怎么放见 lib/covers.mjs 开头和 docs/开发记录.md「封面」一节。
import { readdirSync } from "node:fs";
import path from "node:path";

export const COVER_DIR = "封面候选";
export const PHOTO_DIR = "人物参考图片"; // 做封面时 AI 照着它画人（原作者 10-04 改的叫法：按用处叫，不叫「我的照片」）
export const SELECTED_BASE = "封面-选定";
export const COVER_NAME = /^封面-(\d{2,3})\.(png|jpe?g|webp)$/i;
export const SELECTED_NAME = /^封面-选定\.(png|jpe?g|webp)$/i;

function safeEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 草稿文件夹最外层的封面文件（封面候选/ 和 封面-选定.*）：草稿扫描不把它们当稿子、不算进「最近有改动」 */
export function isCoverEntry(name, isDirectory) {
  return isDirectory ? name === COVER_DIR : SELECTED_NAME.test(name);
}

/** 几张候选、选定的那张叫什么（不读生成记录，便宜）；都没有时是 null */
export function coverSummary(draftsDir, dirName) {
  if (!dirName) return null;
  const folder = path.join(draftsDir, dirName);
  const candidates = safeEntries(path.join(folder, COVER_DIR)).filter((entry) => entry.isFile() && COVER_NAME.test(entry.name)).length;
  const selected = safeEntries(folder).find((entry) => entry.isFile() && SELECTED_NAME.test(entry.name))?.name ?? null;
  return candidates || selected ? { candidates, selected } : null;
}
