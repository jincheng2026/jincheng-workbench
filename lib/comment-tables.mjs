// 评论表：社媒助手导出的 Excel（.xlsx）、CSV、TSV，也收 JSON。
// 工作台只做两件事：认一下是不是评论表（按表头认出「评论内容」那一列），数一数有几条评论、来自几条笔记或视频；
// 拖进页面的表认出来了才存进「市场调研/评论导入/」。分析评论是调研 Skill 的事，这里不碰评论内容本身。
// 只用 Node 自带的模块：.xlsx 是一个 zip 包，用 zlib 解开里面的 XML，再用正则取单元格。
import { inflateRawSync } from "node:zlib";

export const MAX_TABLE_BYTES = 50 * 1024 * 1024;
const MAX_XML_BYTES = 300 * 1024 * 1024; // 解压后的上限，防止压缩炸弹

function fail(message, statusCode = 400, code = undefined) {
  return Object.assign(new Error(message), { statusCode, code });
}

// —— 解 zip ——————————————————————————————

function zipEntries(buf) {
  const minEnd = Math.max(0, buf.length - 22 - 65535);
  let end = -1;
  for (let i = buf.length - 22; i >= minEnd; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw fail("这个文件不是完整的 Excel 表（.xlsx），可能没下载完。重新导出一次再试。", 422, "not-xlsx");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    entries.set(name, { method, compressed, size, local });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buf, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  if (entry.compressed === 0xffffffff || entry.size === 0xffffffff) throw fail("这份表太大了，请分成几份导出。", 413, "too-big");
  if (entry.local + 30 > buf.length || buf.readUInt32LE(entry.local) !== 0x04034b50) return null;
  const start = entry.local + 30 + buf.readUInt16LE(entry.local + 26) + buf.readUInt16LE(entry.local + 28);
  const data = buf.subarray(start, start + entry.compressed);
  if (entry.method === 0) return data.toString("utf8");
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES }).toString("utf8");
  return null;
}

// —— 读 .xlsx 的第一张表 ——————————————————————————————

function xmlText(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (all, code) => {
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "amp") return "&";
    if (code === "quot") return '"';
    if (code === "apos") return "'";
    const n = code[1] === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : all;
  });
}

/** <si>、<is> 里的文字：所有 <t> 连起来（去掉日文注音 <rPh>） */
function runText(xml) {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let text = "";
  for (const match of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += match[1];
  return xmlText(text);
}

function columnIndex(ref) {
  const letters = String(ref ?? "").match(/^[A-Z]+/)?.[0];
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function firstSheetPath(buf, entries) {
  const workbook = zipRead(buf, entries, "xl/workbook.xml");
  const rels = zipRead(buf, entries, "xl/_rels/workbook.xml.rels");
  const sheetTag = workbook?.match(/<sheet\b[^>]*>/)?.[0];
  const rid = sheetTag?.match(/\br:id="([^"]+)"/)?.[1] ?? sheetTag?.match(/\b[A-Za-z]+:id="([^"]+)"/)?.[1];
  if (rid && rels) {
    for (const rel of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (rel[0].match(/\bId="([^"]+)"/)?.[1] !== rid) continue;
      const target = rel[0].match(/\bTarget="([^"]+)"/)?.[1];
      if (target) return target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    }
  }
  return [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()[0] ?? null;
}

function* xlsxRows(buf) {
  const entries = zipEntries(buf);
  const sheetPath = firstSheetPath(buf, entries);
  const sheet = sheetPath ? zipRead(buf, entries, sheetPath) : null;
  if (!sheet) throw fail("这份 Excel 表里没找到工作表。重新导出一次再试。", 422, "no-sheet");
  const shared = [];
  const sst = zipRead(buf, entries, "xl/sharedStrings.xml");
  if (sst) for (const si of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(si[1] ? runText(si[1]) : "");
  // 空行可能写成 <row r="5"/>，要单独认，不然会把下一行吞进来
  for (const row of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = [];
    let next = 0;
    for (const cell of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1];
      const ref = attrs.match(/\br="([A-Z]+)\d*"/)?.[1];
      const index = ref ? columnIndex(ref) : next;
      next = index + 1;
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? "n";
      const inner = cell[2] ?? "";
      let value = "";
      if (type === "inlineStr") value = runText(inner.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1] ?? "");
      else {
        const raw = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
        if (raw !== undefined) value = type === "s" ? (shared[Number(raw)] ?? "") : xmlText(raw);
      }
      cells[index] = value;
    }
    yield Array.from(cells, (v) => v ?? "");
  }
}

// —— 读 CSV、TSV ——————————————————————————————

/** 按开头的标记认 UTF-8、UTF-16；没有标记时先当 UTF-8，不是合法 UTF-8 再按 GB18030（Excel 存的中文 CSV 常见） */
export function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
}

