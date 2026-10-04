#!/usr/bin/env node
// 一条命令启动：pnpm start
// 1. 读设置（第一次运行会写一份默认设置）、建好工作文件夹；
// 2. 界面没编译过或代码更新过，先编译；
// 3. 挑三个空端口（默认接口 18878、界面 18879、创作页保存服务 18977，被占就往后找），拉起接口、界面和保存服务；
// 4. 都能应答以后，打印打开地址。按 Control+C 一起停。
// 加 --background（pnpm start --background）：在后台启动，等它能打开了再结束，关掉终端、关掉 AI 的对话都不停；停用 pnpm stop。
// AI 照安装说明替用户启动时用这个（AI 的命令跑完就结束，不能一直开着一个终端）。
// 保存服务（creation-page/server/brain_save.py）用 Python 3，根目录是设置里的工作文件夹；设置里关了「内容」栏就不起它。
// 三个服务的输出都写进 ~/Library/Logs/<id>/workbench.log，终端里只打印要紧的话。
import { spawn } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { BRAND, VERSION } from "../lib/brand.mjs";
import { displayPath, isThisWorkbench, loadConfig, logDir } from "../lib/config.mjs";
import { DEFAULT_PORTS, pickPort } from "../lib/ports.mjs";
import { SAVE_SERVICE, findPython, saveServiceArgs } from "../lib/creation.mjs";
import { ensureWorkspace } from "../lib/workspace.mjs";
import { NEXT_BIN, ROOT, UI, buildReason, buildUi } from "./build.mjs";

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const BACKGROUND = process.argv.slice(2).includes("--background");

function bail(text) {
  console.error(`\n启动没成功：${text}\n`);
  process.exit(1);
}

// —— 先查环境 ——
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) bail(`需要 Node 24 或更新的版本，这台电脑上是 ${process.versions.node}。`);
if (process.platform !== "darwin") bail("现在只支持 macOS。");
if (!existsSync(NEXT_BIN)) bail("还没装依赖：先在仓库文件夹里运行 pnpm install。");

let config;
try {
  config = loadConfig();
} catch (error) {
  bail(error.message);
}
const home = config.home;
const show = (target) => displayPath(target, home);

const logFolder = logDir(process.env, home);
mkdirSync(logFolder, { recursive: true });
const logFile = path.join(logFolder, "workbench.log");
const logStream = createWriteStream(logFile, { flags: "a" });
const writeLog = (tag, line) => logStream.write(`[${stamp()}] [${tag}] ${line}\n`);
writeLog("启动", `—— ${BRAND.name} 开始启动（${ROOT}）——`);

if (config.created) console.log(`第一次运行，设置文件写在：${show(config.file)}`);
for (const issue of config.issues) console.log(`设置提醒：${issue}`);
const created = ensureWorkspace(config);
if (created.length) console.log(`工作文件夹已经准备好：${show(config.workFolder)}`);

// 创作页的保存服务要 python3：先查，缺了就说清楚怎么装
const withCreation = config.columns.includes("content");
const python = withCreation ? findPython() : null;
if (python && !python.ok) bail(python.reason);

// —— 已经在运行就不再起第二份 ——
// 只认同一个设置文件起的那一份：别的设置文件（另一个家目录、WORKBENCH_CONFIG_DIR）起的工作台占着端口时，往后找空端口另起一份。
// 连本机端口被拒绝（EPERM / EACCES）：AI 工具的沙箱不让命令连本机端口，这时问不到不等于没在运行
let localBlocked = false;

function getJson(port, route, timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: route, timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, json: null });
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", (error) => {
      if (error.code === "EPERM" || error.code === "EACCES") localBlocked = true;
      resolve(null);
    });
  });
}

for (let port = config.ports.ui; port < config.ports.ui + 20; port += 1) {
  const answer = await getJson(port, "/api/health");
  if (isThisWorkbench(answer?.json, config.file)) {
    // 问到的可能是接口的端口（端口被挪过时，接口排在界面前面）：打印界面的端口
    const ui = Number.isInteger(answer.json.ui) ? answer.json.ui : port;
    console.log(`\n${BRAND.name}已经在运行了，直接打开：http://127.0.0.1:${ui}\n`);
    process.exit(0);
  }
}
if (localBlocked) bail("这个终端不让连本机端口（多半是 AI 工具的沙箱），查不了工作台在不在运行，不代表没在运行。请用能连本机端口的权限再运行一次这条命令（Codex 里让这条命令申请提权）。");

// —— 在后台启动：把自己（不带 --background）另起成脱离终端的进程，等它打印「已经启动」再结束 ——
if (BACKGROUND) await startInBackground();

