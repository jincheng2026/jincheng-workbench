import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readPromptLibrary, promptsLayout } from "../lib/prompts.mjs";
import { readWorks, worksLayout } from "../lib/works.mjs";
import { ensureWorkspace, restoreOverview } from "../lib/workspace.mjs";
import { tempHome, testConfig } from "./helpers.mjs";

test("第一次启动建好整个工作文件夹：选题库带一条示例、各类型文件夹、内容草稿、提示词示例、给 AI 的说明", () => {
  const config = testConfig();
  const created = ensureWorkspace(config);
  assert.ok(created.length > 10);
  const w = config.workFolder;
  for (const relative of [
    "AGENTS.md",
    "CLAUDE.md",
    "选题库/00_选题总览.md",
    "选题库/教程/待做/T001_示例选题.md",
    "选题库/教程/已做",
    "选题库/科普/待做",
    "选题库/口播/已做",
    "内容草稿",
    "内容草稿/T001_示例选题/参考拆解.md",
    "内容草稿/T001_示例选题/参考素材/参考视频逐字稿.md",
    "写稿方法/README.md",
    "写稿方法/01_写稿流程.md",
    "写稿方法/07_我的判断库.md",
    "市场调研/README.md",
    "市场调研/对标账号",
    "市场调研/调研报告",
    "市场调研/评论导入",
    "提示词/_格式说明.md",
    "提示词/_分类顺序.md",
    "提示词/选题/想十个选题.md",
    "提示词/写稿/口语稿整理成逐字稿.md",
  ]) {
    assert.ok(existsSync(path.join(w, relative)), `应该有 ${relative}`);
  }
  // 回收站用到时才建
  assert.equal(existsSync(path.join(w, "回收站")), false);

  const agents = readFileSync(path.join(w, "AGENTS.md"), "utf8");
  // 开头先说清这里就是工作文件夹：在 AI 里打开这个文件夹的对话一开始就读到
  assert.match(agents.split("\n").slice(0, 4).join("\n"), /这里就是「.+」的工作文件夹，写稿、调研、做封面都在这里做。/);
  assert.match(agents, /「教程」、「科普」、「口播」/);
  assert.match(agents, /`选题库\/00_选题总览\.md`/);
  assert.match(agents, /`内容草稿\/T001_选题名\/`/);
  assert.match(agents, /`回收站\/`/);
  assert.match(readFileSync(path.join(w, "CLAUDE.md"), "utf8"), /^@AGENTS\.md$/m);
  // 写稿和创作页：写稿前先读写稿方法，创作页放在草稿文件夹里、只用 Skill 的命令改
  assert.match(agents, /`写稿方法\/`/);
  assert.match(agents, /`内容草稿\/T001_选题名\/T001_创作页\.html`/);
  assert.match(agents, /jincheng-workbench-write/);
  // 市场调研：三个文件夹写进表里，先读 市场调研/README.md，调研用调研 Skill
  assert.match(agents, /`市场调研\/对标账号\/<平台>-<账号名>\/`/);
  assert.match(agents, /`市场调研\/README\.md`/);
  assert.match(agents, /jincheng-workbench-research/);

  // 建好的东西工作台读得出来：一条示例选题、两条示例提示词，没有要核对的地方
  const works = readWorks(worksLayout(config));
  assert.deepEqual(
    works.works.map((x) => [x.id, x.type, x.stage, x.issues]),
    [["T001", "教程", "todo", []]],
  );
  // 示例选题带着参考材料，但参考材料不算开始写：还在「选题」里，也不拿参考拆解当「接着写」
  assert.equal(works.works[0].draftDir.name, "T001_示例选题");
  assert.equal(works.works[0].resume, null);
  assert.match(readFileSync(path.join(w, "内容草稿/T001_示例选题/参考素材/参考视频逐字稿.md"), "utf8"), /虚构/);
  assert.deepEqual(works.notices, []);
  const library = readPromptLibrary(promptsLayout(config));
  assert.deepEqual(library.prompts.map((p) => p.id), ["选题/想十个选题", "写稿/口语稿整理成逐字稿"]);
  assert.deepEqual(library.issues, []);
});

