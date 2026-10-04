// 封面（1.1 加，lib/covers.mjs）：读生成记录、一条内容的候选和批次、选定和取消选定、删除挪进回收站、收藏、批注图、
// 照片和封面设置、对标账号的封面 VI；草稿扫描不把封面当稿子；接口走一遍。图片都是测试里现造的几个字节，不放真实图片。
// 文件怎么放是和封面 Skill 一起定的（docs/开发记录.md「封面」一节）。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createApp } from "../lib/app.mjs";
import {
  accountVi,
  coverFile,
  coverNo,
  favoriteCover,
  listFavorites,
  parseRecord,
  readCoverSettings,
  saveAnnotation,
  savePhoto,
  selectCover,
  setDefaultBenchmark,
  topicCovers,
  trashCover,
  unselectCover,
  writeCoverSettings,
} from "../lib/covers.mjs";
import { pickPort } from "../lib/ports.mjs";
import { nextNoteName } from "../ui/lib/cover-names.ts";
import { addOverviewRow } from "../lib/topics.mjs";
import { readWorkDetail, readWorks, worksLayout } from "../lib/works.mjs";
import { ensureWorkspace } from "../lib/workspace.mjs";
import { fakeKeyStore, fakeOpener, testConfig } from "./helpers.mjs";

// 最小的 PNG、JPEG 头（够认出格式就行；内容不同，哈希就不同）
const png = (tag = "a") => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`IHDR-test-${tag}`)]);
const jpg = (tag = "a") => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF-test-${tag}`)]);

const RECORD = `# T001 封面生成记录

## 第 1 批

对标：抖音-某某（暖黄手写风）；照片：我的照片/正脸.jpg；日期：2026-10-05；软件：Codex；生图：image_gen

| 编号 | 本张变化 | 自检 | 文件名 |
| --- | --- | --- | --- |
| 01 | K03 讲台：人在右后 | 通过 | 封面-01.png |
| 02 | K07 对比：左右两半 | 头发遮住「AI」的 A | 封面-02.png |

生成 2 次，报错 0 次，实际像素 1024×1536

## 记录

- 2026-10-05 21:06 收藏 封面-01

## 第 2 批

对标：抖音-某某；照片：我的照片/正脸.jpg；日期：2026-10-06；软件：Claude Code；生图：只出提示词

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
  writeFileSync(path.join(dir, "生图描述-03.md"), "Create ONE complete 3:4 portrait Chinese video cover…\n");
  writeFileSync(path.join(dir, "生成记录.md"), RECORD);
  return { config, layout, folder, dir };
}

test("编号统一成两位，「3」「03」「封面-03」都认", () => {
  assert.equal(coverNo(3), "03");
  assert.equal(coverNo("封面-12"), "12");
  assert.equal(coverNo("103"), "103");
  assert.throws(() => coverNo("没有"), /编号不对/);
});

test("读生成记录：批次按标题认，「## 记录」可以夹在中间；只有一张表、没写小节标题的算第 1 批", () => {
  const record = parseRecord(RECORD);
  assert.deepEqual(record.batches.map((b) => [b.no, b.rows.map((r) => r.no)]), [[1, ["01", "02"]], [2, ["03"]]]);
  assert.match(record.batches[0].info, /^对标：抖音-某某/);
  assert.equal(record.batches[0].rows[1].check, "头发遮住「AI」的 A");
  assert.deepEqual(record.batches[0].footer, ["生成 2 次，报错 0 次，实际像素 1024×1536"]);
  assert.deepEqual(record.events, ["2026-10-05 21:06 收藏 封面-01"]);
  const bare = parseRecord("# T009 封面生成记录\n\n| 编号 | 本张变化 | 自检 | 文件名 |\n| --- | --- | --- | --- |\n| 1 | K01 | 通过 | 封面-01.png |\n");
  assert.deepEqual(bare.batches.map((b) => [b.no, b.rows[0].no]), [[1, "01"]]);
});

