// 加选题（lib/topics.mjs、scripts/add-topic.mjs）：编号不重复、只往对应类型的「待做」表末尾加一行、加完工作台认得出来。
// 写稿 Skill「加选题」和页面上「复制给 AI 的话：加选题」都靠它（2026-10-04 加，照提示词标准：加选题不再要用户自己改表格）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
import { addOverviewRow, cardFileName, cardText, cleanTitle, maxUsedNumber } from "../lib/topics.mjs";
import { overviewTemplate } from "../lib/templates.mjs";
import { parseOverview, readWorks, worksLayout } from "../lib/works.mjs";
import { tempHome } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = ["教程", "科普", "口播"];
const config = (home) => loadConfig({ env: {}, home });

function run(home, args) {
  return spawnSync(process.execPath, ["scripts/add-topic.mjs", ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, WORKBENCH_CONFIG_DIR: "" },
    encoding: "utf8",
  });
}

test("编号：只数表格行、选题卡和草稿文件夹名里的；总览开头说明里的 T001 不算", () => {
  const blank = overviewTemplate(config(tempHome()), { example: false });
  assert.match(blank, /T001/, "说明里写着 T001");
  assert.equal(maxUsedNumber({ overview: blank }), 0);
  const overview = `${blank}\n| T007 | x | | 待写 | | |\n`;
  assert.equal(maxUsedNumber({ overview }), 7);
  assert.equal(maxUsedNumber({ overview, names: ["T012_旧草稿", "T12345_五位数不算编号", "说明.md"] }), 12);
});

test("选题名：去掉误带的编号，换行合成空格", () => {
  assert.equal(cleanTitle("  T009：拆一条\n爆款开头 "), "拆一条 爆款开头");
  assert.equal(cleanTitle("T1 不是编号"), "T1 不是编号");
});

test("只往对应类型的「待做」表末尾加一行，别的行一个字不动", () => {
  const before = overviewTemplate(config(tempHome()));
  const after = addOverviewRow(before, "口播", { id: "T002", title: "用 AI 写周报", source: "自己的想法" });
  const a = before.split("\n");
  const b = after.split("\n");
  assert.equal(b.length, a.length + 1);
  const at = b.indexOf("| T002 | 用 AI 写周报 | 自己的想法 | 待写 |  |  |");
  assert.ok(at > 0, after);
  assert.deepEqual([...b.slice(0, at), ...b.slice(at + 1)], a);
  const { rows } = parseOverview(after, TYPES);
  assert.equal(rows.get("T002").type, "口播");
  assert.equal(rows.get("T002").group, "待做");
  // 再加一条同类的，排在它后面
  const again = addOverviewRow(after, "口播", { id: "T003", title: "第二条", source: "参考别人" });
  assert.ok(again.indexOf("| T003 |") > again.indexOf("| T002 |"));
});

