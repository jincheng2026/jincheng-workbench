// 「内容」栏：一条 T 编号一张卡，全部从文件现算，不另存任何状态。
// 读三样东西：选题总览（一张表）、选题卡（选题库/<类型>/<待做|已做>/T001_*.md，也认直接放在 <类型>/ 下的）、
// 草稿文件夹（内容草稿/T001_*，按编号前缀认，文件夹名和选题卡名不一样也没关系）。
// 新文件放进草稿文件夹就自动出现，不需要登记。
// 草稿文件夹里的创作页（写稿 Skill 生成的 T001_创作页.html，页面数据里写着这条内容的编号）单独认出来，给出页面链接。
// 文件在接口里用「位置:相对路径」表示，比如 topics:教程/待做/T001_示例选题.md、drafts:T001_示例/工作稿.md，
// 这样选题库和内容草稿可以放在不同的地方。
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { displayPath } from "./config.mjs";
import { coverSummary, isCoverEntry } from "./cover-files.mjs";
import { creationUrl, inspectCreationPage } from "./creation.mjs";
import { readFileSyncWithRetry } from "./resilient-read.mjs";

const GROUPS = ["已做", "待做"];
const WORK_ID = /^T\d{3,4}$/;
const DAY = 86_400_000;
const RECENT_DAYS = 14;
// 草稿文件夹最多往下看三层；「版本」文件夹只数个数；制作过程里堆出来的目录只数个数不列出。
const MAX_DEPTH = 3;
const BULK_DIR = /^(?:制作记录|render-temp|_shots)$|^draft_[0-9a-f]+_folder$/;
// 一个子文件夹里的文件超过这么多，按中间产物处理（同样只数个数），不在页面上堆一长串。
const BULK_LIMIT = 24;
const TEXT_LIMIT = 2 * 1024 * 1024;
const TEXT_KINDS = new Set(["teleprompter", "final", "draft", "log", "doc"]);
// 稿子本身（不含改稿日志和其他文档）；创作页里就是稿子
const SCRIPT_KINDS = new Set(["teleprompter", "final", "draft", "creation"]);
// 「接着写」从这些文件里挑最近改过的一份
const RESUME_KINDS = new Set(["draft", "final", "teleprompter", "doc"]);
// 标了 ✅ 却还没发布时，选题卡状态里出现这些字眼就提醒核对
const WAITING_WORDS = /待录制|待交付|待写|待[^\s，。；、,;（）()]{0,4}?审稿?/;
const TEXT_EXT = new Set([".md", ".txt"]);
const MEDIA_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic", ".bmp", ".tif", ".tiff",
  ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi",
  ".wav", ".mp3", ".m4a", ".aac", ".flac", ".aiff", ".ogg",
]);
// 常见文档：列出来，可以用默认程序打开
const DOC_EXT = new Set([".pdf", ".doc", ".docx", ".pages", ".key", ".ppt", ".pptx", ".xls", ".xlsx", ".numbers", ".rtf", ".csv"]);

function fail(message, statusCode = 400, code = undefined) {
  return Object.assign(new Error(message), { statusCode, code });
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function idOf(number) {
  return `T${String(number).padStart(3, "0")}`;
}

/**
 * 设置里的路径整理成「内容」栏要用的几样：选题库、选题总览、内容草稿、内容类型，
 * 还有创作页保存服务这次实际用的端口（pnpm start 挑好后告诉接口；没给就用设置里的）。
 */
export function worksLayout(config, { savePort } = {}) {
  return {
    topicsDir: config.paths.topics,
    overviewFile: config.paths.overview,
    draftsDir: config.paths.drafts,
    workFolder: config.workFolder,
    types: [...config.contentTypes],
    home: config.home,
    savePort: savePort ?? config.ports.save,
  };
}

// —— 文本小工具 ——————————————————————————————

// Markdown 表格行按没转义的竖线切开；[[T001_xxx\|T001]] 里的 \| 不是分隔符。
function splitRow(line) {
  const parts = line.trim().replace(/\\\|/g, "\u0000").split("|");
  if (parts[0].trim() === "") parts.shift();
  if (parts.length && parts.at(-1).trim() === "") parts.pop();
  return parts.map((cell) => cell.replace(/\u0000/g, "|").trim());
}

// 去掉 Markdown 和双中括号链接的写法，只留读得懂的文字。
function plain(text) {
  return String(text ?? "")
    .replace(/\\\|/g, "|")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]\n]*)\]\(<[^>\n]*>\)/g, "$1")
    .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function withoutMark(text) {
  return String(text ?? "").replace(/✅/g, "").replace(/\s+/g, " ").trim();
}

