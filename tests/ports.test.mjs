import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { BLOCKED_PORTS, isUsablePort, pickPort } from "../lib/ports.mjs";

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

test("本机常见服务占用的端口一律不用", () => {
  for (const port of [8878, 8879, 8888, 8890, 8977, 8787, 43127]) {
    assert.ok(BLOCKED_PORTS.has(port));
    assert.equal(isUsablePort(port), false);
  }
  assert.equal(isUsablePort(80), false);
  assert.equal(isUsablePort(18878), true);
});

test("端口被占就往后找；要跳过的端口也跳过", async () => {
  const start = 20000 + Math.floor(Math.random() * 20000);
  const busy = await listen(start);
  try {
    const first = await pickPort(start);
    assert.notEqual(first, start);
    assert.ok(first > start);
    const second = await pickPort(start, { exclude: [first] });
    assert.ok(second !== start && second !== first);
  } finally {
    busy.close();
  }
});

test("设置里写了不能用的端口，从默认端口开始找", async () => {
  const port = await pickPort(8888, { fallback: 18878 });
  assert.ok(port >= 18878);
  assert.ok(!BLOCKED_PORTS.has(port));
});
