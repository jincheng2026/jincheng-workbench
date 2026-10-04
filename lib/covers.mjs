// 封面（1.1 加）：风格（对标账号拆出的封面 VI、你放进来的几张图拆出的风格）和默认构图、「我的照片」、封面设置、
// 每条内容出过的封面（只看）和「我的封面」一览。文件怎么放、生成记录怎么写，是和封面 Skill（skills/<id>-cover）一起定的，
// 写在 docs/开发记录.md「封面」一节：
//   <对标账号>/<平台-账号名>/封面/K01.jpg …、VI拆解.md（第二行「风格名：…」）、默认构图.json
//   <封面素材>/风格/<日期_N张>/封面/…、风格.json、VI拆解.md、默认构图.json
//   <封面素材>/封面设置.json、我的照片/
//   <内容草稿>/T001_*/封面候选/封面-01.png …、生图描述-01.md …、生成记录.md；<内容草稿>/T001_*/封面-选定.png
// 原作者 2026-10-04 定：工作台在封面上主要管拆封面、管理风格和封面 VI；出图、挑一张、改一张都在 Codex 桌面版里做（它自带看图和评论改图）。
// 所以这里只做不用 AI 的事：放照片、放图建风格、设默认风格、改默认构图，再把这些和出过的封面读出来给页面看。生成记录只读不写。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { COVER_DIR, COVER_NAME, PHOTO_DIR, SELECTED_NAME } from "./cover-files.mjs";
import { inspectCreationPage } from "./creation.mjs";
import { readWorkDetail, readWorks } from "./works.mjs";

export { COVER_DIR, PHOTO_DIR, SELECTED_BASE, coverSummary } from "./cover-files.mjs";
export const RECORD_FILE = "生成记录.md";
export const SETTINGS_FILE = "封面设置.json";
export const VI_DIR = "封面";
export const VI_FILE = "VI拆解.md";
export const VI_REPORT_TYPE = "封面VI";
export const STYLE_DIR = "风格";
export const STYLE_META = "风格.json";
export const COMPOSITIONS_FILE = "默认构图.json";
export const DEFAULT_BATCH = 5;
/** 出一批时能选的尺寸（原作者 10-04 定）：视频和小红书图文用竖版，公众号头图用横版 */
export const SIZES = ["竖版 3:4", "横版 2.35:1", "方形 1:1"];
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PROMPT_NAME = /^生图描述-(\d{2,3})\.md$/;
const K_NAME = /^K(\d{2,3})\.(png|jpe?g|webp)$/i;
// 内容类型的名字带这些字的算文章（出封面默认横版），其余算视频
const ARTICLE_TYPE = /文章|图文|公众号|长文|星球|帖子|笔记/;

function fail(message, statusCode = 400, code = undefined) {
  return Object.assign(new Error(message), { statusCode, code });
}

function safeEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const pad = (n) => String(n).padStart(2, "0");

function localDay(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 名字被占了就在后面加 -2、-3（文件和文件夹都用） */
function freeName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; existsSync(path.join(dir, candidate)); i++) candidate = `${stem}-${i}${ext}`;
  return candidate;
}

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

