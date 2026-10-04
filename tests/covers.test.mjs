// 封面（1.1 加，lib/covers.mjs）：风格（对标账号的、你放进来的几组图）和默认构图、我的照片、封面设置、
// 一条内容出过的封面和出一批时的默认值（尺寸、封面上的字）、「我的封面」一览；草稿扫描不把封面当稿子；接口走一遍。
// 原作者 2026-10-04 定：挑和改都在 Codex 桌面版里做，工作台不再有选定、删除、收藏、批注这些按钮和接口。
// 图片都是测试里现造的几个字节，不放真实图片。文件怎么放是和封面 Skill 一起定的（docs/开发记录.md「封面」一节）。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createApp } from "../lib/app.mjs";
import {
  accountVi,
  addStyleImage,
  batchInfo,
  contentForm,
  coverFile,
  defaultSizeFor,
  coverLibrary,
  createImageStyle,
  listPhotos,
  listStyles,
  parseRecord,
  readCoverSettings,
  savePhoto,
  setDefaultStyle,
  styleImage,
  styleRef,
  topicCovers,
  trashImageStyle,
  trashPhoto,
  writeCompositions,
  writeCoverSettings,
} from "../lib/covers.mjs";
import { pickPort } from "../lib/ports.mjs";
import { addOverviewRow } from "../lib/topics.mjs";
import { readWorkDetail, readWorks, worksLayout } from "../lib/works.mjs";
import { ensureWorkspace } from "../lib/workspace.mjs";
import { fakeKeyStore, fakeOpener, testConfig } from "./helpers.mjs";

// 最小的 PNG、JPEG 头（够认出格式就行；内容不同，哈希就不同）
const png = (tag = "a") => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`IHDR-test-${tag}`)]);
const jpg = (tag = "a") => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF-test-${tag}`)]);

const RECORD = `# T001 封面生成记录

## 第 1 批

对标：抖音-某某（暖黄手写风）；照片：2 张；日期：2026-10-05；软件：Codex；生图：image_gen；尺寸：竖版 3:4

| 编号 | 本张变化 | 自检 | 文件名 |
| --- | --- | --- | --- |
| 01 | K03 讲台：人在右后 | 通过 | 封面-01.png |
| 02 | K07 对比：左右两半 | 头发遮住「AI」的 A | 封面-02.png |

生成 2 次，报错 0 次，实际像素 1024×1365

## 记录

- 2026-10-05 21:06 选定 封面-01

## 第 2 批

对标：风格/2026-10-04_8张（蓝白大字风）；照片：1 张；日期：2026-10-06；软件：Claude Code；生图：只出提示词；尺寸：横版 2.35:1

| 编号 | 本张变化 | 自检 | 文件名 |
| --- | --- | --- | --- |
| 03 | K11 前景大手 | 只出了提示词 | 生图描述-03.md |
`;

/** 一份工作文件夹（带示例 T001 和它的草稿文件夹），T001 的封面候选里放好两张图、一份只有提示词的、一条生成记录 */
function setup() {
  const config = testConfig();
  ensureWorkspace(config);
  const layout = worksLayout(config);
  const folder = path.join(config.paths.drafts, readWorkDetail("T001", layout).draftDir.name);
  const dir = path.join(folder, "封面候选");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "封面-01.png"), png("01"));
  writeFileSync(path.join(dir, "封面-02.png"), png("02"));
  writeFileSync(path.join(dir, "生图描述-03.md"), "Create ONE complete 2.35:1 Chinese article cover…\n");
  writeFileSync(path.join(dir, "生成记录.md"), RECORD);
  return { config, layout, folder, dir };
}

/** 一个最小的创作页：jc-doc 里带「封面文字」那一样（final 是用户定的那版） */
function creationPage(folder, { final = "", chosen = "" } = {}) {
  const items = [
    { id: "info-aaaa1111", kind: "info", locked: { title: "示例" }, fields: {} },
    { id: "pub-aaaa1111", kind: "pubslot", locked: { slot: "封面文字" }, fields: { final } },
  ];
  if (chosen) items.push({ id: "pubc-aaaa1111", kind: "pubcand", locked: { slot: "封面文字", round: 1, order: 1, text: chosen }, fields: { decision: "选用" } });
  const doc = { kind: "创作页", page_id: "page1234", content_id: "T001", items };
  writeFileSync(path.join(folder, "T001_创作页.html"), `<!doctype html><title>T001</title><script id="jc-doc" type="application/json">${JSON.stringify(doc)}</script>`);
}

/** 对标账号：封面/ 里放几张 K 图；vi 给了就写 VI拆解.md */
function account(config, name, { images = ["K01", "K02", "K03"], vi = null } = {}) {
  const dir = path.join(config.paths.benchmarkAccounts, name);
  mkdirSync(path.join(dir, "封面"), { recursive: true });
  writeFileSync(path.join(dir, "档案.json"), JSON.stringify({ platform: name.split("-")[0], account_name: name.split("-")[1] }));
  for (const k of images) writeFileSync(path.join(dir, "封面", `${k}.jpg`), jpg(`${name}-${k}`));
  if (vi) writeFileSync(path.join(dir, "VI拆解.md"), `# ${name} 封面 VI 拆解\n风格名：${vi}\n\n## 整体规律\n`);
  return dir;
}

