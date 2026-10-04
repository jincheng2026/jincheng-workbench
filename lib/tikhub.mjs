// TikHub 的 key：只存 macOS 登录钥匙串（服务名 tikhub-api、账户名 tikhub），不写进任何文件、不回传给页面、不进日志。
// 读写都用系统自带的 /usr/bin/security。写的时候用交互模式（security -i），整条命令从标准输入给，
// key 不出现在进程参数里（别的程序用 ps 看不到）。页面只拿到「有没有、在哪、后四位」。
// 环境变量 TIKHUB_API_KEY 有值时优先用它（页面上说明是环境变量里的）。
// 检测 key 只调查账户信息和余额的 get_user_info（官方单价 0 美元）。TikHub 报错时会把请求头原样带回来（里面有 key），
// 所以它的回答只取状态码和余额这几个数，原文一个字都不往外传。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FALLBACK_PRICES, KEYCHAIN, PRICE_ENDPOINTS, TIKHUB, costEstimate } from "./data-sources.mjs";

const SECURITY = "/usr/bin/security";
const NOT_FOUND = 44; // security：钥匙串里没有这一项
const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;

function fail(message, statusCode = 400, code = undefined) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** 钥匙串里的服务名：默认 tikhub-api；环境变量 WORKBENCH_KEYCHAIN_SERVICE 能换（测试和验收用，免得碰到真的那一项）。 */
export function keychainService(env = process.env) {
  return String(env.WORKBENCH_KEYCHAIN_SERVICE ?? "").trim() || KEYCHAIN.service;
}

/**
 * 要不要在 security 命令后面写明登录钥匙串。平时不写，照系统的默认来；
 * HOME 被换掉时（比如在临时家目录里验收）security 找不到默认钥匙串，写会卡住、读会找不到，
 * 这时按系统账户里记的家目录（不看 HOME）找登录钥匙串，写明给它。
 */