function readJsonFile(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function hashOf(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function isImageBuffer(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG") return ".png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return ".jpg";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return null;
}

/** 用户给的文件名去掉扩展名和不能用的字符，太长的截短；什么都不剩就用 fallback */
function cleanStem(filename, fallback) {
  return (
    String(filename ?? "")
      .replace(/\.[^.]*$/, "")
      .replace(/[\u0000-\u001f\\/:*?"<>|]/g, " ")
      .replace(/^[.\s]+/, "")
      .trim()
      .slice(0, 40) || fallback
  );
}

function checkPart(name, what = "名字") {
  if (typeof name !== "string" || !name || name === "." || name === ".." || /[\\/]/.test(name) || name.startsWith(".")) {
    throw fail(`${what}不对。`, 400);
  }
  return name;
}

/** base 下面的文件：消解软链接以后必须还在 base 里 */
function insideDir(base, ...parts) {
  for (const part of parts) checkPart(part, "文件名");
  let realBase;
  let target;
  try {
    realBase = realpathSync(base);
    target = realpathSync(path.join(realBase, ...parts));
  } catch {
    throw fail("找不到这个文件，可能已经被移走或删除。", 404);
  }
  const inner = path.relative(realBase, target);
  if (!inner || inner.startsWith("..") || path.isAbsolute(inner)) throw fail("这个文件不在该在的文件夹里。", 403);
  if (!statSync(target).isFile()) throw fail("这不是文件。", 400);
  return target;
}

function moveToTrash(config, file, label) {
  const trash = config.paths.trash;
  mkdirSync(trash, { recursive: true });
  const name = freeName(trash, `${localDay()}_${label}`);
  renameSync(file, path.join(trash, name));
  if (existsSync(file)) throw fail("没挪走，请再试一次。", 500);
  return name;
}

const imagesIn = (dir) =>
  safeEntries(dir)
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && IMAGE_MIME[path.extname(entry.name).toLowerCase()])
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));

// —— 封面设置 ——————————————————————————————

function settingsFile(config) {
  return path.join(config.paths.coverAssets, SETTINGS_FILE);
}

/** 封面设置：主照片（相对封面素材）、默认风格（风格编号）、一批几张。文件没有或写坏了都按「没设」算，并说出来 */
export function readCoverSettings(config) {
  const file = settingsFile(config);
  let raw = {};
  let problem = null;
  if (existsSync(file)) {
    const value = readJsonFile(file);
    if (value) raw = value;
    else problem = `${SETTINGS_FILE} 写坏了，不是合法的 JSON，先按没设处理。`;
  }
  const batch = Number(raw.batchSize);
  return {
    raw,
    photo: typeof raw.photo === "string" && raw.photo.trim() ? raw.photo.trim() : null,
    benchmark: typeof raw.benchmark === "string" && raw.benchmark.trim() ? raw.benchmark.trim() : null,
    batchSize: Number.isInteger(batch) && batch >= 1 && batch <= 30 ? batch : DEFAULT_BATCH,
    problem,
  };
}

/** 改一项：整份读出、改、先写临时文件再换过去；不认识的键原样留着（封面 Skill 的脚本也这样写） */
export function writeCoverSettings(config, patch) {
  const current = readCoverSettings(config);
  const next = { ...current.raw, ...patch };
  writeAtomic(settingsFile(config), `${JSON.stringify(next, null, 2)}\n`);
  return readCoverSettings(config);
}

function publicSettings(settings) {
  return { photo: settings.photo, benchmark: settings.benchmark, batchSize: settings.batchSize, problem: settings.problem };
}

// —— 我的照片（换成你的脸用；不分组，放一张或几张，出封面时默认都用上）——————————————

function photosDir(config) {
  return path.join(config.paths.coverAssets, PHOTO_DIR);
}

/** 我的照片：主照片在前，其余新放的在前。shown：浏览器显示得了（HEIC 显示不了，但 AI 能用） */
export function listPhotos(config, settings = readCoverSettings(config)) {
  const main = settings.photo?.startsWith(`${PHOTO_DIR}/`) ? settings.photo.slice(PHOTO_DIR.length + 1) : null;
  return safeEntries(photosDir(config))
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && /\.(png|jpe?g|webp|heic)$/i.test(entry.name))
    .map((entry) => {
      const stat = statSync(path.join(photosDir(config), entry.name));
      return {
        name: entry.name,
        main: entry.name === main,
        shown: Boolean(IMAGE_MIME[path.extname(entry.name).toLowerCase()]),
        modifiedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => Number(b.main) - Number(a.main) || b.modifiedAt.localeCompare(a.modifiedAt));
}

/** 放一张照片：存进 我的照片/；还没有主照片（或者原来那张不见了）时设成主照片 */
export function savePhoto(config, { filename, buffer }) {
  const ext = isImageBuffer(buffer);
  if (!ext) throw fail("照片要是 PNG、JPEG 或 WebP（iPhone 的 HEIC 照片先在「照片」App 里导出成 JPEG）。", 415);
  if (buffer.length > MAX_IMAGE_BYTES) throw fail("照片超过 20 MB 了，换一张小一点的。", 413);
  const dir = photosDir(config);
  mkdirSync(dir, { recursive: true });
  const name = freeName(dir, `${cleanStem(filename, "我的照片")}${ext}`);
  writeFileSync(path.join(dir, name), buffer, { flag: "wx" });
  let settings = readCoverSettings(config);
  const mainMissing = !settings.photo || !existsSync(path.join(config.paths.coverAssets, settings.photo));
  if (mainMissing) settings = writeCoverSettings(config, { photo: `${PHOTO_DIR}/${name}` });
  const count = listPhotos(config, settings).length;
  return { ok: true, name, settings: publicSettings(settings), message: `照片放好了，现在有 ${count} 张，出封面时都会用上。` };
}

export function photoFile(config, name) {
  const target = insideDir(photosDir(config), name);
  const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
  if (!mime) throw fail("这张照片浏览器显示不了（比如 HEIC）。", 415);
  return { file: target, mime };
}

/** 拿掉一张照片：挪进回收站；拿掉的是主照片，就换成剩下的里最新的那张 */
export function trashPhoto(config, name) {
  const target = insideDir(photosDir(config), name);
  const trashedAs = moveToTrash(config, target, `照片_${path.basename(target)}`);
  let settings = readCoverSettings(config);
  if (settings.photo === `${PHOTO_DIR}/${path.basename(target)}`) {
    const next = listPhotos(config, { ...settings, photo: null })[0];
    settings = writeCoverSettings(config, { photo: next ? `${PHOTO_DIR}/${next.name}` : null });
  }
  return { ok: true, trashedAs, settings: publicSettings(settings), message: "这张照片挪进回收站了。" };
}

// —— 风格：对标账号的封面 VI，和你放进来的几张图 ——————————————————————————————
// 风格编号：对标账号就是账号文件夹名（「抖音-某某」）；你放进来的图是「风格/<文件夹名>」。设置、交给 AI 的话、报告的 meta.json 都用它。

function stylesRoot(config) {
  return path.join(config.paths.coverAssets, STYLE_DIR);
}

/** 风格编号 → { id, kind, folder, dir }；格式不对报 400，文件夹不在报 404 */
export function styleRef(config, id) {
  const value = String(id ?? "").trim();
  if (value.startsWith(`${STYLE_DIR}/`)) {
    const folder = checkPart(value.slice(STYLE_DIR.length + 1), "风格");
    const dir = path.join(stylesRoot(config), folder);
    if (!existsSync(dir)) throw fail(`找不到这组图「${folder}」，可能已经被移走或删除。`, 404);
    return { id: `${STYLE_DIR}/${folder}`, kind: "images", folder, dir };
  }
  const folder = checkPart(value, "风格");
  const dir = path.join(config.paths.benchmarkAccounts, folder);
  if (!existsSync(dir)) throw fail(`找不到对标账号「${folder}」。`, 404);
  return { id: folder, kind: "account", folder, dir };
}

/** VI拆解.md 第二行「风格名：…」 */
function styleNameOf(file) {
  try {
    const head = readFileSync(file, "utf8").split(/\r?\n/).slice(0, 6);
    for (const line of head) {
      const m = line.match(/^\s*(?:[-*]\s*)?风格名[：:]\s*(.+?)\s*$/);
      if (m) return m[1];
    }
  } catch {
    return null;
  }
  return null;
}

/** 默认构图.json：只留 封面/ 里真有的 K 编号；没有这份或者一张都对不上是 null */
function readCompositions(dir, images) {
  const value = readJsonFile(path.join(dir, COMPOSITIONS_FILE));
  if (!value || !Array.isArray(value.ids)) return null;
  const have = new Set(images.map((name) => name.replace(/\.[^.]+$/, "").toUpperCase()));
  const ids = [...new Set(value.ids.map((x) => String(x).trim().toUpperCase()))].filter((x) => have.has(x));
  return ids.length ? { ids, by: value.by === "你" ? "你" : "AI" } : null;
}

/** 一个风格给页面看的样子：拆过没有、风格名、原图几张和前几张、默认构图、是不是默认风格、对照网页在哪份调研报告里 */
function styleView(ref, { settings, reports, extra = {} }) {
  const images = imagesIn(path.join(ref.dir, VI_DIR));
  const viFile = path.join(ref.dir, VI_FILE);
  const done = existsSync(viFile);
  const report = reports.find((r) => r.type === VI_REPORT_TYPE && r.source === ref.id) ?? null;
  return {
    id: ref.id,
    kind: ref.kind,
    folder: ref.folder,
    name: done ? styleNameOf(viFile) : null,
    done,
    covers: images.length,
    images,
    compositions: readCompositions(ref.dir, images),
    isDefault: settings.benchmark === ref.id,
    report: report ? { id: report.id, page: report.pages[0]?.file ?? "index.html" } : null,
    ...extra,
  };
}

/** 对标账号卡片上那一行用的（市场调研的接口也用） */
export function accountVi(config, folder, { settings = readCoverSettings(config), reports = [] } = {}) {
  const ref = { id: folder, kind: "account", folder, dir: path.join(config.paths.benchmarkAccounts, folder) };
  const view = styleView(ref, { settings, reports });
  return { done: view.done, style: view.name, covers: view.covers, samples: view.images.slice(0, 8), isDefault: view.isDefault, report: view.report };
}

/**
 * 全部风格：对标账号（accounts 是市场调研读出来的账号列表；「市场调研」这一栏关掉时传空的）和你放进来的几组图。
 * 默认风格在前，再是拆好的，最后是还没拆的；同一档里新的在前。
 */
export function listStyles(config, { accounts = [], reports = [], settings = readCoverSettings(config) } = {}) {
  const list = [];
  for (const account of accounts) {
    const ref = { id: account.name, kind: "account", folder: account.name, dir: path.join(config.paths.benchmarkAccounts, account.name) };
    list.push(styleView(ref, { settings, reports, extra: { platform: account.platform ?? null, accountName: account.accountName ?? account.name, at: account.updatedAt ?? null } }));
  }
  for (const entry of safeEntries(stylesRoot(config))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(stylesRoot(config), entry.name);
    const meta = readJsonFile(path.join(dir, STYLE_META)) ?? {};
    const at = typeof meta.createdAt === "string" ? meta.createdAt : statSync(dir).mtime.toISOString();
    list.push(styleView({ id: `${STYLE_DIR}/${entry.name}`, kind: "images", folder: entry.name, dir }, { settings, reports, extra: { at, from: typeof meta.from === "string" ? meta.from : null } }));
  }
  const rank = (s) => (s.isDefault ? 0 : s.done ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b) || String(b.at ?? "").localeCompare(String(a.at ?? "")));
}

/** 风格里的一张原图，给 <img> 用 */
export function styleImage(config, id, file) {
  const ref = styleRef(config, id);
  const target = insideDir(ref.dir, VI_DIR, file);
  const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
  if (!mime) throw fail("这不是图片。", 415);
  return { file: target, mime };
}

/** 设默认风格：要已经拆过 VI */
export function setDefaultStyle(config, id) {
  const ref = styleRef(config, id);
  const viFile = path.join(ref.dir, VI_FILE);
  if (!existsSync(viFile)) throw fail("这个风格还没拆过封面 VI，先拆一下再设成默认。", 409, "no-vi");
  const settings = writeCoverSettings(config, { benchmark: ref.id });
  return { ok: true, settings: publicSettings(settings), message: `以后出封面默认照「${styleNameOf(viFile) ?? ref.folder}」来。` };
}

/** 拖几张图进来建一个风格：先建文件夹「<日期>_<N>张」和 风格.json，图一张一张传（addStyleImage） */
export function createImageStyle(config, { count }) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 60) throw fail("一次放 1 到 60 张图。", 400);
  const root = stylesRoot(config);
  mkdirSync(root, { recursive: true });
  const folder = freeName(root, `${localDay()}_${n}张`);
  const dir = path.join(root, folder);
  mkdirSync(path.join(dir, VI_DIR), { recursive: true });
  writeAtomic(path.join(dir, STYLE_META), `${JSON.stringify({ from: "放进来的图", createdAt: new Date().toISOString(), count: 0 }, null, 2)}\n`);
  return { ok: true, id: `${STYLE_DIR}/${folder}`, folder };
}

