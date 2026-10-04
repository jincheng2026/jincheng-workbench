#!/usr/bin/env node
// 加一条选题：node scripts/add-topic.mjs --title "选题名" [--type 口播] [--source 自己的想法] [--for 写给谁] [--problem 解决什么问题] [--how 大概怎么讲] [--note 原话]
// 写稿 Skill「加选题」用它：用户把想法发给 AI，AI 整理出选题名和类型，跑这条命令。编号、加在选题总览哪一格、选题卡怎么写都由这里定，
// 不让 AI 手改表格（编错号、加错格、表格断开，工作台就读不到）。加完用工作台自己的读法再读一遍，认得出来才说加好了。
// 一次加一条，几条就跑几次。选题总览里已经有同名的，不重复加，打印已有的编号（AI 重试时不会加出两条）。
// 只看类型：node scripts/add-topic.mjs --types
// 设置和工作文件夹跟 pnpm start 一样：没有就按默认建好（只补缺的，不覆盖已有文件）。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { displayPath, loadConfig } from "../lib/config.mjs";
import { addOverviewRow, cardFileName, cardText, cleanTitle, idOf, maxUsedNumber, namesIn } from "../lib/topics.mjs";
import { parseOverview, readWorks, worksLayout } from "../lib/works.mjs";
import { ensureWorkspace } from "../lib/workspace.mjs";

function bail(text, code = 1) {
  console.error(`没加上：${text}`);
  process.exit(code);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      title: { type: "string" },
      type: { type: "string" },
      source: { type: "string" },
      for: { type: "string" },
      problem: { type: "string" },
      how: { type: "string" },
      note: { type: "string" },
      types: { type: "boolean" },
    },
  }));
} catch (error) {
  bail(`${error.message}。用法：node scripts/add-topic.mjs --title "选题名" [--type 类型] [--source 来源] [--for 写给谁] [--problem 解决什么问题] [--how 大概怎么讲] [--note 原话]`);
}

let config;
try {
  config = loadConfig();
} catch (error) {
  bail(error.message);
}
if (!config.columns.includes("content")) bail("设置里关掉了「内容」栏（columns 里没有 content），工作台不显示选题。");
const typeList = config.contentTypes.map((name) => `「${name}」`).join("、");
if (args.types) {
  console.log(`内容类型：${typeList}。不带 --type 时放进第一类「${config.contentTypes[0]}」。`);
  process.exit(0);
}

const title = cleanTitle(args.title);
if (!title) bail("缺选题名：加 --title \"选题名\"。");
if ([...title].length > 80) bail(`选题名太长（${[...title].length} 个字）：压成一句话，80 个字以内；原话放进 --note。`);
const norm = (text) => String(text ?? "").replace(/\s+/g, "");
const type = args.type ? config.contentTypes.find((name) => norm(name) === norm(args.type)) : config.contentTypes[0];
if (!type) bail(`没有「${args.type}」这一类。现在的内容类型：${typeList}。要加新类型，先改工作台的设置文件（docs/配置说明.md）。`);
const source = String(args.source ?? "").trim() || "自己的想法";

const home = config.home;
const show = (file) => displayPath(file, home);

function writeFailed(error, file) {
  if (["EACCES", "EPERM", "EROFS"].includes(error.code)) {
    bail(
      `写不了 ${show(file)}（${error.code}）。多半是 AI 工具只许这个对话写它打开的文件夹：` +
        "照写稿 Skill「先看能不能写工作文件夹」申请写工作文件夹的权限，或者在打开了工作文件夹的对话里再跑一次。",
    );
  }
  bail(`${show(file)}：${error.message}`);
}

try {
  ensureWorkspace(config);
} catch (error) {
  writeFailed(error, config.workFolder);
}
const layout = worksLayout(config);
let overview;
try {
  overview = readFileSync(config.paths.overview, "utf8");
} catch (error) {
  bail(`读不了选题总览 ${show(config.paths.overview)}：${error.message}`);
}

// 已经有同名的：不重复加
const { rows } = parseOverview(overview, config.contentTypes);
const same = (text) => norm(String(text).replace(/✅/g, "").replace(/\*\*/g, ""));
for (const row of rows.values()) {
  if (same(row.summary) === same(title)) {
    console.log(`选题总览里已经有这一条：${row.id}「${title}」（${row.type}），没有重复加。`);
    process.exit(0);
  }
}

const names = [...namesIn(config.paths.topics, 3), ...namesIn(config.paths.drafts, 1)];
const id = idOf(maxUsedNumber({ overview, names }) + 1);
const topic = { id, title, source };
let updated;
try {
  updated = addOverviewRow(overview, type, topic);
} catch (error) {
  bail(`${error.message}：${show(config.paths.overview)}。照工作文件夹 AGENTS.md「选题总览的格式」改好再加。`);
}

const cardDir = path.join(config.paths.topics, type, "待做");
const card = path.join(cardDir, cardFileName(id, title));
try {
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(card, cardText({ id, title, source, audience: args.for, problem: args.problem, approach: args.how, note: args.note }), {
    encoding: "utf8",
    flag: "wx",
  });
} catch (error) {
  writeFailed(error, card);
}
try {
  // 先写到旁边再换过去：写到一半出错，原来的选题总览不会坏
  const tmp = `${config.paths.overview}.tmp-${process.pid}`;
  writeFileSync(tmp, updated, "utf8");
  renameSync(tmp, config.paths.overview);
} catch (error) {
  writeFailed(error, config.paths.overview);
}

// 用工作台自己的读法再读一遍
const work = readWorks(layout).works.find((item) => item.id === id);
if (!work || work.type !== type || work.stage !== "todo") {
  bail(`写进去了，但工作台没按「${type}」的待写选题认出 ${id}，打开 ${show(config.paths.overview)} 看看 ${id} 那一行。`);
}
console.log(`加好了：${id}「${title}」（${type}）`);
console.log(`- 选题总览：${show(config.paths.overview)}，「${type}」的「待做」表最后一行`);
console.log(`- 选题卡：${show(card)}`);
if (work.issues.length) console.log(`- 工作台提示：${work.issues.join("；")}`);
console.log("工作台「内容」栏的「选题」里能看到它（切回工作台的网页会自动重新读取）。");