function guessDelimiter(text) {
  const firstLine = text.slice(0, Math.max(0, text.indexOf("\n")) || 2000);
  const count = (ch) => firstLine.split(ch).length - 1;
  return count("\t") > count(",") ? "\t" : ",";
}

/** 按 RFC 4180 切：双引号包住的字段里可以有分隔符、换行，两个双引号是一个双引号 */
export function* delimitedRows(text, delimiter) {
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      yield row;
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    yield row;
  }
}

// —— 读 JSON ——————————————————————————————

function* jsonRows(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw fail("这个 JSON 文件写坏了，读不出来。重新导出一次再试。", 422, "bad-json");
  }
  const list = Array.isArray(data)
    ? data
    : Object.values(data ?? {}).find((value) => Array.isArray(value) && value.some((item) => item && typeof item === "object")) ?? [];
  const objects = list.filter((item) => item && typeof item === "object" && !Array.isArray(item));
  const headers = [...new Set(objects.slice(0, 200).flatMap((item) => Object.keys(item)))];
  yield headers;
  for (const item of objects) {
    yield headers.map((key) => {
      const value = item[key];
      return value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    });
  }
}

/** 一份表的每一行（字符串数组）。ext 是带点的小写扩展名。 */
export function tableRows(buf, ext) {
  if (ext === ".xlsx") return xlsxRows(buf);
  if (ext === ".xls") throw fail("这是老版 Excel（.xls），读不了。在 Excel 或 Numbers 里另存为 .xlsx 或 CSV，再拖进来。", 415, "old-xls");
  const text = decodeText(buf);
  if (ext === ".json") return jsonRows(text);
  if (ext === ".tsv") return delimitedRows(text, "\t");
  if (ext === ".csv" || ext === ".txt") return delimitedRows(text, guessDelimiter(text));
  throw fail("只收 Excel（.xlsx）、CSV、TSV 和 JSON 文件。", 415, "bad-type");
}

// —— 认评论表 ——————————————————————————————

const norm = (text) => String(text ?? "").replace(/[\s_\-·]/g, "").toLowerCase();

// 评论内容那一列：社媒助手导出的叫「评论内容」；用户改过字段名时退而求其次。「一级评论内容」「引用的评论内容」是别的评论，不算。
function contentScore(header) {
  const h = norm(header);
  if (!h || /^(一级|引用|父|上级|被回复|回复的)/.test(h)) return 0;
  if (h === "评论内容" || h === "评论正文" || h === "commentcontent" || h === "commenttext") return 4;
  if (h === "评论" || h === "评论文本" || h === "comment" || h === "content" || h === "text" || h === "内容") return 3;
  if (h.includes("评论内容") || h.includes("评论文本")) return 2;
  return 0;
}

// 是哪条笔记或视频：ID 和链接优先，没有就用标题
function noteScore(header) {
  const h = norm(header);
  if (!h || /^(评论|用户|一级|引用)/.test(h)) return 0;
  if (/^(笔记|视频|作品)(id|链接|url|地址)$/.test(h) || ["noteid", "awemeid", "videoid", "noteurl", "videourl"].includes(h)) return 3;
  if (/^(笔记|视频|作品)/.test(h) && /(id|链接|url|地址)$/.test(h)) return 2;
  if (/^(笔记|视频|作品)?标题$/.test(h) || h === "title") return 1;
  return 0;
}

