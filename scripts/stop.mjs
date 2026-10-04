#!/usr/bin/env node
// 停掉这台电脑上正在运行的这一份工作台：pnpm stop
// 认的是同一个设置文件起的那一份（和 pnpm start 一样问 /api/health），别的设置文件起的不碰。
// 找到回答的端口，查出是哪个进程在听，停掉它的上一级 scripts/start.mjs（它会把接口、界面、保存服务一起停掉）；
// 上一级不是 start.mjs，就停掉这个进程本身。更新到新版本时先停旧的（安装说明第 0 步），旧版本起的也能停。
// 没在运行就说一声，不算出错。
import { execFileSync } from "node:child_process";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { BRAND } from "../lib/brand.mjs";
import { isThisWorkbench, loadConfig } from "../lib/config.mjs";

// 连本机端口被拒绝（EPERM / EACCES）：AI 工具的沙箱不让命令连本机端口，这时问不到不等于没在运行
let blocked = false;

function getJson(port, route, timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: route, timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", (error) => {
      if (error.code === "EPERM" || error.code === "EACCES") blocked = true;
      resolve(null);
    });
  });
}

/** 这一份工作台正在用的端口：接口的端口和界面那一段（被占时往后挪过，最多 20 个） */
async function answeringPorts(config) {
  const candidates = new Set([config.ports.api, ...Array.from({ length: 20 }, (_, i) => config.ports.ui + i)]);
  const found = [];
  for (const port of candidates) if (isThisWorkbench(await getJson(port, "/api/health"), config.file)) found.push(port);
  return found;
}

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}
const listening = (port) => run("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]).split(/\s+/).filter(Boolean).map(Number);
const parentOf = (pid) => Number(run("ps", ["-o", "ppid=", "-p", String(pid)]).trim()) || 0;
const commandOf = (pid) => run("ps", ["-o", "command=", "-p", String(pid)]).trim();

let config;
try {
  config = loadConfig({ create: false });
} catch (error) {
  console.error(`\n停不了：${error.message}\n`);
  process.exit(1);
}

const ports = await answeringPorts(config);
if (!ports.length && blocked) {
  console.error(`\n停不了：这个终端不让连本机端口（多半是 AI 工具的沙箱），查不了工作台在不在运行，不代表没在运行。请用能连本机端口的权限再运行一次这条命令（Codex 里让这条命令申请提权）。\n`);
  process.exit(2);
}
if (!ports.length) {
  console.log(`${BRAND.name}没在运行，不用停。`);
  process.exit(0);
}

const listeners = ports.flatMap(listening);
const targets = new Set(listeners.map((pid) => {
  const parent = parentOf(pid);
  return parent && commandOf(parent).includes("scripts/start.mjs") ? parent : pid;
}));
if (!targets.size) {
  console.error(`\n停不了：${BRAND.name}在运行（端口 ${ports.join("、")}），但查不到是哪个进程在听这些端口。可以重启电脑，或者在「活动监视器」里结束 node 进程。\n`);
  process.exit(1);
}
for (const pid of targets) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* 已经停了 */
  }
}

// 等它停下：start.mjs 收到信号会先停三个服务，最多等 10 秒；还在应答就强制停掉听端口的进程
const end = Date.now() + 10_000;
while (Date.now() < end && (await answeringPorts(config)).length) await sleep(300);
if ((await answeringPorts(config)).length) {
  for (const pid of [...targets, ...listeners]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已经停了 */
    }
  }
  await sleep(500);
}
if ((await answeringPorts(config)).length) {
  console.error(`\n停不了：${BRAND.name}还在应答（端口 ${ports.join("、")}）。可以重启电脑，或者在「活动监视器」里结束 node 进程。\n`);
  process.exit(1);
}
console.log(`${BRAND.name}已经停了。`);