// 去掉括号里的说明（可能有嵌套），标题只留主干。
function withoutBrackets(text) {
  let value = String(text ?? "");
  for (let previous = ""; previous !== value;) {
    previous = value;
    value = value.replace(/\s*[（(][^（）()]*[）)]/g, "");
  }
  return value.trim();
}

// 截到 limit 字以内最后一个「。」或「；」，不从句子中间切断；没有句号分号才退到逗号，再没有才硬切。
function clipSentence(text, limit) {
  const chars = [...text];
  if (chars.length <= limit) return text;
  const head = chars.slice(0, limit).join("");
  for (const marks of [/[。；;]/g, /[，,]/g]) {
    const cut = [...head.matchAll(marks)].at(-1)?.index ?? -1;
    if (cut > 0) return `${head.slice(0, cut)}…`;
  }
  return `${head}…`;
}

function statusWord(value) {
  return String(value ?? "").match(/已发布|草稿|待写/)?.[0] ?? null;
}

function dateOnly(value) {
  return String(value ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

// 对应选题里的编号，含 T001—T004 这类区间；括号里的说明（如「T003 已作废」）不算。
function idsIn(text) {
  const ids = new Set();
  const clean = withoutBrackets(plain(text));
  for (const match of clean.matchAll(/T(\d{3,4})(?!\d)(?:\s*[—–~～至-]+\s*T(\d{3,4})(?!\d))?/g)) {
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    if (to >= from && to - from <= 50) {
      for (let n = from; n <= to; n++) ids.add(idOf(n));
    } else {
      ids.add(idOf(from));
    }
  }
  return [...ids];
}

const normType = (name) => String(name ?? "").replace(/\s+/g, "");

function localDay(time) {
  return Math.floor((time - new Date(time).getTimezoneOffset() * 60_000) / DAY);
}

function agoText(time, now) {
  const days = localDay(now) - localDay(time);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  return `${days} 天前`;
}

// —— 路径 ——————————————————————————————

const ROOT_KEYS = { topics: "topicsDir", drafts: "draftsDir" };

function toRef(root, relative) {
  return `${root}:${relative}`;
}

function parseRef(ref) {
  const match = typeof ref === "string" ? ref.match(/^(topics|drafts):(.+)$/s) : null;
  if (!match) throw fail("没看懂要打开的是哪个文件。", 400);
  return { root: match[1], relative: match[2] };
}

// 只接受相对路径；消解软链接之后必须还在这个文件夹里面，也不进以点开头的隐藏文件夹。
function resolveInside(base, relative, { directory = false, any = false } = {}) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\\") ||
      relative.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw fail("这个路径不在工作文件夹里。", 400);
  }
  let realBase;
  let target;
  try {
    realBase = realpathSync(base);
    target = realpathSync(path.join(realBase, relative));
  } catch {
    throw fail("找不到这个文件，可能已经被移走或删除。", 404);
  }
  const inner = path.relative(realBase, target);
  if (!inner || inner.startsWith("..") || path.isAbsolute(inner) || inner.split(path.sep).some((part) => part.startsWith("."))) {
    throw fail("这个路径不在工作文件夹里。", 403);
  }
  const stat = statSync(target);
  if (!any && (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw fail(directory ? "这不是文件夹。" : "这不是文件。", 400);
  }
  return target;
}

function resolveRef(layout, ref, options) {
  const { root, relative } = parseRef(ref);
  return resolveInside(layout[ROOT_KEYS[root]], relative, options);
}

// —— 选题总览 ——————————————————————————————

/** 读选题总览。types 是设置里的内容类型；「### AI 教程」和「AI教程」算同一类（空格不算）。 */
export function parseOverview(markdown, types) {
  const rows = new Map();
  const plans = new Map();
  const deferred = new Map();
  const unknownTypes = new Map();
  let schedule = null;
  let section = "";
  let type = null;
  let unknown = null;
  let group = null;
  let header = null;
  const typeOf = (name) => types.find((item) => normType(item) === normType(name)) ?? null;
  for (const raw of String(markdown).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      [type, unknown, group, header] = [null, null, null, null];
      continue;
    }
    if (line.startsWith("### ")) {
      const name = line.slice(4).trim();
      type = typeOf(name);
      unknown = type ? null : name;
      group = null;
      header = null;
      continue;
    }
    const mark = line.match(/^\*\*(已做|待做)\*\*/);
    if (mark) {
      group = mark[1];
      header = null;
      continue;
    }
    if (!line.startsWith("|")) {
      header = null;
      continue;
    }
    const cells = splitRow(line);
    if (cells.length && cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (!header) {
      header = cells;
      continue;
    }
    const col = (name) => {
      const index = header.indexOf(name);
      return index >= 0 ? cells[index] ?? "" : "";
    };
    if (section.startsWith("选题总表")) {
      const id = col("编号").match(/T\d{3,4}(?!\d)/)?.[0];
      if (!id) continue;
      if (!type) {
        // 写在设置里没有的类型下面（或者没写在任何类型下面）的行：不显示，但要告诉用户
        const key = unknown ?? "";
        unknownTypes.set(key, (unknownTypes.get(key) ?? 0) + 1);
        continue;
      }
      if (rows.has(id)) {
        rows.get(id).duplicate = true;
        continue;
      }
      const summary = col("选题");
      rows.set(id, {
        id, type, group, summary,
        source: col("来源"), status: col("状态"), publishDate: col("发布日期"), effect: col("效果"),
        recorded: summary.includes("✅") || col("编号").includes("✅"),
      });
    } else if (section.startsWith("近三天内容安排")) {
      // 表按时间顺序往下写，后面的行盖过前面的：留最后一次提到这个编号的安排。
      const ids = idsIn(col("对应选题"));
      for (const id of ids) plans.set(id, { date: plain(col("日期")), text: plain(col("安排")) });
      // 拍摄顺序：最后一次在「安排」里写了「顺序」的那一行，按「对应选题」列的先后排
      if (/顺序/.test(col("安排")) && ids.length) schedule = { date: plain(col("日期")), ids, text: clipSentence(plain(col("安排")), 120) };
    } else if (section.startsWith("顺延事项")) {
      for (const id of idsIn(col("对应选题"))) deferred.set(id, { text: plain(col("安排")), date: plain(col("新日期")) });
    }
  }
  return { rows, plans, deferred, schedule, unknownTypes };
}

function addCards(index, layout, type, group) {
  const relDir = group ? `${type}/${group}` : type;
  for (const entry of safeReaddir(path.join(layout.topicsDir, relDir))) {
    if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".md")) continue;
    const id = entry.name.match(/^(T\d{3,4})(?!\d)/)?.[1];
    if (id) push(index.cards, id, { relative: `${relDir}/${entry.name}`, type, group, name: entry.name });
  }
}

