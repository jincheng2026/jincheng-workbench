// 新手指引第 3 步的「一键打开」：这台 Mac 上有没有程序接 codex://、claude://code/new 和 claude-cli:// 链接（lib/ai-links.mjs）。
// 不真的问系统：用假的查询结果，测怎么算、问不了时怎么退、多久问一次、测试用的环境变量。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LINK_PROBES, createAiLinks, linksFromEnv, probeLinks } from "../lib/ai-links.mjs";
import { tempHome } from "./helpers.mjs";

test("问系统谁接这几种链接：有程序接就算能一键打开，没有就不放按钮", async () => {
  let script = "";
  const run = async (s) => {
    script = s;
    return JSON.stringify({ codex: "/Applications/ChatGPT.app", "claude-desktop": "/Applications/Claude.app", claude: "" });
  };
  assert.deepEqual(await probeLinks({ home: tempHome(), run }), { codex: true, "claude-desktop": true, claude: false });
  // 问的是官方写明的那几种链接，只问不开
  for (const url of Object.values(LINK_PROBES)) assert.ok(script.includes(url), url);
  assert.equal(LINK_PROBES["claude-desktop"], "claude://code/new");
  assert.ok(script.includes("URLForApplicationToOpenURL"));
  assert.doesNotMatch(script, /openURL\(|\.open\(/);
});

test("问不了系统时：Codex 算没有；Claude 桌面版看有没有 Claude.app；终端版看官方文档写的那个接链接的小程序在不在", async () => {
  const home = tempHome();
  const apps = [path.join(tempHome(), "Applications")];
  const broken = async () => {
    throw new Error("osascript 不能用");
  };
  assert.deepEqual(await probeLinks({ home, apps, run: broken }), { codex: false, "claude-desktop": false, claude: false });
  mkdirSync(path.join(home, "Applications", "Claude Code URL Handler.app"), { recursive: true });
  assert.deepEqual(await probeLinks({ home, apps, run: broken }), { codex: false, "claude-desktop": false, claude: true });
  mkdirSync(path.join(apps[0], "Claude.app"), { recursive: true });
  assert.deepEqual(await probeLinks({ home, apps, run: async () => "不是 JSON" }), { codex: false, "claude-desktop": true, claude: true });
});

test("最多每分钟问一次系统；有旧结果时先给旧的，新的在后台问", async () => {
  let calls = 0;
  let answer = { codex: false, claude: false };
  const probe = async () => {
    calls += 1;
    return answer;
  };
  const aiLinks = createAiLinks({ home: tempHome(), env: {}, ttl: 50, probe });
  const [a, b] = await Promise.all([aiLinks(), aiLinks()]);
  assert.deepEqual(a, { codex: false, claude: false });
  assert.equal(a, b);
  assert.equal(calls, 1, "同时来的两次只问一次");
  await aiLinks();
  assert.equal(calls, 1, "一分钟内不再问");
  answer = { codex: true, claude: false };
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(await aiLinks(), { codex: false, claude: false }, "过期了先给旧的");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await aiLinks(), { codex: true, claude: false }, "后台问到了新的");
  assert.equal(calls, 2);
});

test("测试和验收用的 WORKBENCH_AI_LINKS：写了就照写的算，不问系统", async () => {
  assert.equal(linksFromEnv(undefined), null);
  assert.deepEqual(linksFromEnv("codex,claude-desktop,claude"), { codex: true, "claude-desktop": true, claude: true });
  assert.deepEqual(linksFromEnv(" claude "), { codex: false, "claude-desktop": false, claude: true });
  assert.deepEqual(linksFromEnv("none"), { codex: false, "claude-desktop": false, claude: false });
  assert.deepEqual(linksFromEnv(""), { codex: false, "claude-desktop": false, claude: false });
  const probe = async () => {
    throw new Error("不该问系统");
  };
  assert.deepEqual(await createAiLinks({ home: tempHome(), env: { WORKBENCH_AI_LINKS: "codex" }, probe })(), { codex: true, "claude-desktop": false, claude: false });
});