async function startInBackground() {
  const out = path.join(logFolder, "start-background.log");
  const from = existsSync(out) ? statSync(out).size : 0;
  const fd = openSync(out, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { cwd: ROOT, env: process.env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.unref();
  let exitCode = null;
  child.on("exit", (code) => (exitCode = code ?? 1));
  const said = () => {
    try {
      return readFileSync(out).subarray(from).toString("utf8");
    } catch {
      return "";
    }
  };
  console.log(`正在后台启动${BRAND.name}……（界面要先编译时，第一次大约一两分钟）`);
  const end = Date.now() + 5 * 60_000;
  while (Date.now() < end) {
    const text = said();
    if (/已经启动。/.test(text) || (exitCode === 0 && /已经在运行了/.test(text))) {
      const lines = text.split("\n").filter((line) => !/Control\+C/.test(line));
      console.log(lines.join("\n").trimEnd());
      console.log("\n在后台运行：关掉这个窗口、关掉 AI 的对话都不会停。要停掉，在仓库文件夹里运行 pnpm stop。\n");
      writeLog("启动", "在后台启动好了");
      logStream.end(() => process.exit(0));
      return new Promise(() => {});
    }
    if (exitCode !== null) {
      console.error(text.trimEnd());
      bail(`后台启动的那一份停了（退出码 ${exitCode}），上面是它打印的话；完整记录在 ${show(logFile)}。`);
    }
    await sleep(500);
  }
  bail(`等了 5 分钟还没启动好。它打印的话在 ${show(out)}，完整记录在 ${show(logFile)}。`);
}

// —— 编译界面 ——
const reason = buildReason();
if (reason) {
  console.log(`${reason}，先编译一遍界面（第一次大约要一两分钟）……`);
  const tail = [];
  const ok = await buildUi({
    onLine: (line) => {
      writeLog("编译", line);
      tail.push(line);
      if (tail.length > 40) tail.shift();
    },
  });
  if (!ok) {
    console.error(tail.join("\n"));
    bail(`界面编译失败，上面是最后几行输出，完整记录在 ${show(logFile)}。`);
  }
  console.log("界面编译好了。");
}

// —— 挑端口 ——
let apiPort;
let uiPort;
let savePort = null;
try {
  apiPort = await pickPort(config.ports.api, { fallback: DEFAULT_PORTS.api });
  uiPort = await pickPort(config.ports.ui, { exclude: [apiPort], fallback: DEFAULT_PORTS.ui });
  if (withCreation) savePort = await pickPort(config.ports.save, { exclude: [apiPort, uiPort], fallback: DEFAULT_PORTS.save });
} catch (error) {
  bail(error.message);
}
const moved = [];
if (apiPort !== config.ports.api) moved.push(`接口端口 ${config.ports.api} 被占用，改用 ${apiPort}`);
if (uiPort !== config.ports.ui) moved.push(`界面端口 ${config.ports.ui} 被占用，改用 ${uiPort}`);
if (savePort && savePort !== config.ports.save) moved.push(`创作页保存服务的端口 ${config.ports.save} 被占用，改用 ${savePort}`);

// —— 拉起两个服务 ——
const children = [];
let stopping = false;

function launch(tag, command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const tail = [];
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on("line", (line) => {
      writeLog(tag, line);
      tail.push(line);
      if (tail.length > 30) tail.shift();
    });
  }
  child.on("exit", (code, signal) => {
    writeLog(tag, `进程结束（退出码 ${code ?? "无"}${signal ? `，信号 ${signal}` : ""}）`);
    if (stopping) return;
    console.error(`\n${tag}服务意外停了。最后几行输出：\n${tail.join("\n")}`);
    stop(1);
  });
  children.push(child);
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    process.exit(code);
  }, 3000);
  timer.unref();
  Promise.all(children.map((child) => (child.exitCode !== null ? null : new Promise((r) => child.once("exit", r))))).then(() => {
    writeLog("启动", "已停止");
    logStream.end(() => process.exit(code));
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!stopping) console.log("\n正在停止……");
    stop(0);
  });
}

const env = {
  ...process.env,
  WORKBENCH_API_PORT: String(apiPort),
  WORKBENCH_UI_PORT: String(uiPort),
  WORKBENCH_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
  ...(savePort ? { WORKBENCH_SAVE_PORT: String(savePort) } : {}),
  NEXT_TELEMETRY_DISABLED: "1",
};
launch("接口", process.execPath, [path.join(ROOT, "server.mjs")], { cwd: ROOT, env });
launch("界面", process.execPath, [NEXT_BIN, "start", "-H", "127.0.0.1", "-p", String(uiPort)], { cwd: UI, env: { ...env, NODE_ENV: "production" } });
if (savePort) launch("保存", python.command, saveServiceArgs(config, savePort), { cwd: ROOT, env: { ...env, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" } });

// —— 等两边都能应答 ——
async function ready(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !stopping) {
    const answer = await getJson(port, "/api/health", 1500);
    if (isThisWorkbench(answer?.json, config.file)) return true;
    await sleep(300);
  }
  return false;
}

if (!(await ready(apiPort, 20_000))) {
  stop(1);
  bail(`接口没有按时启动，详细记录在 ${show(logFile)}。`);
}
// 保存服务：/healthz 回答的是保存服务，根目录就是这次的工作文件夹
async function saveReady(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !stopping) {
    const answer = await getJson(port, "/healthz", 1500);
    if (answer?.json?.service === SAVE_SERVICE && answer.json.root === config.workFolder) return true;
    await sleep(300);
  }
  return false;
}
if (savePort && !(await saveReady(savePort, 20_000))) {
  stop(1);
  bail(`创作页的保存服务没有按时启动，详细记录在 ${show(logFile)}。`);
}
if (!(await ready(uiPort, 60_000))) {
  stop(1);
  bail(`界面没有按时启动，详细记录在 ${show(logFile)}。`);
}

const lines = [
  "",
  `${BRAND.name} ${VERSION} 已经启动。`,
  "",
  `  打开：http://127.0.0.1:${uiPort}`,
  `  工作文件夹：${show(config.workFolder)}`,
  ...(savePort ? [`  创作页保存服务：http://127.0.0.1:${savePort}`] : []),
  `  设置文件：${show(config.file)}`,
  `  日志：${show(logFile)}`,
  ...moved.map((text) => `  提醒：${text}`),
  "",
  "不用的时候，在这个窗口按 Control+C 停止。",
  "",
];
console.log(lines.join("\n"));
writeLog("启动", `已启动：界面 http://127.0.0.1:${uiPort}，接口 http://127.0.0.1:${apiPort}${savePort ? `，保存服务 http://127.0.0.1:${savePort}` : ""}`);
