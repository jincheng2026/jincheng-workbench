// TikHub：key 存钥匙串、检测 key 的几种结果、单价。
// 不连真的 TikHub：起一个假的 TikHub（出错时像真的一样把请求头原样带回来），看 key 有没有漏出去。
// 钥匙串只用这次测试专用的服务名（helpers.mjs 里定的），测完删掉，绝不碰真的 tikhub-api 那一项。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { FALLBACK_PRICES, KEYCHAIN, costEstimate, yuan } from "../lib/data-sources.mjs";
import { pickPort } from "../lib/ports.mjs";
import { cleanKey, createKeyStore, createPriceBook, explicitKeychain, fetchPrices, keychainService, runSecurity, testKey } from "../lib/tikhub.mjs";
import { GOOD, NOMAIL, POOR, STOP, TEST_KEYCHAIN_SERVICE, fakeTikhub } from "./helpers.mjs";

test("key 整理：去掉首尾空白和 Bearer；空的、中间有空格引号中文的、长度不对的都说清楚", () => {
  assert.equal(cleanKey("  Bearer abcdefgh123  \n"), "abcdefgh123");
  assert.equal(cleanKey("abc+/def=GHI-123_x.y"), "abc+/def=GHI-123_x.y");
  for (const [raw, code] of [["", "key-empty"], ["abc def ghi", "key-format"], ['abc"defghi', "key-format"], ["钥匙abcdefgh", "key-format"], ["short", "key-format"]]) {
    assert.throws(() => cleanKey(raw), (error) => error.code === code && error.statusCode === 400, raw);
  }
});

test("钥匙串的服务名默认 tikhub-api、账户名 tikhub；测试里换成了专用的名字", () => {
  assert.deepEqual(KEYCHAIN, { service: "tikhub-api", account: "tikhub" });
  assert.equal(keychainService({}), "tikhub-api");
  assert.equal(keychainService({ WORKBENCH_KEYCHAIN_SERVICE: "别的" }), "别的");
  assert.equal(keychainService(), TEST_KEYCHAIN_SERVICE);
  assert.notEqual(TEST_KEYCHAIN_SERVICE, KEYCHAIN.service);
});

test("存 key：key 只从标准输入给 security，从不出现在命令行参数里；读回来核对；只给后四位", async () => {
  const calls = [];
  let stored = null;
  // 假的 security：照着真的退出码办（没有这一项是 44）
  const run = async (args, { input = null } = {}) => {
    calls.push({ args, input });
    if (args[0] === "-i") {
      const match = input.match(/^add-generic-password -U -s "([^"]+)" -a "([^"]+)" -w "([^"]+)"\n$/);
      if (!match) return { code: 1, stdout: "" };
      stored = match[3];
      return { code: 0, stdout: "" };
    }
    if (args[0] === "find-generic-password") return stored ? { code: 0, stdout: args.includes("-w") ? `${stored}\n` : "keychain: ...\n" } : { code: 44, stdout: "" };
    if (args[0] === "delete-generic-password") {
      if (!stored) return { code: 44, stdout: "" };
      stored = null;
      return { code: 0, stdout: "" };
    }
    return { code: 1, stdout: "" };
  };
  const store = createKeyStore({ service: "svc-for-test", env: {}, run, keychain: null });
  assert.deepEqual(await store.status(), { keychainOk: true, savedInKeychain: false, configured: false, source: null, last4: null });
  assert.equal(await store.exists(), false);
  const saved = await store.save(" abc+/def=GHI-123_x9z7 ");
  assert.deepEqual(saved, { keychainOk: true, savedInKeychain: true, configured: true, source: "keychain", last4: "x9z7" });
  assert.equal(await store.exists(), true);
  assert.deepEqual(await store.effectiveKey(), { key: "abc+/def=GHI-123_x9z7", source: "keychain" });
  for (const call of calls) {
    assert.ok(!call.args.some((arg) => arg.includes("abc+/def")), `key 不能出现在参数里：${call.args.join(" ")}`);
    assert.ok(call.args.join(" ").includes("svc-for-test") || call.args[0] === "-i");
  }
  // 「有没有」只看这一项在不在，不读出 key（不带 -w）
  assert.ok(calls.some((call) => call.args[0] === "find-generic-password" && !call.args.includes("-w")));
  assert.deepEqual((await store.remove()).configured, false);
  // 删一个本来就没有的：不报错
  assert.equal((await store.remove()).configured, false);
  // 环境变量 TIKHUB_API_KEY 优先
  const withEnv = createKeyStore({ service: "svc-for-test", env: { TIKHUB_API_KEY: "Bearer env-key-0001" }, run, keychain: null });
  assert.deepEqual(await withEnv.status(), { keychainOk: true, savedInKeychain: false, configured: true, source: "env", last4: "0001" });
  assert.deepEqual(await withEnv.effectiveKey(), { key: "env-key-0001", source: "env" });
});