function loadIndex(layout) {
  let markdown;
  try {
    markdown = readFileSyncWithRetry(layout.overviewFile, "utf8");
  } catch {
    throw fail(`找不到选题总览：${displayPath(layout.overviewFile, layout.home)}`, 503, "overview-missing");
  }
  const index = { ...parseOverview(markdown, layout.types), cards: new Map(), drafts: new Map() };
  for (const type of layout.types) {
    addCards(index, layout, type, null);
    for (const group of GROUPS) addCards(index, layout, type, group);
  }
  // 草稿文件夹只按编号前缀认：文件夹名和选题卡名不一样是正常的。
  for (const entry of safeReaddir(layout.draftsDir)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const id = entry.name.match(/^(T\d{3,4})(?:_|$)/)?.[1];
    if (id) push(index.drafts, id, entry.name);
  }
  for (const list of index.drafts.values()) list.sort((a, b) => a.localeCompare(b, "zh"));
  return index;
}

// —— 选题卡 ——————————————————————————————

function readCard(layout, found) {
  const file = path.join(layout.topicsDir, found.relative);
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const heading = lines.find((line) => /^#\s/.test(line))?.replace(/^#\s+/, "").trim() ?? "";
  const fields = {};
  for (const line of lines) {
    if (/^##\s/.test(line)) break;
    const match = line.match(/^\s*[-*]\s+\*\*([^*]+?)\*\*\s*[：:]\s*(.*)$/);
    if (match && !(match[1].trim() in fields)) fields[match[1].trim()] = match[2].trim();
  }
  return {
    ...found,
    fields,
    title: withoutMark(heading.replace(/^T\d{3,4}(?!\d)\s*/, "")),
    recorded: heading.includes("✅") || found.name.includes("✅"),
    mtime: statSync(file).mtimeMs,
  };
}

// —— 草稿文件夹 ——————————————————————————————

// 参考材料：「参考素材」文件夹里的东西（别人的稿、参考视频）和「参考拆解」（拆别人的笔记）。
// 改了不算这条内容开始写（不进「草稿 14 天内有改动」和最近改动的时间），也不当「接着写」的稿子。
function isReference(relative) {
  return relative.split("/").includes("参考素材") || path.basename(relative).includes("参考拆解");
}

function classify(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  if (MEDIA_EXT.has(ext)) return "media";
  if (TEXT_EXT.has(ext)) {
    if (name.includes("提词器")) return "teleprompter";
    if (name.includes("定稿修改痕迹")) return "doc";
    if (/定稿|最终稿|最终发布稿|录制版/.test(name)) return "final";
    if (name.includes("改稿日志")) return "log";
    if (/工作稿|初稿|逐字稿/.test(name)) return "draft";
    return "doc";
  }
  if (DOC_EXT.has(ext)) return "file";
  // 脚本、数据和其他格式不列出来
  return null;
}

function scanDraft(layout, dirName) {
  const result = { files: [], versions: 0, media: 0, latest: 0 };
  const id = dirName.match(/^(T\d{3,4})/)?.[1] ?? null;
  const versionTexts = [];
  const walk = (relative, depth, mode) => {
    const listed = [];
    const entries = safeReaddir(path.join(layout.draftsDir, relative)).sort((a, b) => a.name.localeCompare(b.name, "zh"));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "__pycache__" || entry.name === "node_modules") continue;
      // 封面候选/ 和 封面-选定.*：详情页的「封面」那一块单独显示（lib/covers.mjs），这里不列、不算进「最近有改动」
      if (depth === 0 && isCoverEntry(entry.name, entry.isDirectory())) continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth + 1 >= MAX_DEPTH) continue;
        const childMode = mode !== "list" ? mode : entry.name === "版本" ? "version" : BULK_DIR.test(entry.name) ? "bulk" : "list";
        const inner = walk(child, depth + 1, childMode);
        if (inner.length <= BULK_LIMIT) listed.push(...inner);
        continue;
      }
      // 软链接不跟：草稿文件夹里的东西必须实实在在在这里。
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = statSync(path.join(layout.draftsDir, child));
      } catch {
        continue;
      }
      let kind = classify(entry.name);
      if (!kind) continue;
      // 参考素材文件夹里的逐字稿是别人的稿，不算这条内容的稿子。
      if (SCRIPT_KINDS.has(kind) && child.split("/").includes("参考素材")) kind = "doc";
      // 网页里写着这条内容编号的创作页：单独认出来（版本、批量文件夹里的不算）
      let page = null;
      if (kind === "html" && mode === "list") {
        page = inspectCreationPage(path.join(layout.draftsDir, child));
        if (page && page.contentId === id) kind = "creation";
        else page = null;
      }
      if (!isReference(child)) result.latest = Math.max(result.latest, stat.mtimeMs);
      if (mode === "version") {
        if (/^readme\.md$/i.test(entry.name)) continue;
        result.versions += 1;
        if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) {
          versionTexts.push({ relative: child, name: entry.name, kind: "draft", modifiedAt: new Date(stat.mtimeMs).toISOString(), size: stat.size, latestVersion: true });
        }
        continue;
      }
      if (kind === "media") {
        result.media += 1;
        continue;
      }
      if (mode === "bulk") continue;
      listed.push({ relative: child, name: entry.name, kind, modifiedAt: new Date(stat.mtimeMs).toISOString(), size: stat.size, ...(page ? { pageId: page.pageId, adopted: page.adopted } : {}) });
    }
    return listed;
  };
  result.files = walk(dirName, 0, "list");
  // 草稿文件夹里除了「版本」没有任何稿子：把最新的一份版本拿出来当工作稿列出来，它不再算进历史版本数。
  if (!result.files.some((file) => SCRIPT_KINDS.has(file.kind)) && versionTexts.length) {
    const newest = versionTexts.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))[0];
    result.files.push(newest);
    result.versions -= 1;
  }
  result.files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return result;
}

