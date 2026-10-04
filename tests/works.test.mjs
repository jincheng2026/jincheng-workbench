import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, utimesSync } from "node:fs";
import path from "node:path";
import {
  createDraftFolder,
  openDraftFolder,
  openWorkTarget,
  parseOverview,
  readWorkDetail,
  readWorkText,
  readWorks,
  resumeWork,
} from "../lib/works.mjs";
import { fakeOpener, tempHome, write } from "./helpers.mjs";

// 测试里的编号从 T101 开始，和示例 T001 分开
const OVERVIEW = `# 选题总览

## 选题总表

### AI 教程

**已做**

| 编号 | 选题 | 来源 | 状态 | 发布日期 | 效果 |
| --- | --- | --- | --- | --- | --- |
| [[T101_旧选题\\|T101]] | ✅ 旧选题（平台标题《旧》） | 自己 | 已发布 | 2026-01-05 | 数据好 |

**待做**

| 编号 | 选题 | 来源 | 状态 | 发布日期 | 效果 |
| --- | --- | --- | --- | --- | --- |
| T102 | 正在写的选题 | 自己 | 草稿 |  |  |
| T103 | 还没开始的选题（括号里的说明） | 参考 | 待写 |  |  |
| T103 | 重复写了一行 |  | 待写 |  |  |
| T104 | 最近改过草稿的选题 |  | 待写 |  |  |
| T105 | 推迟的选题 |  | 待写 |  |  |

### 访谈

**待做**

| 编号 | 选题 | 来源 | 状态 | 发布日期 | 效果 |
| --- | --- | --- | --- | --- | --- |
| T120 | 设置里没有这一类 |  | 待写 |  |  |

## 近三天内容安排

| 日期 | 安排 | 对应选题 |
| --- | --- | --- |
| 2026-01-10 | 先写 T104 | T104 |
| 2026-01-11 | 定拍摄顺序：先 T104 再 T102 | T104、T102 |

## 顺延事项

| 安排 | 新日期 | 对应选题 |
| --- | --- | --- |
| 往后推 | 待定 | T105 |
`;

const DAY = 86_400_000;
const NOW = Date.parse("2026-01-12T12:00:00+08:00");

function age(file, days) {
  const time = new Date(NOW - days * DAY);
  utimesSync(file, time, time);
}

function fixture() {
  const home = tempHome();
  const topicsDir = path.join(home, "选题库");
  const draftsDir = path.join(home, "内容草稿");
  const layout = { topicsDir, overviewFile: path.join(topicsDir, "00_选题总览.md"), draftsDir, types: ["AI教程", "科普"], home };
  write(layout.overviewFile, OVERVIEW);
  const card = (relative, text) => {
    const file = path.join(topicsDir, relative);
    write(file, text);
    age(file, 30);
  };
  card("AI教程/已做/T101_✅旧选题.md", "# T101 ✅ 旧选题\n\n- **状态**：已发布\n");
  card("AI教程/待做/T102_正在写.md", "# T102 正在写的选题\n\n- **状态**：草稿\n");
  card("AI教程/待做/T103_还没开始.md", "# T103 还没开始的选题\n\n- **来源**：参考\n- **状态**：待写\n");
  card("科普/待做/T104_放错类型.md", "# T104 最近改过草稿的选题\n\n- **状态**：待写\n");
  card("AI教程/T106_只有卡.md", "# T106 只有选题卡\n\n- **状态**：待写\n");
  const draft = (relative, text, days) => {
    const file = path.join(draftsDir, relative);
    write(file, text);
    age(file, days);
  };
  draft("T102_正在写/工作稿.md", "T102 的工作稿", 30);
  draft("T102_正在写/版本/v1.md", "旧版本", 40);
  draft("T102_正在写/封面.png", "不是真图片", 30);
  draft("T104_改过/逐字稿.md", "T104 的逐字稿", 0);
  draft("T104_改过/改稿日志.md", "改了开头", 1);
  draft("T104_改过/定稿.md", "T104 的定稿", 2);
  draft("T104_改过/工具.py", "print(1)", 2);
  draft("T130_对不上/工作稿.md", "没有对应选题", 5);
  return layout;
}