test("存 key：写进去读出来对不上、钥匙串锁着，都报错，不说成功", async () => {
  const wrong = createKeyStore({ service: "svc-for-test", env: {}, keychain: null, run: async (args) => (args[0] === "-i" ? { code: 0, stdout: "" } : args.includes("-w") ? { code: 0, stdout: "别的\n" } : { code: 0, stdout: "" }) });
  await assert.rejects(wrong.save("abcdefgh1234"), (error) => error.code === "keychain-write" && /对不上/.test(error.message));
  const locked = createKeyStore({ service: "svc-for-test", env: {}, keychain: null, run: async () => ({ code: 51, stdout: "" }) });
  await assert.rejects(locked.save("abcdefgh1234"), (error) => error.code === "keychain-write" && /锁着/.test(error.message));
  assert.equal((await locked.status()).keychainOk, false);
});

test("HOME 被换掉时（临时家目录里验收）写明登录钥匙串：每条 security 命令后面都带上它；平时不带", async () => {
  const real = mkdtempSync(path.join(os.tmpdir(), "realhome-"));
  assert.equal(explicitKeychain({ home: real, realHome: real }), null);
  assert.equal(explicitKeychain({ home: "/tmp/别处", realHome: real }), null, "登录钥匙串文件不存在时不写");
  const file = path.join(real, "Library", "Keychains", "login.keychain-db");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
  assert.equal(explicitKeychain({ home: "/tmp/别处", realHome: real }), file);
  const calls = [];
  const run = async (args, { input = null } = {}) => {
    calls.push({ args, input });
    return args[0] === "-i" ? { code: 0, stdout: "" } : { code: 0, stdout: "abcdefgh9876\n" };
  };
  const store = createKeyStore({ service: "svc-for-test", env: {}, run, keychain: file });
  await store.save("abcdefgh9876");
  await store.exists();
  await store.remove().catch(() => {});
  assert.ok(calls.filter((c) => c.args[0] !== "-i").every((c) => c.args.at(-1) === file), "find、delete 都写明钥匙串");
  assert.ok(calls.find((c) => c.args[0] === "-i").input.endsWith(`"${file}"\n`), "交互模式那一行也写明钥匙串");
});

test("真的钥匙串：用测试专用的服务名存、读、删一遍，测完一定删掉", async (t) => {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/security")) {
    t.skip("这台电脑上没有 macOS 的 security 命令");
    return;
  }
  const service = `${TEST_KEYCHAIN_SERVICE}-real`;
  assert.ok(service.includes("-test-") && service !== KEYCHAIN.service);
  const store = createKeyStore({ service, env: {} });
  try {
    try {
      await store.save("test-key-real-keychain-4321");
    } catch (error) {
      if (error.code === "keychain-write") {
        t.skip("登录钥匙串现在锁着（比如远程登录），跳过");
        return;
      }
      throw error;
    }
    const status = await store.status();
    assert.equal(status.configured, true);
    assert.equal(status.last4, "4321");
    assert.equal(await store.exists(), true);
    assert.deepEqual(await store.effectiveKey(), { key: "test-key-real-keychain-4321", source: "keychain" });
    // 再存一个：换成新的，不会存出两项
    await store.save("test-key-real-keychain-8765");
    assert.equal((await store.status()).last4, "8765");
    assert.equal((await store.remove()).configured, false);
    assert.equal(await store.exists(), false);
  } finally {
    await runSecurity(["delete-generic-password", "-s", service, "-a", KEYCHAIN.account]);
    assert.equal((await runSecurity(["find-generic-password", "-s", service, "-a", KEYCHAIN.account])).code, 44, "测试专用的那一项要删干净");
  }
});

test("真的钥匙串，HOME 换成临时文件夹（和验收时一样）：照样存得进、读得出、删得掉，测完一定删掉", async (t) => {
  const login = explicitKeychain({ home: "/nonexistent-home" });
  if (process.platform !== "darwin" || !existsSync("/usr/bin/security") || !login) {
    t.skip("这台电脑上没有 macOS 的 security 命令或登录钥匙串");
    return;
  }
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "keychain-home-"));
  const env = { ...process.env, HOME: tmpHome };
  const run = (args, options = {}) => runSecurity(args, { ...options, env });
  const service = `${TEST_KEYCHAIN_SERVICE}-tmphome`;
  assert.ok(service.includes("-test-") && service !== KEYCHAIN.service);
  const store = createKeyStore({ service, env: {}, run, keychain: explicitKeychain({ home: tmpHome }) });
  try {
    try {
      await store.save("test-key-tmp-home-2468");
    } catch (error) {
      if (error.code === "keychain-write") {
        t.skip("登录钥匙串现在锁着（比如远程登录），跳过");
        return;
      }
      throw error;
    }
    assert.equal((await store.status()).last4, "2468");
    assert.equal(await store.exists(), true);
    assert.equal((await store.remove()).configured, false);
  } finally {
    await runSecurity(["delete-generic-password", "-s", service, "-a", KEYCHAIN.account, login]);
    assert.equal((await runSecurity(["find-generic-password", "-s", service, "-a", KEYCHAIN.account, login])).code, 44, "测试专用的那一项要删干净");
  }
});

