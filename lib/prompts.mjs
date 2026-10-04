// 提示词：只读提示词文件夹里的 md 文件（子文件夹就是分类），页面不新增、不改正文。
// 写操作只有四种：复制时记一次使用、点星标记收藏（都往同一份 _使用记录.jsonl 追加一行并回读）、
// 拖动后把顺序写进 _排序.md、删除时把文件挪进回收站。
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRAND } from "./brand.mjs";
import { readFileSyncWithRetry } from "./resilient-read.mjs";

export const UNCATEGORIZED = "未分类";
export const CATEGORY_ORDER_FILE = "_分类顺序.md";
export const MANUAL_ORDER_FILE = "_排序.md";
const VARIABLE_RE = /\{\{\s*([^{}|\n]+?)\s*(?:\|([^{}\n]*))?\}\}/g;
const SOURCE = BRAND.id;

function failure(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function skipName(name) {
  return name.startsWith("_") || name.startsWith(".") || /^readme\.md$/i.test(name);
}

function checkPromptId(id) {
  if (typeof id !== "string" || !id || id.includes("..") || id.startsWith("/") || id.includes("\\")) throw failure("提示词标识不对");
}

/** 设置里的路径整理成提示词要用的三样：提示词文件夹、使用记录、回收站。 */
export function promptsLayout(config) {
  return { dir: config.paths.prompts, eventsFile: config.paths.promptUsage, trashDir: config.paths.trash };
}

export function parsePromptFile(markdown, fallbackTitle) {
  const text = String(markdown).replace(/^﻿/, "");
  const meta = {};
  let body = text;
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const pair = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (pair) meta[pair[1].toLowerCase()] = pair[2].trim();
    }
    body = text.slice(match[0].length);
  }
  body = body.replace(/^\s*\n/, "").replace(/\s+$/, "");
  const seen = new Map();
  for (const found of body.matchAll(VARIABLE_RE)) {
    const name = found[1].trim();
    if (!seen.has(name)) seen.set(name, { name, hint: (found[2] ?? "").trim() });
  }
  return {
    title: meta.title || fallbackTitle,
    when: meta.when ?? "",
    summary: meta.summary ?? "",
    tags: meta.tags ? meta.tags.split(/[、,，]/).map((tag) => tag.trim()).filter(Boolean) : [],
    source: meta.source ?? "",
    body,
    variables: [...seen.values()],
  };
}

export function fillPrompt(body, values = {}) {
  return String(body).replace(VARIABLE_RE, (whole, name) => {
    const value = values[name.trim()];
    return value === undefined || value === null || String(value) === "" ? whole : String(value);
  });
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "zh"))) {
    if (skipName(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const child of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "zh"))) {
        if (skipName(child.name) || !child.isFile() || !child.name.endsWith(".md")) continue;
        files.push({ category: entry.name, file: path.join(full, child.name) });
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push({ category: UNCATEGORIZED, file: full });
    }
  }
  return files;
}

export function loadPromptEvents(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSyncWithRetry(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw failure(`提示词使用记录第 ${index + 1} 行写坏了（不是一行合法的 JSON）：${file}`, 503);
      }
    });
}

/** 读 `_分类顺序.md`：编号或短横线开头的行，「分类 — 说明」。没有文件就是空表。 */
export function parseCategoryOrder(markdown) {
  const order = [];
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:\d+[.、)]|[-*])\s*(.+?)\s*$/);
    if (!match) continue;
    const [name, ...rest] = match[1].split(/\s+[—-]\s+|：/);
    const clean = name.trim();
    if (clean && !order.some((row) => row.name === clean)) order.push({ name: clean, note: rest.join("").trim() });
  }
  return order;
}

export function readCategoryOrder(dir) {
  const file = path.join(dir, CATEGORY_ORDER_FILE);
  if (!existsSync(file)) return [];
  return parseCategoryOrder(readFileSyncWithRetry(file, "utf8"));
}

const MANUAL_ORDER_HEADER =
  "# 卡片顺序\n\n工作台「提示词」页按这里的顺序排卡片，拖动卡片会改写这个文件；没列出的条目按分类顺序排在后面。一行一条，写「分类/文件名」。\n\n";

