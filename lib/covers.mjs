// 封面（1.1 加）：每条内容的封面候选、选定、收藏、批注，「封面素材」里的照片和封面设置，对标账号的封面 VI。
// 文件怎么放、生成记录.md 长什么样，是和封面 Skill（skills/<id>-cover）一起定的，写在 docs/开发记录.md「封面」一节：
//   <内容草稿>/T001_*/封面候选/封面-01.png …、生图描述-01.md …、生成记录.md、批注/封面-03-批注.png
//   <内容草稿>/T001_*/封面-选定.png
//   <封面素材>/封面设置.json、我的照片/、收藏/T001_封面-03.png
//   <对标账号>/<平台-账号名>/封面/K01.jpg …、VI拆解.md（第二行「风格名：…」）
// 出图、拆 VI、按备注改都交给 AI（页面上复制一句话）；这里只做不用 AI 的事：选定、取消选定、删除（挪进回收站）、收藏、
// 存批注图、放照片、设默认对标。每做一件，往这条内容的生成记录.md 的「## 记录」里追加一行；批次小节只由 AI 写。
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { COVER_DIR, COVER_NAME, FAV_DIR, PHOTO_DIR, SELECTED_BASE, SELECTED_NAME } from "./cover-files.mjs";
import { readWorkDetail } from "./works.mjs";

export { COVER_DIR, FAV_DIR, PHOTO_DIR, SELECTED_BASE, coverSummary } from "./cover-files.mjs";
export const NOTES_DIR = "批注";
export const RECORD_FILE = "生成记录.md";
export const SETTINGS_FILE = "封面设置.json";
export const VI_DIR = "封面";
export const VI_FILE = "VI拆解.md";
export const VI_REPORT_TYPE = "封面VI";
export const DEFAULT_BATCH = 10;
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const PHOTO_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PROMPT_NAME = /^生图描述-(\d{2,3})\.md$/;

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
/** 编号统一成至少两位：3 → 03，「3」「03」「封面-03」都认 */
export function coverNo(value) {
  const digits = String(value ?? "").match(/(\d{1,3})(?!.*\d)/)?.[1];
  if (!digits || Number(digits) < 1) throw fail("封面编号不对，应该像 03 这样。", 400);
  return pad(Number(digits));
}

