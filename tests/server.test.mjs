// 接口整体走一遍：用假家目录里的设置起一个真的 HTTP 服务，按界面会发的请求挨个问。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createApp } from "../lib/app.mjs";
import { instanceId } from "../lib/config.mjs";
import { pickPort } from "../lib/ports.mjs";
import { ensureWorkspace } from "../lib/workspace.mjs";
import { fakeKeyStore, fakeOpener, testConfig } from "./helpers.mjs";

async function start(settings = null) {
  const config = testConfig(settings);
  ensureWorkspace(config);
  const apiPort = await pickPort(30000 + Math.floor(Math.random() * 20000));
  const uiPort = apiPort + 1;
  const opener = fakeOpener();
  // 一键在 AI 里打开：不真的问系统，假装这台 Mac 上只有 Codex 接链接
  const aiLinks = async () => ({ codex: true, claude: false });
  const server = createServer(createApp({ config, apiPort, uiPort, opener, keyStore: fakeKeyStore(), aiLinks }));
  await new Promise((resolve) => server.listen(apiPort, "127.0.0.1", resolve));
  const call = async (route, { method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, headers: response.headers };
  };
  return { config, opener, call, uiPort, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("基本信息、选题、详情、提示词都能读到，路径来自设置", async () => {
  const app = await start();
  try {
    const health = await app.call("/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    // 记号由设置文件的位置算出来，pnpm start 靠它认出在运行的是不是自己
    assert.equal(health.json.instance, instanceId(app.config.file));
    assert.equal(health.json.ui, app.uiPort);
    const info = await app.call("/api/app");
    assert.deepEqual(info.json.columns, ["content", "research", "prompts"]);
    // 市场调研：新装好时 TikHub 没接、评论表没导入，左边菜单上显示「还差 2 步」
    assert.deepEqual(info.json.research, { skill: "jincheng-workbench-research", missing: 2 });
    assert.deepEqual(info.json.contentTypes, ["教程", "科普", "口播"]);
    assert.equal(info.json.workFolder, app.config.workFolder);
    // 新手指引第 3 步：哪种 AI 工具能一键打开工作文件夹（有程序接官方链接才放按钮）
    assert.deepEqual(info.json.aiLinks, { codex: true, claude: false });
    const works = await app.call("/api/works");
    assert.deepEqual(works.json.works.map((w) => w.id), ["T001"]);
    const detail = await app.call("/api/works/T001");
    assert.equal(detail.json.card.ref, "topics:教程/待做/T001_示例选题.md");
    assert.equal((await app.call("/api/works/T999")).status, 404);
    const prompts = await app.call("/api/prompts");
    assert.equal(prompts.json.totalPrompts, 2);
    const home = await app.call("/");
    assert.equal(home.status, 302);
    assert.equal(home.headers.get("location"), `http://127.0.0.1:${app.uiPort}/`);
  } finally {
    await app.close();
  }
});

test("防跨站：别的网页发来的、不是 JSON 的写请求一律拒绝", async () => {
  const app = await start();
  try {
    const evil = await app.call("/api/prompts/use", { method: "POST", body: { id: "选题/想十个选题" }, headers: { Origin: "https://example.com" } });
    assert.equal(evil.status, 403);
    const form = await app.call("/api/open", { method: "POST", headers: { "Content-Type": "text/plain" } });
    assert.equal(form.status, 415);
    const fromUi = await app.call("/api/prompts/use", { method: "POST", body: { id: "选题/想十个选题" }, headers: { Origin: `http://127.0.0.1:${app.uiPort}` } });
    assert.equal(fromUi.status, 201);
    assert.equal(fromUi.json.prompt.useCount, 1);
    const bad = await app.call("/api/prompts/use", { method: "POST", body: "不是对象" });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
  }
});

test("建草稿文件夹并在访达里打开、打开固定位置：都只交给打开器，不弹窗口", async () => {
  const app = await start();
  try {
    const made = await app.call("/api/works/draft-folder", { method: "POST", body: { id: "T001" } });
    assert.equal(made.status, 200);
    // 示例选题 T001 自带草稿文件夹（放着参考材料）：用已有的，照样在访达里打开
    assert.equal(made.json.created, false);
    assert.equal(made.json.name, "T001_示例选题");
    assert.ok(existsSync(path.join(app.config.paths.drafts, made.json.name)));
    const opened = await app.call("/api/open", { method: "POST", body: { place: "overview" } });
    assert.equal(opened.status, 200);
    assert.deepEqual(
      app.opener.calls.map((call) => [path.basename(call.target), call.reveal]),
      [[made.json.name, true], ["00_选题总览.md", false]],
    );
    assert.equal((await app.call("/api/open", { method: "POST", body: { place: "别处" } })).status, 400);
    // 回收站还没建：说清楚，不报内部错误
    const trash = await app.call("/api/open", { method: "POST", body: { place: "trash" } });
    assert.equal(trash.status, 404);
    assert.match(trash.json.error, /回收站不见了/);
  } finally {
    await app.close();
  }
});

test("设置里关掉的栏目，接口也不给", async () => {
  const app = await start({ columns: ["content"] });
  try {
    const prompts = await app.call("/api/prompts");
    assert.equal(prompts.status, 404);
    assert.equal(prompts.json.code, "column-off");
    assert.equal((await app.call("/api/works")).status, 200);
  } finally {
    await app.close();
  }
});