export function explicitKeychain({ home = os.homedir(), realHome = os.userInfo().homedir } = {}) {
  if (!realHome || path.resolve(home) === path.resolve(realHome)) return null;
  const file = path.join(realHome, "Library", "Keychains", "login.keychain-db");
  return existsSync(file) && !/["\n]/.test(file) ? file : null;
}

/** 运行 security：返回 { code, stdout }。出错时不带命令内容，免得把标准输入里的东西带出去。 */
export function runSecurity(args, { input = null, timeout = 10_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(SECURITY, args, { stdio: ["pipe", "pipe", "pipe"], env });
    } catch {
      resolve({ code: -1, stdout: "" });
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

/** 粘贴进来的 key 整理一下：去掉首尾空白和开头的「Bearer 」；中间有空格、换行、引号，或者长度不对，就说清楚。 */
export function cleanKey(raw) {
  const text = String(raw ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!text) throw fail("还没粘贴 key。", 400, "key-empty");
  if (/[^\x21-\x7e]/.test(text) || /["'\\]/.test(text)) {
    throw fail("key 里不该有空格、换行、引号或中文，可能复制多了或者少了。回到 TikHub 点「复制」再粘贴一次。", 400, "key-format");
  }
  if (text.length < 8 || text.length > 512) throw fail("这串字符的长度不像 TikHub 的 key，回到 TikHub 重新复制一遍。", 400, "key-format");
  return text;
}

const lastFour = (key) => (key ? key.slice(-4) : null);
const envKeyOf = (env) => String(env.TIKHUB_API_KEY ?? "").trim().replace(/^Bearer\s+/i, "");

/**
 * 钥匙串里的 TikHub key。service 是服务名；run 换成假的，测试就不碰真的钥匙串。
 * 对外只给状态（有没有、在哪、后四位）；effectiveKey() 只给接口内部连 TikHub 用。
 */
export function createKeyStore({
  service = keychainService(),
  account = KEYCHAIN.account,
  env = process.env,
  run = runSecurity,
  keychain = explicitKeychain(),
} = {}) {
  if (!SAFE_NAME.test(service) || !SAFE_NAME.test(account)) throw new Error("钥匙串的服务名、账户名只能用字母、数字和 . _ -");
  const ids = ["-s", service, "-a", account];
  const where = keychain ? [keychain] : [];

  async function readKeychain() {
    const { code, stdout } = await run(["find-generic-password", ...ids, "-w", ...where]);
    if (code === 0) return { key: stdout.replace(/\r?\n$/, "") || null, ok: true };
    if (code === NOT_FOUND) return { key: null, ok: true };
    return { key: null, ok: false };
  }

  /** 有没有 key：只看钥匙串里有没有这一项（不读出 key 本身），左边菜单的「还差几步」用 */
  async function exists() {
    if (envKeyOf(env)) return true;
    const { code } = await run(["find-generic-password", ...ids, ...where]);
    return code === 0;
  }

  async function status() {
    const envKey = envKeyOf(env);
    const stored = await readKeychain();
    const base = { keychainOk: stored.ok, savedInKeychain: Boolean(stored.key) };
    if (envKey) return { ...base, configured: true, source: "env", last4: lastFour(envKey) };
    if (stored.key) return { ...base, configured: true, source: "keychain", last4: lastFour(stored.key) };
    return { ...base, configured: false, source: null, last4: null };
  }

  /** 存进钥匙串（已经有就换成新的），存完读回来核对。调用前先检测过 key。 */
  async function save(raw) {
    const key = cleanKey(raw);
    const line = `add-generic-password -U -s "${service}" -a "${account}" -w "${key}"${keychain ? ` "${keychain}"` : ""}\n`;
    const { code } = await run(["-i"], { input: line });
    if (code !== 0) {
      throw fail("没能存进钥匙串。钥匙串可能锁着（比如远程登录这台 Mac 时）：在这台 Mac 上登录后再试。", 500, "keychain-write");
    }
    const back = await readKeychain();
    if (back.key !== key) throw fail("存进钥匙串以后读出来对不上，请再点一次「检测并保存」。", 500, "keychain-write");
    return status();
  }

  async function remove() {
    const { code } = await run(["delete-generic-password", ...ids, ...where]);
    if (code !== 0 && code !== NOT_FOUND) throw fail("钥匙串可能锁着，在这台 Mac 上登录后再试。", 500, "keychain-delete");
    const back = await readKeychain();
    if (back.key) throw fail("删完再看，钥匙串里还有这一项，请再删一次。", 500, "keychain-delete");
    return status();
  }

  /** 接口内部用：真正拿去连 TikHub 的 key 和它从哪来。 */
  async function effectiveKey() {
    const envKey = envKeyOf(env);
    if (envKey) return { key: envKey, source: "env" };
    const stored = await readKeychain();
    return stored.key ? { key: stored.key, source: "keychain" } : null;
  }

  return { service, account, exists, status, save, remove, effectiveKey };
}

// —— 连 TikHub ——————————————————————————————

/** 接口地址：只用 api.tikhub.io；环境变量 TIKHUB_BASE_URL 有值时用它（测试里指到假的 TikHub）。 */
export function tikhubBase(env = process.env) {
  return String(env.TIKHUB_BASE_URL ?? "").trim().replace(/\/+$/, "") || TIKHUB.apiBase;
}

async function getJson(url, { key = null, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body: body && typeof body === "object" ? body : null };
}

const money = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null;
};
/** 「$3.20」；不到 1 美分的写到小数点后 4 位 */
export const usd = (n) => `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2)}`;

/**
 * 检测一个 key。返回 { result, message, at, balance, freeCredit }：
 * result 是 ok（能用，余额可能是 0）、bad-key（401：key 不对或已停用）、forbidden（403：邮箱没验证或没勾权限，或账户停用）、
 * no-balance（402：余额不够）、network（超时、连不上）、busy（429：太快了）、server（TikHub 出错）。
 * 只有 ok 算检测通过。message 是给页面看的一句话，不带 TikHub 的原话。
 */
export async function testKey(key, { env = process.env, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const at = new Date().toISOString();
  let answer;
  try {
    answer = await getJson(`${tikhubBase(env)}${TIKHUB.userInfoPath}`, { key, fetchImpl, timeoutMs });
  } catch {
    return { result: "network", at, message: "连不上 TikHub（超时或网络不通）。检查网络；平时要开代理才能上外网的，开好代理后再试。" };
  }
  const { status, body } = answer;
  if (status === 401) return { result: "bad-key", at, message: "key 不对，或者已经停用了。回 TikHub 重新复制一遍，再粘贴进来。" };
  if (status === 403) return { result: "forbidden", at, message: "key 是对的，但现在用不了：多半是注册邮箱还没验证，或者创建 key 时没把权限范围全部勾上。" };
  if (status === 402) return { result: "no-balance", at, message: "key 是对的，但账户余额不够了。充值后再试。" };
  if (status === 429) return { result: "busy", at, message: "TikHub 说请求太快了，等一分钟再试。" };
  const user = body?.user_data ?? body?.data?.user_data ?? null;
  if (status !== 200 || !user || typeof user !== "object") {
    return { result: "server", at, message: `TikHub 那边出错了（HTTP ${status}），稍后再试。` };
  }
  if (user.email_verified === false) {
    return { result: "forbidden", at, message: "key 是对的，但注册邮箱还没验证：去邮箱里点 TikHub 发来的验证链接，再试一次。" };
  }
  if (user.account_disabled === true || user.is_active === false) {
    return { result: "forbidden", at, message: "key 是对的，但这个 TikHub 账户被停用了，去 TikHub 看看原因。" };
  }
  const balance = money(user.balance) ?? 0;
  const freeCredit = money(user.free_credit) ?? 0;
  const left = `余额 ${usd(balance)}${freeCredit > 0 ? `，送的额度还剩 ${usd(freeCredit)}` : ""}`;
  return { result: "ok", at, balance, freeCredit, message: balance + freeCredit > 0 ? `已接好，${left}。` : `已接好，${left}。充值以后 AI 才能拉数据。` };
}

/** 现查常用接口的单价（公开接口，不用 key）。查到几个用几个，一个都没查到返回 null。 */
export async function fetchPrices({ env = process.env, fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  const base = tikhubBase(env);
  const entries = await Promise.all(
    Object.entries(PRICE_ENDPOINTS).map(async ([name, endpoint]) => {
      try {
        const answer = await getJson(`${base}${TIKHUB.priceInfoPath}?endpoint=${encodeURIComponent(endpoint)}`, { fetchImpl, timeoutMs });
        const cost = Number(answer.status === 200 ? answer.body?.data?.endpoint_cost : NaN);
        return Number.isFinite(cost) && cost >= 0 ? [name, cost] : null;
      } catch {
        return null;
      }
    }),
  );
  const found = Object.fromEntries(entries.filter(Boolean));
  return Object.keys(found).length ? found : null;
}

/**
 * 单价：查过的记在内存里（12 小时内不再查），没查过或查不到用兜底值。
 * 只在用户点「检测并保存」和接好 TikHub 以后才去查（他已经决定用 TikHub），没接的时候打开页面不连外网。
 */
export function createPriceBook({ env = process.env, fetchImpl = fetch, maxAgeMs = 12 * 3600_000 } = {}) {
  let cached = null; // { prices, at }
  let pending = null;
  const book = {
    estimate() {
      return cached ? costEstimate(cached.prices, { live: true }) : costEstimate(FALLBACK_PRICES);
    },
    async refresh({ force = false } = {}) {
      if (!force && cached && Date.now() - cached.at < maxAgeMs) return book.estimate();
      pending ??= fetchPrices({ env, fetchImpl })
        .then((prices) => {
          if (prices) cached = { prices: { ...FALLBACK_PRICES, ...prices }, at: Date.now() };
        })
        .catch(() => {})
        .finally(() => {
          pending = null;
        });
      await pending;
      return book.estimate();
    },
  };
  return book;
}