test("读生成记录：批次按标题认，「## 记录」可以夹在中间；每批第一行认出风格编号、风格名和尺寸", () => {
  const record = parseRecord(RECORD);
  assert.deepEqual(record.batches.map((b) => [b.no, b.rows.map((r) => r.no)]), [[1, ["01", "02"]], [2, ["03"]]]);
  assert.equal(record.batches[0].rows[1].check, "头发遮住「AI」的 A");
  assert.deepEqual(record.events, ["2026-10-05 21:06 选定 封面-01"]);
  assert.deepEqual(batchInfo(record.batches[0].info), { style: "抖音-某某", styleName: "暖黄手写风", size: "竖版 3:4" });
  assert.deepEqual(batchInfo(record.batches[1].info), { style: "风格/2026-10-04_8张", styleName: "蓝白大字风", size: "横版 2.35:1" });
  assert.deepEqual(batchInfo("对标：抖音-某某；照片：我的照片/正脸.jpg"), { style: "抖音-某某", styleName: null, size: null }, "第一版的写法（没有尺寸）照样认");
  assert.deepEqual(batchInfo(null), { style: null, styleName: null, size: null });
  // 账号名里自己带括号：最后一个括号才是风格名；没起名时 Skill 写「还没起名」
  assert.deepEqual(batchInfo("对标：抖音-某某（AI）（暖黄手写风）；照片：1 张；尺寸：方形 1:1"), { style: "抖音-某某（AI）", styleName: "暖黄手写风", size: "方形 1:1" });
  assert.deepEqual(batchInfo("对标：抖音-某某（还没起名）；照片：1 张"), { style: "抖音-某某", styleName: null, size: null });
});

test("视频还是文章：内容类型的名字带「文章」「图文」「公众号」这些字的算文章；默认尺寸小红书的用竖版", () => {
  assert.deepEqual(["教程", "口播", "公众号文章", "小红书图文", "知识星球", "长文"].map(contentForm), ["视频", "视频", "文章", "文章", "文章", "文章"]);
  assert.deepEqual(["口播", "公众号文章", "小红书笔记", "小红书图文", "知识星球"].map(defaultSizeFor), ["竖版 3:4", "横版 2.35:1", "竖版 3:4", "竖版 3:4", "横版 2.35:1"]);
});

test("一条内容的封面：按批次排，带上每批的风格和尺寸；只有提示词的也列出来，没登记的放最后；认出选定的是哪张", () => {
  const { config, layout, folder, dir } = setup();
  writeFileSync(path.join(dir, "封面-04.jpg"), jpg("04")); // 用户自己放进来的、还没登记的
  writeFileSync(path.join(folder, "封面-选定.png"), png("02")); // 和 封面-02 一模一样
  const state = topicCovers(config, layout, "T001");
  assert.deepEqual(state.batches.map((b) => [b.no, b.items.map((i) => i.no)]), [[1, ["01", "02"]], [2, ["03"]], [null, ["04"]]]);
  assert.deepEqual([state.batches[0].style, state.batches[0].styleName, state.batches[0].size], ["抖音-某某", "暖黄手写风", "竖版 3:4"]);
  assert.equal(state.batches[1].size, "横版 2.35:1");
  const third = state.batches[1].items[0];
  assert.deepEqual([third.image, third.prompt], [null, "生图描述-03.md"]);
  assert.match(third.promptText, /2\.35:1/);
  assert.equal(state.selected.from, "02", "按内容认，不看「## 记录」里那一行");
  assert.deepEqual(state.batches[0].items.map((i) => i.selected), [false, true]);
  assert.deepEqual([state.total, state.next], [3, { batch: 3 }]);
  assert.equal(state.form, "视频");
  assert.equal(state.defaults.size, "横版 2.35:1", "默认尺寸跟上一批走");
});

