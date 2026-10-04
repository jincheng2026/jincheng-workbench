import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BRAND } from "../lib/brand.mjs";
import { configDir, defaultSettings, displayPath, instanceId, isThisWorkbench, loadConfig, logDir } from "../lib/config.mjs";
import { configFileIn, tempHome, testConfig, write } from "./helpers.mjs";

test("第一次读设置：按默认值写出设置文件，路径都在工作文件夹里", () => {
  const home = tempHome();
  const config = loadConfig({ env: {}, home });
  assert.equal(config.created, true);
  assert.equal(config.file, configFileIn(home));
  assert.ok(existsSync(config.file));
  assert.deepEqual(JSON.parse(readFileSync(config.file, "utf8")), defaultSettings());
  const work = path.join(home, "Documents", BRAND.id);
  assert.equal(config.workFolder, work);
  assert.deepEqual(config.paths, {
    topics: path.join(work, "选题库"),
    overview: path.join(work, "选题库", "00_选题总览.md"),
    drafts: path.join(work, "内容草稿"),
    writingMethod: path.join(work, "写稿方法"),
    benchmarkAccounts: path.join(work, "市场调研", "对标账号"),
    researchReports: path.join(work, "市场调研", "调研报告"),
    commentImports: path.join(work, "市场调研", "评论导入"),
    prompts: path.join(work, "提示词"),
    promptUsage: path.join(work, "提示词", "_使用记录.jsonl"),
    trash: path.join(work, "回收站"),
  });
  assert.deepEqual(config.contentTypes, ["教程", "科普", "口播"]);
  assert.deepEqual(config.columns, ["content", "research", "prompts"]);
  assert.deepEqual(config.ports, { api: 18878, ui: 18879, save: 18977 });
  assert.deepEqual(config.issues, []);
  // 第二次读：不再新建，内容不变
  const again = loadConfig({ env: {}, home });
  assert.equal(again.created, false);
  assert.deepEqual(again.paths, config.paths);
});

test("只写了几项的设置：没写的用默认值；~ 展开到家目录；相对路径接在工作文件夹后面，绝对路径照用", () => {
  const home = tempHome();
  const config = testConfig(
    {
      workFolder: "~/写作",
      paths: { prompts: "/opt/共享/提示词", drafts: "稿子" },
      contentTypes: ["教程", "访谈"],
      columns: ["prompts"],
      ports: { api: 20001, ui: 20002 },
    },
    { home },
  );
  assert.equal(config.workFolder, path.join(home, "写作"));
  assert.equal(config.paths.prompts, "/opt/共享/提示词");
  assert.equal(config.paths.drafts, path.join(home, "写作", "稿子"));
  assert.equal(config.paths.topics, path.join(home, "写作", "选题库"));
  assert.deepEqual(config.contentTypes, ["教程", "访谈"]);
  assert.deepEqual(config.columns, ["prompts"]);
  assert.deepEqual(config.ports, { api: 20001, ui: 20002, save: 18977 });
  assert.deepEqual(config.issues, []);
});

test("设置写得不对：用默认值顶上，并且一条条说清楚哪里不对", () => {
  const config = testConfig({
    contentTypes: ["教程", "a/b"],
    columns: ["不认识的栏目"],
    ports: { api: 8888, ui: 99 },
    paths: { topics: "", 多余: "x" },
    拼错的项: 1,
  });
  assert.deepEqual(config.contentTypes, ["教程", "科普", "口播"]);
  assert.deepEqual(config.columns, ["content", "research", "prompts"]);
  assert.deepEqual(config.ports, { api: 18878, ui: 18879, save: 18977 });
  assert.equal(config.paths.topics, path.join(config.workFolder, "选题库"));
  const text = config.issues.join("\n");
  for (const words of ["拼错的项", "contentTypes", "不认识的栏目", "至少要开一个栏目", "ports.api", "ports.ui", "paths.topics", "多余"]) {
    assert.match(text, new RegExp(words), `应该提到「${words}」`);
  }
});

