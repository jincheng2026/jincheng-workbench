import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultSettings } from "../lib/config.mjs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("配置说明里写的默认设置和代码里的一样", () => {
  const block = read("docs/配置说明.md").match(/## 默认设置\n\n```json\n([\s\S]*?)\n```/)?.[1];
  assert.ok(block, "配置说明里要有「## 默认设置」那段 JSON");
  assert.deepEqual(JSON.parse(block), defaultSettings());
});

test("安装说明里写的 pnpm 版本和 package.json 固定的一样", () => {
  const pinned = JSON.parse(read("package.json")).packageManager.replace(/^pnpm@/, "");
  const doc = read("docs/给AI的安装说明.md");
  assert.match(doc, new RegExp(`输出 \`${pinned.replace(/\./g, "\\.")}\``));
  const rest = doc.replace(new RegExp(pinned.replace(/\./g, "\\."), "g"), "").replace(/127\.0\.0\.1/g, "");
  assert.doesNotMatch(rest, /\b\d+\.\d+\.\d+\b/, "安装说明里不要留别的 pnpm 版本号");
});