test("出一批的默认值：没出过按视频、文章给尺寸；封面上的字带创作页里你定的那版，没定看选用的候选", () => {
  const { config, layout, folder } = setup();
  let state = topicCovers(config, layout, "T001");
  assert.deepEqual([state.defaults.text, state.defaults.textFrom], [null, null]);
  creationPage(folder, { final: "十分钟写完周报" });
  state = topicCovers(config, layout, "T001");
  assert.deepEqual([state.defaults.text, state.defaults.textFrom], ["十分钟写完周报", "你定的"]);
  creationPage(folder, { final: "", chosen: "周报别再熬夜写" });
  state = topicCovers(config, layout, "T001");
  assert.deepEqual([state.defaults.text, state.defaults.textFrom], ["周报别再熬夜写", "选用的候选"]);
  // 还没有草稿文件夹的文章：空的，默认横版；没有这条选题：照详情页一样报「没有」
  const overview = readFileSync(config.paths.overview, "utf8");
  config.contentTypes.push("公众号文章");
  const layout2 = worksLayout(config);
  writeFileSync(config.paths.overview, addOverviewRow(overview, "公众号文章", { id: "T002", title: "还没写的", source: "自己的想法" }));
  const none = topicCovers(config, layout2, "T002");
  assert.deepEqual([none.folder, none.batches, none.form, none.defaults.size], [null, [], "文章", "横版 2.35:1"]);
  assert.throws(() => topicCovers(config, layout, "T999"), /没有 T999/);
});

test("给页面看的图：只给封面候选里的封面和选定的那张", () => {
  const { config, layout, folder } = setup();
  writeFileSync(path.join(folder, "封面-选定.png"), png("01"));
  assert.match(coverFile(config, layout, "T001", "封面候选/封面-01.png").file, /封面-01\.png$/);
  assert.match(coverFile(config, layout, "T001", "封面-选定.png").file, /封面-选定\.png$/);
  assert.throws(() => coverFile(config, layout, "T001", "封面候选/生成记录.md"), /只给看封面候选和选定的封面/);
  assert.throws(() => coverFile(config, layout, "T001", "../T001_用AI写周报/封面候选/封面-01.png"), /只给看/);
});

test("封面设置：没有文件按没设算（一批 5 张）；改一项整份写回，不认识的键留着；写坏了说出来", () => {
  const { config } = setup();
  assert.deepEqual(readCoverSettings(config), { raw: {}, photo: null, benchmark: null, batchSize: 5, problem: null });
  writeCoverSettings(config, { photo: "我的照片/a.jpg", 以后的设置: 1 });
  const next = writeCoverSettings(config, { batchSize: 8 });
  assert.deepEqual([next.photo, next.batchSize, next.raw["以后的设置"]], ["我的照片/a.jpg", 8, 1]);
  writeFileSync(path.join(config.paths.coverAssets, "封面设置.json"), "{坏了");
  assert.match(readCoverSettings(config).problem, /写坏了/);
});

test("我的照片：放一张、几张都行；第一张当主照片，后放的不换主照片；拿掉主照片换成剩下最新的；只收 PNG、JPEG、WebP", () => {
  const { config } = setup();
  savePhoto(config, { filename: "正脸.png", buffer: png("me1") });
  const second = savePhoto(config, { filename: "半身.jpg", buffer: jpg("me2") });
  assert.match(second.message, /现在有 2 张/);
  assert.equal(readCoverSettings(config).photo, "我的照片/正脸.png");
  assert.deepEqual(listPhotos(config).map((p) => [p.name, p.main]), [["正脸.png", true], ["半身.jpg", false]]);
  const removed = trashPhoto(config, "正脸.png");
  assert.match(removed.trashedAs, /^\d{4}-\d{2}-\d{2}_照片_正脸\.png$/);
  assert.ok(existsSync(path.join(config.paths.trash, removed.trashedAs)));
  assert.equal(readCoverSettings(config).photo, "我的照片/半身.jpg");
  assert.throws(() => savePhoto(config, { filename: "a.heic", buffer: Buffer.from("ftypheic-not-supported") }), /PNG、JPEG 或 WebP/);
  assert.throws(() => trashPhoto(config, "../封面设置.json"), /文件名不对/);
});