/** 往「你放进来的图」这种风格里存一张：按原文件名存进 封面/（不改成 K01，拆的时候 Skill 再改），重名加 -2 */
export function addStyleImage(config, id, { filename, buffer }) {
  const ref = styleRef(config, id);
  if (ref.kind !== "images") throw fail("对标账号的封面由 AI 拉，或者在对标账号里放。", 400);
  const ext = isImageBuffer(buffer);
  if (!ext) throw fail("封面图要是 PNG、JPEG 或 WebP（HEIC 先导出成 JPEG）。", 415);
  if (buffer.length > MAX_IMAGE_BYTES) throw fail("这张图超过 20 MB 了。", 413);
  const dir = path.join(ref.dir, VI_DIR);
  mkdirSync(dir, { recursive: true });
  const name = freeName(dir, `${cleanStem(filename, "封面")}${ext}`);
  writeFileSync(path.join(dir, name), buffer, { flag: "wx" });
  const meta = readJsonFile(path.join(ref.dir, STYLE_META)) ?? { from: "放进来的图" };
  const count = imagesIn(dir).length;
  writeAtomic(path.join(ref.dir, STYLE_META), `${JSON.stringify({ ...meta, count }, null, 2)}\n`);
  return { ok: true, name, count };
}

/** 拿掉一组放进来的图（放错了的时候）：整个文件夹挪进回收站；是默认风格的话，默认风格清空 */
export function trashImageStyle(config, id) {
  const ref = styleRef(config, id);
  if (ref.kind !== "images") throw fail("对标账号在「市场调研」的对标账号里删。", 400);
  const trashedAs = moveToTrash(config, ref.dir, `风格_${ref.folder}`);
  let settings = readCoverSettings(config);
  if (settings.benchmark === ref.id) settings = writeCoverSettings(config, { benchmark: null });
  return { ok: true, trashedAs, settings: publicSettings(settings), message: "这组图挪进回收站了。" };
}

