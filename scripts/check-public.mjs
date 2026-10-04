#!/usr/bin/env node
// 公开前自查：在 git 管着的每个文件里（图片等二进制文件也查里面的文字和元数据）找
//   常见的密钥格式、本机家目录路径、看着像密钥的长随机串，
//   作者的名字（brand.json 的署名）出现在不该出现的地方：只许出现在品牌名里（比如工作台的名字、Skill 说明里「…工作台配套」那一句）、
//   LICENSE 和 brand.json 的署名、README 的「## 作者」一节，
//   以及环境变量 PUBLIC_CHECK_WORDS 里列的词（逗号分开，比如自己的名字、域名、内部编号；这些词不写进仓库）。
// 图片：只许放 README 用的截图，在 docs/images/ 里，PNG 或 JPEG，不带元数据（PNG 的文字块、EXIF、时间；JPEG 的 EXIF、XMP、IPTC、注释），
//   截图里的拍摄时间、电脑名、软件这类信息就不会跟着公开。
// 用法：pnpm check:public
//       PUBLIC_CHECK_WORDS="名字,example.com" pnpm check:public
// 找到就列出「文件:行」并以退出码 1 结束；一个都没有就打印「没有发现」。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join("/");

const PATTERNS = [
  ["OpenAI、Anthropic 一类的密钥", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ["GitHub 令牌", /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ["Slack 令牌", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["AWS 访问密钥", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Google API 密钥", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["私钥", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["本机家目录路径", /\/Users\/[^/\s"'`<>)]+/g],
];
const words = String(process.env.PUBLIC_CHECK_WORDS ?? "")
  .split(",")
  .map((word) => word.trim())
  .filter(Boolean);

// 图片：README 的截图放在 docs/images/，只收 PNG、JPEG，里面不能带元数据
const RASTER = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp|ico)$/i;
export const IMAGE_DIR = "docs/images/";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_META = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

/** 一张图片有什么问题：放错地方、格式不对、带着元数据。没问题返回空数组。 */
export function imageProblems(file, buffer) {
  if (!RASTER.test(file)) return [];
  const problems = [];
  if (!file.startsWith(IMAGE_DIR)) problems.push(`图片只放在 ${IMAGE_DIR} 里（README 用的截图）`);
  const meta = new Set();
  if (/\.png$/i.test(file)) {
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) problems.push("扩展名是 .png，内容不是 PNG");
    else {
      for (let i = 8; i + 8 <= buffer.length; ) {
        const length = buffer.readUInt32BE(i);
        const type = buffer.toString("latin1", i + 4, i + 8);
        if (PNG_META.has(type)) meta.add(type);
        i += 12 + length;
      }
    }
  } else if (/\.jpe?g$/i.test(file)) {
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) problems.push("扩展名是 .jpg，内容不是 JPEG");
    else {
      for (let i = 2; i + 4 <= buffer.length && buffer[i] === 0xff; ) {
        const marker = buffer[i + 1];
        if (marker === 0xda || marker === 0xd9) break; // 后面是图像数据
        if (marker === 0xe1) meta.add("EXIF 或 XMP");
        else if (marker === 0xed) meta.add("IPTC");
        else if (marker === 0xfe) meta.add("注释");
        i += 2 + buffer.readUInt16BE(i + 2);
      }
    }
  } else problems.push("截图只收 PNG 和 JPEG");
  if (meta.size) problems.push(`带着元数据（${[...meta].join("、")}），去掉再放进来，比如 exiftool -all= 文件名`);
  return problems;
}

// 长随机串：32 个字符以上、大小写字母和数字都有、杂乱程度高。软件包的校验值（sha512- 开头）不算。
const TOKEN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
function looksRandom(token) {
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/\d/.test(token)) return false;
  const counts = new Map();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) entropy -= (n / token.length) * Math.log2(n / token.length);
  return entropy > 4.2;
}

// 作者的名字：品牌名里的那一处算品牌名；LICENSE、brand.json 是署名；README 只许在「## 作者」一节里
const brand = JSON.parse(readFileSync(path.join(ROOT, "brand.json"), "utf8"));
const holder = String(brand.copyrightHolder ?? "").trim();
const brandName = String(brand.name ?? "").trim();
const SIGNED_FILES = new Set(["LICENSE", "brand.json"]);
function holderAllowed(file, text, at) {
  if (SIGNED_FILES.has(file)) return true;
  const inName = brandName.indexOf(holder);
  if (inName >= 0 && at - inName >= 0 && text.startsWith(brandName, at - inName)) return true;
  if (file === "README.md") {
    const heading = text.lastIndexOf("\n## ", at);
    return heading >= 0 && text.startsWith("\n## 作者", heading);
  }
  return false;
}

/** 查 git 管着的每个文件，找到就列出来并以退出码 1 结束 */
function main() {
  const files = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  const found = [];
  for (const file of files) {
    const buffer = readFileSync(path.join(ROOT, file));
    const text = buffer.toString("utf8");
    for (const problem of imageProblems(file, buffer)) found.push(`${file}  ${problem}`);
    const lineOf = (index) => text.slice(0, index).split("\n").length;
    if (file !== SELF) {
      for (const [label, pattern] of PATTERNS) {
        for (const match of text.matchAll(pattern)) found.push(`${file}:${lineOf(match.index)}  ${label}：${match[0].slice(0, 40)}`);
      }
    }
    for (const word of words) {
      for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) found.push(`${file}:${lineOf(at)}  自己列的词：${word}`);
    }
    if (holder) {
      for (let at = text.indexOf(holder); at >= 0; at = text.indexOf(holder, at + holder.length)) {
        if (!holderAllowed(file, text, at)) found.push(`${file}:${lineOf(at)}  作者的名字「${holder}」只能出现在品牌名、署名和 README 的作者介绍里`);
      }
    }
    if (file === "pnpm-lock.yaml" || file === SELF) continue;
    for (const match of text.matchAll(TOKEN)) {
      const before = text.slice(Math.max(0, match.index - 8), match.index);
      if (/sha(?:1|256|384|512)-$/.test(before)) continue;
      if (looksRandom(match[0])) found.push(`${file}:${lineOf(match.index)}  像密钥的长随机串：${match[0].slice(0, 12)}…`);
    }
  }

  console.log(`查了 ${files.length} 个文件${words.length ? `，另外查了 ${words.length} 个自己列的词` : ""}。`);
  if (found.length) {
    console.log(`发现 ${found.length} 处，公开前处理掉：`);
    for (const line of found) console.log(`  ${line}`);
    process.exit(1);
  }
  console.log(`没有发现密钥、本机路径和要查的词；作者的名字只出现在品牌名、署名和 README 的作者介绍里；图片都在 ${IMAGE_DIR}、不带元数据。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