// —— 组装一张卡 ——————————————————————————————

function pickCard(cards, row) {
  if (!cards.length) return null;
  return cards.find((card) => row && card.type === row.type && card.group === row.group) ?? cards[0];
}

const RESUME_LABEL = { draft: "工作稿", final: "定稿", teleprompter: "提词器版", doc: "文档" };

// 「接着写」打开哪一份：草稿文件夹里最近改过的文字稿（改稿日志不算）
function resumeOf(files) {
  const list = files
    .filter((file) => RESUME_KINDS.has(file.kind) && TEXT_EXT.has(path.extname(file.name).toLowerCase()) && !isReference(file.relative))
    .sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
  if (!list.length) return null;
  const pick = list[0];
  return { kind: pick.kind, label: RESUME_LABEL[pick.kind] ?? "文档", ref: toRef("drafts", pick.relative), name: pick.name, modifiedAt: pick.modifiedAt };
}

function buildWork(layout, index, id, { now, detail }) {
  const number = Number(id.slice(1));
  const row = index.rows.get(id) ?? null;
  const cards = index.cards.get(id) ?? [];
  const found = pickCard(cards, row);
  const card = found ? readCard(layout, found) : null;
  const dirs = index.drafts.get(id) ?? [];
  const draftDir = dirs[0] ?? null;
  const scan = draftDir ? scanDraft(layout, draftDir) : null;

  const rowStatus = statusWord(row?.status);
  // 选题卡「状态」一栏原话（括号里的说明也保留），详情页原样给人看。
  const cardStatusText = plain(card?.fields["状态"]);
  const cardStatus = statusWord(cardStatusText);
  const status = rowStatus ?? cardStatus;
  const statusFrom = rowStatus ? "选题总览" : "选题卡";
  const recorded = Boolean(card?.recorded || row?.recorded);
  const published = status === "已发布";
  const publishDate = dateOnly(row?.publishDate) ?? dateOnly(card?.fields["发布日期"]);
  // 草稿文件夹里已经有稿子，就算在做（从「版本」里拿出来顶替的那份不算）。
  const hasScript = (scan?.files ?? []).some((file) => !file.latestVersion && SCRIPT_KINDS.has(file.kind));
  const done = row?.group === "已做" || recorded || published || (!row && card?.group === "已做");

  let stage;
  let stageReason;
  if (done) {
    stage = "done";
    // ✅ 只说明标题上打了勾，不等于已经发出去，所以不写「已发布」。
    stageReason = published
      ? publishDate ? `已发布 ${publishDate}` : "已发布，日期待确认"
      : recorded ? "标了 ✅，还没发布" : "选题总览：已做";
  } else if (status === "草稿") {
    stage = "doing";
    stageReason = `${statusFrom}：草稿`;
  } else if (scan?.latest && now - scan.latest <= RECENT_DAYS * DAY) {
    stage = "doing";
    const ago = agoText(scan.latest, now);
    stageReason = /^\d/.test(ago) ? `草稿 ${ago}有改动` : `草稿${ago}有改动`;
  } else if (hasScript && status !== "已发布") {
    stage = "doing";
    stageReason = "草稿文件夹里已经有稿子";
  } else {
    stage = "todo";
    stageReason = status ? `${statusFrom}：${status}` : "还没开始写";
  }

  // 只报能从文件确认的对不上的地方，最多三条。
  const issues = [];
  if (!card) issues.push("找不到选题卡");
  if (!row) issues.push("选题总览里没有这个编号");
  if (row?.group === "已做" && rowStatus === "待写") issues.push("在「已做」表里，但状态写的是待写");
  const waiting = recorded && !published ? cardStatusText.match(WAITING_WORDS)?.[0] : null;
  if (waiting && !(waiting === "待写" && issues.includes("在「已做」表里，但状态写的是待写"))) {
    issues.push(`标了 ✅，但选题卡写着「${waiting}」`);
  }
  if (rowStatus && cardStatus && rowStatus !== cardStatus) {
    issues.push(`选题卡的状态是「${cardStatus}」，选题总览里是「${rowStatus}」`);
  }
  if (row && card && card.type !== row.type) issues.push(`选题卡放在「${card.type}」，选题总览列在「${row.type}」`);
  else if (row && card && card.group && row.group && card.group !== row.group) {
    issues.push(`选题卡放在「${card.group}」，选题总览列在「${row.group}」`);
  }
  if (row && card && row.recorded !== card.recorded) {
    issues.push(row.recorded ? "选题总览标了 ✅，选题卡标题没有" : "选题卡标了 ✅，选题总览没有");
  }
  if (row?.duplicate) issues.push("选题总览里这个编号有两行");
  if (cards.length > 1) issues.push(`有 ${cards.length} 张选题卡`);
  if (dirs.length > 1) issues.push(`有 ${dirs.length} 个草稿文件夹，只看了第一个`);

  const files = scan?.files ?? [];
  // 创作页：一条内容只该有一个；有几个时用最近改过的那个，并提醒
  const pages = files.filter((file) => file.kind === "creation").sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  if (pages.length > 1) issues.push(`草稿文件夹里有 ${pages.length} 个创作页，打开的是最近改过的那个`);
  const creation = pages[0]
    ? { ref: toRef("drafts", pages[0].relative), name: pages[0].name, pageId: pages[0].pageId, url: creationUrl(layout.savePort, pages[0].pageId), modifiedAt: pages[0].modifiedAt, adopted: pages[0].adopted ?? 0 }
    : null;
  const effect = plain(row?.effect ?? card?.fields["效果"]);
  const source = plain(row?.source || card?.fields["来源"]);
  const format = plain(card?.fields["形式"]);
  const priority = plain(card?.fields["制作优先级"] ?? card?.fields["计划制作"]);
  const latest = scan?.latest || card?.mtime || 0;

  const work = {
    id,
    number,
    title: card?.title || withoutBrackets(withoutMark(plain(row?.summary))) || id,
    summary: row ? withoutMark(plain(row.summary)) : plain(card?.fields["选题"]) || card?.title || "",
    type: row?.type ?? card?.type,
    stage,
    stageReason,
    overviewStatus: plain(row?.status) || null,
    recorded,
    publishDate,
    effect: effect || null,
    source: source || null,
    format: format || null,
    priority: priority ? clipSentence(priority, 80) : null,
    plan: index.plans.get(id) ?? null,
    deferred: index.deferred.get(id) ?? null,
    card: card ? { ref: toRef("topics", card.relative), name: card.name } : null,
    draftDir: draftDir ? { ref: toRef("drafts", draftDir), name: draftDir } : null,
    lastModified: latest ? new Date(latest).toISOString() : null,
    counts: {
      texts: files.filter((file) => TEXT_KINDS.has(file.kind)).length,
      html: files.filter((file) => file.kind === "html").length,
      files: files.filter((file) => file.kind === "file").length,
      versions: scan?.versions ?? 0,
      media: scan?.media ?? 0,
    },
    issues: issues.slice(0, 3),
    order: index.schedule ? index.schedule.ids.indexOf(id) + 1 || null : null,
    resume: done ? null : resumeOf(files),
    creation,
    cover: coverSummary(layout.draftsDir, draftDir),
  };
  if (!detail) return work;
  return {
    ...work,
    cardStatus: cardStatusText || null,
    files: files.map(({ relative, ...file }) => ({ ...file, ref: toRef("drafts", relative) })),
  };
}

