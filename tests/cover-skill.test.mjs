// 封面 Skill（skills/<id>-cover/）自己的 Python 测试，以及它和工作台对得上的地方：
// 读的是同一个设置文件、默认位置和端口一样，Skill 的名字就是文件夹名。
// Python 测试全在临时文件夹里跑：假的家目录和工作文件夹、现造的小图片、只听 127.0.0.1 的小服务，不碰真实的 ~/.codex，不连外网。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../lib/brand.mjs";
import { findPython } from "../lib/creation.mjs";
import { defaultSettings } from "../lib/config.mjs";
import { BLOCKED_PORTS, DEFAULT_PORTS } from "../lib/ports.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = path.join(REPO, "skills", `${BRAND.id}-cover`);
const python = findPython();
const cleanEnv = () => {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  for (const key of Object.keys(env)) if (key.startsWith("COVER_") || key === "CODEX_HOME") delete env[key];
  return env;
};

/** 封面 Skill 的脚本里写的默认值：品牌 id、各个位置、端口 */
function skillDefaults() {
  const code =
    "import json,sys; sys.path.insert(0,'scripts'); from cover_kit import places as P; " +
    "print(json.dumps({'id': P.brand_id(), 'paths': P.DEFAULT_PATHS, 'ports': P.DEFAULT_PORTS, 'blocked': sorted(P.BLOCKED_PORTS)}))";
  const run = spawnSync(python.command, ["-c", code], { cwd: SKILL, encoding: "utf8", env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("封面 Skill 的文件夹名和 SKILL.md 里的名字一致", () => {
  assert.ok(existsSync(path.join(SKILL, "SKILL.md")), `找不到 ${SKILL}/SKILL.md`);
  const head = readFileSync(path.join(SKILL, "SKILL.md"), "utf8").split("\n").slice(0, 3).join("\n");
  assert.match(head, new RegExp(`^name: ${BRAND.id}-cover$`, "m"));
});

test("封面 Skill 读的默认位置和端口和工作台一样", { skip: !python.ok && "没有能用的 python3" }, () => {
  const got = skillDefaults();
  assert.equal(got.id, BRAND.id);
  const defaults = defaultSettings();
  assert.equal(defaults.workFolder, `~/Documents/${got.id}`);
  for (const key of ["topics", "overview", "drafts", "writingMethod", "benchmarkAccounts", "researchReports", "commentImports", "trash"]) {
    assert.equal(got.paths[key], defaults.paths[key], `paths.${key}`);
  }
  assert.deepEqual(got.ports, { ...DEFAULT_PORTS });
  assert.deepEqual(got.blocked, [...BLOCKED_PORTS].sort((a, b) => a - b));
});

// 封面素材的位置（paths.coverAssets，默认「封面素材」）是封面 1.1 新加的一项，由工作台那边加进 lib/config.mjs 的 defaultSettings。
// 那边还没加的时候没有东西可比，这一条先跳过（Skill 这边照两边的约定写「封面素材」）；加上以后这条就会比，两边不一样会报错。
const coverAssetsDefault = defaultSettings().paths.coverAssets;
test(
  "封面素材的默认位置和工作台一样",
  {
    skip:
      (coverAssetsDefault === undefined && "lib/config.mjs 的 defaultSettings 里还没有 paths.coverAssets（工作台那边加上以后这条才比）") ||
      (!python.ok && "没有能用的 python3"),
  },
  () => {
    assert.equal(skillDefaults().paths.coverAssets, coverAssetsDefault);
  },
);

test("封面 Skill 的 Python 测试", { skip: !python.ok && "没有能用的 python3" }, (t) => {
  const run = spawnSync(python.command, ["-m", "unittest", "discover", "-s", "tests"], { cwd: SKILL, encoding: "utf8", env: cleanEnv(), timeout: 180_000 });
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, `\n${output}`);
  t.diagnostic(output.trim().split("\n").filter((line) => /^(Ran \d+ tests|OK)/.test(line)).join("，"));
});