test("你放进来的图建一个风格：建「日期_N张」文件夹和 风格.json，图按原文件名存；没拆前在风格里显示「还没拆」", () => {
  const { config } = setup();
  const created = createImageStyle(config, { count: 2 });
  assert.match(created.id, /^风格\/\d{4}-\d{2}-\d{2}_2张$/);
  addStyleImage(config, created.id, { filename: "小红书截图.png", buffer: png("s1") });
  const again = addStyleImage(config, created.id, { filename: "小红书截图.png", buffer: png("s2") });
  assert.deepEqual([again.name, again.count], ["小红书截图-2.png", 2]);
  const dir = styleRef(config, created.id).dir;
  assert.deepEqual(readdirSync(path.join(dir, "封面")).sort(), ["小红书截图-2.png", "小红书截图.png"]);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "风格.json"), "utf8")).count, 2);
  assert.throws(() => addStyleImage(config, created.id, { filename: "x.txt", buffer: Buffer.from("not an image at all") }), /PNG、JPEG 或 WebP/);
  const second = createImageStyle(config, { count: 2 });
  assert.notEqual(second.id, created.id, "同一天同样张数的第二组加 -2");
  const [style] = listStyles(config).filter((s) => s.id === created.id);
  assert.deepEqual([style.kind, style.done, style.name, style.covers], ["images", false, null, 2]);
  assert.equal(styleImage(config, created.id, "小红书截图.png").mime, "image/png");
  assert.throws(() => createImageStyle(config, { count: 0 }), /1 到 60 张/);
  assert.throws(() => styleRef(config, "风格/../我的照片"), /风格不对/);
  assert.throws(() => styleRef(config, "风格/没有这组"), /找不到这组图/);
});

test("风格列表：对标账号的和放进来的都在；默认风格在前，拆好的在前；默认构图只留真有的图；设默认要先拆过", () => {
  const { config } = setup();
  account(config, "抖音-某某", { vi: "暖黄手写风" });
  account(config, "小红书-还没拆");
  const mine = createImageStyle(config, { count: 1 });
  addStyleImage(config, mine.id, { filename: "a.png", buffer: png("mine") });
  const dir = styleRef(config, mine.id).dir;
  writeFileSync(path.join(dir, "VI拆解.md"), "# 放进来的图\n风格名：蓝白大字风\n");
  writeFileSync(path.join(config.paths.benchmarkAccounts, "抖音-某某", "默认构图.json"), JSON.stringify({ ids: ["K03", "K01", "K09"], by: "AI" }));
  assert.throws(() => setDefaultStyle(config, "小红书-还没拆"), /还没拆过封面 VI/);
  setDefaultStyle(config, mine.id);
  const accounts = [
    { name: "抖音-某某", platform: "抖音", accountName: "某某" },
    { name: "小红书-还没拆", platform: "小红书", accountName: "还没拆" },
  ];
  const reports = [{ id: "2026-10-05_某某封面VI", type: "封面VI", source: "抖音-某某", pages: [{ file: "index.html" }] }];
  const styles = listStyles(config, { accounts, reports });
  assert.deepEqual(styles.map((s) => [s.id, s.done, s.isDefault]), [[mine.id, true, true], ["抖音-某某", true, false], ["小红书-还没拆", false, false]]);
  const dy = styles[1];
  assert.deepEqual([dy.name, dy.covers, dy.compositions, dy.report], ["暖黄手写风", 3, { ids: ["K03", "K01"], by: "AI" }, { id: "2026-10-05_某某封面VI", page: "index.html" }]);
  assert.deepEqual([dy.platform, dy.accountName], ["抖音", "某某"]);
  // 对标账号卡片上那一行照旧
  const vi = accountVi(config, "抖音-某某", { reports });
  assert.deepEqual([vi.done, vi.style, vi.isDefault, vi.samples], [true, "暖黄手写风", false, ["K01.jpg", "K02.jpg", "K03.jpg"]]);
  assert.throws(() => setDefaultStyle(config, "抖音-没有这个人"), /找不到对标账号/);
});

test("改默认构图：只能挑这个风格里有的 K 图，1 到 20 张；写成「你」挑的", () => {
  const { config } = setup();
  const dir = account(config, "抖音-某某", { images: ["K01", "K02", "K03", "K04"], vi: "暖黄手写风" });
  const result = writeCompositions(config, "抖音-某某", ["k04", "K02", "K02"]);
  assert.deepEqual(result.compositions, { ids: ["K04", "K02"], by: "你" });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "默认构图.json"), "utf8")).ids, ["K04", "K02"]);
  assert.throws(() => writeCompositions(config, "抖音-某某", ["K09"]), /没有 K09/);
  assert.throws(() => writeCompositions(config, "抖音-某某", []), /1 到 20 张/);
});