test("一条内容的封面：按批次排，只有提示词的也列出来，没登记的放最后；下一张、下一批的编号", () => {
  const { config, layout, dir } = setup();
  writeFileSync(path.join(dir, "封面-04.jpg"), jpg("04")); // 用户自己放进来的、还没登记的
  const state = topicCovers(config, layout, "T001");
  assert.deepEqual(state.batches.map((b) => [b.no, b.items.map((i) => i.no)]), [[1, ["01", "02"]], [2, ["03"]], [null, ["04"]]]);
  const [first, second] = state.batches[0].items;
  assert.equal(first.image, "封面-01.png");
  assert.equal(first.check, "通过");
  assert.equal(second.change, "K07 对比：左右两半");
  assert.deepEqual([state.batches[1].items[0].image, state.batches[1].items[0].prompt], [null, "生图描述-03.md"]);
  assert.deepEqual(state.next, { no: "05", batch: 3 });
  assert.equal(state.total, 3);
  assert.equal(state.selected, null);
  // 还没有草稿文件夹的内容：空的，不报错；没有这条选题：照详情页一样报「没有」
  const overview = readFileSync(config.paths.overview, "utf8");
  writeFileSync(config.paths.overview, addOverviewRow(overview, "口播", { id: "T002", title: "还没写的", source: "自己的想法" }));
  const none = topicCovers(config, layout, "T002");
  assert.deepEqual([none.folder, none.batches, none.next], [null, [], { no: "01", batch: 1 }]);
  assert.throws(() => topicCovers(config, layout, "T999"), /没有 T999/);
});

