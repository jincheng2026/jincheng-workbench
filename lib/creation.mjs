// 创作页：一条内容一个网页（内容草稿/T001_xxx/T001_创作页.html），在页面上直接改稿，改动由保存服务逐格写回这个文件。
// 页面由写稿 Skill 调 creation-page/build_page.py 生成；保存服务是 creation-page/server/brain_save.py（Python 3，只用标准库），
// pnpm start 和接口、界面一起拉起，根目录是设置里的工作文件夹，回收站不扫。
// 这里管三件事：找 python3、拼保存服务的启动参数、认出草稿文件夹里的创作页并给出页面链接。
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CREATION_DIR = path.join(REPO, "creation-page");
export const SAVE_SCRIPT = path.join(CREATION_DIR, "server", "brain_save.py");
export const SAVE_SERVICE = "jc-brain-save"; // 保存服务 /healthz 里的 service
export const MIN_PYTHON = [3, 8];

/**
 * 找能用的 python3：环境变量 WORKBENCH_PYTHON，没有就用 PATH 里的 python3（macOS 装了「命令行开发者工具」就有）。
 * 返回 { ok, command, version, reason }。
 */
export function findPython(env = process.env) {
  const command = String(env.WORKBENCH_PYTHON ?? "").trim() || "python3";
  const run = spawnSync(command, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8", timeout: 20_000, env });
  const version = String(run.stdout ?? "").trim();
  if (run.error || run.status !== 0 || !/^\d+\.\d+$/.test(version)) {
    return {
      ok: false,
      command,
      version: null,
      reason:
        `找不到能用的 python3（${command}）。创作页的保存服务要用 Python 3：` +
        "在终端运行 xcode-select --install 装好「命令行开发者工具」（装 Git 时多半已经装了），再运行一次 pnpm start。",
    };
  }
  const [major, minor] = version.split(".").map(Number);
  if (major < MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor < MIN_PYTHON[1])) {
    return { ok: false, command, version, reason: `创作页的保存服务要 Python ${MIN_PYTHON.join(".")} 或更新的版本，${command} 是 ${version}。` };
  }
  return { ok: true, command, version, reason: null };
}

/** 回收站在工作文件夹里面时，保存服务扫页面不进它：挪进回收站的旧页面不算同号副本。 */
export function skipDirs(config) {
  const inner = path.relative(config.workFolder, config.paths.trash);
  return inner && !inner.startsWith("..") && !path.isAbsolute(inner) ? [config.paths.trash] : [];
}

/** 保存服务的启动参数：根目录是设置里的工作文件夹（不是别处），端口是这次挑好的。 */
export function saveServiceArgs(config, port) {
  return [SAVE_SCRIPT, "--root", config.workFolder, "--port", String(port), ...skipDirs(config).flatMap((dir) => ["--skip-dir", dir])];
}

export function creationUrl(port, pageId) {
  return `http://127.0.0.1:${port}/p/${pageId}`;
}

// —— 认出创作页 ——————————————————————————————
// 页面里唯一的 <script id="jc-doc" type="application/json"> 是页面数据，写着 page_id（页面标识）、content_id（内容编号）、kind（创作页）。
// 页面可能有几百 KB，数据块在文件末尾附近，所以整个读一遍；按（inode、大小、修改时间）记住结果，文件没变就不重读。
const JC_DOC_RE = /<script\b[^>]*\bid=["']jc-doc["'][^>]*>([\s\S]*?)<\/script>/;
const READ_LIMIT = 20 * 1024 * 1024;
const cache = new Map();

function readText(file, size) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, READ_LIMIT));
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** 一个网页是不是创作页：是就返回 { pageId, contentId, title }，不是或读不出返回 null。 */
export function inspectCreationPage(file) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return null;
  }
  const sig = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(file);
  if (hit?.sig === sig) return hit.info;
  let info = null;
  try {
    const block = readText(file, stat.size).match(JC_DOC_RE);
    const doc = block ? JSON.parse(block[1]) : null;
    if (doc && doc.kind === "创作页" && typeof doc.page_id === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(doc.page_id)) {
      const items = Array.isArray(doc.items) ? doc.items : [];
      const pageInfo = items.find((item) => item?.kind === "info") ?? null;
      info = {
        pageId: doc.page_id,
        contentId: typeof doc.content_id === "string" ? doc.content_id : null,
        title: typeof pageInfo?.locked?.title === "string" ? pageInfo.locked.title : null,
        // 用户在页面上采纳了几条修改建议（新手指引的清单用：「在创作页采纳一条建议」）
        adopted: items.filter((item) => item?.kind === "suggestion" && ["采纳", "部分采纳"].includes(item?.fields?.decision)).length,
      };
    }
  } catch {
    info = null;
  }
  if (cache.size > 2000) cache.clear();
  cache.set(file, { sig, info });
  return info;
}
