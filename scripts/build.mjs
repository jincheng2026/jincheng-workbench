#!/usr/bin/env node
// 编译界面：pnpm build。编译成功后在 ui/.next 里记一下当时界面代码最新的修改时间，
// pnpm start 拿它判断界面代码有没有更新过（比如 git pull 之后），有就先重新编译。
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const UI = path.join(ROOT, "ui");
export const NEXT_BIN = path.join(UI, "node_modules", "next", "dist", "bin", "next");
const STAMP = path.join(UI, ".next", "workbench-build.json");
// 编译时自动生成的文件不算「界面代码有更新」
const GENERATED = /^(?:next-env\.d\.ts|.*\.tsbuildinfo)$/;

export function newestSourceTime() {
  let newest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".") || GENERATED.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(UI);
  for (const file of ["brand.json", "package.json"]) newest = Math.max(newest, statSync(path.join(ROOT, file)).mtimeMs);
  return newest;
}

/** 要不要先编译：返回原因（一句话），不用编译时返回 null。 */
export function buildReason() {
  if (!existsSync(path.join(UI, ".next", "BUILD_ID")) || !existsSync(STAMP)) return "界面还没编译过";
  try {
    const { sourceTime } = JSON.parse(readFileSync(STAMP, "utf8"));
    return newestSourceTime() > Number(sourceTime) ? "界面代码有更新" : null;
  } catch {
    return "上次编译的记录读不出来";
  }
}

/** 运行 next build。onLine 收到编译输出的每一行（启动脚本写进日志）；成功返回 true。 */
export function buildUi({ onLine = (line) => process.stdout.write(`${line}\n`) } = {}) {
  return new Promise((resolve) => {
    if (!existsSync(NEXT_BIN)) {
      onLine("还没装依赖：先在仓库文件夹里运行 pnpm install。");
      resolve(false);
      return;
    }
    const child = spawn(process.execPath, [NEXT_BIN, "build"], {
      cwd: UI,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let rest = "";
    const feed = (chunk) => {
      rest += chunk.toString("utf8");
      const lines = rest.split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (error) => {
      onLine(`编译没能开始：${error.message}`);
      resolve(false);
    });
    child.on("close", (code) => {
      if (rest) onLine(rest);
      if (code === 0) writeFileSync(STAMP, JSON.stringify({ sourceTime: newestSourceTime(), builtAt: new Date().toISOString() }) + "\n");
      resolve(code === 0);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log("正在编译界面，第一次大约要一两分钟……");
  const ok = await buildUi();
  if (ok) {
    console.log("\n界面编译好了。接下来运行 pnpm start 启动。");
  } else {
    console.error("\n界面编译失败，上面是出错的地方。");
    process.exit(1);
  }
}
