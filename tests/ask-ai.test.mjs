// 交给 AI 的话（ui/lib/ask-ai.ts）：页面上「复制给 AI」的每一段，都照「提示词标准」写（原作者 2026-10-03 定，见 AGENTS.md）。
// 能用程序查的几条在这里查：写了目的和做完的样子、带 Skill 名字和仓库地址（没装好先装）、不带这台电脑的路径、
// 用户只在最后贴一处自己知道的东西、要人做的事 AI 到了再提醒。真的发给 AI 跑一遍的验收另做（见 docs/开发记录.md「交给 AI 的话」）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PASTE_HERE, askAddAccount, askAddTopic, askCommentReport, askResearch, askWrite } from "../ui/lib/ask-ai.ts";

const brand = JSON.parse(readFileSync(new URL("../brand.json", import.meta.url), "utf8"));
const write = { name: brand.name, repo: brand.repository, skill: `${brand.id}-write` };
const research = { name: brand.name, repo: brand.repository, skill: `${brand.id}-research` };

const all = () => [
  ["写稿", askWrite("T001", write), write],
  ["加选题", askAddTopic(write), write],
  ["评论洞察", askResearch("comments", research), research],
  ["评论洞察（已导入评论表）", askResearch("comments", research, { importedFiles: ["抖音评论.xlsx"] }), research],
  ["生成评论报告", askCommentReport(research, ["抖音评论.xlsx", "小红书.csv"]), research],
  ["视频拆解", askResearch("video", research), research],
  ["账号研究", askResearch("account", research), research],
  ["加对标账号", askAddAccount(research), research],
];

test("每一段都带 Skill 名字和仓库地址：没装好时 AI 先照安装说明装好，缺什么直接装", () => {
  assert.match(brand.repository, /^https:\/\/github\.com\//, "brand.json 要写 repository");
  for (const [name, text, info] of all()) {
    assert.ok(text.includes(`（${info.skill}）`), `${name}：要写 Skill 的名字`);
    assert.ok(text.includes(`${brand.repository} 里的安装说明`), `${name}：没装好时照哪里装`);
    assert.match(text, /缺什么直接装/, `${name}`);
  }
  // 没有仓库地址（比如改名后忘了写）时也说得通
  assert.match(askWrite("T001", { ...write, repo: "" }), /照 工作台仓库里的安装说明装好/);
});

test("不带这台电脑的路径，不让用户先打开哪个文件夹", () => {
  for (const [name, text] of all()) {
    assert.doesNotMatch(text, /\/Users\/|~\/|\/private\/|工作文件夹是|工作文件夹：/, `${name}：不写这台电脑的路径，位置由 Skill 自己查`);
    assert.doesNotMatch(text, /新开一个对话|打开工作文件夹|打开这个文件夹/, `${name}：不让用户先做准备`);
  }
});

test("写了目的和做完的样子：写成什么、最后告诉用户什么", () => {
  const write1 = askWrite("T001", write);
  assert.match(write1, /把选题 T001 写成第一版逐字稿，做成创作页，做完把创作页的链接发给我/);
  assert.match(askResearch("comments", research), /写成评论洞察报告放进工作台的「市场调研」，做完告诉我结论和能拍的选题/);
  assert.match(askResearch("video", research), /写成视频拆解报告放进工作台的「市场调研」，做完告诉我能借的地方/);
  assert.match(askResearch("account", research), /写成账号研究报告放进工作台的「市场调研」，做完告诉我结论/);
  assert.match(askAddAccount(research), /建好档案，让我在工作台「市场调研」的对标账号里能看到/);
  assert.match(askAddTopic(write), /把我想做的选题加进工作台，让我在工作台「选题」里能看到，做完告诉我每条的编号/);
});

test("用户只在最后贴一处自己知道的东西；中间不留空让人填", () => {
  for (const [name, text] of all()) {
    const n = text.split(PASTE_HERE).length - 1;
    assert.ok(n <= 1, `${name}：「${PASTE_HERE}」最多一处`);
    if (n) assert.ok(text.endsWith(PASTE_HERE), `${name}：要贴的放在最后`);
    assert.doesNotMatch(text, /（在这里|\{\{|（链接）|（主页链接）/, `${name}：中间不留要填的空`);
  }
  // 已经导入了评论表：不用再贴链接，复制、粘贴、发送就行
  assert.ok(!askCommentReport(research, ["抖音评论.xlsx"]).includes(PASTE_HERE));
  assert.match(askCommentReport(research, ["抖音评论.xlsx", "小红书.csv"]), /读我导入工作台的评论表（抖音评论\.xlsx、小红书\.csv）/);
  assert.match(askResearch("video", research), /视频链接贴在这句后面：$/);
  assert.match(askResearch("account", research), /博主的主页链接贴在这句后面：$/);
  assert.match(askAddTopic(write), /选题（一条或几条都行）贴在这句后面：$/);
});

test("要人做的事，AI 做到那一步再提醒", () => {
  assert.match(askWrite("T001", write), /要我输密码、点允许的时候提醒我。$/);
  assert.match(askAddTopic(write), /要我输密码、点允许的时候提醒我。选题/);
  for (const [name, text, info] of all()) {
    if (info === research) assert.match(text, /要我接 TikHub、导出评论或者同意花钱的时候，停下来告诉我怎么做。/, name);
  }
});