function bestColumn(headers, score) {
  let best = -1;
  let bestScore = 0;
  headers.forEach((header, index) => {
    const s = score(header);
    if (s > bestScore) {
      best = index;
      bestScore = s;
    }
  });
  return best;
}

/** 笔记还是视频：先看列名，再看链接 */
function unitOf(header, samples) {
  const h = norm(header);
  if (h.includes("笔记") || h.startsWith("note")) return "笔记";
  if (h.includes("视频") || h.includes("作品") || h.startsWith("aweme") || h.startsWith("video")) return "视频";
  const text = samples.join(" ");
  if (/xiaohongshu\.com|xhslink\.com/.test(text)) return "笔记";
  if (/douyin\.com|iesdouyin\.com/.test(text)) return "视频";
  return "内容";
}

/**
 * 认一份表是不是评论表。返回 { ok, comments, notes, noteKeys, unit, headers, problem }：
 * comments 是有评论内容的行数，notes 是来自几条笔记或视频（表里没有这一列时是 null）。
 */
export function recognizeComments(rows) {
  let headers = null;
  let contentAt = -1;
  let noteAt = -1;
  let seen = 0;
  let comments = 0;
  const noteKeys = new Set();
  const samples = [];
  let firstRow = null;
  for (const row of rows) {
    if (!headers) {
      seen += 1;
      if (!firstRow && row.some((cell) => String(cell).trim())) firstRow = row;
      const at = bestColumn(row, contentScore);
      if (at >= 0) {
        headers = row.map((cell) => String(cell ?? "").trim());
        contentAt = at;
        noteAt = bestColumn(headers, noteScore);
      } else if (seen >= 10) break;
      continue;
    }
    const content = String(row[contentAt] ?? "").trim();
    if (!content) continue;
    comments += 1;
    if (noteAt >= 0) {
      const key = String(row[noteAt] ?? "").trim();
      if (key) {
        noteKeys.add(key);
        if (samples.length < 20) samples.push(key);
      }
    }
  }
  if (!headers) {
    const seenHeaders = (firstRow ?? []).map((cell) => String(cell).trim()).filter(Boolean).slice(0, 8);
    return {
      ok: false,
      comments: 0,
      notes: null,
      noteKeys,
      unit: null,
      headers: seenHeaders,
      problem: `没认出评论那一列：表头里要有「评论内容」这样的列名${seenHeaders.length ? `，这份表的表头是「${seenHeaders.join("、")}」` : "，这份表是空的"}。`,
    };
  }
  if (comments === 0) {
    return { ok: false, comments: 0, notes: null, noteKeys, unit: null, headers, problem: "表头认出来了，但表里一条评论都没有。" };
  }
  return {
    ok: true,
    comments,
    notes: noteAt >= 0 ? noteKeys.size : null,
    noteKeys,
    unit: noteAt >= 0 ? unitOf(headers[noteAt], samples) : null,
    headers,
    problem: null,
  };
}

/** 读一份表并认一下。出错（读不了、太大）时抛出带中文原因的错误。 */
export function inspectCommentTable(buf, ext) {
  if (buf.length > MAX_TABLE_BYTES) throw fail("这份表超过 50 MB 了，请分成几份导出。", 413, "too-big");
  try {
    return recognizeComments(tableRows(buf, ext));
  } catch (error) {
    if (error?.statusCode) throw error;
    if (error?.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|buffer/i.test(String(error?.message))) {
      throw fail("这份表解开以后太大了，请分成几份导出。", 413, "too-big");
    }
    throw fail("这份表读不出来，可能文件坏了。重新导出一次再试。", 422, "unreadable");
  }
}
