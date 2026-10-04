// 端口：默认接口 18878、界面 18879、创作页保存服务 18977，被占就往后找空的。
// BLOCKED_PORTS 是本机常见服务正在用的端口，无论设置里怎么写都不会用。
import net from "node:net";

export const DEFAULT_PORTS = Object.freeze({ api: 18878, ui: 18879, save: 18977 });
export const BLOCKED_PORTS = new Set([8878, 8879, 8888, 8890, 8977, 8978, 8787, 43127]);

export function isUsablePort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && !BLOCKED_PORTS.has(port);
}

// 有程序在这个端口上应答，就算占用（覆盖只监听 0.0.0.0 或 ::1 的程序）。
function answers(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(400, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function canListen(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function isPortFree(port, host = "127.0.0.1") {
  if (!isUsablePort(port)) return false;
  if ((await answers(port, "127.0.0.1")) || (await answers(port, "::1"))) return false;
  return canListen(port, host);
}

/** 从 preferred 开始往后找一个空端口；exclude 里的端口（比如已经分给接口的）跳过。 */
export async function pickPort(preferred, { exclude = [], tries = 60, fallback = DEFAULT_PORTS.ui } = {}) {
  const skip = new Set(exclude);
  const start = isUsablePort(preferred) ? preferred : fallback;
  for (let port = start, n = 0; n < tries && port <= 65535; port += 1, n += 1) {
    if (!isUsablePort(port) || skip.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`从 ${start} 往后 ${tries} 个端口都被占用了，请在设置文件的 ports 里换一个起始端口。`);
}
