// 加选题：编号怎么排、往选题总览哪一格加、选题卡怎么写。scripts/add-topic.mjs 调这里（写稿 Skill「加选题」用它）。
// 编号 = 选题总览的表格里、选题库的文件名里、内容草稿的文件夹名里出现过的最大编号加一：
// 作废了、从总览里删掉的编号也不再给别的选题（工作文件夹 AGENTS.md「T 编号」）。总览开头那几行说明里的 T001 不算。
// 选题总览只往对应类型的「待做」表末尾加一行，别的行一个字不动；这一行按那张表自己的表头填（用户挪过、加过列也对得上）。
// 读法和工作台一样（lib/works.mjs 的 parseOverview）：「### 口播」和「### 口 播」算同一类，「**待做**」下面第一张表就是待做表。
import { readdirSync } from "node:fs";
import path from "node:path";
import { TABLE_HEAD } from "./templates.mjs";

const norm = (text) => String(text ?? "").replace(/\s+/g, "");

export function idOf(number) {
  return `T${String(number).padStart(3, "0")}`;
}

function numberAtStart(name) {
  const match = String(name).match(/^T(\d{3,4})(?!\d)/);
  return match ? Number(match[1]) : 0;
}

/** 文件夹里（往下 depth 层）以编号开头的文件和文件夹名 */
export function namesIn(dir, depth = 2) {
  const names = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (numberAtStart(entry.name)) names.push(entry.name);
    if (entry.isDirectory() && depth > 1) names.push(...namesIn(path.join(dir, entry.name), depth - 1));
  }
  return names;
}

/** 用过的最大编号：选题总览里表格行上的、选题库里文件名开头的、内容草稿里文件夹名开头的 */
export function maxUsedNumber({ overview = "", names = [] } = {}) {
  let max = 0;
  for (const line of String(overview).split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    for (const match of line.matchAll(/T(\d{3,4})(?!\d)/g)) max = Math.max(max, Number(match[1]));
  }
  for (const name of names) max = Math.max(max, numberAtStart(name));
  return max;
}

/** 选题名：去掉开头误带的编号，换行和多余空格合成一个空格 */
export function cleanTitle(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^T\d{3,4}(?!\d)[\s:：、._-]*/, "")
    .trim();
}

// 表格里的一格：竖线转义（工作台读表时认 \|），换行合成空格
const cell = (value) => String(value ?? "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");

function splitRow(line) {
  const parts = line.trim().replace(/\\\|/g, "\u0000").split("|");
  if (parts[0].trim() === "") parts.shift();
  if (parts.length && parts.at(-1).trim() === "") parts.pop();
  return parts.map((part) => part.replace(/\u0000/g, "|").trim());
}

const isSeparator = (cells) => cells.length > 0 && cells.every((part) => /^:?-+:?$/.test(part));

/** 按表头排一行：编号、选题、来源、状态四列填上，别的列空着 */
export function rowFor(header, { id, title, source, status = "待写" }) {
  if (!header.includes("编号")) throw Object.assign(new Error("这张表没有「编号」这一列，工作台认不出来"), { code: "BAD_TABLE" });
  const value = { 编号: id, 选题: title, 来源: source, 状态: status };
  return `| ${header.map((name) => cell(value[name] ?? "")).join(" | ")} |`;
}

/**
 * 在选题总览里，给某一类的「待做」表末尾加一行，返回新的全文。
 * 这一类还没有「### 类型」一节、或者这一节里还没有「**待做**」表时，照新建总览时的样子补上（工作台的读法认得）。
 */
export function addOverviewRow(markdown, type, topic) {
  const eol = String(markdown).includes("\r\n") ? "\r\n" : "\n";
  const lines = String(markdown).split(/\r?\n/);
  const head = TABLE_HEAD.split("\n");
  const headCells = splitRow(head[0]);

  const start = lines.findIndex((line) => /^##\s+选题总表/.test(line.trim()));
  if (start < 0) throw Object.assign(new Error("选题总览里找不到「## 选题总表」这一节"), { code: "BAD_OVERVIEW" });
  let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line.trim()));
  if (end < 0) end = lines.length;

  const typeAt = lines.findIndex((line, i) => i > start && i < end && line.trim().startsWith("### ") && norm(line.trim().slice(4)) === norm(type));
  if (typeAt < 0) {
    // 没有这一类：加在「选题总表」这一节最后（下一节前面），前后各空一行
    let at = end;
    while (at > start + 1 && lines[at - 1].trim() === "") at--;
    const block = ["", `### ${type}`, "", "**待做**", "", ...head, rowFor(headCells, topic), "", "**已做**", "", ...head];
    if (at < lines.length) block.push("");
    lines.splice(at, 0, ...block);
    return lines.join(eol);
  }

  let typeEnd = lines.findIndex((line, i) => i > typeAt && /^#{2,3}\s/.test(line.trim()));
  if (typeEnd < 0 || typeEnd > end) typeEnd = end;
  const todoAt = lines.findIndex((line, i) => i > typeAt && i < typeEnd && /^\*\*待做\*\*/.test(line.trim()));
  if (todoAt < 0) {
    // 这一类下面没有「待做」：紧接着「### 类型」补一张
    lines.splice(typeAt + 1, 0, "", "**待做**", "", ...head, rowFor(headCells, topic));
    return lines.join(eol);
  }

  // 「**待做**」下面第一张表（到「**已做**」或这一类结束为止）：表头是第一行不是分隔线的「|」行
  let header = null;
  let last = -1;
  for (let i = todoAt + 1; i < typeEnd; i++) {
    const text = lines[i].trim();
    if (/^\*\*(已做|待做)\*\*/.test(text)) break;
    if (!text.startsWith("|")) {
      if (header) break;
      continue;
    }
    const cells = splitRow(text);
    if (!header) {
      if (isSeparator(cells)) continue;
      header = cells;
    }
    last = i;
  }
  if (!header) {
    lines.splice(todoAt + 1, 0, "", ...head, rowFor(headCells, topic));
    return lines.join(eol);
  }
  lines.splice(last + 1, 0, rowFor(header, topic));
  return lines.join(eol);
}

/** 选题卡的文件名：编号_选题名.md，去掉文件名里不能有的字，太长截到 40 个字 */
export function cardFileName(id, title) {
  const name = [...String(title ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim()]
    .slice(0, 40)
    .join("")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return `${id}_${name || "选题"}.md`;
}

/** 选题卡：格式和工作文件夹 AGENTS.md「选题卡的格式」一样；原话整段放进备注，不改字 */
export function cardText({ id, title, source, audience = "", problem = "", approach = "", note = "" }) {
  const one = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const lines = [
    `# ${id} ${title}`,
    "",
    `- **来源**：${one(source)}`,
    "- **状态**：待写",
    "- **发布日期**：",
    "- **效果**：",
    "",
    "## 选题内容",
    "",
    `- **写给谁**：${one(audience)}`,
    `- **解决什么问题**：${one(problem)}`,
    `- **大概怎么讲**：${one(approach)}`,
  ];
  const said = String(note ?? "").trim();
  if (said) lines.push("", "## 备注", "", "加这条选题时的原话：", "", ...said.split(/\r?\n/).map((line) => (line.trim() ? `> ${line}` : ">")));
  return `${lines.join("\n")}\n`;
}