test("写稿方法：一份说明和七份默认写法，文件里的占位换成写稿 Skill 的名字", () => {
  const config = testConfig();
  ensureWorkspace(config);
  const dir = config.paths.writingMethod;
  const names = ["01_写稿流程.md", "02_选题卡怎么写.md", "03_拆参考怎么拆.md", "04_定叙事.md", "05_口播通用写法.md", "06_改稿建议怎么给.md", "07_我的判断库.md"];
  for (const name of names) {
    const text = readFileSync(path.join(dir, name), "utf8");
    assert.match(text, /^# .+\n\n/, `${name} 开头是标题`);
    assert.doesNotMatch(text, /待填/, `${name} 要有默认正文`);
    assert.ok(text.length > 200, `${name} 正文太短`);
    assert.doesNotMatch(text, /\{\{/, `${name} 里的占位要换掉`);
  }
  const readme = readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(readme, /AI 用写稿 Skill（jincheng-workbench-write）帮你写稿/);
  assert.match(readme, /改了就|下次写稿就按新的来/);
  for (const name of names) assert.match(readme, new RegExp(name.replace(/\./g, "\\.")), `说明里要列出 ${name}`);
  // 删掉一份、再启动：文件夹已经有了，不再补回来（用户删掉的不会再冒出来）
  rmSync(path.join(dir, "07_我的判断库.md"));
  ensureWorkspace(config);
  assert.equal(existsSync(path.join(dir, "07_我的判断库.md")), false);
});

test("再启动只补缺的，不覆盖改过的文件，删掉的示例也不会再冒出来", () => {
  const config = testConfig();
  ensureWorkspace(config);
  const overview = config.paths.overview;
  writeFileSync(overview, "# 我自己的总览\n");
  const example = path.join(config.paths.prompts, "选题", "想十个选题.md");
  rmSync(example);
  rmSync(path.join(config.paths.topics, "科普"), { recursive: true });
  const created = ensureWorkspace(config);
  assert.equal(readFileSync(overview, "utf8"), "# 我自己的总览\n");
  assert.equal(existsSync(example), false);
  // 类型文件夹是结构，缺了就补
  assert.ok(existsSync(path.join(config.paths.topics, "科普", "待做")));
  assert.ok(created.every((item) => item.includes(`${path.sep}科普`)));
});

test("工作文件夹原来就有：不往里写 AGENTS.md，选题库原来就有时总览补一份空白的、不带示例", () => {
  const home = tempHome();
  const work = path.join(home, "已有的文件夹");
  mkdirSync(path.join(work, "选题库"), { recursive: true });
  const config = testConfig({ workFolder: work }, { home });
  ensureWorkspace(config);
  assert.equal(existsSync(path.join(work, "AGENTS.md")), false);
  const overview = readFileSync(config.paths.overview, "utf8");
  assert.match(overview, /## 选题总表/);
  assert.doesNotMatch(overview, /\| T001 \|/);
  assert.equal(existsSync(path.join(config.paths.topics, "教程", "待做", "T001_示例选题.md")), false);
});

test("选题总览被删掉：界面上的「重新建一份」只补总览，不动别的", () => {
  const config = testConfig();
  ensureWorkspace(config);
  rmSync(config.paths.overview);
  assert.throws(() => readWorks(worksLayout(config)), (error) => error.code === "overview-missing");
  assert.deepEqual(restoreOverview(config), [config.paths.overview]);
  assert.deepEqual(restoreOverview(config), []);
  const works = readWorks(worksLayout(config));
  // 示例卡还在，所以 T001 照样显示，只是提醒总览里没有这一行
  assert.deepEqual(works.works.map((x) => [x.id, x.issues]), [["T001", ["选题总览里没有这个编号"]]]);
});

test("设置里关掉的栏目不建它的文件夹；内容类型按设置建", () => {
  const config = testConfig({ columns: ["content"], contentTypes: ["长视频", "图文"] });
  ensureWorkspace(config);
  assert.equal(existsSync(config.paths.prompts), false);
  assert.ok(existsSync(path.join(config.paths.topics, "长视频", "待做", "T001_示例选题.md")));
  assert.ok(existsSync(path.join(config.paths.topics, "图文", "已做")));
  assert.match(readFileSync(config.paths.overview, "utf8"), /### 长视频[\s\S]*### 图文/);
});

test("市场调研：三个文件夹和一份说明；说明写清每个文件夹放什么、两种文件的格式、key 在钥匙串哪一项；删掉说明不会再冒出来", () => {
  const config = testConfig();
  ensureWorkspace(config);
  const readme = path.join(config.workFolder, "市场调研", "README.md");
  const text = readFileSync(readme, "utf8");
  for (const words of [
    "`市场调研/对标账号/`",
    "`市场调研/调研报告/`",
    "`市场调研/评论导入/`",
    "\"account_name\"",
    "\"updated_at\"",
    "\"followers\"",
    "`tikhub` 是 AI 用 TikHub 拉的，`manual` 是手动加的",
    "「评论洞察」「视频拆解」「账号研究」",
    "\"workbenchVisible\": false",
    "服务名 `tikhub-api`，账户名 `tikhub`",
    "TIKHUB_API_KEY",
    "jincheng-workbench-research",
    "社媒助手",
  ]) {
    assert.ok(text.includes(words), `说明里要有：${words}`);
  }
  rmSync(readme);
  rmSync(config.paths.commentImports, { recursive: true });
  const created = ensureWorkspace(config);
  // 评论导入是结构，缺了就补；说明是这一层新建时才写，删掉的不再冒出来
  assert.deepEqual(created, [config.paths.commentImports]);
  assert.equal(existsSync(readme), false);
});

test("市场调研：老用户升级时（工作文件夹早就有）也补上三个文件夹和说明；设置里关掉这一栏就不建", () => {
  const home = tempHome();
  const work = path.join(home, "老的工作文件夹");
  mkdirSync(path.join(work, "选题库"), { recursive: true });
  const config = testConfig({ workFolder: work }, { home });
  ensureWorkspace(config);
  assert.ok(existsSync(path.join(work, "市场调研", "README.md")));
  assert.ok(existsSync(config.paths.benchmarkAccounts));
  const off = testConfig({ columns: ["content", "prompts"] });
  ensureWorkspace(off);
  assert.equal(existsSync(path.join(off.workFolder, "市场调研")), false);
  // 三个文件夹改到了没有共同上一层的地方：照样建文件夹，不写说明
  const spread = testConfig({ paths: { benchmarkAccounts: "对标", researchReports: "报告", commentImports: "评论" } });
  ensureWorkspace(spread);
  assert.ok(existsSync(spread.paths.benchmarkAccounts) && existsSync(spread.paths.commentImports));
  assert.equal(existsSync(path.join(spread.workFolder, "README.md")), false);
});
