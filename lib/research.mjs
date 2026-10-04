// 「市场调研」栏读写的文件，全部在设置里的三个文件夹里，页面上的状态都从文件现算：
//   对标账号/<平台>-<账号名>/   档案.json（platform、account_name、url、note、tags、updated_at，可选 followers、bio、source）+ 任意图片
//   调研报告/<日期_主题>/       一个或几个网页（.html）+ meta.json（title、date、type、source、pages、workbenchVisible）
//   评论导入/                   社媒助手导出的评论表（.xlsx、.csv、.tsv、.json）
// 页面上能做的写操作：添加、编辑对标账号（写回档案.json 再读回来核对），给账号加图片，把账号挪进回收站，导入评论表。
// 文件夹和文件名都只认一层名字：不收带斜杠、以点开头的；消解软链接以后必须还在对应的文件夹里。
import { randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { COMMENT_TABLE_EXTS } from "./data-sources.mjs";
import { inspectCommentTable, MAX_TABLE_BYTES } from "./comment-tables.mjs";

export const PROFILE_FILE = "档案.json";
export const PLATFORMS = Object.freeze(["抖音", "小红书", "视频号", "B站", "快手", "公众号", "微博", "YouTube", "TikTok", "X", "其他"]);
const IMAGE_MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// 报告文件夹里能给浏览器看的文件
const REPORT_MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
};
// 报告网页放在隔开的环境里打开（来源是空的）：里面的脚本照常能画图，但碰不到工作台的接口和浏览器存储
export const REPORT_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

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

/** 只认一层名字：不能空、不能带斜杠、不能是 . 或 ..、不能以点开头 */
function checkName(name, what = "名字") {
  if (typeof name !== "string" || !name || name.length > 255 || /[\\/\0]/.test(name) || name.startsWith(".")) {
    throw fail(`${what}不对。`, 400);
  }
  return name;
}

/** base 里的一个东西：消解软链接以后还在 base 里面才算 */
function inside(base, ...parts) {
  let realBase;
  let target;
  try {
    realBase = realpathSync(base);
    target = realpathSync(path.join(realBase, ...parts));
  } catch {
    throw fail("找不到这个文件，可能已经被移走或删除。", 404);
  }
  const inner = path.relative(realBase, target);
  if (!inner || inner.startsWith("..") || path.isAbsolute(inner) || inner.split(path.sep).some((part) => part.startsWith("."))) {
    throw fail("这个文件不在市场调研的文件夹里。", 403);
  }
  return target;
}

