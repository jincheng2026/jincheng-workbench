// 设置：一个 JSON 文件，放在 ~/Library/Application Support/<id>/config.json。
// 第一次运行时按默认值写出来；之后只读不改。每一项是什么见 docs/配置说明.md。
// 所有路径都从这里来：工作文件夹、选题库、选题总览、内容草稿、写稿方法、市场调研的三个文件夹、提示词、回收站。
// 创作页的 Python 脚本（creation-page/creation_doc.py 的 workbench_settings）也读这个文件，默认值和路径写法两边要一致。
// TikHub 的 key 不在这里：它只存 macOS 钥匙串（lib/tikhub.mjs），设置文件里不记 key。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BRAND } from "./brand.mjs";
import { DEFAULT_PORTS, isUsablePort } from "./ports.mjs";

export const DEFAULT_TYPES = Object.freeze(["教程", "科普", "口播"]);
// 栏目：content 是「内容」（选题、在做），research 是「市场调研」（对标账号、调研报告），prompts 是「提示词」。
// 左边菜单按这里的先后排。以后加栏目先在这里登记。
export const COLUMN_KEYS = Object.freeze(["content", "research", "prompts"]);
// 市场调研的三个文件夹：对标账号、调研报告、评论导入（社媒助手导出的评论放这里）。调研 Skill 也按这三项找文件夹。
export const RESEARCH_PATH_KEYS = Object.freeze(["benchmarkAccounts", "researchReports", "commentImports"]);
const PATH_KEYS = ["topics", "overview", "drafts", "writingMethod", ...RESEARCH_PATH_KEYS, "prompts", "promptUsage", "coverAssets", "trash"];
const KNOWN_KEYS = new Set(["说明", "workFolder", "paths", "contentTypes", "columns", "ports"]);

export function expandHome(value, home = os.homedir()) {
  const text = String(value ?? "").trim();
  if (text === "~") return home;
  if (text.startsWith("~/")) return path.join(home, text.slice(2));
  return text;
}

/** 把本机绝对路径写成 ~/… 的样子，界面和日志里给人看用。 */
export function displayPath(target, home = os.homedir()) {
  const value = String(target ?? "");
  if (value === home) return "~";
  return value.startsWith(home + path.sep) ? `~/${value.slice(home.length + 1)}` : value;
}

/** 设置文件所在的文件夹。环境变量 WORKBENCH_CONFIG_DIR 可以换掉（测试用）。 */
export function configDir(env = process.env, home = os.homedir()) {
  const custom = String(env.WORKBENCH_CONFIG_DIR ?? "").trim();
  return custom ? path.resolve(expandHome(custom, home)) : path.join(home, "Library", "Application Support", BRAND.id);
}

/**
 * 这一份工作台的记号：由设置文件的位置算出来的 16 位字符，不带路径本身。
 * 接口的 /api/health 回答它；pnpm start 靠它认出「在运行的是不是自己」：
 * 同一台电脑上用别的设置文件起的另一份工作台（比如换了 WORKBENCH_CONFIG_DIR 或者家目录）不算自己，照样另起一份。
 */
export function instanceId(file) {
  return createHash("sha256").update(path.resolve(String(file ?? ""))).digest("hex").slice(0, 16);
}

/** /api/health 的回答是不是这一份工作台（同一个设置文件起的）。 */
export function isThisWorkbench(health, file) {
  return Boolean(health) && health.app === BRAND.id && health.instance === instanceId(file);
}

/** 日志文件夹：~/Library/Logs/<id>。环境变量 WORKBENCH_LOG_DIR 可以换掉。 */
export function logDir(env = process.env, home = os.homedir()) {
  const custom = String(env.WORKBENCH_LOG_DIR ?? "").trim();
  return custom ? path.resolve(expandHome(custom, home)) : path.join(home, "Library", "Logs", BRAND.id);
}

export function defaultSettings() {
  return {
    说明: `这是「${BRAND.name}」的设置文件。每一项是什么、怎么改，见仓库里的 docs/配置说明.md。改完要先运行 pnpm stop，再运行 pnpm start 才生效。`,
    workFolder: `~/Documents/${BRAND.id}`,
    paths: {
      topics: "选题库",
      overview: "选题库/00_选题总览.md",
      drafts: "内容草稿",
      writingMethod: "写稿方法",
      benchmarkAccounts: "市场调研/对标账号",
      researchReports: "市场调研/调研报告",
      commentImports: "市场调研/评论导入",
      prompts: "提示词",
      promptUsage: "提示词/_使用记录.jsonl",
      // 封面（1.1 加）：封面设置.json、人物参考图片/、风格/（你放进来的几组图）。每条内容的封面候选放在它自己的草稿文件夹里
      coverAssets: "封面素材",
      trash: "回收站",
    },
    contentTypes: [...DEFAULT_TYPES],
    columns: [...COLUMN_KEYS],
    ports: { ...DEFAULT_PORTS },
  };
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

// 出错在第几行：Node 有时直接给行号，有时只给位置，有时都不给（比如最常见的「最后多了一个逗号」，那就自己找）。
function jsonErrorLine(text, error) {
  const message = String(error?.message ?? "");
  const line = message.match(/line (\d+) column \d+/);
  if (line) return Number(line[1]);
  const at = Number(message.match(/position (\d+)/)?.[1]);
  if (Number.isFinite(at)) return text.slice(0, at).split("\n").length;
  const trailing = text.search(/,\s*[\]}]/);
  return trailing >= 0 ? text.slice(0, trailing).split("\n").length : null;
}

