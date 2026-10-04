// 市场调研：读对标账号、调研报告、评论导入；页面上手动加账号存回文件；导入评论表；TikHub「检测并保存」的接口。
// 用假家目录里的设置起一个真的 HTTP 服务，按界面会发的请求挨个问。钥匙串用内存里的假的，TikHub 用假的。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import path from "node:path";
import { createApp } from "../lib/app.mjs";
import { pickPort } from "../lib/ports.mjs";
import { listAccounts, listReports, scanCommentImports } from "../lib/research.mjs";
import { ensureWorkspace } from "../lib/workspace.mjs";
import { DOUYIN_HEAD, DOUYIN_ROWS, GOOD, POOR, fakeKeyStore, fakeOpener, fakeTikhub, testConfig, write, xlsx } from "./helpers.mjs";

async function startApp({ settings = null, key = null, tikhubBase = null } = {}) {
  const config = testConfig(settings);
  ensureWorkspace(config);
  const apiPort = await pickPort(30000 + Math.floor(Math.random() * 20000));
  const uiPort = apiPort + 1;
  const keyStore = fakeKeyStore({ key });
  const outside = [];
  // 记下所有往外连的请求：没接 TikHub 时一个都不该有
  const fetchImpl = async (url, init) => {
    outside.push(String(url));
    return fetch(url, init);
  };
  const tikhubEnv = { TIKHUB_BASE_URL: tikhubBase ?? "http://127.0.0.1:9" };
  const server = createServer(createApp({ config, apiPort, uiPort, opener: fakeOpener(), keyStore, tikhubEnv, fetchImpl }));
  await new Promise((resolve) => server.listen(apiPort, "127.0.0.1", resolve));
  const call = async (route, { method = "GET", body, raw, type, headers = {} } = {}) => {
    const init = { method, headers: { ...headers }, redirect: "manual" };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    } else if (raw !== undefined) {
      init.headers["Content-Type"] = type ?? "application/octet-stream";
      init.body = raw;
    }
    const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, init);
    const buffer = Buffer.from(await response.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(buffer.toString("utf8"));
    } catch {
      json = null;
    }
    return { status: response.status, json, text: buffer.toString("utf8"), headers: response.headers };
  };
  return { config, keyStore, outside, call, uiPort, port: apiPort, close: () => new Promise((resolve) => server.close(resolve)) };
}

const profileOf = (config, name) => JSON.parse(readFileSync(path.join(config.paths.benchmarkAccounts, name, "档案.json"), "utf8"));

test("读对标账号：档案里的字段、图片（头像在前）；档案写坏了照样列出来并说清楚；以点开头的文件夹不列", () => {
  const config = testConfig();
  ensureWorkspace(config);
  const dir = config.paths.benchmarkAccounts;
  write(
    path.join(dir, "抖音-示例博主", "档案.json"),
    JSON.stringify({ platform: "抖音", account_name: "示例博主", url: "https://www.douyin.com/user/demo", note: "开头三秒很会抓人", tags: ["口播", "低粉爆款"], updated_at: "2026-10-02T10:00:00+08:00", followers: 12000, bio: "每天一个小技巧", source: "tikhub" }),
  );
  write(path.join(dir, "抖音-示例博主", "主页截图.png"), "png");
  write(path.join(dir, "抖音-示例博主", "头像.jpg"), "jpg");
  write(path.join(dir, "抖音-示例博主", "笔记.txt"), "不是图片");
  write(path.join(dir, "小红书-坏档案", "档案.json"), "{ 坏");
  mkdirSync(path.join(dir, ".隐藏"), { recursive: true });
  const accounts = listAccounts(dir);
  // 最近改过的在前：坏档案那个没写 updated_at，按文件夹的修改时间（刚建的）算
  assert.deepEqual(accounts.map((a) => a.name), ["小红书-坏档案", "抖音-示例博主"]);
  const demo = accounts.find((a) => a.name === "抖音-示例博主");
  assert.deepEqual(
    { platform: demo.platform, accountName: demo.accountName, url: demo.url, note: demo.note, tags: demo.tags, followers: demo.followers, bio: demo.bio, source: demo.source, images: demo.images, problem: demo.problem },
    { platform: "抖音", accountName: "示例博主", url: "https://www.douyin.com/user/demo", note: "开头三秒很会抓人", tags: ["口播", "低粉爆款"], followers: 12000, bio: "每天一个小技巧", source: "tikhub", images: ["头像.jpg", "主页截图.png"], problem: null },
  );
  const broken = accounts.find((a) => a.name === "小红书-坏档案");
  assert.equal(broken.accountName, "小红书-坏档案");
  assert.match(broken.problem, /写坏了/);
});

