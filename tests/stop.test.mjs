// pnpm stop：没在运行时说一声、不算出错；AI 工具的沙箱不让连本机端口时（Codex 默认这样），说「查不了」、退出码 2，
// 不误报「没在运行」（2026-10-03 真跑验收时发现：沙箱里误报，AI 差点以为旧版本已经停了）。
// pnpm start 碰到同样的情况也直说（scripts/start.mjs 的 localBlocked）。真的停一份在运行的工作台，在开发记录「交给 AI 的话」里手动验过。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = () => mkdtempSync(path.join(os.tmpdir(), "workbench-stop-test-"));
const env = (h) => ({ ...process.env, HOME: h, WORKBENCH_CONFIG_DIR: "", WORKBENCH_KEYCHAIN_SERVICE: "jincheng-workbench-stop-test" });

test("没在运行：说一声，退出码 0，不写设置文件", () => {
  const h = home();
  const r = spawnSync(process.execPath, ["scripts/stop.mjs"], { cwd: ROOT, env: env(h), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /没在运行，不用停/);
  assert.ok(!existsSync(path.join(h, "Library", "Application Support")), "停的时候不建设置文件");
});

const SANDBOX = "/usr/bin/sandbox-exec";
test("沙箱不让连本机端口：说查不了，退出码 2；启动也直说", { skip: !existsSync(SANDBOX) && "这台电脑没有 sandbox-exec" }, () => {
  const h = home();
  const profile = "(version 1)(allow default)(deny network*)";
  const stop = spawnSync(SANDBOX, ["-p", profile, process.execPath, "scripts/stop.mjs"], { cwd: ROOT, env: env(h), encoding: "utf8" });
  assert.equal(stop.status, 2, stop.stdout + stop.stderr);
  assert.match(stop.stderr, /不让连本机端口.*不代表没在运行/);
  assert.doesNotMatch(stop.stdout, /没在运行，不用停/);
});
