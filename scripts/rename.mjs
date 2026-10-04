#!/usr/bin/env node
// 改名字、改署名：一条命令改完仓库里所有地方。
//   node scripts/rename.mjs --name "新名字" --id NewId --package new-name --holder "署名" [--year 2026] [--dry-run]
// 只写要改的那几项就行。改的是 git 管着的文字文件里出现的旧值（brand.json、package.json、LICENSE、README、docs 等），
// 不碰 ui/LICENSE.md（circle 原作者的版权声明必须原样保留）。
// 改 id 时，写稿 Skill 和调研 Skill 的文件夹 skills/<旧 id>-write、skills/<旧 id>-research 也跟着改名（Skill 的名字就是文件夹名）。
// 已经在用的人：他电脑上的 ~/Documents/<旧 id> 和 ~/Library/Application Support/<旧 id> 不会自动搬，改 id 前想清楚；
// 装好的 Skill（~/.claude/skills/<旧 id>-write 等）也要照安装说明重新装一次。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = new Set(["ui/LICENSE.md"]);
const FLAGS = { "--name": "name", "--id": "id", "--package": "packageName", "--holder": "copyrightHolder", "--year": "copyrightYear" };
const CHECK = {
  id: [/^[A-Za-z][A-Za-z0-9_-]{1,40}$/, "id 只能用英文字母、数字、- 和 _，用字母开头（它会变成文件夹名）"],
  packageName: [/^[a-z][a-z0-9-]{1,60}$/, "包名只能用小写英文字母、数字和 -，用字母开头"],
  copyrightYear: [/^\d{4}(?:-\d{4})?$/, "年份写成 2026 或 2026-2027"],
};

function parseArgs(argv) {
  const wanted = {};
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") dryRun = true;
    else if (FLAGS[argv[i]] && typeof argv[i + 1] === "string") wanted[FLAGS[argv[i]]] = argv[++i].trim();
    else throw new Error(`看不懂这个参数：${argv[i]}`);
  }
  return { wanted, dryRun };
}

const { wanted, dryRun } = parseArgs(process.argv.slice(2));
if (!Object.keys(wanted).length) {
  console.log('用法：node scripts/rename.mjs --name "新名字" --id NewId --package new-name --holder "署名" [--year 2026] [--dry-run]');
  process.exit(1);
}
for (const [key, value] of Object.entries(wanted)) {
  if (!value) throw new Error(`${key} 不能是空的`);
  if (CHECK[key] && !CHECK[key][0].test(value)) throw new Error(CHECK[key][1]);
}

const brand = JSON.parse(readFileSync(path.join(ROOT, "brand.json"), "utf8"));
// id 和包名现在可能是同一段文字：同一段旧文字要换成两个不同的新值时没法分辨，先停下
for (const [key, value] of Object.entries(wanted)) {
  for (const [other, otherValue] of Object.entries(wanted)) {
    if (key !== other && brand[key] === brand[other] && value !== otherValue) {
      throw new Error(`${key} 和 ${other} 现在都是「${brand[key]}」，要改就改成一样的，或者分两次手动改。`);
    }
  }
  for (const other of Object.keys(FLAGS).map((flag) => FLAGS[flag])) {
    if (other !== key && !(other in wanted) && brand[other] === brand[key] && brand[key] !== value) {
      throw new Error(`${other} 现在也是「${brand[key]}」，要一起改：加上 --${other === "packageName" ? "package" : other === "copyrightHolder" ? "holder" : other === "copyrightYear" ? "year" : other} 同一个新值。`);
    }
  }
}
// 长的先换，免得短的把长的拆坏（比如包名 jincheng-workbench 和 jincheng-workbench-ui）
const pairs = Object.entries(wanted)
  .filter(([key, value]) => brand[key] && brand[key] !== value)
  .map(([key, value]) => [brand[key], value])
  .sort((a, b) => b[0].length - a[0].length);
if (!pairs.length) {
  console.log("没有要改的：新值和现在的一样。");
  process.exit(0);
}

const files = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((file) => file && !KEEP.has(file) && /\.(?:md|mjs|ts|tsx|json|yaml|css|svg)$|^LICENSE$/.test(file));
const changed = [];
for (const file of files) {
  const full = path.join(ROOT, file);
  const before = readFileSync(full, "utf8");
  let after = before;
  for (const [from, to] of pairs) after = after.split(from).join(to);
  if (after !== before) {
    changed.push(file);
    if (!dryRun) writeFileSync(full, after);
  }
}
// 写稿 Skill、调研 Skill 的文件夹跟着 id 改名
const skillMoves = wanted.id && wanted.id !== brand.id
  ? ["write", "research"].map((kind) => [path.join(ROOT, "skills", `${brand.id}-${kind}`), path.join(ROOT, "skills", `${wanted.id}-${kind}`)])
  : [];
for (const [from, to] of skillMoves) {
  if (!existsSync(from)) continue;
  if (existsSync(to)) throw new Error(`${path.relative(ROOT, to)} 已经有了，没有改 Skill 文件夹的名字。`);
}
for (const [from, to] of skillMoves) {
  if (!existsSync(from)) continue;
  if (!dryRun) renameSync(from, to);
  console.log(`${dryRun ? "将要改名" : "改了名"}：${path.relative(ROOT, from)} → ${path.relative(ROOT, to)}`);
}
console.log(`${dryRun ? "将要改" : "改好了"} ${changed.length} 个文件：`);
for (const file of changed) console.log(`  ${file}`);
for (const [from, to] of pairs) console.log(`  「${from}」→「${to}」`);
if (!dryRun) console.log("\n接下来：运行 pnpm install 和 pnpm test，再 pnpm build 重新编译界面。");