/** 改默认构图：编号要是这个风格 封面/ 里有的 K 图，1 到 20 张；by 写「你」，以后 Skill 重新导出也不覆盖 */
export function writeCompositions(config, id, ids) {
  const ref = styleRef(config, id);
  const images = imagesIn(path.join(ref.dir, VI_DIR));
  const have = new Set(images.filter((name) => K_NAME.test(name)).map((name) => name.replace(/\.[^.]+$/, "").toUpperCase()));
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x).trim().toUpperCase()))];
  if (!list.length || list.length > 20) throw fail("默认构图挑 1 到 20 张。", 400);
  const missing = list.filter((x) => !have.has(x));
  if (missing.length) throw fail(`这个风格里没有 ${missing.join("、")}。`, 400);
  writeAtomic(path.join(ref.dir, COMPOSITIONS_FILE), `${JSON.stringify({ ids: list, by: "你", updatedAt: new Date().toISOString() }, null, 2)}\n`);
  return { ok: true, compositions: { ids: list, by: "你" }, message: `默认构图改成了这 ${list.length} 张。` };
}

// —— 一条内容出过的封面（只看）——————————————————————————————

/** 这条内容算视频还是文章：看内容类型的名字（带「文章」「图文」「公众号」这些字的算文章） */
export function contentForm(type) {
  return ARTICLE_TYPE.test(String(type ?? "")) ? "文章" : "视频";
}

