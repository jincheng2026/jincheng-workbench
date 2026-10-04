import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

// 名字和署名只在 brand.json 写一次；别的地方用到的必须跟它一致（改名用 scripts/rename.mjs 一次改完）
test("package.json 的包名、LICENSE 的署名都和 brand.json 一致", () => {
  const brand = JSON.parse(read("brand.json"));
  assert.equal(JSON.parse(read("package.json")).name, brand.packageName);
  assert.equal(JSON.parse(read("ui/package.json")).name, `${brand.packageName}-ui`);
  assert.match(read("LICENSE"), new RegExp(`^Copyright \\(c\\) ${brand.copyrightYear} ${brand.copyrightHolder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
});

test("界面改自的 circle 的 MIT 版权声明原样保留", () => {
  const notice = read("ui/LICENSE.md");
  assert.match(notice, /^MIT License/);
  assert.match(notice, /Copyright \(c\) 2025 lndev-ui \| Circle Template/);
});