test("拿掉一组放进来的图：整个文件夹挪进回收站；是默认风格的话默认清空；对标账号不能在这里删", () => {
  const { config } = setup();
  account(config, "抖音-某某", { vi: "暖黄手写风" });
  const mine = createImageStyle(config, { count: 1 });
  writeFileSync(path.join(styleRef(config, mine.id).dir, "VI拆解.md"), "风格名：蓝白大字风\n");
  setDefaultStyle(config, mine.id);
  const result = trashImageStyle(config, mine.id);
  assert.match(result.trashedAs, /^\d{4}-\d{2}-\d{2}_风格_\d{4}-\d{2}-\d{2}_1张$/);
  assert.equal(readCoverSettings(config).benchmark, null);
  assert.throws(() => trashImageStyle(config, "抖音-某某"), /对标账号在「市场调研」/);
});

test("我的封面：每条出过封面的内容一组，只放 AI 给它出的封面；每张带上照哪个风格出的；选定的标出来", () => {
  const { config, layout, folder } = setup();
  writeFileSync(path.join(folder, "封面-选定.png"), png("01"));
  const { groups } = coverLibrary(config, layout);
  assert.deepEqual(groups.map((g) => [g.id, g.form]), [["T001", "视频"]]);
  const covers = groups[0].covers;
  assert.deepEqual(covers.map((c) => [c.no, c.style, c.styleName, c.selected]), [["02", "抖音-某某", "暖黄手写风", false], ["01", "抖音-某某", "暖黄手写风", true]]);
  assert.equal(groups[0].selected.from, "01");
});

test("草稿扫描：封面候选/ 和 封面-选定 不当稿子、不让选题跑到「在做」；卡片上带几张候选、选定没有", () => {
  const { layout, folder } = setup();
  let t1 = readWorks(layout).works.find((w) => w.id === "T001");
  assert.equal(t1.stage, "todo", "只有封面、没有稿子，还在「选题」里");
  assert.deepEqual(t1.cover, { candidates: 2, selected: null });
  writeFileSync(path.join(folder, "封面-选定.png"), png("01"));
  t1 = readWorks(layout).works.find((w) => w.id === "T001");
  assert.equal(t1.stage, "todo");
  assert.deepEqual(t1.cover, { candidates: 2, selected: "封面-选定.png" });
  const detail = readWorkDetail("T001", layout);
  assert.ok(!detail.files.some((f) => /封面|生成记录|生图描述/.test(f.name)), "详情页的文件列表里没有封面那些文件");
});