/** 生成记录里一批的第一行：「对标：<风格编号>（<风格名>）；…；尺寸：竖版 3:4」→ 风格编号、风格名、尺寸（认不出的是 null） */
export function batchInfo(info) {
  const text = String(info ?? "");
  const m = text.match(/^对标[：:]\s*([^（(；;]+?)\s*(?:[（(]([^）)]*)[）)])?\s*(?:[；;]|$)/);
  const sizeText = text.match(/尺寸[：:]\s*([^；;]+)/)?.[1]?.replace(/\s+/g, "") ?? "";
  const size = SIZES.find((s) => s.replace(/\s+/g, "") === sizeText) ?? null;
  return { style: m ? m[1].trim() : null, styleName: m?.[2]?.trim() || null, size };
}

/** 读生成记录.md：批次（## 第 N 批 + 表格）和「## 记录」里的事；只有一张表、没写小节标题的算第 1 批 */
export function parseRecord(markdown) {
  const batches = [];
  const events = [];
  let current = null;
  let inEvents = false;
  let header = null;
  const ensureBatch = () => {
    if (!current) {
      current = { no: batches.length ? batches.at(-1).no + 1 : 1, info: null, rows: [], footer: [] };
      batches.push(current);
    }
    return current;
  };
  for (const raw of String(markdown ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const batchHead = line.match(/^##\s*第\s*(\d+)\s*批/);
    if (batchHead) {
      current = { no: Number(batchHead[1]), info: null, rows: [], footer: [] };
      batches.push(current);
      inEvents = false;
      header = null;
      continue;
    }
    if (/^##\s*记录/.test(line)) {
      inEvents = true;
      current = null;
      header = null;
      continue;
    }
    if (/^##\s/.test(line)) {
      inEvents = false;
      current = null;
      header = null;
      continue;
    }
    if (inEvents) {
      const m = line.match(/^[-*]\s+(.+)$/);
      if (m) events.push(m[1]);
      continue;
    }
    if (line.startsWith("|")) {
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      if (!header) {
        if (cells.includes("编号")) {
          header = cells;
          ensureBatch();
        }
        continue;
      }
      const col = (name) => cells[header.indexOf(name)] ?? "";
      const no = col("编号").match(/\d{1,3}/)?.[0];
      if (!no) continue;
      ensureBatch().rows.push({ no: pad(Number(no)), change: col("本张变化"), check: col("自检"), file: col("文件名") });
      continue;
    }
    header = null;
    if (!line || line.startsWith("#")) continue;
    if (current) {
      if (!current.rows.length && !current.info) current.info = line;
      else if (current.rows.length) current.footer.push(line);
    }
  }
  return { batches: batches.filter((b) => b.rows.length || b.info), events };
}

/** 草稿文件夹里的封面：候选（有图的、只有提示词的）、生成记录、选定的是哪张 */
function scanCovers(folder) {
  const dir = path.join(folder, COVER_DIR);
  const images = new Map();
  const prompts = new Set();
  for (const entry of safeEntries(dir)) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const cover = entry.name.match(COVER_NAME);
    if (cover) {
      const stat = statSync(path.join(dir, entry.name));
      images.set(pad(Number(cover[1])), { name: entry.name, modifiedAt: stat.mtime.toISOString() });
      continue;
    }
    const prompt = entry.name.match(PROMPT_NAME);
    if (prompt) prompts.add(pad(Number(prompt[1])));
  }
  let record = { batches: [], events: [] };
  const recordFile = path.join(dir, RECORD_FILE);
  if (existsSync(recordFile)) record = parseRecord(readFileSync(recordFile, "utf8"));
  // 选定：封面-选定.* 和哪张候选一模一样；比不出来时看「## 记录」里最后一次选定
  let selected = null;
  for (const entry of safeEntries(folder)) {
    if (!entry.isFile() || !SELECTED_NAME.test(entry.name)) continue;
    const hash = hashOf(path.join(folder, entry.name));
    let from = null;
    for (const [no, image] of images) if (hash && hashOf(path.join(dir, image.name)) === hash) from = no;
    if (!from) {
      const last = [...record.events].reverse().find((e) => /选定\s*封面-\d+/.test(e) && !/取消选定/.test(e));
      const m = last?.match(/封面-(\d+)/);
      if (m && images.has(pad(Number(m[1])))) from = pad(Number(m[1]));
    }
    selected = { name: entry.name, from, modifiedAt: statSync(path.join(folder, entry.name)).mtime.toISOString() };
    break;
  }
  return { dir, images, prompts, record, selected };
}

/** 一条内容的封面全貌：按批次排的候选、选定的是哪张、下一批的编号，和出一批时的默认值（尺寸、封面上的字） */
export function topicCovers(config, layout, id) {
  const detail = readWorkDetail(id, layout);
  const settings = readCoverSettings(config);
  const form = contentForm(detail.type);
  // 封面上的字：创作页「标题封面简介」里定好的那版
  let text = null;
  const ref = detail.creation?.ref;
  if (typeof ref === "string" && ref.startsWith("drafts:")) text = inspectCreationPage(path.join(layout.draftsDir, ref.slice(7)))?.coverText ?? null;
  const base = {
    id,
    title: detail.title,
    type: detail.type ?? null,
    form,
    folder: detail.draftDir?.name ?? null,
    settings: publicSettings(settings),
    defaults: { size: form === "文章" ? SIZES[1] : SIZES[0], text: text?.text ?? null, textFrom: text?.from ?? null },
  };
  if (!detail.draftDir) return { ...base, batches: [], selected: null, next: { batch: 1 }, total: 0 };
  const folder = path.join(layout.draftsDir, detail.draftDir.name);
  const { dir, images, prompts, record, selected } = scanCovers(folder);

  // 只有提示词、没有图的（Claude Code 只出提示词）：把提示词带上，页面上一键复制
  const promptText = (no) => {
    try {
      const value = readFileSync(path.join(dir, `生图描述-${no}.md`), "utf8");
      return value.length > 20000 ? `${value.slice(0, 20000)}\n……（太长，后面的去文件里看）` : value;
    } catch {
      return null;
    }
  };
  const item = (no, row = null) => {
    const image = images.get(no) ?? null;
    return {
      no,
      image: image ? image.name : null,
      prompt: prompts.has(no) ? `生图描述-${no}.md` : null,
      promptText: !image && prompts.has(no) ? promptText(no) : null,
      change: row?.change || null,
      check: row?.check || null,
      selected: selected?.from === no,
      modifiedAt: image?.modifiedAt ?? null,
    };
  };
  const seen = new Set();
  const batches = record.batches.map((batch) => {
    const items = [];
    for (const row of batch.rows) {
      if (seen.has(row.no)) continue;
      if (!images.has(row.no) && !prompts.has(row.no)) continue; // 文件不在了（挪进回收站）的不再显示
      seen.add(row.no);
      items.push(item(row.no, row));
    }
    return { no: batch.no, info: batch.info, ...batchInfo(batch.info), items };
  });
  // 有图却没登记的（AI 还没登记完，或者用户自己放进来的）：放在最后一组「还没登记的」
  const loose = [...new Set([...images.keys(), ...prompts])].filter((no) => !seen.has(no)).sort();
  if (loose.length) batches.push({ no: null, info: null, style: null, styleName: null, size: null, items: loose.map((no) => item(no)) });
  const lastBatch = record.batches.length ? Math.max(...record.batches.map((b) => b.no)) : images.size || prompts.size ? 1 : 0;
  const lastSize = [...batches].reverse().find((b) => b.size)?.size ?? null;
  return {
    ...base,
    defaults: { ...base.defaults, size: lastSize ?? base.defaults.size },
    batches: batches.filter((b) => b.items.length),
    selected,
    next: { batch: lastBatch + 1 },
    total: images.size,
  };
}

/** 页面要显示的一张图：封面候选/封面-NN.*、封面-选定.*（相对这条内容的草稿文件夹） */
export function coverFile(config, layout, id, relative) {
  const detail = readWorkDetail(id, layout);
  if (!detail.draftDir) throw fail(`${id} 还没有草稿文件夹。`, 404);
  const folder = path.join(layout.draftsDir, detail.draftDir.name);
  const parts = String(relative ?? "").split("/").filter(Boolean);
  const ok = (parts.length === 1 && SELECTED_NAME.test(parts[0])) || (parts.length === 2 && parts[0] === COVER_DIR && COVER_NAME.test(parts[1]));
  if (!ok) throw fail("这里只给看封面候选和选定的封面。", 403);
  const target = insideDir(folder, ...parts);
  return { file: target, mime: IMAGE_MIME[path.extname(target).toLowerCase()] };
}

/**
 * 「封面」页的「我的封面」：每条出过封面的内容一组（只放 AI 给这条内容出的封面，收来参考的别人的封面不算），
 * 每张带上它是照哪个风格出的（看生成记录那一批的第一行），页面按内容或者按风格排。最近有改动的内容在前。
 */
export function coverLibrary(config, layout) {
  const groups = [];
  for (const work of readWorks(layout).works) {
    if (!work.cover || !work.draftDir) continue;
    const folder = path.join(layout.draftsDir, work.draftDir.name);
    const { images, record, selected } = scanCovers(folder);
    if (!images.size && !selected) continue;
    const styleOfNo = new Map();
    for (const batch of record.batches) {
      const info = batchInfo(batch.info);
      for (const row of batch.rows) if (!styleOfNo.has(row.no)) styleOfNo.set(row.no, { style: info.style, styleName: info.styleName, size: info.size, batch: batch.no });
    }
    const covers = [...images.entries()]
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([no, image]) => ({ no, image: image.name, modifiedAt: image.modifiedAt, selected: selected?.from === no, ...(styleOfNo.get(no) ?? { style: null, styleName: null, size: null, batch: null }) }));
    const latest = [selected?.modifiedAt, ...covers.map((c) => c.modifiedAt)].filter(Boolean).sort().at(-1) ?? null;
    groups.push({ id: work.id, title: work.title, type: work.type ?? null, form: contentForm(work.type), selected, covers, latest });
  }
  groups.sort((a, b) => String(b.latest ?? "").localeCompare(String(a.latest ?? "")));
  return { groups };
}