test("检测 key：能用、key 不对、余额不够、邮箱没验证、请求太快、TikHub 出错、连不上，每种都说人话，不带 TikHub 的原话和 key", async () => {
  const tikhub = await fakeTikhub();
  try {
    const env = { TIKHUB_BASE_URL: tikhub.base };
    const ok = await testKey(GOOD, { env });
    assert.equal(ok.result, "ok");
    assert.equal(ok.balance, 3.2);
    assert.equal(ok.freeCredit, 0.05);
    assert.match(ok.message, /已接好，余额 \$3\.20，送的额度还剩 \$0\.05/);
    const zero = await testKey(POOR, { env });
    assert.equal(zero.result, "ok");
    assert.match(zero.message, /余额 \$0\.00。充值以后 AI 才能拉数据/);
    const cases = {
      "test-key-wrong-0000": ["bad-key", /key 不对，或者已经停用了/],
      "test-key-payment": ["no-balance", /余额不够/],
      "test-key-forbidden": ["forbidden", /邮箱还没验证|权限范围/],
      [NOMAIL]: ["forbidden", /邮箱还没验证/],
      [STOP]: ["forbidden", /停用/],
      "test-key-busy": ["busy", /太快/],
      "test-key-broken": ["server", /HTTP 500/],
    };
    for (const [key, [result, words]] of Object.entries(cases)) {
      const answer = await testKey(key, { env });
      assert.equal(answer.result, result, key);
      assert.match(answer.message, words, key);
      assert.ok(!JSON.stringify(answer).includes(key), `回答里不能有 key：${key}`);
      assert.ok(!JSON.stringify(answer).includes("上游原话"), "不转述 TikHub 的原话");
    }
    // 每次都带着 key 去问账户信息
    assert.ok(tikhub.seen.every((call) => call.path === "/api/v1/tikhub/user/get_user_info" && call.auth.startsWith("Bearer ")));
  } finally {
    await tikhub.close();
  }
  // 连不上：端口上没有服务；超时：服务不回答
  const closed = await pickPort(30000 + Math.floor(Math.random() * 20000));
  const down = await testKey(GOOD, { env: { TIKHUB_BASE_URL: `http://127.0.0.1:${closed}` } });
  assert.equal(down.result, "network");
  assert.match(down.message, /连不上 TikHub.*代理/);
  const silent = createServer(() => {});
  const port = await pickPort(30000 + Math.floor(Math.random() * 20000));
  await new Promise((resolve) => silent.listen(port, "127.0.0.1", resolve));
  try {
    const slow = await testKey(GOOD, { env: { TIKHUB_BASE_URL: `http://127.0.0.1:${port}` }, timeoutMs: 200 });
    assert.equal(slow.result, "network");
  } finally {
    silent.closeAllConnections();
    await new Promise((resolve) => silent.close(resolve));
  }
});

test("不设 TIKHUB_BASE_URL 时只连 api.tikhub.io（不用 api.tikhub.dev）", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ detail: {} }), { status: 401 });
  };
  const answer = await testKey(GOOD, { env: {}, fetchImpl });
  assert.equal(answer.result, "bad-key");
  assert.deepEqual(urls, ["https://api.tikhub.io/api/v1/tikhub/user/get_user_info"]);
});

test("大概花多少钱：兜底单价算出来的几句；现查到的单价优先用", async () => {
  assert.equal(yuan(0.006), "0.04");
  assert.equal(yuan(0.056), "0.39");
  assert.equal(yuan(0.28), "2");
  const fallback = costEstimate(FALLBACK_PRICES);
  assert.equal(fallback.live, false);
  assert.equal(fallback.checkedOn, "2026-10-03");
  assert.match(fallback.lines[0], /拉一个博主 100 条作品约 0\.04 元，带上播放量约 0\.39 元；200 条评论约 0\.07 到 0\.39 元，1000 条评论约 0\.35 到 2 元/);
  assert.match(fallback.lines[1], /小红书贵 10 倍左右：200 条评论约 0\.7 到 3\.9 元/);
  assert.equal(fallback.video, "拆一条抖音视频不到 1 分钱");
  assert.equal(yuan(0.05), "0.35");
  assert.match(fallback.note, /1 美元约 7 元/);

  const tikhub = await fakeTikhub({ prices: { "/api/v1/douyin/app/v3/fetch_video_comments": 0.002 } });
  try {
    const env = { TIKHUB_BASE_URL: tikhub.base };
    assert.deepEqual(await fetchPrices({ env }), { douyinComments: 0.002 });
    const book = createPriceBook({ env });
    assert.equal(book.estimate().live, false);
    const live = await book.refresh();
    assert.equal(live.live, true);
    assert.equal(live.prices.douyinComments, 0.002);
    assert.equal(live.prices.douyinReplies, FALLBACK_PRICES.douyinReplies);
    // 12 小时内不再查
    const before = tikhub.seen.length;
    await book.refresh();
    assert.equal(tikhub.seen.length, before);
  } finally {
    await tikhub.close();
  }
  // 一个都查不到：还是兜底值
  const closed = await pickPort(30000 + Math.floor(Math.random() * 20000));
  assert.equal(await fetchPrices({ env: { TIKHUB_BASE_URL: `http://127.0.0.1:${closed}` } }), null);
});
