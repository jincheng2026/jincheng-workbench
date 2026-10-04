// 交给 AI 的话（ui/lib/ask-ai.ts）：页面上「复制给 AI」的每一段，都照「提示词标准」写（原作者 2026-10-03 定，见 AGENTS.md）。
// 能用程序查的几条在这里查：写了目的和做完的样子、带 Skill 名字和仓库地址（没装好先装）、不带这台电脑的路径、
// 用户只在最后贴一处自己知道的东西、要人做的事 AI 到了再提醒。真的发给 AI 跑一遍的验收另做（见 docs/开发记录.md「交给 AI 的话」）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PASTE_HERE,
  askAddAccount,
  askAddTopic,
  askCommentReport,
  askCoverVi,
  askCoverViBatch,
  askCoverViImages,
  askCoverViLink,
  askMakeCovers,
  askResearch,
  askWrite,
} from "../ui/lib/ask-ai.ts";

const brand = JSON.parse(readFileSync(new URL("../brand.json", import.meta.url), "utf8"));
const write = { name: brand.name, repo: brand.repository, skill: `${brand.id}-write` };
const research = { name: brand.name, repo: brand.repository, skill: `${brand.id}-research` };
const cover = { name: brand.name, repo: brand.repository, skill: `${brand.id}-cover` };
const account = { name: "抖音-某某", accountName: "某某", platform: "抖音" };

const all = () => [
  ["写稿", askWrite("T001", write), write],
  ["加选题", askAddTopic(write), write],
  ["评论洞察", askResearch("comments", research), research],
  ["评论洞察（已导入评论表）", askResearch("comments", research, { importedFiles: ["抖音评论.xlsx"] }), research],
  ["生成评论报告", askCommentReport(research, ["抖音评论.xlsx", "小红书.csv"]), research],
  ["视频拆解", askResearch("video", research), research],
  ["账号研究", askResearch("account", research), research],
  ["加对标账号", askAddAccount(research), research],
  ["拆对标账号的封面 VI", askCoverVi(account, cover), cover],
  ["一次全拆", askCoverViBatch([account, { accountName: "某某二", platform: "小红书" }], cover), cover],
  ["拆放进来的那组图", askCoverViImages({ id: "风格/2026-10-04_8张", covers: 8 }, cover), cover],
  ["贴主页链接拆一个博主（没贴）", askCoverViLink(cover), cover],
  ["贴主页链接拆一个博主（页面上贴了）", askCoverViLink(cover, "https://www.douyin.com/user/abc"), cover],
  ["出一批封面", askMakeCovers("T002", cover, { count: 5, size: "横版 2.35:1", style: { id: "抖音-某某", kind: "account", name: "暖黄手写风" }, compositions: ["K03", "K07"], text: "十分钟写完周报" }), cover],
  ["出一批封面（什么都没选）", askMakeCovers("T002", cover), cover],
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
  // 封面（原作者 10-04 定：拆一个博主看最近 20 张；一批默认 5 张；挑和改在 Codex 里，没有「按备注改」的话）
  assert.match(askCoverVi(account, cover), /拆对标账号「某某」（抖音）的封面 VI：看他最近 20 张封面，写成 VI 拆解放进工作台，起好风格名；我还没有默认风格的话，就把它设成默认。做完告诉我他的封面最值得学的几条规律。/);
  assert.match(askCoverViBatch([account, { accountName: "某某二", platform: "小红书" }], cover), /把我还没拆封面 VI 的 2 个对标账号都拆了：「某某」（抖音）、「某某二」（小红书）。每个看他最近 20 张封面.*把第一个拆完的设成默认。做完告诉我每个的风格名和最值得学的几条规律。/);
  assert.match(askCoverViImages({ id: "风格/2026-10-04_8张", covers: 8 }, cover), /拆我放进工作台「封面」里的那组图（风格\/2026-10-04_8张，8 张）：一张张看，写成 VI 拆解放进工作台，起好风格名；不是同一种风格就分开拆、各起名字；/);
  assert.match(
    askMakeCovers("T002", cover, { count: 5, size: "横版 2.35:1", style: { id: "抖音-某某", kind: "account", name: "暖黄手写风" }, compositions: ["K03", "K07"], text: "十分钟写完周报" }),
    /给选题 T002 出一批封面：5 张，横版 2\.35:1；照风格「暖黄手写风」（对标账号「抖音-某某」）出，构图参考它的 K03、K07；封面上的字用「十分钟写完周报」；人物参考图片用我在工作台「封面」里放的。放进这条内容的封面候选，做完告诉我出了几张、哪几张自检有问题。/,
  );
  assert.match(askMakeCovers("T002", cover, { style: { id: "风格/2026-10-04_8张", kind: "images", name: "蓝白大字风" } }), /照风格「蓝白大字风」（我放进来的图「风格\/2026-10-04_8张」）出；/);
  assert.match(askMakeCovers("T002", cover), /出一批封面：5 张，竖版 3:4；照我设的默认风格出；封面上的字用创作页里定好的，没定就用选题名；/);
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
  assert.match(askCoverViLink(cover), /博主的主页链接贴在这句后面：$/);
  assert.match(askCoverViLink(cover, " https://www.douyin.com/user/abc "), /博主的主页链接：https:\/\/www\.douyin\.com\/user\/abc$/, "页面上贴了链接就直接带上，不再让人贴");
  assert.match(askAddTopic(write), /选题（一条或几条都行）贴在这句后面：$/);
});

test("要人做的事，AI 做到那一步再提醒", () => {
  assert.match(askWrite("T001", write), /要我输密码、点允许的时候提醒我。$/);
  assert.match(askAddTopic(write), /要我输密码、点允许的时候提醒我。选题/);
  for (const [name, text, info] of all()) {
    if (info === research) assert.match(text, /要我接 TikHub、导出评论或者同意花钱的时候，停下来告诉我怎么做。/, name);
  }
  // 封面：放人物参考图片、接 TikHub、放封面图这些人做的事到了再提醒
  for (const [name, text, info] of all()) {
    if (info === cover) assert.match(text, /要我放人物参考图片、接 TikHub、放封面图或者点允许的时候，停下来告诉我怎么做。/, name);
  }
});