/** 读 `_排序.md`：列表行里的「分类/文件名」，去掉重复、保持先后。 */
export function parseManualOrder(markdown) {
  const ids = [];
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:\d+[.、)]|[-*])\s*(.+?)\s*$/);
    if (match && !ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

export function readManualOrder(dir) {
  const file = path.join(dir, MANUAL_ORDER_FILE);
  if (!existsSync(file)) return [];
  return parseManualOrder(readFileSyncWithRetry(file, "utf8"));
}

export function readPromptLibrary({ dir, eventsFile, now = new Date() }) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw Object.assign(failure(`提示词文件夹不见了：${dir}`, 503), { code: "prompts-missing" });
  }
  const events = loadPromptEvents(eventsFile);
  const since30 = new Date(now.valueOf() - 30 * 86400000).toISOString();
  const usage = new Map();
  // 收藏以最后一条记录为准：按文件顺序（也就是时间顺序）一条条盖过去。
  const starred = new Map();
  for (const event of events) {
    if (event.event_type === "prompt_copied" && event.prompt_id) {
      const row = usage.get(event.prompt_id) ?? { count: 0, count30: 0, lastUsedAt: null };
      row.count += 1;
      if (new Date(event.at).toISOString() >= since30) row.count30 += 1;
      if (!row.lastUsedAt || String(event.at) > row.lastUsedAt) row.lastUsedAt = String(event.at);
      usage.set(event.prompt_id, row);
    } else if ((event.event_type === "prompt_starred" || event.event_type === "prompt_unstarred") && event.prompt_id) {
      starred.set(event.prompt_id, event.event_type === "prompt_starred");
    }
  }
  const issues = [];
  const prompts = [];
  for (const { category, file } of walk(dir)) {
    const id = path.relative(dir, file).replace(/\.md$/, "").split(path.sep).join("/");
    let parsed;
    try {
      parsed = parsePromptFile(readFileSyncWithRetry(file, "utf8"), path.basename(file, ".md"));
    } catch (cause) {
      issues.push(`${id}：${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    if (!parsed.body) {
      issues.push(`${id}：正文是空的`);
      continue;
    }
    const used = usage.get(id) ?? { count: 0, count30: 0, lastUsedAt: null };
    const stat = statSync(file);
    prompts.push({
      id,
      category,
      file,
      ...parsed,
      useCount: used.count,
      useCount30: used.count30,
      lastUsedAt: used.lastUsedAt,
      addedAt: (stat.birthtime?.valueOf() ? stat.birthtime : stat.mtime).toISOString(),
      starred: starred.get(id) ?? false,
    });
  }
  const order = readCategoryOrder(dir);
  // 排序：拖动定下的顺序（_排序.md）优先；没列出的按分类顺序、再按名字排在后面。
  const manual = readManualOrder(dir);
  const manualIndex = new Map(manual.map((id, index) => [id, index]));
  const categoryIndex = new Map(order.map((row, index) => [row.name, index]));
  prompts.sort((a, b) => {
    const ma = manualIndex.get(a.id);
    const mb = manualIndex.get(b.id);
    if (ma !== undefined || mb !== undefined) {
      if (ma === undefined) return 1;
      if (mb === undefined) return -1;
      return ma - mb;
    }
    const ca = categoryIndex.get(a.category) ?? 999;
    const cb = categoryIndex.get(b.category) ?? 999;
    return ca - cb || a.title.localeCompare(b.title, "zh");
  });
  const counts = new Map();
  for (const prompt of prompts) counts.set(prompt.category, (counts.get(prompt.category) ?? 0) + 1);
  const categories = order
    .filter((row) => counts.has(row.name))
    .map((row) => ({ name: row.name, note: row.note, count: counts.get(row.name) }));
  for (const name of [...counts.keys()].sort((a, b) => a.localeCompare(b, "zh"))) {
    if (!categories.some((row) => row.name === name)) categories.push({ name, note: "", count: counts.get(name) });
  }
  return {
    dir,
    eventsFile,
    categoryOrderFile: path.join(dir, CATEGORY_ORDER_FILE),
    manualOrderFile: path.join(dir, MANUAL_ORDER_FILE),
    formatFile: path.join(dir, "_格式说明.md"),
    manualOrdered: manual.length,
    prompts,
    categories,
    totalPrompts: prompts.length,
    totalCopies: events.filter((event) => event.event_type === "prompt_copied").length,
    totalStarred: prompts.filter((row) => row.starred).length,
    issues,
  };
}

function appendEvent(eventsFile, event, key) {
  mkdirSync(path.dirname(eventsFile), { recursive: true });
  appendFileSync(eventsFile, JSON.stringify(event) + "\n", { encoding: "utf8", mode: 0o600 });
  const saved = loadPromptEvents(eventsFile).find((row) => row[key] === event[key]);
  if (JSON.stringify(saved) !== JSON.stringify(event)) throw failure("记录写进去以后读回来对不上，请刷新页面看一下。", 503);
  return saved;
}

/** 复制一次就记一次使用。 */
export function recordPromptUse(layout, { id, at = new Date().toISOString() } = {}) {
  checkPromptId(id);
  const library = readPromptLibrary(layout);
  const prompt = library.prompts.find((row) => row.id === id);
  if (!prompt) throw failure("这条提示词已经不在文件夹里了，请刷新页面后再复制。", 404);
  if (Number.isNaN(new Date(at).valueOf())) throw failure("使用时间不对");
  const event = { schema_version: 1, event_type: "prompt_copied", usage_id: `${id}@${at}`, prompt_id: id, title: prompt.title, at, source: SOURCE };
  const saved = appendEvent(layout.eventsFile, event, "usage_id");
  const after = readPromptLibrary(layout);
  return { created: true, event: saved, prompt: after.prompts.find((row) => row.id === id), library: after };
}

/** 星标就是收藏：和使用记录写在同一份文件里，多两种记录，当前收没收藏看最后一条。 */
export function setPromptStar(layout, { id, starred, at = new Date().toISOString() } = {}) {
  checkPromptId(id);
  if (typeof starred !== "boolean") throw failure("收藏状态只能是 true 或 false");
  if (Number.isNaN(new Date(at).valueOf())) throw failure("操作时间不对");
  const library = readPromptLibrary(layout);
  const prompt = library.prompts.find((row) => row.id === id);
  if (!prompt) throw failure("这条提示词已经不在文件夹里了，请刷新页面后再操作。", 404);
  if (prompt.starred === starred) return { changed: false, prompt, library };
  const event = {
    schema_version: 1,
    event_type: starred ? "prompt_starred" : "prompt_unstarred",
    star_id: `${id}@${at}`,
    prompt_id: id,
    title: prompt.title,
    at,
    source: SOURCE,
  };
  const saved = appendEvent(layout.eventsFile, event, "star_id");
  const after = readPromptLibrary(layout);
  const updated = after.prompts.find((row) => row.id === id);
  if (!updated || updated.starred !== starred) throw failure("收藏状态写进去以后读回来对不上，请刷新页面看一下。", 503);
  return { changed: true, event: saved, prompt: updated, library: after };
}

/** 拖动后保存整份顺序：只接受文件夹里还在的条目，先写临时文件再改名，读回来一致才算成功。 */
export function savePromptOrder(layout, { ids } = {}) {
  if (!Array.isArray(ids) || !ids.length) throw failure("没有收到卡片顺序");
  ids.forEach(checkPromptId);
  const library = readPromptLibrary(layout);
  const known = new Set(library.prompts.map((row) => row.id));
  const unique = [...new Set(ids)];
  const unknown = unique.filter((id) => !known.has(id));
  if (unknown.length) throw failure(`这几条已经不在文件夹里了：${unknown.join("、")}，请刷新页面后再拖。`, 409);
  const file = path.join(layout.dir, MANUAL_ORDER_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, MANUAL_ORDER_HEADER + unique.map((id, index) => `${index + 1}. ${id}`).join("\n") + "\n", "utf8");
  renameSync(tmp, file);
  const saved = readManualOrder(layout.dir);
  if (JSON.stringify(saved) !== JSON.stringify(unique)) throw failure("顺序写进去以后读回来对不上，请刷新页面看一下。", 503);
  return { saved: true, ids: saved, library: readPromptLibrary(layout) };
}

function localDateKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 删除 = 挪进回收站，文件名改成「日期_提示词-分类-文件名.md」，再记一条 prompt_deleted。先全部核对，再动文件。 */
export function trashPrompts(layout, { ids, at = new Date() } = {}) {
  if (!Array.isArray(ids) || !ids.length) throw failure("没有说要删除哪几条");
  if (ids.length > 50) throw failure("一次最多删除 50 条");
  ids.forEach(checkPromptId);
  const unique = [...new Set(ids)];
  const library = readPromptLibrary(layout);
  const targets = unique.map((id) => {
    const prompt = library.prompts.find((row) => row.id === id);
    if (!prompt) throw failure(`「${id}」已经不在文件夹里了，请刷新页面后再操作。`, 404);
    return prompt;
  });
  mkdirSync(layout.trashDir, { recursive: true });
  const stamp = at instanceof Date ? at : new Date(at);
  const day = localDateKey(stamp);
  const moved = [];
  for (const prompt of targets) {
    const base = `${day}_提示词-${prompt.category}-${path.basename(prompt.file, ".md")}`;
    let dest = path.join(layout.trashDir, `${base}.md`);
    for (let n = 2; existsSync(dest); n += 1) dest = path.join(layout.trashDir, `${base}-${n}.md`);
    renameSync(prompt.file, dest);
    if (existsSync(prompt.file) || !existsSync(dest)) throw failure(`「${prompt.title}」挪进回收站以后核对失败，请到提示词文件夹和回收站里看一下。`, 503);
    appendEvent(
      layout.eventsFile,
      { schema_version: 1, event_type: "prompt_deleted", delete_id: `${prompt.id}@${stamp.toISOString()}`, prompt_id: prompt.id, title: prompt.title, at: stamp.toISOString(), trash_path: dest, source: SOURCE },
      "delete_id",
    );
    moved.push({ id: prompt.id, title: prompt.title, trashPath: dest });
  }
  const after = readPromptLibrary(layout);
  if (after.prompts.some((row) => unique.includes(row.id))) throw failure("删除以后还能读到这几条，请刷新页面看一下。", 503);
  return { deleted: moved, trashDir: layout.trashDir, library: after };
}