function localDay(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
function localMinute(now = new Date()) {
  return `${localDay(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 名字被占了就在后面加 -2、-3 */
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

// —— 封面素材：设置、照片 ——————————————————————————————

function settingsFile(config) {
  return path.join(config.paths.coverAssets, SETTINGS_FILE);
}

/** 封面设置：照片（相对封面素材）、默认对标（对标账号文件夹名）、一批几张。文件没有或写坏了都按「没设」算，并说出来 */
export function readCoverSettings(config) {
  const file = settingsFile(config);
  let raw = {};
  let problem = null;
  if (existsSync(file)) {
    try {
      const value = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
      if (value && typeof value === "object" && !Array.isArray(value)) raw = value;
      else problem = `${SETTINGS_FILE} 最外层不是 { … }，先按没设处理。`;
    } catch {
      problem = `${SETTINGS_FILE} 写坏了，不是合法的 JSON，先按没设处理。`;
    }
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

function photosDir(config) {
  return path.join(config.paths.coverAssets, PHOTO_DIR);
}

export function listPhotos(config) {
  return safeEntries(photosDir(config))
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && /\.(png|jpe?g|webp|heic)$/i.test(entry.name))
    .map((entry) => {
      const stat = statSync(path.join(photosDir(config), entry.name));
      return { name: entry.name, shown: PHOTO_EXT.has(path.extname(entry.name).toLowerCase()), modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** 页面上放一张照片：存进 我的照片/，设成默认照片 */
export function savePhoto(config, { filename, buffer }) {
  const ext = isImageBuffer(buffer);
  if (!ext) throw fail("照片要是 PNG、JPEG 或 WebP（iPhone 的 HEIC 照片先在「照片」App 里导出成 JPEG）。", 415);
  if (buffer.length > MAX_IMAGE_BYTES) throw fail("照片超过 20 MB 了，换一张小一点的。", 413);
  const stem = String(filename ?? "")
    .replace(/\.[^.]*$/, "")
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, " ")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 40) || "我的照片";
  const dir = photosDir(config);
  mkdirSync(dir, { recursive: true });
  const name = freeName(dir, `${stem}${ext}`);
  writeFileSync(path.join(dir, name), buffer, { flag: "wx" });
  const settings = writeCoverSettings(config, { photo: `${PHOTO_DIR}/${name}` });
  return { ok: true, name, settings: publicSettings(settings), message: `照片放好了，以后出封面用这张：${name}` };
}

export function photoFile(config, name) {
  const base = photosDir(config);
  const target = insideDir(base, name);
  const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
  if (!mime) throw fail("这张照片浏览器显示不了（比如 HEIC）。", 415);
  return { file: target, mime };
}

function publicSettings(settings) {
  return { photo: settings.photo, benchmark: settings.benchmark, batchSize: settings.batchSize, problem: settings.problem };
}

// —— 对标账号的封面 VI ——————————————————————————————

/** VI拆解.md 第二行「风格名：…」 */
function styleOf(file) {
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

/** 一个对标账号的封面 VI：拆过没有、风格名、封面/ 里有几张、前几张样张、是不是默认、对照网页在哪份调研报告里 */
export function accountVi(config, folder, { settings = readCoverSettings(config), reports = [] } = {}) {
  const dir = path.join(config.paths.benchmarkAccounts, folder);
  const viFile = path.join(dir, VI_FILE);
  const images = safeEntries(path.join(dir, VI_DIR))
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && IMAGE_MIME[path.extname(entry.name).toLowerCase()])
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  const done = existsSync(viFile);
  const report = reports.find((r) => r.type === VI_REPORT_TYPE && r.source === folder) ?? null;
  return {
    done,
    style: done ? styleOf(viFile) : null,
    covers: images.length,
    samples: images.slice(0, 8),
    isDefault: settings.benchmark === folder,
    report: report ? { id: report.id, page: report.pages[0]?.file ?? "index.html" } : null,
  };
}

/** 对标账号 封面/ 里的一张，给 <img> 用 */
export function viImage(config, folder, file) {
  const target = insideDir(path.join(config.paths.benchmarkAccounts, checkPart(folder)), VI_DIR, file);
  const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
  if (!mime) throw fail("这不是图片。", 415);
  return { file: target, mime };
}

/** 设默认对标：这个账号要已经拆过 VI */
export function setDefaultBenchmark(config, folder) {
  const name = checkPart(folder);
  const dir = path.join(config.paths.benchmarkAccounts, name);
  if (!existsSync(dir)) throw fail(`找不到对标账号「${name}」。`, 404);
  if (!existsSync(path.join(dir, VI_FILE))) throw fail(`「${name}」还没拆过封面 VI，先拆一下再设成默认。`, 409, "no-vi");
  const settings = writeCoverSettings(config, { benchmark: name });
  const style = styleOf(path.join(dir, VI_FILE));
  return { ok: true, settings: publicSettings(settings), message: `以后出封面默认照「${style ?? name}」来。` };
}

// —— 一条内容的封面 ——————————————————————————————

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

/** 这条内容的草稿文件夹。required：没有就报错（选定、删除这些操作要有）；不要求时没有返回 null（还没出过封面） */
function draftFolder(layout, id, { required = false } = {}) {
  const detail = readWorkDetail(id, layout);
  if (!detail.draftDir) {
    if (!required) return null;
    throw fail(`${id} 还没有草稿文件夹。`, 404, "no-draft");
  }
  return path.join(layout.draftsDir, detail.draftDir.name);
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

/** 往「## 记录」追加一行（没有这一节就在文件末尾建）；文件还没有就建一个最小的 */
function appendEvent(folder, id, text, now = new Date()) {
  const file = path.join(folder, COVER_DIR, RECORD_FILE);
  let markdown = existsSync(file) ? readFileSync(file, "utf8") : `# ${id} 封面生成记录\n`;
  const line = `- ${localMinute(now)} ${text}`;
  if (/^##\s*记录\s*$/m.test(markdown)) {
    // 记在「## 记录」这一节的最后（下一节标题之前）
    const lines = markdown.split(/\r?\n/);
    const start = lines.findIndex((l) => /^##\s*记录\s*$/.test(l.trim()));
    let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l.trim()));
    if (end < 0) end = lines.length;
    let at = end;
    while (at > start + 1 && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, line);
    markdown = lines.join("\n");
  } else {
    markdown = `${markdown.replace(/\s*$/, "")}\n\n## 记录\n\n${line}\n`;
  }
  if (!markdown.endsWith("\n")) markdown += "\n";
  writeAtomic(file, markdown);
}

