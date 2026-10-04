// 调研 Skill（skills/<id>-research/）自己的 Python 测试，以及它和工作台对得上的地方：
// 读的是同一个设置文件、默认位置一样，Skill 的名字就是文件夹名。
// Python 测试全在临时文件夹里跑：假的家目录、假的 TikHub（只监听 127.0.0.1），钥匙串换成测试专用的名字，不碰真实条目。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../lib/brand.mjs";
import { findPython } from "../lib/creation.mjs";
import { defaultSettings } from "../lib/config.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = path.join(REPO, "skills", `${BRAND.id}-research`);
const python = findPython();
const cleanEnv = () => {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", WORKBENCH_KEYCHAIN_SERVICE: "jcwb-research-test-not-real", RESEARCH_PRICE_LOOKUP: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("TIKHUB_")) delete env[key];
  return env;
};

test("调研 Skill 的文件夹名和 SKILL.md 里的名字一致", () => {
  assert.ok(existsSync(path.join(SKILL, "SKILL.md")), `找不到 ${SKILL}/SKILL.md`);
  const head = readFileSync(path.join(SKILL, "SKILL.md"), "utf8").split("\n").slice(0, 3).join("\n");
  assert.match(head, new RegExp(`^name: ${BRAND.id}-research$`, "m"));
});

test("调研 Skill 读的默认位置和工作台一样", { skip: !python.ok && "没有能用的 python3" }, () => {
  const code = "import json,sys; sys.path.insert(0,'scripts'); from research_kit import places as P; print(json.dumps({'id': P.brand_id(), 'paths': P.DEFAULT_PATHS}))";
  const run = spawnSync(python.command, ["-c", code], { cwd: SKILL, encoding: "utf8", env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
  const got = JSON.parse(run.stdout);
  assert.equal(got.id, BRAND.id);
  const defaults = defaultSettings();
  for (const key of ["drafts", "writingMethod", "trash"]) assert.equal(got.paths[key], defaults.paths[key], `paths.${key}`);
  assert.equal(defaults.workFolder, `~/Documents/${got.id}`);
});

test("调研 Skill 的 Python 测试", { skip: !python.ok && "没有能用的 python3" }, (t) => {
  const run = spawnSync(python.command, ["-m", "unittest", "discover", "-s", "tests"], { cwd: SKILL, encoding: "utf8", env: cleanEnv(), timeout: 180_000 });
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, `\n${output}`);
  t.diagnostic(output.trim().split("\n").filter((line) => /^(Ran \d+ tests|OK)/.test(line)).join("，"));
});