test("读调研报告：有 meta.json 按它来，没有就按文件夹名和里面的网页；不显示的、没有网页的不列；日期新的在前", () => {
  const config = testConfig();
  ensureWorkspace(config);
  const dir = config.paths.researchReports;
  write(path.join(dir, "2026-10-02_某条视频的评论区", "index.html"), "<h1>总览</h1>");
  write(path.join(dir, "2026-10-02_某条视频的评论区", "需求.html"), "<h1>需求</h1>");
  write(
    path.join(dir, "2026-10-02_某条视频的评论区", "meta.json"),
    JSON.stringify({ title: "某条视频的评论区", date: "2026-10-02", type: "评论洞察", source: "https://www.douyin.com/video/v100", pages: [{ file: "index.html", title: "总览" }, { file: "需求.html", title: "评论里的需求" }, { file: "../越界.html" }, { file: "不存在.html" }] }),
  );
  write(path.join(dir, "2026-9-30_没有说明的报告", "b.html"), "b");
  write(path.join(dir, "2026-9-30_没有说明的报告", "index.html"), "i");
  write(path.join(dir, "2026-10-03_藏起来的", "index.html"), "x");
  write(path.join(dir, "2026-10-03_藏起来的", "meta.json"), JSON.stringify({ workbenchVisible: false }));
  write(path.join(dir, "2026-10-03_还在做", "meta.json"), JSON.stringify({ title: "还在做" }));
  write(path.join(dir, "2026-10-01_说明写坏了", "index.html"), "x");
  write(path.join(dir, "2026-10-01_说明写坏了", "meta.json"), "{坏");
  const reports = listReports(dir);
  assert.deepEqual(reports.map((r) => [r.id, r.date, r.type]), [
    ["2026-10-02_某条视频的评论区", "2026-10-02", "评论洞察"],
    ["2026-10-01_说明写坏了", "2026-10-01", "未分类"],
    ["2026-9-30_没有说明的报告", "2026-09-30", "未分类"],
  ]);
  assert.deepEqual(reports[0].pages.map((p) => [p.file, p.title]), [["index.html", "总览"], ["需求.html", "评论里的需求"]]);
  assert.equal(reports[0].source, "https://www.douyin.com/video/v100");
  assert.equal(reports[1].title, "说明写坏了");
  assert.match(reports[1].problem, /meta\.json 写坏了/);
  assert.deepEqual(reports[2].pages.map((p) => p.file), ["index.html", "b.html"]);
});

