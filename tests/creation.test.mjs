// 创作页和工作台接上的地方：保存服务的根目录从设置读、端口避让、详情页和「在做」能打开创作页。
// 要用 python3（和 pnpm start 一样，环境变量 WORKBENCH_PYTHON 可以换）；保存服务真的起在随机端口上，测完关掉。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { createApp } from "../lib/app.mjs";
import { CREATION_DIR, SAVE_SERVICE, creationUrl, findPython, saveServiceArgs } from "../lib/creation.mjs";
import { BLOCKED_PORTS, DEFAULT_PORTS, pickPort } from "../lib/ports.mjs";
import { readWorks, worksLayout } from "../lib/works.mjs";
import { ensureWorkspace } from "../lib/workspace.mjs";
import { fakeKeyStore, fakeOpener, tempHome, testConfig } from "./helpers.mjs";

const python = findPython();

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const randomPort = () => 30000 + Math.floor(Math.random() * 20000);

async function healthz(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
    return await response.json();
  } catch {
    return null;
  }
}

/** 照 pnpm start 的样子起保存服务：同一个 python3、同一套参数。等它应答，返回停它的函数。 */
async function startSaveService(config, port) {
  const child = spawn(python.command, saveServiceArgs(config, port), { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  for (let i = 0; i < 60; i += 1) {
    const h = await healthz(port);
    if (h?.service === SAVE_SERVICE) {
      return { health: h, stop: () => new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); }) };
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill("SIGKILL");
  throw new Error(`保存服务没起来：${stderr}`);
}

/** 用仓库里的 build_page.py（写稿 Skill 底层调的那个）给一条内容生成创作页，返回页面标识。 */
function buildPage(config, id, folderName, extra = {}) {
  const folder = path.join(config.paths.drafts, folderName);
  mkdirSync(folder, { recursive: true });
  const data = {
    content_id: id,
    type: "口播",
    stage: "写稿",
    title: "示例：用 AI 三分钟想好一条视频的开头",
    narrative: { story: "开头总卡住的人，用一条提示词三分钟想好开头", audience: "刚开始做短视频的人", problem: "开头 5 秒留不住人" },
    segments: [
      { title: "开头", role: "钩子", refs: [], baseline: "你是不是每次都卡在第一句？", mine: "你是不是每次都卡在第一句？" },
      { title: "做法", role: "给方法", refs: [], baseline: "我用一条提示词，让 AI 一次写五个开头。", mine: "我用一条提示词，让 AI 一次写五个开头。" },
    ],
    suggestions: [
      { segment: 2, category: "表达", original: "一次写五个开头", proposed: "一口气写五个开头", reason: "「一口气」更像说话", basis: { type: "AI 自己的判断", text: "口语" } },
    ],
    ...extra,
  };
  const dataFile = path.join(config.home, `${id}_数据.json`);
  writeFileSync(dataFile, JSON.stringify(data));
  const out = path.join(folder, `${id}_创作页.html`);
  const run = spawnSync(python.command, [path.join(CREATION_DIR, "build_page.py"), dataFile, "--out", out, "--root", config.workFolder], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", WORKBENCH_CONFIG_DIR: path.dirname(config.file) },
  });
  assert.equal(run.status, 0, run.stderr);
  const pageId = run.stdout.match(/page_id：([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(pageId, run.stdout);
  return { pageId, file: out, stdout: run.stdout };
}

test("找 python3：能找到就给版本；找不到时说清楚怎么装", () => {
  assert.ok(python.ok, python.reason ?? "");
  assert.match(python.version, /^3\.\d+$/);
  const missing = findPython({ ...process.env, WORKBENCH_PYTHON: "/没有这个程序/python3" });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /xcode-select --install/);
});

test("保存服务的根目录从设置读：工作文件夹在哪，保存服务就管哪；回收站不扫", async () => {
  const home = tempHome();
  const config = testConfig({ workFolder: "~/我的 写作", paths: { trash: "回收站" } }, { home });
  ensureWorkspace(config);
  const port = await pickPort(randomPort());
  const args = saveServiceArgs(config, port);
  assert.deepEqual(args.slice(1), ["--root", path.join(home, "我的 写作"), "--port", String(port), "--skip-dir", path.join(home, "我的 写作", "回收站")]);
  const service = await startSaveService(config, port);
  try {
    assert.equal(service.health.root, config.workFolder);
    assert.deepEqual(service.health.skip, [config.paths.trash]);
    assert.equal(service.health.root_ok, true);
  } finally {
    await service.stop();
  }
  // 回收站放在工作文件夹外面时不用跳过
  const outside = testConfig({ paths: { trash: path.join(home, "别处的回收站") } }, { home: tempHome() });
  assert.deepEqual(saveServiceArgs(outside, port).slice(5), []);
});

test("端口避让：保存服务的端口被占就往后找，不用 8977、8978，也不和接口、界面抢", async () => {
  assert.equal(DEFAULT_PORTS.save, 18977);
  for (const port of [8977, 8978]) assert.ok(BLOCKED_PORTS.has(port), `${port} 要在禁用清单里`);
  // 从 8976 往后找、8976 算占用：8977、8978 一定跳过
  const next = await pickPort(8976, { exclude: [8976] });
  assert.ok(next >= 8979, `应该跳过 8977、8978，实际挑了 ${next}`);
  // 保存服务的端口被别的程序占着：往后挪，也不和接口、界面的端口撞
  const start = randomPort();
  const busy = await listen(start);
  try {
    const apiPort = await pickPort(start + 1);
    const uiPort = await pickPort(apiPort + 1, { exclude: [apiPort] });
    const savePort = await pickPort(start, { exclude: [apiPort, uiPort] });
    assert.ok(savePort > start);
    assert.ok(![apiPort, uiPort].includes(savePort));
  } finally {
    busy.close();
  }
});

test("详情页和「在做」能打开创作页：认出草稿文件夹里的创作页，链接用保存服务这次的端口，真的打得开", async () => {
  const config = testConfig(null, { home: tempHome() });
  ensureWorkspace(config);
  const { pageId } = buildPage(config, "T001", "T001_示例选题");
  const apiPort = await pickPort(randomPort());
  const uiPort = await pickPort(apiPort + 1, { exclude: [apiPort] });
  const savePort = await pickPort(uiPort + 1, { exclude: [apiPort, uiPort] });
  const server = createServer(createApp({ config, apiPort, uiPort, savePort, opener: fakeOpener(), keyStore: fakeKeyStore() }));
  await new Promise((resolve) => server.listen(apiPort, "127.0.0.1", resolve));
  const service = await startSaveService(config, savePort);
  try {
    const get = async (route) => (await fetch(`http://127.0.0.1:${apiPort}${route}`)).json();
    const detail = await get("/api/works/T001");
    assert.deepEqual(
      { name: detail.creation.name, pageId: detail.creation.pageId, url: detail.creation.url, ref: detail.creation.ref },
      { name: "T001_创作页.html", pageId, url: creationUrl(savePort, pageId), ref: "drafts:T001_示例选题/T001_创作页.html" },
    );
    assert.equal(detail.stage, "doing", "草稿文件夹里有创作页，就算在做");
    assert.ok(detail.files.some((file) => file.kind === "creation"));
    // 「在做」页签用的列表里也有这条内容的创作页
    const list = await get("/api/works");
    assert.equal(list.works.find((work) => work.id === "T001").creation.url, detail.creation.url);
    // 界面要写「复制给 AI 的话」：Skill 名字、仓库位置、保存服务端口
    const info = await get("/api/app");
    assert.deepEqual(info.creation, { skill: "jincheng-workbench-write", repo: path.resolve(CREATION_DIR, ".."), savePort });
    // 链接真的打得开：保存服务按页面标识找到这个文件，给出页面
    const page = await fetch(detail.creation.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>T001 示例：用 AI 三分钟想好一条视频的开头<\/title>/);
    assert.match(html, /window\.JC_SERVED/);
  } finally {
    await service.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("创作页里采纳了几条：从页面文件里数（新手指引的清单「在创作页采纳一条建议」用）", () => {
  const config = testConfig(null, { home: tempHome() });
  ensureWorkspace(config);
  const { file } = buildPage(config, "T001", "T001_示例选题");
  const layout = worksLayout(config, { savePort: 18977 });
  const t001 = () => readWorks(layout).works.find((work) => work.id === "T001");
  assert.equal(t001().creation.adopted, 0);
  // 用户在页面上点了「采纳」：页面文件里这条建议的决定变成「采纳」
  const html = readFileSync(file, "utf8");
  const block = html.match(/(<script id="jc-doc" type="application\/json">)([\s\S]*?)(<\/script>)/);
  const doc = JSON.parse(block[2]);
  doc.items.find((item) => item.kind === "suggestion").fields.decision = "采纳";
  writeFileSync(file, html.replace(block[0], () => block[1] + JSON.stringify(doc) + block[3]));
  assert.equal(t001().creation.adopted, 1);
});

test("没有创作页时 creation 是空的；草稿文件夹里别的编号的创作页不算", async () => {
  const config = testConfig(null, { home: tempHome() });
  ensureWorkspace(config);
  const apiPort = await pickPort(randomPort());
  const server = createServer(createApp({ config, apiPort, uiPort: apiPort + 1, savePort: 18977, opener: fakeOpener(), keyStore: fakeKeyStore() }));
  await new Promise((resolve) => server.listen(apiPort, "127.0.0.1", resolve));
  try {
    const get = async (route) => (await fetch(`http://127.0.0.1:${apiPort}${route}`)).json();
    assert.equal((await get("/api/works/T001")).creation, null);
    // T001 的草稿文件夹里放了一张写着 T002 的创作页：不是这条内容的
    buildPage(config, "T002", "T001_示例选题");
    const detail = await get("/api/works/T001");
    assert.equal(detail.creation, null);
    assert.ok(detail.files.some((file) => file.kind === "html" && file.name === "T002_创作页.html"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Python 脚本和工作台读同一个设置文件：默认路径、端口和禁用端口两边一致", () => {
  const script =
    "import json, sys; sys.path.insert(0, sys.argv[1]); import creation_doc as cd; " +
    "print(json.dumps({'paths': cd.DEFAULT_PATHS, 'ports': cd.DEFAULT_PORTS, 'blocked': sorted(cd.BLOCKED_PORTS), 'id': cd.brand_id()}))";
  const run = spawnSync(python.command, ["-c", script, CREATION_DIR], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(run.status, 0, run.stderr);
  const py = JSON.parse(run.stdout);
  const defaults = testConfig(null, { home: tempHome() });
  const rel = (key) => path.relative(defaults.workFolder, defaults.paths[key]);
  assert.deepEqual(py.paths, { drafts: rel("drafts"), trash: rel("trash"), writingMethod: rel("writingMethod") });
  assert.deepEqual(py.ports, { ...DEFAULT_PORTS });
  assert.deepEqual(py.blocked, [...BLOCKED_PORTS].sort((a, b) => a - b));
  assert.equal(py.id, path.basename(path.dirname(defaults.file)));
});