test("读选题总览：类型标题里的空格不算、双中括号链接里的编号、✅、重复行、安排和顺延、设置里没有的类型", () => {
  const parsed = parseOverview(OVERVIEW, ["AI教程", "科普"]);
  assert.deepEqual([...parsed.rows.keys()], ["T101", "T102", "T103", "T104", "T105"]);
  const t101 = parsed.rows.get("T101");
  assert.equal(t101.type, "AI教程");
  assert.equal(t101.group, "已做");
  assert.equal(t101.recorded, true);
  assert.equal(t101.status, "已发布");
  assert.equal(parsed.rows.get("T103").duplicate, true);
  assert.equal(parsed.rows.get("T102").group, "待做");
  // 安排：后面的行盖过前面的
  assert.deepEqual(parsed.plans.get("T104"), { date: "2026-01-11", text: "定拍摄顺序：先 T104 再 T102" });
  assert.deepEqual(parsed.schedule.ids, ["T104", "T102"]);
  assert.deepEqual(parsed.deferred.get("T105"), { text: "往后推", date: "待定" });
  assert.deepEqual([...parsed.unknownTypes], [["访谈", 1]]);
});

test("一条编号一张卡：做到哪一步、为什么这么判断、要核对的地方，都从文件算出来", () => {
  const layout = fixture();
  const result = readWorks(layout, { now: NOW });
  const by = Object.fromEntries(result.works.map((work) => [work.id, work]));
  assert.deepEqual(Object.keys(by), ["T101", "T102", "T103", "T104", "T105", "T106"]);

  assert.equal(by.T101.stage, "done");
  assert.equal(by.T101.stageReason, "已发布 2026-01-05");
  assert.equal(by.T101.title, "旧选题");

  assert.equal(by.T102.stage, "doing");
  assert.equal(by.T102.stageReason, "选题总览：草稿");
  assert.equal(by.T102.resume.name, "工作稿.md");
  assert.equal(by.T102.counts.versions, 1);
  assert.equal(by.T102.counts.media, 1);
  assert.equal(by.T102.order, 2);

  assert.equal(by.T103.stage, "todo");
  assert.equal(by.T103.title, "还没开始的选题");
  assert.deepEqual(by.T103.issues, ["选题总览里这个编号有两行"]);

  assert.equal(by.T104.stage, "doing");
  assert.equal(by.T104.stageReason, "草稿今天有改动");
  assert.equal(by.T104.order, 1);
  assert.equal(by.T104.resume.name, "逐字稿.md");
  assert.deepEqual(by.T104.issues, ["选题卡放在「科普」，选题总览列在「AI教程」"]);

  assert.equal(by.T105.stage, "todo");
  assert.deepEqual(by.T105.deferred, { text: "往后推", date: "待定" });
  assert.deepEqual(by.T105.issues, ["找不到选题卡"]);

  // 直接放在类型文件夹里、总览没写的卡也认
  assert.equal(by.T106.type, "AI教程");
  assert.deepEqual(by.T106.issues, ["选题总览里没有这一行"]);

  assert.equal(result.notices.length, 2);
  assert.match(result.notices[0], /访谈/);
  assert.match(result.notices[1], /T130_对不上/);
});

test("参考材料不算开始写：草稿文件夹里只有「参考素材」和「参考拆解」，刚放进去也还在「选题」里，也不当「接着写」", () => {
  const layout = fixture();
  const draft = (relative, text, days) => {
    const file = path.join(layout.draftsDir, relative);
    write(file, text);
    age(file, days);
  };
  draft("T103_还没开始/参考拆解.md", "拆了一条参考", 0);
  draft("T103_还没开始/参考素材/参考视频逐字稿.md", "别人的逐字稿", 0);
  const t103 = readWorks(layout, { now: NOW }).works.find((work) => work.id === "T103");
  assert.equal(t103.stage, "todo");
  assert.equal(t103.resume, null);
  assert.equal(t103.draftDir.name, "T103_还没开始");
  assert.ok(Date.parse(t103.lastModified) <= NOW - 29 * DAY, "最近改动不按参考材料算");
  // 真开始写了（放进一份初稿）就算在做
  draft("T103_还没开始/初稿.md", "我的第一版", 0);
  const again = readWorks(layout, { now: NOW }).works.find((work) => work.id === "T103");
  assert.equal(again.stage, "doing");
  assert.equal(again.resume.name, "初稿.md");
});

