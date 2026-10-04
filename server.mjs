#!/usr/bin/env node
// 接口服务：只监听 127.0.0.1。平时由 scripts/start.mjs 拉起来（它负责挑端口），也可以单独运行：
//   node server.mjs            用设置里的端口（默认 18878）
// 环境变量 WORKBENCH_API_PORT / WORKBENCH_UI_PORT / WORKBENCH_SAVE_PORT 由启动脚本传进来，
// 告诉接口自己、界面和创作页保存服务各用哪个端口（创作页的链接要用保存服务这次实际的端口）。
import { createServer } from "node:http";
import { BRAND } from "./lib/brand.mjs";
import { displayPath, loadConfig } from "./lib/config.mjs";
import { createApp } from "./lib/app.mjs";
import { createOpener } from "./lib/open.mjs";
import { BLOCKED_PORTS, isUsablePort } from "./lib/ports.mjs";
import { ensureWorkspace } from "./lib/workspace.mjs";

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const log = (message) => console.log(`[${stamp()}] ${message}`);
const logError = (message) => console.error(`[${stamp()}] ${message}`);

let config;
try {
  config = loadConfig();
} catch (error) {
  logError(error.message);
  process.exit(1);
}
for (const issue of config.issues) logError(`设置提醒：${issue}`);
const created = ensureWorkspace(config);
if (created.length) log(`工作文件夹里新建了 ${created.length} 项：${displayPath(config.workFolder, config.home)}`);

const apiPort = Number(process.env.WORKBENCH_API_PORT || config.ports.api);
const uiPort = Number(process.env.WORKBENCH_UI_PORT || config.ports.ui);
const savePort = Number(process.env.WORKBENCH_SAVE_PORT || config.ports.save);
for (const [name, port] of [["接口", apiPort], ["界面", uiPort]]) {
  if (!isUsablePort(port)) {
    logError(`${name}端口 ${port} 不能用${BLOCKED_PORTS.has(port) ? "（这是本机常见服务占用的端口）" : ""}，请换一个。`);
    process.exit(1);
  }
}

const opener = createOpener({ log });
const server = createServer(createApp({ config, apiPort, uiPort, savePort, opener, log: logError }));

server.once("error", (error) => {
  logError(
    error.code === "EADDRINUSE"
      ? `端口 ${apiPort} 已经被别的程序占用了。用 pnpm start 启动会自动换一个空端口。`
      : `接口没能启动：${error.message}`,
  );
  process.exit(1);
});

server.listen(apiPort, "127.0.0.1", () => {
  log(`${BRAND.name}接口已启动：http://127.0.0.1:${apiPort}（工作文件夹 ${displayPath(config.workFolder, config.home)}）`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    server.close();
    process.exit(0);
  });
}
