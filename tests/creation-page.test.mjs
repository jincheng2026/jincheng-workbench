// 创作页（creation-page/）自己的 Python 测试：保存服务、生成和读改脚本、页面模板、和工作台设置接上的部分。
// 每个测试文件起一个 python3 进程，几个一起跑（各用各的临时文件夹和随机端口）；浏览器测试另外跑（pnpm test:browser）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { CREATION_DIR, findPython } from "../lib/creation.mjs";

const python = findPython();
const modules = readdirSync(path.join(CREATION_DIR, "tests"))
  .filter((name) => /^test_.*\.py$/.test(name) && !/browser/.test(name))
  .sort()
  .map((name) => name.replace(/\.py$/, ""));

function run(module) {
  return new Promise((resolve) => {
    const child = spawn(python.command, ["-m", "unittest", `tests.${module}`], {
      cwd: CREATION_DIR,
      env: { ...process.env, JC_SKIP_BROWSER: "1", PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ code: -1, output: String(error) }));
    child.on("close", (code) => resolve({ code, output }));
  });
}

// 一加载就全部开跑，下面每个测试只等自己那一份的结果
const runs = python.ok ? Object.fromEntries(modules.map((module) => [module, run(module)])) : {};

test("找得到 python3，有创作页的测试文件", () => {
  assert.ok(python.ok, python.reason ?? "");
  assert.ok(modules.length >= 6, `测试文件太少：${modules.join("、")}`);
});

for (const module of modules) {
  test(`创作页 Python 测试：${module}`, { skip: !python.ok && "没有能用的 python3" }, async (t) => {
    const result = await runs[module];
    assert.equal(result.code, 0, `\n${result.output}`);
    t.diagnostic(result.output.trim().split("\n").filter((line) => /^(Ran \d+ tests|OK)/.test(line)).join("，"));
  });
}