function cleanType(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > 20 || /[\\/:]/.test(name) || name.startsWith(".")) return null;
  return name;
}

/**
 * 读设置并核对，返回整理好的设置（路径全部是绝对路径）和 issues（哪里写得不对、按什么处理了）。
 * 设置文件不存在时：create 为 true 就按默认值写一份。设置文件不是合法 JSON 时直接报错，不悄悄用默认值顶上。
 */
export function loadConfig({ env = process.env, home = os.homedir(), create = true } = {}) {
  const dir = configDir(env, home);
  const file = path.join(dir, "config.json");
  const defaults = defaultSettings();
  let raw = null;
  let created = false;
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8").replace(/^﻿/, "");
    try {
      raw = JSON.parse(text);
    } catch (error) {
      const line = jsonErrorLine(text, error);
      throw Object.assign(
        new Error(
          `设置文件写坏了，不是合法的 JSON：${displayPath(file, home)}${line ? `（第 ${line} 行附近）` : ""}。` +
            "改好它，或者把它删掉（删掉后会按默认值重新生成），再运行 pnpm start。",
        ),
        { code: "CONFIG_INVALID", file },
      );
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw Object.assign(new Error(`设置文件最外层应该是 { … }：${displayPath(file, home)}`), { code: "CONFIG_INVALID", file });
    }
  } else if (create) {
    writeJsonAtomic(file, defaults);
    raw = defaults;
    created = true;
  } else {
    raw = defaults;
  }

  const issues = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) issues.push(`设置里有一项不认识：「${key}」，没有用上。`);
  }

  let workFolderText = raw.workFolder;
  if (typeof workFolderText !== "string" || !workFolderText.trim()) {
    if (workFolderText !== undefined) issues.push("workFolder 应该是一个文件夹路径，按默认值处理。");
    workFolderText = defaults.workFolder;
  }
  const workFolder = path.resolve(expandHome(workFolderText, home));
  const resolveIn = (value) => {
    const text = expandHome(value, home);
    return path.isAbsolute(text) ? path.resolve(text) : path.resolve(workFolder, text);
  };

  const rawPaths = raw.paths && typeof raw.paths === "object" && !Array.isArray(raw.paths) ? raw.paths : {};
  if (raw.paths !== undefined && rawPaths !== raw.paths) issues.push("paths 应该是 { … }，按默认值处理。");
  const paths = {};
  for (const key of PATH_KEYS) {
    let value = rawPaths[key];
    if (value === undefined) value = defaults.paths[key];
    else if (typeof value !== "string" || !value.trim()) {
      issues.push(`paths.${key} 应该是一个路径，按默认值处理。`);
      value = defaults.paths[key];
    }
    paths[key] = resolveIn(value);
  }
  for (const key of Object.keys(rawPaths)) {
    if (!PATH_KEYS.includes(key)) issues.push(`paths 里有一项不认识：「${key}」，没有用上。`);
  }

  let contentTypes = [...DEFAULT_TYPES];
  if (raw.contentTypes !== undefined) {
    const list = Array.isArray(raw.contentTypes) ? raw.contentTypes.map(cleanType) : [];
    const unique = [...new Set(list.filter(Boolean))];
    if (unique.length && unique.length === list.length && unique.length <= 12) {
      contentTypes = unique;
    } else {
      issues.push(
        "contentTypes 要写成 [\"教程\", \"科普\"] 这样：1 到 12 个不重复的名字，每个不超过 20 个字，不能带 / \\ : 也不能以点开头。按默认的教程、科普、口播处理。",
      );
    }
  }

  let columns = [...COLUMN_KEYS];
  if (raw.columns !== undefined) {
    const list = Array.isArray(raw.columns) ? raw.columns : [];
    const known = list.filter((key) => COLUMN_KEYS.includes(key));
    for (const key of list) if (!COLUMN_KEYS.includes(key)) issues.push(`columns 里有一个栏目不认识：「${key}」。能写的是 ${COLUMN_KEYS.join("、")}。`);
    if (known.length) columns = COLUMN_KEYS.filter((key) => known.includes(key));
    else issues.push("columns 至少要开一个栏目，按默认全部打开处理。");
  }

  const rawPorts = raw.ports && typeof raw.ports === "object" && !Array.isArray(raw.ports) ? raw.ports : {};
  const ports = { ...DEFAULT_PORTS };
  for (const key of ["api", "ui", "save"]) {
    if (rawPorts[key] === undefined) continue;
    const value = Number(rawPorts[key]);
    if (isUsablePort(value)) ports[key] = value;
    else issues.push(`ports.${key} 写的是 ${JSON.stringify(rawPorts[key])}，不能用（要在 1024 到 65535 之间，而且不能是本机常见服务占用的端口），按默认的 ${DEFAULT_PORTS[key]} 处理。`);
  }
  if (ports.api === ports.ui) {
    issues.push("ports.api 和 ports.ui 不能一样，按默认值处理。");
    Object.assign(ports, DEFAULT_PORTS);
  }
  if (ports.save === ports.api || ports.save === ports.ui) {
    issues.push(`ports.save 不能和 ports.api、ports.ui 一样，按默认的 ${DEFAULT_PORTS.save} 处理。`);
    ports.save = DEFAULT_PORTS.save;
    // 默认的保存服务端口正好被写成了接口或界面的端口：三个都按默认值
    if (ports.save === ports.api || ports.save === ports.ui) Object.assign(ports, DEFAULT_PORTS);
  }

  return { file, dir, created, home, workFolder, paths, contentTypes, columns, ports, issues };
}