test("选定：复制成 封面-选定，认得出是哪张；换一张（扩展名不同）旧的挪进回收站；取消选定也挪进回收站；都记进「## 记录」", () => {
  const { config, layout, folder, dir } = setup();
  writeFileSync(path.join(dir, "封面-05.jpg"), jpg("05"));
  selectCover(config, layout, "T001", "02");
  assert.ok(existsSync(path.join(folder, "封面-选定.png")));
  assert.equal(topicCovers(config, layout, "T001").selected.from, "02");
  selectCover(config, layout, "T001", 5);
  assert.ok(!existsSync(path.join(folder, "封面-选定.png")), "换成 jpg 以后，png 那份挪走了");
  assert.equal(topicCovers(config, layout, "T001").selected.from, "05");
  unselectCover(config, layout, "T001");
  assert.equal(topicCovers(config, layout, "T001").selected, null);
  assert.ok(readdirSync(config.paths.trash).some((name) => name.endsWith("_T001_封面-选定.jpg")));
  const events = parseRecord(readFileSync(path.join(dir, "生成记录.md"), "utf8")).events;
  assert.deepEqual(events.map((e) => e.replace(/^\S+ \S+ /, "")), ["收藏 封面-01", "选定 封面-02", "选定 封面-05", "取消选定 封面-05"]);
  // 「## 记录」后面的第 2 批小节原样还在
  assert.match(readFileSync(path.join(dir, "生成记录.md"), "utf8"), /## 第 2 批[\s\S]*\| 03 \| K11 前景大手/);
  assert.throws(() => unselectCover(config, layout, "T001"), /还没有选定/);
});

test("删除：挪进回收站（文件名前加日期和编号），选定的那张不能删，删掉的不再显示", () => {
  const { config, layout, dir } = setup();
  selectCover(config, layout, "T001", "01");
  assert.throws(() => trashCover(config, layout, "T001", "01"), /选定的封面/);
  const result = trashCover(config, layout, "T001", "02");
  assert.match(result.trashedAs, /^\d{4}-\d{2}-\d{2}_T001_封面-02\.png$/);
  assert.ok(!existsSync(path.join(dir, "封面-02.png")));
  assert.ok(existsSync(path.join(config.paths.trash, result.trashedAs)));
  assert.deepEqual(topicCovers(config, layout, "T001").batches[0].items.map((i) => i.no), ["01"]);
  assert.throws(() => trashCover(config, layout, "T001", "02"), /找不到封面-02/);
});

test("收藏：复制到 封面素材/收藏/，重复收藏不多复制；取消收藏挪进回收站", () => {
  const { config, layout } = setup();
  favoriteCover(config, layout, "T001", "01");
  favoriteCover(config, layout, "T001", "01");
  assert.deepEqual(listFavorites(config).map((f) => [f.name, f.id, f.no]), [["T001_封面-01.png", "T001", "01"]]);
  assert.equal(topicCovers(config, layout, "T001").batches[0].items[0].favorite, true);
  favoriteCover(config, layout, "T001", "01", false);
  assert.deepEqual(listFavorites(config), []);
  assert.ok(readdirSync(config.paths.trash).some((name) => name.endsWith("_收藏_T001_封面-01.png")));
});

test("批注图：只收 PNG，存在 封面候选/批注/，同一张再批注加 -2；页面能拿到它", () => {
  const { config, layout } = setup();
  const first = saveAnnotation(layout, "T001", "02", png("note"));
  const again = saveAnnotation(layout, "T001", "02", png("note2"));
  assert.deepEqual([first.relative, again.name], ["封面候选/批注/封面-02-批注.png", "封面-02-批注-2.png"]);
  assert.equal(topicCovers(config, layout, "T001").batches[0].items[1].note, "封面-02-批注-2.png");
  assert.equal(nextNoteName("02", "封面-02-批注-2.png"), "封面-02-批注-3.png");
  assert.equal(nextNoteName("02", null), "封面-02-批注.png");
  assert.equal(nextNoteName("02", "封面-02-批注.png"), "封面-02-批注-2.png");
  // 页面先算好名字（先复制话再存图）：名字合规矩、没被占就用它；被占了、不合规矩就照旧自己起
  assert.equal(saveAnnotation(layout, "T001", "02", png("n3"), { name: "封面-02-批注-3.png" }).name, "封面-02-批注-3.png");
  assert.equal(saveAnnotation(layout, "T001", "02", png("n4"), { name: "封面-02-批注-3.png" }).name, "封面-02-批注-4.png");
  assert.equal(saveAnnotation(layout, "T001", "02", png("n5"), { name: "../../坏.png" }).name, "封面-02-批注-5.png");
  assert.throws(() => saveAnnotation(layout, "T001", "02", jpg()), /要是 PNG/);
  assert.throws(() => saveAnnotation(layout, "T001", "09", png()), /找不到封面-09/);
  assert.equal(coverFile(config, layout, "T001", first.relative).mime, "image/png");
  // 只给看封面候选、批注图和选定的封面
  assert.throws(() => coverFile(config, layout, "T001", "封面候选/生成记录.md"), /只给看/);
  assert.throws(() => coverFile(config, layout, "T001", "参考拆解.md"), /只给看/);
  assert.throws(() => coverFile(config, layout, "T001", "封面候选/../../../etc/passwd"), /只给看|不对/);
});

test("封面设置：没有文件按没设算；改一项整份写回，不认识的键留着；写坏了说出来", () => {
  const { config } = setup();
  assert.deepEqual(readCoverSettings(config), { raw: {}, photo: null, benchmark: null, batchSize: 5, problem: null });
  writeFileSync(path.join(config.paths.coverAssets, "封面设置.json"), JSON.stringify({ photo: "我的照片/a.jpg", 以后的设置: 1 }));
  const next = writeCoverSettings(config, { batchSize: 8 });
  assert.deepEqual([next.photo, next.batchSize, next.raw["以后的设置"]], ["我的照片/a.jpg", 8, 1]);
  writeFileSync(path.join(config.paths.coverAssets, "封面设置.json"), "{坏了");
  assert.match(readCoverSettings(config).problem, /写坏了/);
});

test("放照片：只收 PNG、JPEG、WebP，存进 我的照片/、设成默认照片；重名加 -2", () => {
  const { config } = setup();
  const a = savePhoto(config, { filename: "正脸.jpg", buffer: jpg() });
  const b = savePhoto(config, { filename: "正脸.jpg", buffer: jpg("b") });
  assert.deepEqual([a.name, b.name], ["正脸.jpg", "正脸-2.jpg"]);
  assert.equal(readCoverSettings(config).photo, "我的照片/正脸-2.jpg");
  assert.throws(() => savePhoto(config, { filename: "x.heic", buffer: Buffer.from("ftypheic-not-really") }), /HEIC/);
});

test("对标账号的封面 VI：拆过没有、风格名、几张封面、是不是默认、对照网页在哪；没拆过不能设成默认", () => {
  const { config } = setup();
  const account = path.join(config.paths.benchmarkAccounts, "抖音-某某");
  mkdirSync(path.join(account, "封面"), { recursive: true });
  for (const n of ["K02", "K01", "K10"]) writeFileSync(path.join(account, "封面", `${n}.jpg`), jpg(n));
  let vi = accountVi(config, "抖音-某某");
  assert.deepEqual([vi.done, vi.covers, vi.samples], [false, 3, ["K01.jpg", "K02.jpg", "K10.jpg"]]);
  assert.throws(() => setDefaultBenchmark(config, "抖音-某某"), /还没拆过封面 VI/);
  writeFileSync(path.join(account, "VI拆解.md"), "# 某某 封面 VI 拆解\n风格名：暖黄手写风\n\n## 整体规律\n");
  setDefaultBenchmark(config, "抖音-某某");
  const reports = [{ id: "2026-10-05_某某封面VI", type: "封面VI", source: "抖音-某某", pages: [{ file: "index.html" }] }];
  vi = accountVi(config, "抖音-某某", { reports });
  assert.deepEqual([vi.done, vi.style, vi.isDefault, vi.report], [true, "暖黄手写风", true, { id: "2026-10-05_某某封面VI", page: "index.html" }]);
  assert.throws(() => setDefaultBenchmark(config, "抖音-没有这个人"), /找不到对标账号/);
});

test("草稿扫描：封面候选/ 和 封面-选定 不当稿子、不让选题跑到「在做」；卡片上带几张候选、选定没有", () => {
  const { config, layout } = setup();
  let t1 = readWorks(layout).works.find((w) => w.id === "T001");
  assert.equal(t1.stage, "todo", "只有封面、没有稿子，还在「选题」里");
  assert.deepEqual(t1.cover, { candidates: 2, selected: null });
  selectCover(config, layout, "T001", "01");
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

test("接口：封面全貌、选定、删除、收藏、批注、照片、默认对标、对标账号带上封面 VI；别的网页发来的写请求拒绝", async () => {
  const { config, dir } = setup();
  const app = await startApp(config);
  try {
    const info = await app.call("/api/app");
    assert.deepEqual(info.json.cover, { skill: "jincheng-workbench-cover" });
    const state = await app.call("/api/works/T001/covers");
    assert.deepEqual(state.json.batches.map((b) => b.no), [1, 2]);
    const image = await app.call(`/api/works/T001/covers/file/${encodeURIComponent("封面候选")}/${encodeURIComponent("封面-01.png")}`);
    assert.equal(image.status, 200);
    assert.equal(image.type, "image/png");
    assert.deepEqual(image.buffer, png("01"));
    const picked = await app.call("/api/works/T001/covers/select", { method: "POST", body: { no: "02" } });
    assert.equal(picked.json.covers.selected.from, "02");
    const blocked = await app.call("/api/works/T001/covers/trash", { method: "POST", body: { no: "02" } });
    assert.equal(blocked.status, 409);
    const fav = await app.call("/api/works/T001/covers/favorite", { method: "POST", body: { no: "01" } });
    assert.equal(fav.json.covers.favorites[0], "01");
    const note = await app.call("/api/works/T001/covers/annotate?no=01", { method: "POST", binary: png("note") });
    assert.equal(note.status, 201);
    assert.equal(note.json.relative, "封面候选/批注/封面-01-批注.png");
    const photo = await app.call(`/api/covers/photo?filename=${encodeURIComponent("我.png")}`, { method: "POST", binary: png("me") });
    assert.equal(photo.status, 201);
    const covers = await app.call("/api/covers");
    assert.equal(covers.json.settings.photo, "我的照片/我.png");
    assert.deepEqual(covers.json.favorites.map((f) => f.name), ["T001_封面-01.png"]);
    const shown = await app.call(`/api/covers/photo/${encodeURIComponent("我.png")}`);
    assert.equal(shown.status, 200);
    // 对标账号：带上封面 VI；设默认要先拆过
    const account = path.join(config.paths.benchmarkAccounts, "抖音-某某");
    mkdirSync(path.join(account, "封面"), { recursive: true });
    writeFileSync(path.join(account, "档案.json"), JSON.stringify({ platform: "抖音", account_name: "某某" }));
    writeFileSync(path.join(account, "封面", "K01.jpg"), jpg());
    const noVi = await app.call("/api/research/accounts/vi-default", { method: "POST", body: { name: "抖音-某某" } });
    assert.equal(noVi.status, 409);
    writeFileSync(path.join(account, "VI拆解.md"), "# 某某\n风格名：暖黄手写风\n");
    const set = await app.call("/api/research/accounts/vi-default", { method: "POST", body: { name: "抖音-某某" } });
    assert.equal(set.status, 200);
    const accounts = await app.call("/api/research/accounts");
    assert.deepEqual(accounts.json.accounts[0].vi.style, "暖黄手写风");
    assert.equal(accounts.json.accounts[0].vi.isDefault, true);
    const cover = await app.call(`/api/research/accounts/${encodeURIComponent("抖音-某某")}/vi/K01.jpg`);
    assert.equal(cover.type, "image/jpeg");
    // 防跨站：别的网页发来的写请求、不是 JSON 的写请求拒绝
    const evil = await app.call("/api/works/T001/covers/unselect", { method: "POST", body: {}, headers: { Origin: "https://example.com" } });
    assert.equal(evil.status, 403);
    const form = await app.call("/api/works/T001/covers/select", { method: "POST", headers: { "Content-Type": "text/plain" } });
    assert.equal(form.status, 415);
    assert.ok(existsSync(path.join(dir, "封面-02.png")), "被拒绝的请求什么都没动");
  } finally {
    await app.close();
  }
});