function checkId(id) {
  if (typeof id !== "string" || !WORK_ID.test(id)) throw fail("编号格式不对，应该像 T001 这样。", 400);
}

function notices(layout, index) {
  const list = [];
  for (const [name, count] of index.unknownTypes) {
    list.push(
      name
        ? `选题总览里「### ${name}」下面有 ${count} 条选题，但设置里的内容类型没有「${name}」，这几条没有显示。要显示，就把「${name}」加进设置文件的 contentTypes。`
        : `选题总览的「选题总表」里有 ${count} 行没写在任何「### 类型」下面，没有显示。`,
    );
  }
  const known = new Set([...index.rows.keys(), ...index.cards.keys()]);
  const orphans = [...index.drafts.entries()].filter(([id]) => !known.has(id)).map(([, dirs]) => dirs[0]);
  if (orphans.length) {
    const shown = orphans.slice(0, 5).join("、");
    list.push(`内容草稿里有 ${orphans.length} 个文件夹对不上选题：${shown}${orphans.length > 5 ? " 等" : ""}。在选题总览里加上这些编号就会显示。`);
  }
  return list;
}

// —— 对外接口 ——————————————————————————————

export function readWorks(layout, { now = Date.now() } = {}) {
  const index = loadIndex(layout);
  const ids = [...new Set([...index.rows.keys(), ...index.cards.keys()])]
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)) || a.localeCompare(b));
  return {
    generatedAt: new Date(now).toISOString(),
    types: layout.types,
    works: ids.map((id) => buildWork(layout, index, id, { now, detail: false })),
    // 拍摄顺序（选题总览「近三天内容安排」里最后一次写了顺序的那一行）
    schedule: index.schedule,
    notices: notices(layout, index),
  };
}