test("手动添加对标账号：存回 档案.json（约定的字段，source 是 manual），读回来一致；同一个账号不重复建；编辑只改表单那几项", async () => {
  const app = await startApp();
  try {
    const added = await app.call("/api/research/accounts", {
      method: "POST",
      body: { platform: "抖音", accountName: " 示例 博主 ", url: "https://www.douyin.com/user/demo?from=share", note: "学它的开头", tags: "口播，低粉爆款、口播" },
    });
    assert.equal(added.status, 201);
    assert.equal(added.json.name, "抖音-示例博主");
    assert.match(added.json.message, /已添加「示例 博主」/);
    const profile = profileOf(app.config, "抖音-示例博主");
    assert.deepEqual(Object.keys(profile), ["platform", "account_name", "url", "note", "tags", "updated_at", "source", "created_at"]);
    assert.deepEqual(
      { platform: profile.platform, account_name: profile.account_name, url: profile.url, note: profile.note, tags: profile.tags, source: profile.source },
      { platform: "抖音", account_name: "示例 博主", url: "https://www.douyin.com/user/demo?from=share", note: "学它的开头", tags: ["口播", "低粉爆款"], source: "manual" },
    );
    assert.match(profile.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    const listed = await app.call("/api/research/accounts");
    assert.deepEqual(listed.json.accounts.map((a) => [a.name, a.accountName, a.source]), [["抖音-示例博主", "示例 博主", "manual"]]);
    assert.ok(listed.json.platforms.includes("小红书"));

    // 同平台同名、同一个主页链接（参数不同也算）：不再建，告诉他去编辑那一个
    const twin = await app.call("/api/research/accounts", { method: "POST", body: { platform: "抖音", accountName: "示例博主" } });
    assert.equal(twin.status, 409);
    assert.match(twin.json.error, /已经有这个账号了：「抖音-示例博主」/);
    const sameUrl = await app.call("/api/research/accounts", { method: "POST", body: { platform: "其他", accountName: "换个名字", url: "https://douyin.com/user/demo/" } });
    assert.equal(sameUrl.status, 409);

    // 填错的说清楚
    assert.match((await app.call("/api/research/accounts", { method: "POST", body: { accountName: "  " } })).json.error, /账号名要填/);
    assert.match((await app.call("/api/research/accounts", { method: "POST", body: { accountName: "x", url: "javascript:alert(1)" } })).json.error, /http:\/\/ 或 https:\/\//);

    // 编辑：AI 用 TikHub 拉来的粉丝数、简介、来源和别的字段原样留着
    const file = path.join(app.config.paths.benchmarkAccounts, "抖音-示例博主", "档案.json");
    writeFileSync(file, JSON.stringify({ ...profileOf(app.config, "抖音-示例博主"), followers: 12000, bio: "简介", source: "tikhub", 别的字段: 1 }, null, 2));
    const edited = await app.call("/api/research/accounts", { method: "POST", body: { name: "抖音-示例博主", platform: "抖音", accountName: "示例博主", url: "", note: "改了备注", tags: [] } });
    assert.equal(edited.status, 200);
    const after = profileOf(app.config, "抖音-示例博主");
    assert.deepEqual(
      { account_name: after.account_name, url: after.url, note: after.note, tags: after.tags, followers: after.followers, bio: after.bio, source: after.source, 别的字段: after.别的字段 },
      { account_name: "示例博主", url: null, note: "改了备注", tags: [], followers: 12000, bio: "简介", source: "tikhub", 别的字段: 1 },
    );
    // 不能借编辑改到文件夹外面去
    assert.equal((await app.call("/api/research/accounts", { method: "POST", body: { name: "../外面", accountName: "x" } })).status, 400);
  } finally {
    await app.close();
  }
});

test("账号图片：传上去（不覆盖同名的）、拿得到；只收图片、只收原始字节；账号挪进回收站", async () => {
  const app = await startApp();
  try {
    await app.call("/api/research/accounts", { method: "POST", body: { platform: "小红书", accountName: "图片墙" } });
    const name = encodeURIComponent("小红书-图片墙");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const first = await app.call(`/api/research/accounts/image?name=${name}&filename=${encodeURIComponent("头像.png")}`, { method: "POST", raw: png });
    assert.equal(first.status, 201);
    assert.equal(first.json.file, "头像.png");
    const second = await app.call(`/api/research/accounts/image?name=${name}&filename=${encodeURIComponent("头像.png")}`, { method: "POST", raw: png });
    assert.equal(second.json.file, "头像-2.png");
    const got = await app.call(`/api/research/accounts/${name}/${encodeURIComponent("头像.png")}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.equal(got.text.length > 0, true);
    assert.equal((await app.call(`/api/research/accounts/image?name=${name}&filename=a.svg`, { method: "POST", raw: png })).status, 415);
    // 表单那种请求（别的网页不先问就能发）一律不收
    assert.equal((await app.call(`/api/research/accounts/image?name=${name}&filename=a.png`, { method: "POST", raw: png, type: "text/plain" })).status, 415);
    assert.equal((await app.call(`/api/research/accounts/${name}/${encodeURIComponent("../../config.json")}`)).status, 400);

    const trashed = await app.call("/api/research/accounts/trash", { method: "POST", body: { name: "小红书-图片墙" } });
    assert.equal(trashed.status, 200);
    assert.equal(existsSync(path.join(app.config.paths.benchmarkAccounts, "小红书-图片墙")), false);
    assert.deepEqual(readdirSync(app.config.paths.trash).map((n) => n.replace(/^\d{4}-\d{2}-\d{2}_/, "")), ["对标账号_小红书-图片墙"]);
  } finally {
    await app.close();
  }
});

test("调研报告的网页：在隔开的环境里打开（sandbox，碰不到工作台的接口），路径跑不出报告文件夹", async () => {
  const app = await startApp();
  try {
    write(path.join(app.config.paths.researchReports, "2026-10-02_示例", "index.html"), "<h1>报告</h1><img src='图/封面.png'>");
    write(path.join(app.config.paths.researchReports, "2026-10-02_示例", "图", "封面.png"), "png");
    const list = await app.call("/api/research/reports");
    assert.deepEqual(list.json.reports.map((r) => r.id), ["2026-10-02_示例"]);
    const id = encodeURIComponent("2026-10-02_示例");
    const page = await app.call(`/api/research/reports/${id}/index.html`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /^sandbox /);
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.equal((await app.call(`/api/research/reports/${id}/${encodeURIComponent("图")}/${encodeURIComponent("封面.png")}`)).status, 200);
    assert.equal((await app.call(`/api/research/reports/${id}/..%2F..%2F..%2Fconfig.json`)).status, 400);
    assert.equal((await app.call(`/api/research/reports/${id}/没有.html`)).status, 404);
  } finally {
    await app.close();
  }
});

test("导入评论表：认出是评论表才存进评论导入，数对条数和来自几条视频；不是评论表的不存；合计时同一条视频只算一次", async () => {
  const app = await startApp();
  try {
    const first = await app.call(`/api/research/comments/import?filename=${encodeURIComponent("抖音评论 导出.xlsx")}`, { method: "POST", raw: xlsx([DOUYIN_HEAD, ...DOUYIN_ROWS]) });
    assert.equal(first.status, 201);
    assert.equal(first.json.file, "抖音评论导出.xlsx");
    assert.equal(first.json.message, "「抖音评论导出.xlsx」导入好了：4 条评论，来自 2 条视频。");
    assert.equal(first.json.imports.line, "已导入 4 条评论，来自 2 条视频");
    assert.ok(existsSync(path.join(app.config.paths.commentImports, "抖音评论导出.xlsx")));
    // 同一个文件再拖一次：另存一份，不覆盖；合计里两条视频只算一次
    const again = await app.call(`/api/research/comments/import?filename=${encodeURIComponent("抖音评论 导出.xlsx")}`, { method: "POST", raw: xlsx([DOUYIN_HEAD, ...DOUYIN_ROWS]) });
    assert.equal(again.json.file, "抖音评论导出-2.xlsx");
    assert.equal(again.json.imports.comments, 8);
    assert.equal(again.json.imports.notes, 2);
    assert.equal(again.json.imports.line, "已导入 8 条评论，来自 2 条视频");
    const wrong = await app.call(`/api/research/comments/import?filename=${encodeURIComponent("别的表.csv")}`, { method: "POST", raw: Buffer.from("标题,点赞\n一,2\n") });
    assert.equal(wrong.status, 422);
    assert.match(wrong.json.error, /没导入：没认出评论那一列/);
    assert.equal(existsSync(path.join(app.config.paths.commentImports, "别的表.csv")), false);
    assert.equal((await app.call(`/api/research/comments/import?filename=a.xls`, { method: "POST", raw: Buffer.from("x") })).status, 415);
    // 自己放进文件夹的表也算；README 这类不是表的不算
    write(path.join(app.config.paths.commentImports, "小红书.csv"), "笔记ID,评论内容\nn1,好\n");
    write(path.join(app.config.paths.commentImports, "说明.md"), "# 说明");
    const scan = scanCommentImports(app.config.paths.commentImports);
    assert.deepEqual([scan.recognized, scan.comments, scan.notes, scan.unit, scan.configured], [3, 9, 3, "笔记或视频", true]);
    assert.deepEqual(scan.tables.map((t) => t.name).sort(), ["小红书.csv", "抖音评论导出-2.xlsx", "抖音评论导出.xlsx"].sort());
  } finally {
    await app.close();
  }
});

test("数据来源：新装好时还差 2 步、不连外网；导入评论表少一步；接好 TikHub 再少一步", async () => {
  const tikhub = await fakeTikhub({ prices: { "/api/v1/douyin/app/v3/fetch_video_comments": 0.001 } });
  const app = await startApp({ tikhubBase: tikhub.base });
  try {
    const fresh = await app.call("/api/research/sources");
    assert.equal(fresh.status, 200);
    assert.equal(fresh.json.missing, 2);
    assert.deepEqual([fresh.json.tikhub.configured, fresh.json.tikhub.last4, fresh.json.tikhub.check], [false, null, null]);
    assert.equal(fresh.json.tikhub.links.register, "https://user.tikhub.io/register");
    assert.equal(fresh.json.tikhub.links.keys, "https://user.tikhub.io/dashboard/api");
    assert.equal(fresh.json.tikhub.cost.live, false);
    assert.equal(fresh.json.social.storeUrl, "https://chromewebstore.google.com/detail/iecafjejbggeoldcjiehgoolokaebpdf");
    assert.equal(fresh.json.social.downloadUrl, "https://socialext.com/download");
    assert.equal(fresh.json.social.imports.configured, false);
    assert.deepEqual(app.outside, [], "没接 TikHub 时不连外网");
    assert.equal((await app.call("/api/app")).json.research.missing, 2);

    await app.call(`/api/research/comments/import?filename=a.csv`, { method: "POST", raw: Buffer.from("评论内容\n好\n") });
    assert.equal((await app.call("/api/research/sources")).json.missing, 1);

    const saved = await app.call("/api/research/tikhub/connect", { method: "POST", body: { key: GOOD } });
    assert.equal(saved.json.result, "ok");
    const after = await app.call("/api/research/sources");
    assert.equal(after.json.missing, 0);
    assert.equal((await app.call("/api/app")).json.research.missing, 0);
    assert.deepEqual([after.json.tikhub.configured, after.json.tikhub.last4, after.json.tikhub.check.result, after.json.tikhub.check.balance], [true, "1234", "ok", 3.2]);
  } finally {
    await app.close();
    await tikhub.close();
  }
});

test("TikHub 检测并保存：key 不对不存（原来的也不动），能用才存；页面只拿到后四位和余额；能删；别的网页发来的、不是 JSON 的一律拒绝", async () => {
  const tikhub = await fakeTikhub();
  const app = await startApp({ tikhubBase: tikhub.base });
  const secretFree = (response, key) => assert.ok(!response.text.includes(key), `回给页面的内容里不能有 key：${response.text}`);
  try {
    const wrong = await app.call("/api/research/tikhub/connect", { method: "POST", body: { key: "test-key-wrong-0000" } });
    assert.equal(wrong.status, 200);
    assert.deepEqual([wrong.json.result, wrong.json.saved, wrong.json.status.configured], ["bad-key", false, false]);
    assert.match(wrong.json.message, /key 不对，或者已经停用了/);
    secretFree(wrong, "test-key-wrong-0000");
    assert.equal(await app.keyStore.exists(), false);

    const good = await app.call("/api/research/tikhub/connect", { method: "POST", body: { key: ` Bearer ${GOOD} ` } });
    assert.deepEqual([good.json.result, good.json.saved, good.json.status.last4, good.json.balance], ["ok", true, "1234", 3.2]);
    secretFree(good, GOOD);
    assert.deepEqual(await app.keyStore.effectiveKey(), { key: GOOD, source: "keychain" });

    // 换一个不对的 key：没通过，钥匙串里原来那个能用的不动
    const worse = await app.call("/api/research/tikhub/connect", { method: "POST", body: { key: "test-key-forbidden" } });
    assert.deepEqual([worse.json.result, worse.json.saved], ["forbidden", false]);
    assert.equal((await app.keyStore.effectiveKey()).key, GOOD);

    // 重新检测已经存好的；余额是 0 也算接好了，只是提醒充值
    const recheck = await app.call("/api/research/tikhub/check", { method: "POST", body: {} });
    assert.deepEqual([recheck.json.result, recheck.json.status.configured], ["ok", true]);
    secretFree(recheck, GOOD);
    const poor = await app.call("/api/research/tikhub/connect", { method: "POST", body: { key: POOR } });
    assert.deepEqual([poor.json.result, poor.json.saved], ["ok", true]);
    assert.match(poor.json.message, /充值以后 AI 才能拉数据/);

    const sources = await app.call("/api/research/sources");
    secretFree(sources, POOR);
    assert.equal(sources.json.tikhub.last4, "5678");

    // 粘贴的东西不像 key：直接说，不去问 TikHub
    const blank = await app.call("/api/research/tikhub/connect", { method: "POST", body: { key: "两 个 字" } });
    assert.equal(blank.status, 400);

    const removed = await app.call("/api/research/tikhub/delete", { method: "POST", body: {} });
    assert.deepEqual([removed.json.ok, removed.json.status.configured], [true, false]);
    assert.equal((await app.call("/api/research/tikhub/check", { method: "POST", body: {} })).status, 404);

    // 防跨站：别的网页、表单格式的请求都拒绝
    const evil = await app.call("/api/research/tikhub/connect", { method: "POST", body: { key: GOOD }, headers: { Origin: "https://example.com" } });
    assert.equal(evil.status, 403);
    const form = await app.call("/api/research/tikhub/connect", { method: "POST", raw: `key=${GOOD}`, type: "application/x-www-form-urlencoded" });
    assert.equal(form.status, 415);
    const fromUi = await app.call("/api/research/tikhub/connect", { method: "POST", body: { key: GOOD }, headers: { Origin: `http://127.0.0.1:${app.uiPort}` } });
    assert.equal(fromUi.json.saved, true);
    // 把别的域名解析到本机的网页（Host 不是本机地址）：fetch 改不了 Host，用 node:http 发
    const otherHost = await new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: app.port, path: "/api/research/tikhub/delete", method: "POST", headers: { Host: "evil.example", "Content-Type": "application/json" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(otherHost, 403);
    assert.equal(await app.keyStore.exists(), true);
  } finally {
    await app.close();
    await tikhub.close();
  }
});

test("设置里关掉市场调研：这一栏的接口都不给，文件夹也不建，左边菜单不算还差几步", async () => {
  const app = await startApp({ settings: { columns: ["content", "prompts"] } });
  try {
    for (const route of ["/api/research/accounts", "/api/research/reports", "/api/research/sources"]) {
      const answer = await app.call(route);
      assert.equal(answer.status, 404, route);
      assert.equal(answer.json.code, "column-off");
    }
    assert.equal((await app.call("/api/research/tikhub/connect", { method: "POST", body: { key: GOOD } })).status, 404);
    assert.equal(existsSync(app.config.paths.benchmarkAccounts), false);
    assert.equal((await app.call("/api/app")).json.research.missing, 0);
  } finally {
    await app.close();
  }
});