test("详情：只列草稿文件夹里认得的文件（脚本不列），文字稿能复制全文，别的编号的文件不行", () => {
  const layout = fixture();
  const detail = readWorkDetail("T104", layout, { now: NOW });
  assert.deepEqual(
    detail.files.map((file) => [file.name, file.kind]),
    [["逐字稿.md", "draft"], ["改稿日志.md", "log"], ["定稿.md", "final"]],
  );
  const finalRef = detail.files.find((file) => file.kind === "final").ref;
  assert.equal(finalRef, "drafts:T104_改过/定稿.md");
  assert.equal(readWorkText("T104", finalRef, layout).text, "T104 的定稿");
  assert.throws(() => readWorkText("T104", "drafts:T102_正在写/工作稿.md", layout), (error) => error.statusCode === 403);
  assert.throws(() => readWorkText("T104", "drafts:T104_改过/../T102_正在写/工作稿.md", layout), (error) => error.statusCode === 403);
  assert.throws(() => readWorkDetail("T999", layout), (error) => error.statusCode === 404);
  assert.throws(() => readWorkDetail("../x", layout), (error) => error.statusCode === 400);
});

test("打开文件：只开这条内容自己的选题卡、草稿文件夹和里面列出的文件；接着写打开最近改过的稿子", async () => {
  const layout = fixture();
  const opener = fakeOpener();
  const detail = readWorkDetail("T104", layout, { now: NOW });
  await openWorkTarget("T104", detail.card.ref, "default", layout, { opener });
  await openWorkTarget("T104", detail.draftDir.ref, "finder", layout, { opener });
  await assert.rejects(() => openWorkTarget("T104", "topics:AI教程/待做/T102_正在写.md", "default", layout, { opener }), (error) => error.statusCode === 403);
  await assert.rejects(() => openWorkTarget("T104", detail.card.ref, "terminal", layout, { opener }), (error) => error.statusCode === 400);
  const resumed = await resumeWork("T104", layout, { opener });
  assert.match(resumed.message, /逐字稿\.md/);
  await assert.rejects(() => resumeWork("T103", layout, { opener }), (error) => error.statusCode === 404);
  const names = opener.calls.map((call) => [path.basename(call.target), call.reveal]);
  assert.deepEqual(names, [["T104_放错类型.md", false], ["T104_改过", true], ["逐字稿.md", false]]);
});

test("建草稿文件夹：文件夹名是「编号_选题名」，去掉访达不认的字符；已经有了就用已有的", async () => {
  const layout = fixture();
  const first = createDraftFolder("T103", layout);
  assert.deepEqual(first, { created: true, ref: "drafts:T103_还没开始的选题", name: "T103_还没开始的选题" });
  assert.equal(createDraftFolder("T103", layout).created, false);
  write(path.join(layout.topicsDir, "AI教程/待做/T107_怪名字.md"), "# T107 用: AI/做 *视频*?\n");
  assert.equal(createDraftFolder("T107", layout).name, "T107_用 AI 做 视频");
  const opener = fakeOpener();
  const opened = await openDraftFolder("T105", layout, { opener });
  assert.equal(opened.created, true);
  assert.ok(existsSync(path.join(layout.draftsDir, opened.name)));
  assert.equal(opener.calls[0].reveal, true);
});

test("选题总览不见了：报出明确的原因和代号，界面据此给出「重新建一份」", () => {
  const home = tempHome();
  const layout = { topicsDir: home, overviewFile: path.join(home, "没有这个.md"), draftsDir: home, types: ["教程"], home };
  assert.throws(() => readWorks(layout), (error) => error.code === "overview-missing" && error.statusCode === 503);
});
