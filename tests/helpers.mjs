// 测试用的小工具：每个测试都在系统临时文件夹里造一个假的「家目录」，不碰真实的设置和文件。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { createServer } from "node:http";
import { pickPort } from "../lib/ports.mjs";
import { BRAND } from "../lib/brand.mjs";
import { loadConfig } from "../lib/config.mjs";

// 钥匙串：测试里绝不碰真的 tikhub-api 那一项。服务名换成这次运行专用的，环境变量里的 key 和 TikHub 地址也不用。
export const TEST_KEYCHAIN_SERVICE = `${BRAND.id}-test-${process.pid}-${Date.now().toString(36)}`;
process.env.WORKBENCH_KEYCHAIN_SERVICE = TEST_KEYCHAIN_SERVICE;
delete process.env.TIKHUB_API_KEY;
delete process.env.TIKHUB_BASE_URL;

/** 放在内存里的假钥匙串：和 lib/tikhub.mjs 的 createKeyStore 一样的几个方法，key 不出这个对象。 */
export function fakeKeyStore({ key = null } = {}) {
  let stored = key;
  const status = async () => ({
    keychainOk: true,
    savedInKeychain: Boolean(stored),
    configured: Boolean(stored),
    source: stored ? "keychain" : null,
    last4: stored ? stored.slice(-4) : null,
  });
  return {
    service: "fake",
    account: "tikhub",
    exists: async () => Boolean(stored),
    status,
    async save(value) {
      stored = String(value).trim();
      return status();
    },
    async remove() {
      stored = null;
      return status();
    },
    effectiveKey: async () => (stored ? { key: stored, source: "keychain" } : null),
  };
}

export function tempHome(prefix = "workbench-test-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function configFileIn(home) {
  return path.join(home, "Library", "Application Support", BRAND.id, "config.json");
}

/** 在假家目录里写一份设置（不传就用默认设置）再读出来。 */
export function testConfig(settings = null, { home = tempHome() } = {}) {
  if (settings) write(configFileIn(home), typeof settings === "string" ? settings : JSON.stringify(settings, null, 2));
  return loadConfig({ env: {}, home });
}

/** 记下要打开什么、不真的打开的「打开器」。 */
export function fakeOpener() {
  const calls = [];
  return {
    dryRun: true,
    calls,
    async open(target, { reveal = false } = {}) {
      calls.push({ target, reveal });
      return { how: reveal ? "finder" : "default" };
    },
  };
}

// —— 评论表样例（全是虚构的；社媒助手的条款不许传播导出的数据，仓库里不放真的导出文件）——

/** 拼一个最小的 zip 包（Excel 文件就是 zip）：files 是 { 名字: 内容 } */
export function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const col = (i) => String.fromCharCode(65 + i);

/** 拼一个 Excel 表：表头和行；字符串放进共享字符串表，第二列起偶数行用行内字符串，数字原样 */
export function xlsx(rows) {
  const shared = [];
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${col(c)}${r + 1}`;
          if (value === null || value === undefined || value === "") return "";
          if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
          if (c > 0 && r % 2 === 0) return `<c r="${ref}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`;
          shared.push(value);
          return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
        })
        .join("");
      return cells ? `<row r="${r + 1}">${cells}</row>` : `<row r="${r + 1}"/>`;
    })
    .join("");
  return zip({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": '<workbook xmlns:r="x"><sheets><sheet name="评论" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
    "xl/sharedStrings.xml": `<sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`,
  });
}

// 照社媒助手帮助页上写的抖音评论导出字段（评论ID、视频ID、视频链接……评论内容……），内容是虚构的
export const DOUYIN_HEAD = ["评论ID", "视频ID", "视频链接", "用户名称", "评论内容", "评论时间", "点赞数", "一级评论内容"];
export const DOUYIN_ROWS = [
  ["c1", "v100", "https://www.douyin.com/video/v100", "小林", "这个方法我也试了 <真的> & 好用", "2026-10-01 10:00", 12, ""],
  ["c2", "v100", "https://www.douyin.com/video/v100", "阿青", "求一份模板", "2026-10-01 10:05", 3, ""],
  ["c3", "v200", "https://www.douyin.com/video/v200", "路过", "第二条视频的评论", "2026-10-02 09:00", 0, ""],
  ["c4", "v200", "https://www.douyin.com/video/v200", "没写字", "", "2026-10-02 09:01", 0, ""],
  ["c5", "v200", "https://www.douyin.com/video/v200", "回复的人", "回复：同问", "2026-10-02 09:02", 1, "第二条视频的评论"],
];

// —— 假的 TikHub ——————————————————————————————

export const GOOD = "test-key-good-1234";
export const POOR = "test-key-poor-5678";
export const NOMAIL = "test-key-nomail-0000";
export const STOP = "test-key-stopped-9999";

/** 假的 TikHub：按 key 回不同的结果；出错时像真的 TikHub 一样把请求头（带着 key）放进回答里 */
export async function fakeTikhub({ prices = {} } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const auth = req.headers.authorization ?? "";
    seen.push({ path: url.pathname, auth });
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const failWith = (status) => reply(status, { detail: { code: status, message_zh: "上游原话请勿转述", headers: { Authorization: auth } } });
    if (url.pathname === "/api/v1/tikhub/user/get_endpoint_info") {
      const endpoint = url.searchParams.get("endpoint");
      if (!(endpoint in prices)) return failWith(404);
      return reply(200, { code: 200, data: { endpoint_uri: endpoint, endpoint_cost: prices[endpoint] } });
    }
    if (url.pathname !== "/api/v1/tikhub/user/get_user_info") return failWith(404);
    const key = auth.replace(/^Bearer /, "");
    const user = (extra) => reply(200, { code: 200, user_data: { email: "someone@example.com", balance: 0, free_credit: 0, email_verified: true, account_disabled: false, is_active: true, ...extra } });
    if (key === GOOD) return user({ balance: 3.2, free_credit: 0.05 });
    if (key === POOR) return user({});
    if (key === NOMAIL) return user({ balance: 1, email_verified: false });
    if (key === "test-key-forbidden") return failWith(403);
    if (key === "test-key-payment") return failWith(402);
    if (key === "test-key-busy") return failWith(429);
    if (key === "test-key-broken") return failWith(500);
    if (key === STOP) return user({ balance: 1, account_disabled: true });
    return failWith(401);
  });
  const port = await pickPort(30000 + Math.floor(Math.random() * 20000));
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}