function favDir(config) {
  return path.join(config.paths.coverAssets, FAV_DIR);
}

/** 一条内容的封面全貌：按批次排的候选（有图的、只有提示词的）、选定的是哪张、收藏了哪几张、下一张和下一批的编号 */
export function topicCovers(config, layout, id) {
  const folder = draftFolder(layout, id);
  const settings = readCoverSettings(config);
  const base = { id, folder: folder ? path.basename(folder) : null, settings: publicSettings(settings) };
  if (!folder) return { ...base, batches: [], selected: null, favorites: [], next: { no: "01", batch: 1 }, total: 0 };
  const dir = path.join(folder, COVER_DIR);
  const images = new Map();
  const prompts = new Set();
  for (const entry of safeEntries(dir)) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const cover = entry.name.match(COVER_NAME);
    if (cover) {
      const stat = statSync(path.join(dir, entry.name));
      images.set(pad(Number(cover[1])), { name: entry.name, modifiedAt: stat.mtime.toISOString(), size: stat.size });
      continue;
    }
    const prompt = entry.name.match(PROMPT_NAME);
    if (prompt) prompts.add(pad(Number(prompt[1])));
  }
  const notes = new Map();
  for (const entry of safeEntries(path.join(dir, NOTES_DIR))) {
    const m = entry.isFile() && entry.name.match(/^封面-(\d{2,3})-批注(?:-(\d+))?\.png$/);
    if (m) {
      const no = pad(Number(m[1]));
      const k = Number(m[2] ?? 1);
      if (!notes.has(no) || notes.get(no).k < k) notes.set(no, { k, name: entry.name });
    }
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
  const favorites = safeEntries(favDir(config))
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${id}_`))
    .map((entry) => entry.name.match(/_封面-(\d{2,3})\./)?.[1])
    .filter(Boolean)
    .map((no) => pad(Number(no)));

  // 只有提示词、没有图的（Claude Code 只出提示词）：把提示词带上，页面上一键复制
  const promptText = (no) => {
    try {
      const text = readFileSync(path.join(dir, `生图描述-${no}.md`), "utf8");
      return text.length > 20000 ? `${text.slice(0, 20000)}\n……（太长，后面的去文件里看）` : text;
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
      note: notes.get(no)?.name ?? null,
      favorite: favorites.includes(no),
      selected: selected?.from === no,
      modifiedAt: image?.modifiedAt ?? null,
    };
  };
  const seen = new Set();
  const batches = record.batches.map((batch) => {
    const items = [];
    for (const row of batch.rows) {
      if (seen.has(row.no)) continue;
      if (!images.has(row.no) && !prompts.has(row.no)) continue; // 删掉了（挪进回收站）的不再显示
      seen.add(row.no);
      items.push(item(row.no, row));
    }
    return { no: batch.no, info: batch.info, items };
  });
  // 有图却没登记的（AI 还没登记完，或者用户自己放进来的）：放在最后一组「还没登记的」
  const loose = [...new Set([...images.keys(), ...prompts])].filter((no) => !seen.has(no)).sort();
  if (loose.length) batches.push({ no: null, info: null, items: loose.map((no) => item(no)) });
  const used = [...images.keys(), ...prompts, ...record.batches.flatMap((b) => b.rows.map((r) => r.no))].map(Number);
  const nextNo = pad((used.length ? Math.max(...used) : 0) + 1);
  const lastBatch = record.batches.length ? Math.max(...record.batches.map((b) => b.no)) : images.size || prompts.size ? 1 : 0;
  return {
    ...base,
    batches: batches.filter((b) => b.items.length),
    selected,
    favorites,
    events: record.events.slice(-20),
    next: { no: nextNo, batch: lastBatch + 1 },
    total: images.size,
  };
}

/** 页面要显示的一张图：封面候选/…、封面候选/批注/…、封面-选定.*（相对这条内容的草稿文件夹） */
export function coverFile(config, layout, id, relative) {
  const folder = draftFolder(layout, id);
  if (!folder) throw fail(`${id} 还没有草稿文件夹。`, 404);
  const parts = String(relative ?? "").split("/").filter(Boolean);
  const ok =
    (parts.length === 1 && SELECTED_NAME.test(parts[0])) ||
    (parts.length === 2 && parts[0] === COVER_DIR && COVER_NAME.test(parts[1])) ||
    (parts.length === 3 && parts[0] === COVER_DIR && parts[1] === NOTES_DIR && /\.png$/i.test(parts[2]));
  if (!ok) throw fail("这里只给看封面候选、批注图和选定的封面。", 403);
  const target = insideDir(folder, ...parts);
  return { file: target, mime: IMAGE_MIME[path.extname(target).toLowerCase()] };
}

function candidate(folder, no) {
  const dir = path.join(folder, COVER_DIR);
  const name = safeEntries(dir).find((entry) => entry.isFile() && entry.name.match(COVER_NAME) && pad(Number(entry.name.match(COVER_NAME)[1])) === no)?.name;
  if (!name) throw fail(`找不到封面-${no}，可能已经删掉了。`, 404, "no-cover");
  return path.join(dir, name);
}

function moveToTrash(config, file, label) {
  const trash = config.paths.trash;
  mkdirSync(trash, { recursive: true });
  const name = freeName(trash, `${localDay()}_${label}`);
  renameSync(file, path.join(trash, name));
  if (existsSync(file)) throw fail("没挪走，请再试一次。", 500);
  return name;
}

/** 就用这张：复制成 封面-选定.<扩展名>（换了扩展名，旧的那份挪进回收站）；候选原图不动 */
export function selectCover(config, layout, id, value) {
  const no = coverNo(value);
  const folder = draftFolder(layout, id, { required: true });
  const source = candidate(folder, no);
  const ext = path.extname(source).toLowerCase();
  for (const entry of safeEntries(folder)) {
    if (entry.isFile() && SELECTED_NAME.test(entry.name) && path.extname(entry.name).toLowerCase() !== ext) {
      moveToTrash(config, path.join(folder, entry.name), `${id}_${entry.name}`);
    }
  }
  copyFileSync(source, path.join(folder, `${SELECTED_BASE}${ext}`));
  appendEvent(folder, id, `选定 封面-${no}`);
  return { ok: true, message: `已选定封面-${no}，存成「${SELECTED_BASE}${ext}」。` };
}

/** 取消选定：封面-选定.* 挪进回收站（文件夹里不留错的选定文件） */
export function unselectCover(config, layout, id) {
  const folder = draftFolder(layout, id, { required: true });
  const state = topicCovers(config, layout, id);
  if (!state.selected) throw fail("这条内容还没有选定的封面。", 409);
  moveToTrash(config, path.join(folder, state.selected.name), `${id}_${state.selected.name}`);
  appendEvent(folder, id, `取消选定${state.selected.from ? ` 封面-${state.selected.from}` : ""}`);
  return { ok: true, message: "已取消选定。" };
}

/** 删一张候选：挪进回收站（文件名前加日期和编号）；选定的那张不能删 */
export function trashCover(config, layout, id, value) {
  const no = coverNo(value);
  const folder = draftFolder(layout, id, { required: true });
  const state = topicCovers(config, layout, id);
  if (state.selected?.from === no) throw fail("这张是选定的封面，先取消选定再删。", 409, "selected");
  const source = candidate(folder, no);
  const trashedAs = moveToTrash(config, source, `${id}_${path.basename(source)}`);
  appendEvent(folder, id, `删除 封面-${no}（挪进回收站）`);
  return { ok: true, trashedAs, message: `封面-${no} 挪进回收站了。` };
}

/** 收藏、取消收藏：收藏是复制一份到 封面素材/收藏/<编号>_封面-NN.<扩展名>；取消收藏把那份挪进回收站 */
export function favoriteCover(config, layout, id, value, on = true) {
  const no = coverNo(value);
  const folder = draftFolder(layout, id, { required: true });
  const dir = favDir(config);
  const existing = safeEntries(dir).find((entry) => entry.isFile() && entry.name.startsWith(`${id}_封面-${no}.`));
  if (on) {
    if (existing) return { ok: true, message: `封面-${no} 已经在收藏里了。` };
    const source = candidate(folder, no);
    mkdirSync(dir, { recursive: true });
    copyFileSync(source, path.join(dir, `${id}_封面-${no}${path.extname(source).toLowerCase()}`));
    appendEvent(folder, id, `收藏 封面-${no}`);
    return { ok: true, message: `已收藏封面-${no}，出下一批时可以挑它当构图参考。` };
  }
  if (!existing) return { ok: true, message: `封面-${no} 不在收藏里。` };
  moveToTrash(config, path.join(dir, existing.name), `收藏_${existing.name}`);
  appendEvent(folder, id, `取消收藏 封面-${no}`);
  return { ok: true, message: `已取消收藏封面-${no}。` };
}

/** 全部收藏（出一批时挑构图参考用）：新收藏的在前 */
export function listFavorites(config) {
  return safeEntries(favDir(config))
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && IMAGE_MIME[path.extname(entry.name).toLowerCase()])
    .map((entry) => {
      const m = entry.name.match(/^(T\d{3,4})_封面-(\d{2,3})\./);
      return { name: entry.name, id: m?.[1] ?? null, no: m ? pad(Number(m[2])) : null, modifiedAt: statSync(path.join(favDir(config), entry.name)).mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function favoriteFile(config, name) {
  const target = insideDir(favDir(config), name);
  const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
  if (!mime) throw fail("这不是图片。", 415);
  return { file: target, mime };
}

/**
 * 存批注图（页面在图上点了编号、写了话，画成一张 PNG 传过来）：封面候选/批注/封面-NN-批注.png，再批注加 -2、-3。
 * name：页面先算好的名字（浏览器只许在点按钮的那一下复制，页面得先复制话、再存图，话里写的位置要和存下来的一样）；
 * 名字不合规矩或者已经被占了，就照旧自己起一个，返回实际存成的名字。
 */
export function saveAnnotation(layout, id, value, buffer, { name: wanted = null } = {}) {
  const no = coverNo(value);
  if (isImageBuffer(buffer) !== ".png") throw fail("批注图要是 PNG。", 415);
  if (buffer.length > MAX_IMAGE_BYTES) throw fail("批注图太大了。", 413);
  const folder = draftFolder(layout, id, { required: true });
  candidate(folder, no); // 原图得在
  const dir = path.join(folder, COVER_DIR, NOTES_DIR);
  mkdirSync(dir, { recursive: true });
  const ok = typeof wanted === "string" && new RegExp(`^封面-${no}-批注(?:-\\d+)?\\.png$`).test(wanted) && !existsSync(path.join(dir, wanted));
  const name = ok ? wanted : freeName(dir, `封面-${no}-批注.png`);
  writeFileSync(path.join(dir, name), buffer, { flag: "wx" });
  return { ok: true, name, relative: `${COVER_DIR}/${NOTES_DIR}/${name}` };
}

