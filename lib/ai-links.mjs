// 新手指引第 3 步的「一键打开」：两家 AI 工具官方写明的、用链接在指定文件夹里新开对话的办法
//（Codex：codex://threads/new?path=…&prompt=…，ChatGPT 桌面版接；Claude 桌面版：claude://code/new?folder=…&q=…；
// 终端里的 Claude Code：claude-cli://open?cwd=…&q=…），这台 Mac 上有没有程序接这种链接。
// 页面只在有的时候放按钮：点了没反应的按钮不放（AGENTS.md 规矩 2）。Claude 桌面版和终端版都有时只放桌面版（ui/lib/tour-steps.ts 的 availableAiLinks）。
// 查过哪些、出处和日期见 docs/开发记录.md「新手指引」。只问系统、不打开任何东西。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** 拿来问「谁接这种链接」的地址（不会真的打开） */
export const LINK_PROBES = { codex: "codex://threads/new", "claude-desktop": "claude://code/new", claude: "claude-cli://open" };
const KEYS = Object.keys(LINK_PROBES);
const none = () => Object.fromEntries(KEYS.map((key) => [key, false]));

const JXA = `ObjC.import("AppKit");
function handler(url) {
  var app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString(url));
  return app && !app.isNil() ? ObjC.unwrap(app.path) : "";
}
JSON.stringify({ ${KEYS.map((key) => `${JSON.stringify(key)}: handler(${JSON.stringify(LINK_PROBES[key])})`).join(", ")} });`;

/**
 * 环境变量 WORKBENCH_AI_LINKS（只给测试和验收用）：写了就不问系统，照写的算，
 * 比如 "codex,claude-desktop,claude" 三个都有、"claude" 只有终端里的 Claude Code、"none" 都没有。没写返回 null。
 */
export function linksFromEnv(value) {
  if (value === undefined || value === null) return null;
  const want = new Set(String(value).split(/[\s,]+/).filter(Boolean));
  return Object.fromEntries(KEYS.map((key) => [key, want.has(key)]));
}

function runJxa(script) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeout: 4000 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout).trim()),
    );
  });
}

/**
 * 问 macOS 谁来打开这几种链接（系统自带的 osascript 查「启动服务」的登记，只读）。
 * 问不了时退一步：Codex 算没有；Claude 桌面版看「应用程序」里有没有 Claude.app；终端里的 Claude Code 看官方文档写的
 * 那个接链接的小程序在不在（~/Applications/Claude Code URL Handler.app，第一次在终端里用 Claude Code 发出一句话时它自己装上）。
 */
export async function probeLinks({ home, run = runJxa, apps = ["/Applications"] } = {}) {
  try {
    const found = JSON.parse(await run(JXA));
    return Object.fromEntries(KEYS.map((key) => [key, Boolean(found[key])]));
  } catch {
    const has = (name) => [...apps, ...(home ? [path.join(home, "Applications")] : [])].some((dir) => existsSync(path.join(dir, name)));
    return { ...none(), "claude-desktop": has("Claude.app"), claude: has("Claude Code URL Handler.app") };
  }
}

/**
 * 接口 /api/app 用的：最多每分钟问一次系统。第一次要等它（约 0.1 秒）；之后有旧结果就先给旧的，新的在后台问，不挡着页面。
 */
export function createAiLinks({ home, env = process.env, ttl = 60_000, probe = probeLinks } = {}) {
  const fixed = linksFromEnv(env.WORKBENCH_AI_LINKS);
  let last = null;
  let at = 0;
  let pending = null;
  return async function aiLinks() {
    if (fixed) return fixed;
    if (last && Date.now() - at < ttl) return last;
    if (!pending) {
      pending = probe({ home })
        .then((found) => {
          last = found;
          at = Date.now();
          return found;
        })
        .finally(() => {
          pending = null;
        });
    }
    return last ?? pending;
  };
}