async function startApp(config) {
  const apiPort = await pickPort(30000 + Math.floor(Math.random() * 20000));
  const server = createServer(createApp({ config, apiPort, uiPort: apiPort + 1, opener: fakeOpener(), keyStore: fakeKeyStore(), aiLinks: async () => ({}) }));
  await new Promise((resolve) => server.listen(apiPort, "127.0.0.1", resolve));
  const call = async (route, { method = "GET", body, binary, headers = {} } = {}) => {
    const init = { method, headers: { ...headers } };
    if (binary) {
      init.headers["Content-Type"] = "application/octet-stream";
      init.body = binary;
    } else if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, init);
    const buffer = Buffer.from(await response.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(buffer.toString("utf8"));
    } catch {
      json = null;
    }
    return { status: response.status, json, buffer, type: response.headers.get("content-type") };
  };
  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("接口：风格、放图建风格、默认风格、默认构图、照片、一条内容的封面、我的封面；去掉的接口没有了；别的网页发来的写请求拒绝", async () => {
  const { config, folder } = setup();
  account(config, "抖音-某某", { vi: "暖黄手写风" });
  creationPage(folder, { final: "十分钟写完周报" });
  const app = await startApp(config);
  try {
    const info = await app.call("/api/app");
    assert.deepEqual(info.json.cover, { skill: "jincheng-workbench-cover" });
    // 一条内容的封面和图
    const state = await app.call("/api/works/T001/covers");
    assert.deepEqual(state.json.batches.map((b) => b.no), [1, 2]);
    assert.equal(state.json.defaults.text, "十分钟写完周报");
    const image = await app.call(`/api/works/T001/covers/file/${encodeURIComponent("封面候选")}/${encodeURIComponent("封面-01.png")}`);
    assert.deepEqual([image.status, image.type], [200, "image/png"]);
    assert.deepEqual(image.buffer, png("01"));
    // 放图建风格：先建，再一张一张传
    const created = await app.call("/api/covers/styles", { method: "POST", body: { count: 1 } });
    assert.equal(created.status, 201);
    const up = await app.call(`/api/covers/styles/image?style=${encodeURIComponent(created.json.id)}&filename=${encodeURIComponent("参考.jpg")}`, { method: "POST", binary: jpg("ref") });
    assert.deepEqual([up.status, up.json.name], [201, "参考.jpg"]);
    const shown = await app.call(`/api/covers/styles/image?style=${encodeURIComponent(created.json.id)}&file=${encodeURIComponent("参考.jpg")}`);
    assert.deepEqual([shown.type, shown.buffer], ["image/jpeg", jpg("ref")]);
    // 默认风格、默认构图
    const noVi = await app.call("/api/covers/styles/default", { method: "POST", body: { style: created.json.id } });
    assert.equal(noVi.status, 409);
    const set = await app.call("/api/covers/styles/default", { method: "POST", body: { style: "抖音-某某" } });
    assert.equal(set.json.settings.benchmark, "抖音-某某");
    const picked = await app.call("/api/covers/styles/compositions", { method: "POST", body: { style: "抖音-某某", ids: ["K02", "K01"] } });
    assert.deepEqual(picked.json.compositions, { ids: ["K02", "K01"], by: "你" });
    // 照片
    const photo = await app.call(`/api/covers/photo?filename=${encodeURIComponent("我.png")}`, { method: "POST", binary: png("me") });
    assert.equal(photo.status, 201);
    const covers = await app.call("/api/covers");
    assert.deepEqual(covers.json.sizes, ["竖版 3:4", "横版 2.35:1", "方形 1:1"]);
    assert.equal(covers.json.settings.photo, "我的照片/我.png");
    assert.deepEqual(covers.json.photos.map((p) => p.name), ["我.png"]);
    assert.deepEqual(covers.json.styles.map((s) => [s.id, s.isDefault]), [["抖音-某某", true], [created.json.id, false]]);
    assert.deepEqual(covers.json.styles[0].compositions.ids, ["K02", "K01"]);
    const trashedPhoto = await app.call("/api/covers/photo/trash", { method: "POST", body: { name: "我.png" } });
    assert.equal(trashedPhoto.json.settings.photo, null);
    // 我的封面
    const library = await app.call("/api/covers/library");
    assert.deepEqual(library.json.groups.map((g) => g.id), ["T001"]);
    // 市场调研那边：对标账号带上封面 VI，原图照样给看，设默认照样能设
    const accounts = await app.call("/api/research/accounts");
    assert.deepEqual([accounts.json.accounts[0].vi.style, accounts.json.accounts[0].vi.isDefault], ["暖黄手写风", true]);
    const cover = await app.call(`/api/research/accounts/${encodeURIComponent("抖音-某某")}/vi/K01.jpg`);
    assert.equal(cover.type, "image/jpeg");
    const viaResearch = await app.call("/api/research/accounts/vi-default", { method: "POST", body: { name: "抖音-某某" } });
    assert.equal(viaResearch.status, 200);
    // 拿掉放进来的那组图
    const trashed = await app.call("/api/covers/styles/trash", { method: "POST", body: { style: created.json.id } });
    assert.equal(trashed.status, 200);
    // 去掉的：选定、删除、收藏、批注
    for (const rest of ["select", "unselect", "trash", "favorite", "annotate?no=01"]) {
      const gone = await app.call(`/api/works/T001/covers/${rest}`, { method: "POST", body: { no: "01" } });
      assert.equal(gone.status, 404, rest);
    }
    // 防跨站：别的网页发来的写请求、不是 JSON 的写请求拒绝
    const evil = await app.call("/api/covers/styles", { method: "POST", body: { count: 1 }, headers: { Origin: "https://example.com" } });
    assert.equal(evil.status, 403);
    const form = await app.call("/api/covers/styles/default", { method: "POST", headers: { "Content-Type": "text/plain" } });
    assert.equal(form.status, 415);
    assert.equal(listStyles(config).filter((s) => s.kind === "images").length, 0, "被拒绝的请求什么都没建");
  } finally {
    await app.close();
  }
});
