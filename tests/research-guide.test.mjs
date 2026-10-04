// 市场调研页的空白引导：什么都没配时说什么、三种调研缺什么、要几分钟、约花多少钱、旁边放什么按钮。
// 页面上的这些话和判断都在 ui/lib/research-guide.ts（只有纯函数），这里直接拿来测。「复制给 AI 的话」本身在 tests/ask-ai.test.mjs。
import test from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_PRICES, costEstimate } from "../lib/data-sources.mjs";
import {
  accountsEmpty,
  balanceText,
  checkAdvice,
  followersText,
  relatedReports,
  reportsEmpty,
  researchCards,
  sourcesLine,
} from "../ui/lib/research-guide.ts";

const cost = costEstimate(FALLBACK_PRICES);
const links = { keys: "https://user.tikhub.io/dashboard/api", addCredit: "https://user.tikhub.io/dashboard/add-credit" };

test("对标账号空白时：一句话说清两种加法（自己加、让 AI 用 TikHub 拉），没接 TikHub 时提醒先接；怎么点就是正下方的两个按钮，不再讲一遍", () => {
  const off = accountsEmpty(false);
  assert.equal(off.text, "还没有对标账号");
  assert.equal(off.hint, "两种加法：自己加，或者让 AI 用 TikHub 拉博主的资料和作品（要先在上面接好 TikHub）。");
  assert.match(off.hint, /要先在上面接好 TikHub/);
  assert.doesNotMatch(accountsEmpty(true).hint, /要先/);
});

test("什么都没配：几种调研都显示；缺东西的变灰，写清缺什么、要几分钟、约花多少钱，按钮是去配；封面 VI 不用 TikHub 也能做", () => {
  const cards = researchCards({ tikhubReady: false, importedComments: 0, cost });
  assert.deepEqual(cards.map((c) => [c.title, c.ready, c.action, c.actionLabel]), [
    ["评论洞察", false, "social", "去导出评论"],
    ["视频拆解", false, "tikhub", "去接 TikHub"],
    ["账号研究", false, "tikhub", "去接 TikHub"],
    ["封面 VI", true, "covers", "拆封面 VI"],
  ]);
  assert.match(cards[3].line, /「内容」栏的「封面」页里拆.*拖进去（哪个平台的都行，不花钱）/);
  assert.match(cards[0].line, /社媒助手.*约 10 分钟，不花钱.*TikHub（约 5 分钟，抖音 200 条评论约 0\.07 到 0\.39 元/);
  assert.equal(cards[1].line, "接好 TikHub 约 5 分钟，拆一条抖音视频不到 1 分钱。");
  assert.equal(cards[2].line, "接好 TikHub 约 5 分钟，拉一个抖音博主 100 条作品约 0.04 元，带上播放量约 0.39 元。");
});

test("接好 TikHub：三种都能做；只导入了评论表：评论洞察能做，另外两种还缺 TikHub", () => {
  const all = researchCards({ tikhubReady: true, importedComments: 0, cost });
  assert.ok(all.slice(0, 3).every((c) => c.ready && c.action === "copy" && c.actionLabel === "复制给 AI 的话"));
  assert.equal(all[3].action, "covers");
  assert.match(all[0].line, /用 TikHub 采少量评论.*要完整的评论区，用社媒助手导出/);
  const onlyComments = researchCards({ tikhubReady: false, importedComments: 1280, cost });
  assert.deepEqual(onlyComments.map((c) => c.ready), [true, false, false, true]);
  assert.equal(onlyComments[0].line, "评论表里已经有 1,280 条评论，可以直接让 AI 做。");
});

test("调研报告空白时：有能做的调研就叫他点卡片上的「复制给 AI 的话」；都还缺东西时先去配，旁边也给一段话", () => {
  const ready = reportsEmpty(true);
  assert.equal(ready.copy, false);
  assert.match(ready.hint, /点它的「复制给 AI 的话」/);
  const none = reportsEmpty(false);
  assert.equal(none.copy, true);
  assert.match(none.hint, /先接好上面的数据来源/);
  // 复制出去的那段话末尾已经写着「…贴在这句后面：」，空白处不再教一遍怎么贴
  for (const hint of [ready.hint, none.hint]) assert.match(hint, /「复制给 AI 的话」粘贴给 AI。/);
});

test("数据来源收起来时的一行和「还差几步」", () => {
  assert.deepEqual(sourcesLine({ tikhubReady: false, balanceText: null, importsLine: null }), { missing: 2, parts: ["TikHub 还没接", "评论表还没导入"] });
  assert.deepEqual(sourcesLine({ tikhubReady: true, balanceText: "余额 $3.20", importsLine: "已导入 12 条评论，来自 1 条视频" }), {
    missing: 0,
    parts: ["TikHub 已接好，余额 $3.20", "评论表已导入 12 条评论，来自 1 条视频"],
  });
});

test("检测 key 的结果：出错时旁边放什么按钮（重新复制 key、打开 TikHub 账户、去充值、重试）", () => {
  assert.deepEqual(checkAdvice({ result: "bad-key" }, links), { tone: "err", action: { label: "重新复制 key", href: links.keys } });
  assert.deepEqual(checkAdvice({ result: "forbidden" }, links), { tone: "warn", action: { label: "打开 TikHub 账户", href: links.keys } });
  assert.deepEqual(checkAdvice({ result: "no-balance" }, links), { tone: "warn", action: { label: "去充值", href: links.addCredit } });
  assert.deepEqual(checkAdvice({ result: "network" }, links), { tone: "err", action: { label: "重试", href: null } });
  assert.deepEqual(checkAdvice({ result: "ok", balance: 3.2, freeCredit: 0 }, links), { tone: "ok", action: null });
  assert.deepEqual(checkAdvice({ result: "ok", balance: 0, freeCredit: 0 }, links).action, { label: "去充值", href: links.addCredit });
  assert.equal(balanceText({ result: "ok", balance: 3.2, freeCredit: 0.05 }), "余额 $3.20（送的额度还剩 $0.05）");
  assert.equal(balanceText({ result: "bad-key" }), null);
});

test("账号卡上的报告：报告的 source 是他的主页链接，或者标题里带他的账号名；粉丝数写成人话", () => {
  const reports = [
    { id: "2026-10-01_某博主拆解", title: "示例博主怎么涨粉", source: "https://www.douyin.com/user/demo?from=share", pages: [] },
    { id: "2026-10-02_评论区", title: "某条视频的评论区", source: "https://www.douyin.com/video/1", pages: [] },
    { id: "2026-10-03_账号", title: "「示例 博主」账号研究", source: null, pages: [] },
  ];
  assert.deepEqual(relatedReports({ accountName: "示例博主", url: "https://douyin.com/user/demo/" }, reports).map((r) => r.id), ["2026-10-01_某博主拆解", "2026-10-03_账号"]);
  assert.deepEqual(relatedReports({ accountName: "x", url: null }, reports), []);
  assert.equal(followersText(12000), "1.2 万粉丝");
  assert.equal(followersText(356000), "36 万粉丝");
  assert.equal(followersText(860), "860 粉丝");
  assert.equal(followersText("3.4w"), "3.4w 粉丝");
  assert.equal(followersText(null), null);
});
