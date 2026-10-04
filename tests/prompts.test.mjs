import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  fillPrompt,
  parseCategoryOrder,
  parsePromptFile,
  readPromptLibrary,
  recordPromptUse,
  savePromptOrder,
  setPromptStar,
  trashPrompts,
} from "../lib/prompts.mjs";
import { tempHome, write } from "./helpers.mjs";

const PROMPT = `---
title: 短视频脚本
when: 有了主题，不知道怎么开口
summary: 按主题生成脚本
tags: 内容、脚本
---

主题：{{主题}}
时长：{{时长|30秒 / 60秒}}
再提一次主题：{{ 主题 }}
输出格式：[开头文案]
`;

function fixture() {
  const home = tempHome();
  const dir = path.join(home, "提示词");
  write(path.join(dir, "写稿", "短视频脚本.md"), PROMPT);
  write(path.join(dir, "问题定义.md"), "---\ntitle: 问题定义\n---\n请拆解：{{你的问题}}\n");
  write(path.join(dir, "_格式说明.md"), "# 说明\n不应该被读成提示词");
  write(path.join(dir, "写稿", "空的.md"), "---\ntitle: 空\n---\n\n");
  write(path.join(dir, "_分类顺序.md"), "1. 未分类 — 先想清楚\n2. 写稿 — 再动手\n");
  return { dir, eventsFile: path.join(dir, "_使用记录.jsonl"), trashDir: path.join(home, "回收站") };
}

test("读开头几行和正文：要填的地方去重，方括号不算", () => {
  const parsed = parsePromptFile(PROMPT, "备用名");
  assert.equal(parsed.title, "短视频脚本");
  assert.equal(parsed.when, "有了主题，不知道怎么开口");
  assert.deepEqual(parsed.tags, ["内容", "脚本"]);
  assert.deepEqual(parsed.variables, [{ name: "主题", hint: "" }, { name: "时长", hint: "30秒 / 60秒" }]);
  assert.equal(
    fillPrompt(parsed.body, { 主题: "AI 剪辑", 时长: "60秒" }),
    "主题：AI 剪辑\n时长：60秒\n再提一次主题：AI 剪辑\n输出格式：[开头文案]",
  );
  assert.match(fillPrompt(parsed.body, { 主题: "只填一个" }), /时长：\{\{时长\|30秒 \/ 60秒\}\}/);
  assert.deepEqual(parseCategoryOrder("1. 选题 — 想清楚\n- 写稿：动手\n"), [
    { name: "选题", note: "想清楚" },
    { name: "写稿", note: "动手" },
  ]);
});

test("子文件夹就是分类，说明文件和空正文不列；分类按 _分类顺序.md 排", () => {
  const f = fixture();
  const library = readPromptLibrary(f);
  assert.deepEqual(library.prompts.map((row) => [row.id, row.category, row.useCount]), [
    ["问题定义", "未分类", 0],
    ["写稿/短视频脚本", "写稿", 0],
  ]);
  assert.deepEqual(library.categories.map((row) => row.name), ["未分类", "写稿"]);
  assert.deepEqual(library.issues, ["写稿/空的：正文是空的，没有列出来"]);
  assert.throws(() => readPromptLibrary({ ...f, dir: path.join(f.dir, "没有") }), (error) => error.code === "prompts-missing");
});

test("复制记一次使用，收藏以最后一条为准，都写进同一份记录并读回核对，md 文件不动", () => {
  const f = fixture();
  const file = path.join(f.dir, "写稿", "短视频脚本.md");
  const before = readFileSync(file, "utf8");
  recordPromptUse(f, { id: "写稿/短视频脚本", at: "2026-01-10T10:00:00+08:00" });
  const second = recordPromptUse(f, { id: "写稿/短视频脚本", at: "2026-01-10T11:00:00+08:00" });
  assert.equal(second.prompt.useCount, 2);
  assert.equal(second.prompt.lastUsedAt, "2026-01-10T11:00:00+08:00");
  assert.equal(setPromptStar(f, { id: "问题定义", starred: true }).prompt.starred, true);
  assert.equal(setPromptStar(f, { id: "问题定义", starred: true }).changed, false);
  assert.equal(setPromptStar(f, { id: "问题定义", starred: false }).prompt.starred, false);
  assert.equal(readFileSync(f.eventsFile, "utf8").trim().split("\n").length, 4);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.throws(() => recordPromptUse(f, { id: "不存在/条目" }), /不在文件夹里/);
  assert.throws(() => recordPromptUse(f, { id: "../外面" }), /标识不对/);
});

test("拖动后的顺序写进 _排序.md，以后按它排；文件夹里没有的条目不收", () => {
  const f = fixture();
  const saved = savePromptOrder(f, { ids: ["写稿/短视频脚本", "问题定义"] });
  assert.deepEqual(saved.library.prompts.map((row) => row.id), ["写稿/短视频脚本", "问题定义"]);
  assert.match(readFileSync(path.join(f.dir, "_排序.md"), "utf8"), /1\. 写稿\/短视频脚本\n2\. 问题定义/);
  assert.throws(() => savePromptOrder(f, { ids: ["没有这条"] }), (error) => error.statusCode === 409);
});

test("删除是挪进回收站：文件名前面加日期和分类，记一条删除记录；先全部核对再动文件", () => {
  const f = fixture();
  assert.throws(() => trashPrompts(f, { ids: ["问题定义", "没有这条"] }), (error) => error.statusCode === 404);
  assert.ok(existsSync(path.join(f.dir, "问题定义.md")), "有一条不对时一条都不动");
  const result = trashPrompts(f, { ids: ["写稿/短视频脚本"], at: new Date("2026-01-10T10:00:00+08:00") });
  const moved = path.join(f.trashDir, "2026-01-10_提示词-写稿-短视频脚本.md");
  assert.deepEqual(result.deleted.map((row) => row.trashPath), [moved]);
  assert.equal(readFileSync(moved, "utf8"), PROMPT);
  assert.equal(existsSync(path.join(f.dir, "写稿", "短视频脚本.md")), false);
  assert.deepEqual(result.library.prompts.map((row) => row.id), ["问题定义"]);
  assert.match(readFileSync(f.eventsFile, "utf8"), /"event_type":"prompt_deleted"/);
});