export function readWorkDetail(id, layout, { now = Date.now() } = {}) {
  checkId(id);
  const index = loadIndex(layout);
  if (!index.rows.has(id) && !index.cards.has(id)) throw fail(`选题总览和选题库里都没有 ${id}。`, 404);
  return buildWork(layout, index, id, { now, detail: true });
}

// 一键复制：只读这条内容草稿文件夹里列出来的文字稿。
export function readWorkText(id, ref, layout) {
  const detail = readWorkDetail(id, layout);
  const entry = detail.files.find((item) => item.ref === ref);
  if (!entry) throw fail("这个文件不在这条选题的草稿文件夹里。", 403);
  if (!TEXT_KINDS.has(entry.kind) || !TEXT_EXT.has(path.extname(entry.name).toLowerCase())) {
    throw fail("这个文件不是文字稿，不能复制。", 400);
  }
  const target = resolveRef(layout, ref);
  if (statSync(target).size > TEXT_LIMIT) throw fail("这个文件超过 2MB，不能一键复制。", 413);
  return { ref, text: readFileSync(target, "utf8") };
}

// 接着写：用默认程序打开草稿文件夹里最近改过的那份稿子。
export async function resumeWork(id, layout, { opener }) {
  const detail = readWorkDetail(id, layout);
  const r = detail.resume;
  if (!r) throw fail(`${id} 的草稿文件夹里还没有稿子，没有地方接着写。`, 404);
  const file = resolveRef(layout, r.ref);
  const result = await opener.open(file);
  const how = result.how === "text" ? "用「文本编辑」" : "用默认程序";
  return { ok: true, message: `已${how}打开「${r.name}」。`, dryRun: opener.dryRun || undefined };
}

