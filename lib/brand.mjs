// 名字只在仓库根目录的 brand.json 里写一次：
// id 用在文件夹名（~/Library/Application Support/<id>、~/Documents/<id>），
// name 是界面上显示的名字，packageName 是 package.json 里的包名。
// 以后改名用 scripts/rename.mjs，一次改完。
import { readFileSync } from "node:fs";

const raw = JSON.parse(readFileSync(new URL("../brand.json", import.meta.url), "utf8"));

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`brand.json 里的 ${field} 必须是一段不为空的文字。`);
  }
  return value.trim();
}

export const BRAND = Object.freeze({
  id: text(raw.id, "id"),
  name: text(raw.name, "name"),
  packageName: text(raw.packageName, "packageName"),
  tagline: typeof raw.tagline === "string" ? raw.tagline.trim() : "",
  holder: typeof raw.copyrightHolder === "string" ? raw.copyrightHolder.trim() : "",
});

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const VERSION = typeof pkg.version === "string" ? pkg.version : "0.0.0";