test("按那张表自己的表头填；竖线转义；Windows 换行照旧", () => {
  const md = ["## 选题总表", "", "### 口 播", "", "**待做**", "", "| 状态 | 编号 | 选题 | 备注 | 来源 |", "|---|---|---|---|---|", "| 待写 | T001 | 旧的 |  | 自己的想法 |", "", "## 近三天内容安排", ""].join("\r\n");
  const out = addOverviewRow(md, "口播", { id: "T002", title: "a|b", source: "参考别人" });
  assert.match(out, /\| 待写 \| T002 \| a\\\|b \|  \| 参考别人 \|\r\n\r\n## 近三天/);
  assert.ok(!/[^\r]\n/.test(out), "全是 \\r\\n");
  const { rows } = parseOverview(out, ["口播"]);
  assert.equal(rows.get("T002").summary, "a|b");
});

test("还没有这一类、或者这一类下面没有「待做」表：照新建总览的样子补上", () => {
  const md = "# 选题总览\n\n## 选题总表\n\n### 教程\n\n**已做**\n\n| 编号 | 选题 | 来源 | 状态 | 发布日期 | 效果 |\n| --- | --- | --- | --- | --- | --- |\n\n## 顺延事项\n";
  const one = addOverviewRow(md, "教程", { id: "T001", title: "教程这条", source: "自己的想法" });
  const two = addOverviewRow(one, "口播", { id: "T002", title: "口播这条", source: "自己的想法" });
  const { rows } = parseOverview(two, TYPES);
  assert.deepEqual([rows.get("T001").type, rows.get("T001").group], ["教程", "待做"]);
  assert.deepEqual([rows.get("T002").type, rows.get("T002").group], ["口播", "待做"]);
  assert.ok(two.indexOf("### 口播") < two.indexOf("## 顺延事项"), "加在「选题总表」这一节里");
  assert.throws(() => addOverviewRow("# 没有总表\n", "教程", { id: "T001", title: "x", source: "y" }), /选题总表/);
});

test("选题卡：文件名去掉不能用的字、截到 40 个字；原话整段放进备注", () => {
  assert.equal(cardFileName("T002", ' a/b:c*?"<>| '), "T002_a b c.md");
  assert.equal(cardFileName("T002", "..."), "T002_选题.md");
  assert.equal([...cardFileName("T002", "字".repeat(60))].length, "T002_".length + 40 + ".md".length);
  const text = cardText({ id: "T002", title: "用 AI 写周报", source: "自己的想法", audience: "上班族", note: "第一行\n\n第二行" });
  assert.match(text, /^# T002 用 AI 写周报\n/);
  assert.match(text, /- \*\*写给谁\*\*：上班族\n- \*\*解决什么问题\*\*：\n/);
  assert.match(text, /> 第一行\n>\n> 第二行\n$/);
});

test("命令：编号接着往下排、同名不重复加、没有的类型直说；加完工作台认得出来", () => {
  const home = tempHome();
  const first = run(home, ["--title", "用 AI 写周报", "--type", "口播", "--for", "上班族", "--note", "我想做一条讲 AI 写周报的"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /加好了：T002「用 AI 写周报」（口播）/);
  const c = config(home);
  const drafts = c.paths.drafts;
  mkdirSync(path.join(drafts, "T010_以前作废的"), { recursive: true });
  const second = run(home, ["--title", "拆一条爆款开头"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /T011「拆一条爆款开头」（教程）/, "草稿文件夹里出现过的编号不再用；不带类型放第一类");

  const dup = run(home, ["--title", " 用 AI  写周报 ", "--type", "口播"]);
  assert.equal(dup.status, 0);
  assert.match(dup.stdout, /已经有这一条：T002/);
  const wrong = run(home, ["--title", "x", "--type", "访谈"]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /没有「访谈」这一类.*「教程」、「科普」、「口播」/);
  assert.equal(run(home, ["--type", "口播"]).status, 1, "没有选题名不加");

  const works = readWorks(worksLayout(c)).works;
  const t2 = works.find((w) => w.id === "T002");
  assert.deepEqual([t2.type, t2.stage, t2.title, t2.issues], ["口播", "todo", "用 AI 写周报", []]);
  assert.ok(works.find((w) => w.id === "T011"));
  assert.equal(works.filter((w) => w.title === "用 AI 写周报").length, 1);
  const cards = readdirSync(path.join(c.paths.topics, "口播", "待做"));
  assert.deepEqual(cards, ["T002_用 AI 写周报.md"]);
  assert.match(readFileSync(path.join(c.paths.topics, "口播", "待做", cards[0]), "utf8"), /> 我想做一条讲 AI 写周报的/);
});

test("命令：还没启动过工作台也能加（跟 pnpm start 一样先建好工作文件夹，带示例 T001）", () => {
  const home = tempHome();
  const r = run(home, ["--title", "第一条自己的"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /T002「第一条自己的」/);
  const c = config(home);
  assert.ok(existsSync(path.join(c.workFolder, "AGENTS.md")));
});

test("命令：总览里一条都没有时从 T001 开始", () => {
  const home = tempHome();
  const c = config(home);
  mkdirSync(path.dirname(c.paths.overview), { recursive: true });
  writeFileSync(c.paths.overview, overviewTemplate(c, { example: false }));
  const r = run(home, ["--title", "第一条"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /加好了：T001「第一条」/);
});

const SANDBOX = "/usr/bin/sandbox-exec";
test("命令：写不了工作文件夹时直说（Codex 默认只许写打开的文件夹）", { skip: !existsSync(SANDBOX) && "这台电脑没有 sandbox-exec" }, () => {
  const home = tempHome();
  assert.equal(run(home, ["--types"]).status, 0);
  const c = config(home);
  run(home, ["--title", "先建好工作文件夹"]);
  const before = readFileSync(c.paths.overview, "utf8");
  const profile = `(version 1)(allow default)(deny file-write* (subpath "${realpathSync(c.workFolder)}"))`;
  const r = spawnSync(SANDBOX, ["-p", profile, process.execPath, "scripts/add-topic.mjs", "--title", "写不进去的"], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, WORKBENCH_CONFIG_DIR: "" },
    encoding: "utf8",
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /写不了 .*申请写工作文件夹的权限/);
  assert.equal(readFileSync(c.paths.overview, "utf8"), before, "选题总览没被动过");
});