const OPEN_AS = new Set(["default", "finder"]);
// 打开这条内容自己的文件：选题卡、草稿文件夹和里面列出来的文件。
export async function openWorkTarget(id, ref, as, layout, { opener }) {
  if (!OPEN_AS.has(as)) throw fail("不支持这种打开方式。", 400);
  if (typeof ref !== "string" || !ref) throw fail("没有说要打开哪个文件。", 400);
  const detail = readWorkDetail(id, layout);
  const known = new Set([detail.card?.ref, detail.draftDir?.ref, ...detail.files.map((item) => item.ref)].filter(Boolean));
  if (!known.has(ref)) throw fail("这个文件不属于这条选题。", 403);
  const target = resolveRef(layout, ref, { any: true });
  const result = await opener.open(target, { reveal: as === "finder" });
  const message = result.how === "finder" ? "已在访达中打开。" : result.how === "text" ? "已用「文本编辑」打开。" : "已用默认程序打开。";
  return { ok: true, message, dryRun: opener.dryRun || undefined };
}

// 文件夹名里去掉访达和其他程序不认的字符，太长的截短。
function folderTitle(title) {
  const clean = String(title ?? "")
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
  const chars = [...clean];
  return (chars.length > 40 ? chars.slice(0, 40).join("") : clean).trim();
}