test("栏目按固定的先后排：写成 [\"prompts\", \"research\"] 也是市场调研在前", () => {
  const config = testConfig({ columns: ["prompts", "research"] });
  assert.deepEqual(config.columns, ["research", "prompts"]);
  assert.deepEqual(config.issues, []);
});

test("接口和界面不能用同一个端口", () => {
  const config = testConfig({ ports: { api: 20005, ui: 20005 } });
  assert.deepEqual(config.ports, { api: 18878, ui: 18879, save: 18977 });
  assert.match(config.issues.join("\n"), /不能一样/);
});

test("创作页保存服务的端口：能改；和接口、界面撞了或者写了本机常见服务的端口，按默认的 18977", () => {
  assert.deepEqual(testConfig({ ports: { save: 20007 } }).ports, { api: 18878, ui: 18879, save: 20007 });
  const clash = testConfig({ ports: { api: 20008, save: 20008 } });
  assert.deepEqual(clash.ports, { api: 20008, ui: 18879, save: 18977 });
  assert.match(clash.issues.join("\n"), /ports\.save 不能和/);
  for (const port of [8977, 8978]) {
    const blocked = testConfig({ ports: { save: port } });
    assert.equal(blocked.ports.save, 18977);
    assert.match(blocked.issues.join("\n"), /ports\.save/);
  }
  // 默认的 18977 正好被写成了接口端口：三个都按默认值，不会出现两个服务抢一个端口
  const taken = testConfig({ ports: { api: 18977, save: 18977 } });
  assert.deepEqual(taken.ports, { api: 18878, ui: 18879, save: 18977 });
});

test("设置文件不是合法的 JSON：直接报错，说清是哪个文件、第几行，不悄悄用默认值", () => {
  const home = tempHome();
  write(configFileIn(home), '{\n  "workFolder": "~/写作",\n  "contentTypes": ["教程",]\n}\n');
  assert.throws(
    () => loadConfig({ env: {}, home }),
    (error) => error.code === "CONFIG_INVALID" && /第 3 行/.test(error.message) && /config\.json/.test(error.message),
  );
});

test("环境变量能换掉设置和日志的位置；给人看的路径写成 ~/…", () => {
  const home = tempHome();
  assert.equal(configDir({}, home), path.join(home, "Library", "Application Support", BRAND.id));
  assert.equal(configDir({ WORKBENCH_CONFIG_DIR: "~/别处" }, home), path.join(home, "别处"));
  assert.equal(logDir({}, home), path.join(home, "Library", "Logs", BRAND.id));
  assert.equal(displayPath(path.join(home, "Documents", "x"), home), "~/Documents/x");
  assert.equal(displayPath("/opt/x", home), "/opt/x");
});

test("这一份工作台的记号：同一个设置文件算出来一样，别的设置文件不一样；记号里不带路径", () => {
  const home = tempHome();
  const mine = loadConfig({ env: {}, home });
  const other = loadConfig({ env: { WORKBENCH_CONFIG_DIR: path.join(home, "另一份") }, home });
  const id = instanceId(mine.file);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(instanceId(mine.file), id);
  assert.notEqual(instanceId(other.file), id);
  assert.ok(!id.includes(home));
  // pnpm start 只把同一个设置文件起的那一份当成「已经在运行」：别的设置文件起的、老版本没写记号的、别的程序都不算
  assert.equal(isThisWorkbench({ ok: true, app: BRAND.id, instance: id }, mine.file), true);
  assert.equal(isThisWorkbench({ ok: true, app: BRAND.id, instance: instanceId(other.file) }, mine.file), false);
  assert.equal(isThisWorkbench({ ok: true, app: BRAND.id }, mine.file), false);
  assert.equal(isThisWorkbench({ ok: true, app: "别的程序", instance: id }, mine.file), false);
  assert.equal(isThisWorkbench(null, mine.file), false);
});