function nowIso(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  const abs = Math.abs(tz);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 文件、文件夹名里不能有的字符换成「-」，空白去掉，最长 48 个字 */
function cleanSegment(value, fallback = "") {
  const cleaned = [...String(value ?? "")
    .replace(/[\\/:*?"<>|\r\n\t\0]+/g, "-")
    .replace(/\s+/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")]
    .slice(0, 48)
    .join("");
  return cleaned || fallback;
}

/** 同名的已经有了就在后面加 -2、-3 */
function freeName(dir, stem, ext = "") {
  let name = `${stem}${ext}`;
  for (let i = 2; existsSync(path.join(dir, name)); i += 1) name = `${stem}-${i}${ext}`;
  return name;
}

function writeJsonAtomic(file, value) {
  const tmp = path.join(path.dirname(file), `.tmp-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/** 主页链接比较用：不分大小写的域名，去掉问号后面的参数、井号和结尾的斜杠 */
export function sameUrlKey(url) {
  try {
    const u = new URL(String(url ?? "").trim());
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

const sameName = (text) => String(text ?? "").replace(/\s+/g, "").toLowerCase();

// —— 对标账号 ——————————————————————————————

function readProfile(dir) {
  const file = path.join(dir, PROFILE_FILE);
  if (!existsSync(file)) return { profile: null, problem: `还没有 ${PROFILE_FILE}` };
  try {
    const value = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
    if (value && typeof value === "object" && !Array.isArray(value)) return { profile: value, problem: null };
    return { profile: null, problem: `${PROFILE_FILE} 最外层不是 { … }` };
  } catch {
    return { profile: null, problem: `${PROFILE_FILE} 写坏了，不是合法的 JSON` };
  }
}

function listImages(dir) {
  return safeEntries(dir)
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && IMAGE_MIME[path.extname(entry.name).toLowerCase()])
    .map((entry) => entry.name)
    .sort((a, b) => (a.startsWith("头像") ? 0 : 1) - (b.startsWith("头像") ? 0 : 1) || a.localeCompare(b, "zh-CN"));
}

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

function accountOf(dir, name) {
  const { profile, problem } = readProfile(dir);
  const p = profile ?? {};
  const followers = typeof p.followers === "number" || typeof p.followers === "string" ? p.followers : null;
  let updatedAt = text(p.updated_at);
  if (!updatedAt) {
    try {
      updatedAt = statSync(dir).mtime.toISOString();
    } catch {
      updatedAt = null;
    }
  }
  return {
    name,
    platform: text(p.platform),
    accountName: text(p.account_name) ?? name,
    url: text(p.url),
    note: text(p.note),
    tags: Array.isArray(p.tags) ? p.tags.map((t) => String(t).trim()).filter(Boolean) : [],
    followers,
    bio: text(p.bio),
    source: text(p.source),
    images: listImages(dir),
    updatedAt,
    problem,
  };
}

/** 全部对标账号，最近改过的在前 */
export function listAccounts(dir) {
  return safeEntries(dir)
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => accountOf(path.join(dir, entry.name), entry.name))
    .sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0) || a.name.localeCompare(b.name, "zh-CN"));
}

function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[,，、;；\s]+/);
  const tags = [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
  if (tags.length > 20 || tags.some((t) => [...t].length > 20)) throw fail("标签最多 20 个，每个不超过 20 个字。", 400);
  return tags;
}

/**
 * 添加或编辑一个对标账号。name 是账号文件夹名（编辑时给，添加时不给）。
 * 添加：文件夹叫「平台-账号名」，同平台同名或者主页链接一样的已经有了就不再建，告诉用户去编辑那一个。
 * 编辑：只改表单里的几项，档案里别的字段（粉丝数、简介、来源这些）原样留着。写完读回来核对。
 */
export function saveAccount(dir, { name, platform, accountName, url, note, tags } = {}) {
  const cleanName = typeof accountName === "string" ? accountName.trim() : "";
  if (!cleanName) throw fail("账号名要填。", 400, "name-empty");
  if ([...cleanName].length > 60) throw fail("账号名太长了（最多 60 个字）。", 400);
  const cleanPlatform = typeof platform === "string" && platform.trim() ? platform.trim().slice(0, 20) : "其他";
  const cleanUrl = typeof url === "string" && url.trim() ? url.trim() : null;
  if (cleanUrl) {
    let parsed = null;
    try {
      parsed = new URL(cleanUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol) || cleanUrl.length > 2000) {
      throw fail("主页链接要是 http:// 或 https:// 开头的网址，从浏览器地址栏复制过来就行。", 400, "bad-url");
    }
  }
  const cleanNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 2000) : null;
  const cleanTagList = cleanTags(tags);

  mkdirSync(dir, { recursive: true });
  let folder;
  let created = false;
  let existing = {};
  if (name) {
    folder = checkName(name, "账号文件夹名");
    const target = inside(dir, folder);
    if (!statSync(target).isDirectory()) throw fail("这不是一个账号文件夹。", 400);
    existing = readProfile(target).profile ?? {};
  } else {
    const others = listAccounts(dir);
    const twin = others.find(
      (a) =>
        (sameName(a.accountName) === sameName(cleanName) && (a.platform ?? "其他") === cleanPlatform) ||
        (cleanUrl && a.url && sameUrlKey(a.url) && sameUrlKey(a.url) === sameUrlKey(cleanUrl)),
    );
    if (twin) throw fail(`已经有这个账号了：「${twin.name}」。点它卡片上的「编辑」改就行。`, 409, "duplicate");
    folder = freeName(dir, `${cleanSegment(cleanPlatform, "其他")}-${cleanSegment(cleanName, "账号")}`);
    mkdirSync(path.join(dir, folder));
    created = true;
  }

  const target = path.join(dir, folder);
  const { platform: _p, account_name: _a, url: _u, note: _n, tags: _t, updated_at: _up, ...rest } = existing;
  const profile = {
    platform: cleanPlatform,
    account_name: cleanName,
    url: cleanUrl,
    note: cleanNote,
    tags: cleanTagList,
    updated_at: nowIso(),
    ...rest,
    ...(created ? { source: "manual", created_at: nowIso() } : {}),
  };
  writeJsonAtomic(path.join(target, PROFILE_FILE), profile);
  const back = readProfile(target).profile;
  const same = back && ["platform", "account_name", "url", "note", "updated_at"].every((key) => back[key] === profile[key]) &&
    JSON.stringify(back.tags) === JSON.stringify(profile.tags);
  if (!same) throw fail(`写进 ${PROFILE_FILE} 以后读出来对不上，请再保存一次。`, 500, "readback");
  return {
    ok: true,
    created,
    name: folder,
    message: created ? `已添加「${cleanName}」。` : `已保存「${cleanName}」。`,
    account: accountOf(target, folder),
  };
}

/** 给账号加一张图：请求体就是图片本身，先写临时文件，收完再改名，不覆盖同名的 */
export function saveAccountImage(dir, { name, filename, req }) {
  const folder = checkName(name, "账号文件夹名");
  const target = inside(dir, folder);
  const original = path.basename(String(filename ?? "").replace(/\\/g, "/"));
  const ext = path.extname(original).toLowerCase();
  if (!IMAGE_MIME[ext]) throw fail("只收 jpg、png、webp、gif 图片。", 415, "bad-image");
  const finalName = freeName(target, cleanSegment(original.slice(0, -ext.length), "截图"), ext === ".jpeg" ? ".jpg" : ext);
  const tmp = path.join(target, `.tmp-upload-${randomBytes(6).toString("hex")}`);
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let done = false;
    const out = createWriteStream(tmp, { flags: "wx" });
    const stop = (error) => {
      if (done) return;
      done = true;
      out.destroy();
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* 清理失败不盖住原来的错误 */
      }
      reject(error);
    };
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_IMAGE_BYTES) {
        req.destroy();
        stop(fail("图片超过 20 MB 了，换一张小一点的。", 413));
        return;
      }
      if (!out.write(chunk)) req.pause();
    });
    out.on("drain", () => req.resume());
    req.on("error", stop);
    out.on("error", stop);
    req.on("end", () => {
      out.end(() => {
        if (done) return;
        try {
          if (bytes === 0) throw fail("收到的图片是空的。", 400);
          renameSync(tmp, path.join(target, finalName));
          if (statSync(path.join(target, finalName)).size !== bytes) throw fail("图片没存完整，请再传一次。", 500);
          done = true;
          resolve({ ok: true, name: folder, file: finalName, bytes });
        } catch (error) {
          stop(error);
        }
      });
    });
  });
}

/** 账号图片：给 <img> 用 */
export function accountImage(dir, name, file) {
  const target = inside(dir, checkName(name, "账号文件夹名"), checkName(file, "图片名"));
  const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
  if (!mime || !statSync(target).isFile()) throw fail("这不是图片。", 415);
  return { file: target, mime };
}

/** 账号挪进回收站：文件夹名前面加日期和「对标账号」，不永久删除 */
export function trashAccount(dir, trashDir, name) {
  const folder = checkName(name, "账号文件夹名");
  const target = inside(dir, folder);
  if (!statSync(target).isDirectory()) throw fail("这不是一个账号文件夹。", 400);
  mkdirSync(trashDir, { recursive: true });
  const moved = freeName(trashDir, `${localDay()}_对标账号_${folder}`);
  renameSync(target, path.join(trashDir, moved));
  if (existsSync(target)) throw fail("没挪走，请再试一次。", 500);
  return { ok: true, name: folder, trashedAs: moved, message: `已把「${folder}」挪进回收站。` };
}

// —— 调研报告 ——————————————————————————————

const DATE_IN_NAME = /^(\d{4})-(\d{1,2})-(\d{1,2})/;

function normalDate(value) {
  const m = String(value ?? "").trim().match(DATE_IN_NAME);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/** 报告文件夹里的一个相对路径：一段段核对，不收 ..、隐藏文件和反斜杠 */
function checkRelative(relative) {
  const parts = String(relative ?? "").split("/");
  if (!relative || parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".") || part.includes("\\") || part.includes("\0"))) {
    throw fail("报告里的文件名不对。", 400);
  }
  return parts;
}

function reportOf(dir, id) {
  let meta = {};
  let problem = null;
  const metaFile = path.join(dir, "meta.json");
  if (existsSync(metaFile)) {
    try {
      const value = JSON.parse(readFileSync(metaFile, "utf8").replace(/^﻿/, ""));
      if (value && typeof value === "object" && !Array.isArray(value)) meta = value;
      else problem = "meta.json 最外层不是 { … }";
    } catch {
      problem = "meta.json 写坏了，不是合法的 JSON，下面按文件夹名和里面的网页显示";
    }
  }
  if (meta.workbenchVisible === false) return null;
  const isPage = (file) => /\.html?$/i.test(file);
  let pages = [];
  if (Array.isArray(meta.pages) && meta.pages.length) {
    for (const page of meta.pages) {
      const file = typeof page === "string" ? page : page?.file;
      if (typeof file !== "string" || !isPage(file)) continue;
      try {
        checkRelative(file);
        if (!statSync(inside(dir, ...file.split("/"))).isFile()) continue;
      } catch {
        continue;
      }
      pages.push({
        file,
        title: text(page?.title) ?? file.replace(/\.html?$/i, ""),
        subtitle: text(page?.subtitle),
      });
    }
  }
  if (!pages.length) {
    pages = safeEntries(dir)
      .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && isPage(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => (/^index\.html?$/i.test(a) ? 0 : 1) - (/^index\.html?$/i.test(b) ? 0 : 1) || a.localeCompare(b, "zh-CN"))
      .map((file) => ({ file, title: file.replace(/\.html?$/i, ""), subtitle: null }));
  }
  if (!pages.length) return null;
  let updatedAt = null;
  try {
    updatedAt = statSync(dir).mtime.toISOString();
  } catch {
    updatedAt = null;
  }
  return {
    id,
    title: text(meta.title) ?? (id.replace(DATE_IN_NAME, "").replace(/^[_\-\s]+/, "") || id),
    date: normalDate(meta.date) ?? normalDate(id),
    type: text(meta.type) ?? "未分类",
    source: text(meta.source),
    pages,
    updatedAt,
    problem,
  };
}

/** 全部调研报告，日期新的在前；没有网页的文件夹（可能 AI 还在做）和写了 workbenchVisible: false 的不列 */
export function listReports(dir) {
  return safeEntries(dir)
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => reportOf(path.join(dir, entry.name), entry.name))
    .filter(Boolean)
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")) || (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
}

/** 报告里的一个文件（网页、图片、样式……），给浏览器看 */
export function reportFile(dir, id, relative) {
  const parts = checkRelative(relative);
  const target = inside(dir, checkName(id, "报告文件夹名"), ...parts);
  const mime = REPORT_MIME[path.extname(target).toLowerCase()];
  if (!mime) throw fail("报告里的这种文件不能在浏览器里看。", 415);
  if (!statSync(target).isFile()) throw fail("这不是文件。", 400);
  return { file: target, mime };
}

export function streamFile(res, { file, mime }, extraHeaders = {}) {
  const { size } = statSync(file);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  createReadStream(file).pipe(res);
}

// —— 评论导入 ——————————————————————————————

const tableCache = new Map();

function inspectFile(file, stat) {
  const sig = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const hit = tableCache.get(file);
  if (hit?.sig === sig) return hit.info;
  let info;
  try {
    const result = inspectCommentTable(readFileSync(file), path.extname(file).toLowerCase());
    info = { ok: result.ok, comments: result.comments, notes: result.notes, noteKeys: result.noteKeys, unit: result.unit, problem: result.problem };
  } catch (error) {
    info = { ok: false, comments: 0, notes: null, noteKeys: new Set(), unit: null, problem: error?.message ?? "读不出来" };
  }
  if (tableCache.size > 500) tableCache.clear();
  tableCache.set(file, { sig, info });
  return info;
}

/** 「已导入 128 条评论，来自 3 条笔记」 */
export function importedLine(comments, notes, unit) {
  const n = Number(comments).toLocaleString("zh-CN");
  return notes ? `已导入 ${n} 条评论，来自 ${Number(notes).toLocaleString("zh-CN")} 条${unit ?? "内容"}` : `已导入 ${n} 条评论`;
}

/**
 * 评论导入文件夹里有什么：每份表认没认出来、几条评论、来自几条笔记或视频；合计时同一条笔记只算一次。
 * 认出至少一份评论表，就算社媒助手这一步配好了。
 */
export function scanCommentImports(dir) {
  const tables = [];
  const keys = new Set();
  const units = new Map();
  let comments = 0;
  let anyNotes = false;
  for (const entry of safeEntries(dir)) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!COMMENT_TABLE_EXTS.includes(ext) && ext !== ".xls") continue;
    const file = path.join(dir, entry.name);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    const info = inspectFile(file, stat);
    tables.push({
      name: entry.name,
      ok: info.ok,
      comments: info.comments,
      notes: info.notes,
      unit: info.unit,
      problem: info.problem,
      modifiedAt: stat.mtime.toISOString(),
      size: stat.size,
    });
    if (!info.ok) continue;
    comments += info.comments;
    if (info.notes !== null) {
      anyNotes = true;
      for (const key of info.noteKeys) keys.add(key);
    }
    if (info.unit) units.set(info.unit, (units.get(info.unit) ?? 0) + 1);
  }
  tables.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const unit = units.size === 1 ? [...units.keys()][0] : units.size > 1 ? "笔记或视频" : null;
  const recognized = tables.filter((t) => t.ok).length;
  return {
    folder: dir,
    exists: existsSync(dir),
    tables,
    recognized,
    comments,
    notes: anyNotes ? keys.size : null,
    unit,
    configured: recognized > 0,
    line: recognized ? importedLine(comments, anyNotes ? keys.size : null, unit) : null,
  };
}

/** 导入一份评论表：先认，认出是评论表才存进评论导入文件夹（不覆盖同名的），存完核对大小 */
export function importCommentTable(dir, { filename, buffer }) {
  const original = path.basename(String(filename ?? "").replace(/\\/g, "/"));
  const ext = path.extname(original).toLowerCase();
  if (ext === ".xls") throw fail("这是老版 Excel（.xls），读不了。在 Excel 或 Numbers 里另存为 .xlsx 或 CSV，再拖进来。", 415, "old-xls");
  if (!COMMENT_TABLE_EXTS.includes(ext)) throw fail("只收社媒助手导出的 Excel（.xlsx）、CSV、TSV，或者 JSON。", 415, "bad-type");
  if (!buffer?.length) throw fail("收到的文件是空的。", 400);
  if (buffer.length > MAX_TABLE_BYTES) throw fail("这份表超过 50 MB 了，请分成几份导出。", 413, "too-big");
  const result = inspectCommentTable(buffer, ext);
  if (!result.ok) throw fail(`这份表没导入：${result.problem}`, 422, "not-comments");
  mkdirSync(dir, { recursive: true });
  const finalName = freeName(dir, cleanSegment(original.slice(0, -ext.length), `评论表-${localDay()}`), ext);
  const tmp = path.join(dir, `.tmp-import-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmp, buffer, { flag: "wx" });
  renameSync(tmp, path.join(dir, finalName));
  if (statSync(path.join(dir, finalName)).size !== buffer.length) throw fail("表没存完整，请再拖一次。", 500);
  return {
    ok: true,
    file: finalName,
    comments: result.comments,
    notes: result.notes,
    unit: result.unit,
    message: `「${finalName}」导入好了：${result.comments.toLocaleString("zh-CN")} 条评论${result.notes ? `，来自 ${result.notes.toLocaleString("zh-CN")} 条${result.unit ?? "内容"}` : ""}。`,
  };
}