/** 给一条选题建草稿文件夹「T001_选题名」。已经有了就直接用已有的那个。 */
export function createDraftFolder(id, layout) {
  const detail = readWorkDetail(id, layout);
  if (detail.draftDir) return { created: false, ref: detail.draftDir.ref, name: detail.draftDir.name };
  const title = folderTitle(detail.title === id ? "" : detail.title);
  const name = title ? `${id}_${title}` : id;
  mkdirSync(layout.draftsDir, { recursive: true });
  try {
    mkdirSync(path.join(layout.draftsDir, name));
  } catch (error) {
    if (error?.code !== "EEXIST") throw fail(`没能建草稿文件夹：${error?.message ?? error}`, 500);
  }
  const after = readWorkDetail(id, layout);
  if (!after.draftDir) throw fail("草稿文件夹建好后没有读到，请到访达里看一下。", 500);
  return { created: true, ref: after.draftDir.ref, name: after.draftDir.name };
}

/** 打开草稿文件夹（给「建草稿文件夹」用：建好或已有就在访达里打开）。 */
export async function openDraftFolder(id, layout, { opener }) {
  const made = createDraftFolder(id, layout);
  const target = resolveRef(layout, made.ref, { directory: true });
  await opener.open(target, { reveal: true });
  return {
    ok: true,
    created: made.created,
    ref: made.ref,
    name: made.name,
    message: made.created ? `建好了草稿文件夹「${made.name}」，已在访达中打开。` : "已在访达中打开草稿文件夹。",
    dryRun: opener.dryRun || undefined,
  };
}
