// 接口：只给本机的界面用。server.mjs 负责监听端口，这里只管「收到什么请求、回什么」，测试直接拿它来用。
// 防跨站：Host 必须是本机接口地址；带 Origin 的请求必须来自本机的界面或接口；写操作必须是 JSON（传图片、评论表时是原始字节）。
// TikHub 的 key：只在「检测并保存」时收进来，检测通过才存钥匙串；回给页面的只有有没有、后四位和余额，key 本身从不回传、不进日志。
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { createAiLinks } from "./ai-links.mjs";
import { BRAND, VERSION } from "./brand.mjs";
import { instanceId } from "./config.mjs";
import { REPO } from "./creation.mjs";
import { NEW_ACCOUNT_CREDIT_USD, MIN_TOP_UP_USD, SOCIAL_HELPER, TIKHUB } from "./data-sources.mjs";
import {
  PLATFORMS,
  REPORT_CSP,
  accountImage,
  importCommentTable,
  listAccounts,
  listReports,
  reportFile,
  saveAccount,
  saveAccountImage,
  scanCommentImports,
  streamFile,
  trashAccount,
} from "./research.mjs";
import { COVER_SKILL, RESEARCH_SKILL } from "./templates.mjs";
import {
  COVER_DIR,
  PHOTO_DIR,
  accountVi,
  coverFile,
  favoriteCover,
  favoriteFile,
  listFavorites,
  listPhotos,
  photoFile,
  readCoverSettings,
  saveAnnotation,
  savePhoto,
  selectCover,
  setDefaultBenchmark,
  topicCovers,
  trashCover,
  unselectCover,
  viImage,
} from "./covers.mjs";
import { cleanKey, createKeyStore, createPriceBook, testKey } from "./tikhub.mjs";
import { restoreOverview } from "./workspace.mjs";
import { openDraftFolder, openWorkTarget, readWorkDetail, readWorkText, readWorks, resumeWork, worksLayout } from "./works.mjs";
import { promptsLayout, readPromptLibrary, recordPromptUse, savePromptOrder, setPromptStar, trashPrompts } from "./prompts.mjs";

const JSON_TYPE = "application/json; charset=utf-8";

function fail(message, statusCode = 400, code = undefined) {
  return Object.assign(new Error(message), { statusCode, code });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function readBuffer(req, limit = 64 * 1024, tooBig = "请求内容太大了。") {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(fail(tooBig, 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readBody(req, limit = 64 * 1024) {
  return (await readBuffer(req, limit)).toString("utf8");
}

function decodePart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    throw fail("地址里的文件名不对。", 400);
  }
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    throw fail("请求内容不是合法的 JSON。", 400);
  }
}

export function createApp({
  config,
  apiPort,
  uiPort,
  savePort = config.ports.save,
  opener,
  log = () => {},
  keyStore = createKeyStore(),
  tikhubEnv = process.env,
  fetchImpl = fetch,
  priceBook = createPriceBook({ env: tikhubEnv, fetchImpl }),
  aiLinks = createAiLinks({ home: config.home }),
}) {
  const works = worksLayout(config, { savePort });
  const prompts = promptsLayout(config);
  // 上一次检测 key 的结果（只记在内存里）：页面上「已接好，余额 $x」用；换了 key 或删了就作废
  let lastCheck = null;
  const enabled = new Set(config.columns);
  const allowedHosts = new Set([`127.0.0.1:${apiPort}`, `localhost:${apiPort}`]);
  const allowedOrigins = new Set(
    [apiPort, uiPort].filter(Boolean).flatMap((port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]),
  );

  // 界面上「在访达中打开 / 打开」能用的固定位置
  const places = {
    workFolder: { target: config.workFolder, label: "工作文件夹" },
    topics: { target: config.paths.topics, label: "选题库", column: "content" },
    overview: { target: config.paths.overview, label: "选题总览", column: "content" },
    drafts: { target: config.paths.drafts, label: "内容草稿", column: "content" },
    writingMethod: { target: config.paths.writingMethod, label: "写稿方法", column: "content" },
    prompts: { target: config.paths.prompts, label: "提示词文件夹", column: "prompts" },
    promptFormat: { target: path.join(config.paths.prompts, "_格式说明.md"), label: "提示词格式说明", column: "prompts" },
    // 市场调研的三个文件夹是结构：不见了就先建好再打开
    benchmarkAccounts: { target: config.paths.benchmarkAccounts, label: "对标账号文件夹", column: "research", ensure: true },
    researchReports: { target: config.paths.researchReports, label: "调研报告文件夹", column: "research", ensure: true },
    commentImports: { target: config.paths.commentImports, label: "评论导入文件夹", column: "research", ensure: true },
    // 封面（1.1 加）：封面素材和里面的「我的照片」是结构，不见了先建好再打开
    coverAssets: { target: config.paths.coverAssets, label: "封面素材文件夹", column: "content", ensure: true },
    photos: { target: path.join(config.paths.coverAssets, PHOTO_DIR), label: "我的照片文件夹", column: "content", ensure: true },
    trash: { target: config.paths.trash, label: "回收站" },
  };

  function rejectCrossSite(req, res, { requireJson = false } = {}) {
    if (!allowedHosts.has(req.headers.host ?? "")) {
      send(res, 403, { error: "只接受本机的请求。" });
      return true;
    }
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) {
      send(res, 403, { error: "只接受本机工作台页面发来的请求。" });
      return true;
    }
    if (requireJson && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      send(res, 415, { error: "请求格式要是 JSON。" });
      return true;
    }
    return false;
  }

  // 传图片、评论表：请求体是原始字节。只收 application/octet-stream（别的网页不先问过就发不了这种请求）
  function rejectBinary(req, res) {
    if (rejectCrossSite(req, res)) return true;
    if (!String(req.headers["content-type"] ?? "").startsWith("application/octet-stream")) {
      send(res, 415, { error: "请求格式不对。" });
      return true;
    }
    return false;
  }

  function needColumn(key) {
    if (!enabled.has(key)) throw fail("这个栏目在设置里关掉了。", 404, "column-off");
  }

  async function appInfo() {
    // 市场调研还差几步：TikHub 没接好算一步，评论导入里还没有认出来的评论表算一步（左边菜单上显示「还差 2 步」）
    let missing = 0;
    if (enabled.has("research")) {
      const [hasKey, imports] = await Promise.all([keyStore.exists(), Promise.resolve(scanCommentImports(config.paths.commentImports))]);
      missing = (hasKey ? 0 : 1) + (imports.configured ? 0 : 1);
    }
    return {
      app: { id: BRAND.id, name: BRAND.name, tagline: BRAND.tagline, version: VERSION },
      columns: config.columns,
      contentTypes: config.contentTypes,
      home: config.home,
      workFolder: config.workFolder,
      paths: { ...config.paths },
      configFile: config.file,
      issues: config.issues,
      // 创作页：写稿 Skill 的名字、工作台仓库的位置（「复制给 AI 的话」里要写）、保存服务这次的端口
      creation: { skill: `${BRAND.id}-write`, repo: REPO, savePort },
      // 市场调研：调研 Skill 的名字、还差几步没配好
      research: { skill: RESEARCH_SKILL, missing },
      // 封面（1.1 加）：封面 Skill 的名字（「复制给 AI 的话」里要写）
      cover: { skill: COVER_SKILL },
      // 新手指引第 3 步：能不能用官方链接一键在 AI 里打开工作文件夹（这台 Mac 上有程序接这种链接才放按钮）
      aiLinks: await aiLinks().catch(() => ({ codex: false, "claude-desktop": false, claude: false })),
    };
  }

  /** 「数据来源」两张卡片要的东西。没接 TikHub 时不连外网；接好了才现查单价（12 小时一次，不等它） */
  async function sourcesInfo() {
    const status = await keyStore.status();
    if (status.configured) void priceBook.refresh();
    const imports = scanCommentImports(config.paths.commentImports);
    const check = lastCheck && status.configured && lastCheck.last4 === status.last4 ? lastCheck : null;
    return {
      tikhub: {
        configured: status.configured,
        source: status.source,
        last4: status.last4,
        keychainOk: status.keychainOk,
        check,
        cost: priceBook.estimate(),
        links: { register: TIKHUB.registerUrl, keys: TIKHUB.keysUrl, addCredit: TIKHUB.addCreditUrl, pricing: TIKHUB.pricingUrl },
        newCredit: NEW_ACCOUNT_CREDIT_USD,
        minTopUp: MIN_TOP_UP_USD,
      },
      social: { ...SOCIAL_HELPER, imports },
      missing: (status.configured ? 0 : 1) + (imports.configured ? 0 : 1),
    };
  }

  /** 检测一个 key，同时现查一下单价（用户这时已经在用 TikHub 了）。结果里只留 key 的后四位 */
  async function checkKey(key, source) {
    const [result] = await Promise.all([testKey(key, { env: tikhubEnv, fetchImpl }), priceBook.refresh()]);
    return { ...result, last4: key.slice(-4), source };
  }

  async function openPlace(name) {
    const place = places[name];
    if (!place) throw fail("不认识要打开的位置。", 400);
    if (place.column) needColumn(place.column);
    if (place.ensure) mkdirSync(place.target, { recursive: true });
    if (!existsSync(place.target)) throw fail(`${place.label}不见了，可能被移走或删除了：${place.target}`, 404);
    const result = await opener.open(place.target, { reveal: statSync(place.target).isDirectory() });
    const how = result.how === "finder" ? "在访达中打开" : result.how === "text" ? "用「文本编辑」打开" : "用默认程序打开";
    return { ok: true, message: `已${how}${place.label}。`, dryRun: opener.dryRun || undefined };
  }

  // 封面的接口（1.1 加）：处理了返回 true。出图、拆 VI 交给 AI；这里只做选定、删除、收藏、批注、照片、默认对标
  async function handleCovers(req, res, url, route, method) {
    if (method === "GET" && route === "/api/covers") {
      if (rejectCrossSite(req, res)) return true;
      needColumn("content");
      const settings = readCoverSettings(config);
      let benchmarks = [];
      if (enabled.has("research")) {
        const reports = listReports(config.paths.researchReports);
        benchmarks = listAccounts(config.paths.benchmarkAccounts).map((account) => ({
          name: account.name,
          accountName: account.accountName,
          platform: account.platform,
          vi: accountVi(config, account.name, { settings, reports }),
        }));
      }
      send(res, 200, {
        folder: config.paths.coverAssets,
        settings: { photo: settings.photo, benchmark: settings.benchmark, batchSize: settings.batchSize, problem: settings.problem },
        photos: listPhotos(config),
        favorites: listFavorites(config),
        benchmarks,
      });
      return true;
    }
    if (method === "POST" && route === "/api/covers/photo") {
      if (rejectBinary(req, res)) return true;
      needColumn("content");
      const buffer = await readBuffer(req, 20 * 1024 * 1024, "照片超过 20 MB 了，换一张小一点的。");
      send(res, 201, savePhoto(config, { filename: url.searchParams.get("filename"), buffer }));
      return true;
    }
    const photo = method === "GET" && route.match(/^\/api\/covers\/photo\/([^/]+)$/);
    if (photo) {
      if (rejectCrossSite(req, res)) return true;
      needColumn("content");
      streamFile(res, photoFile(config, decodePart(photo[1])), { "Cache-Control": "private, max-age=60" });
      return true;
    }
    const favorite = method === "GET" && route.match(/^\/api\/covers\/favorite\/([^/]+)$/);
    if (favorite) {
      if (rejectCrossSite(req, res)) return true;
      needColumn("content");
      streamFile(res, favoriteFile(config, decodePart(favorite[1])), { "Cache-Control": "private, max-age=60" });
      return true;
    }
    const topic = route.match(/^\/api\/works\/(T\d{3,4})\/covers(?:\/(.*))?$/);
    if (!topic) return false;
    const id = topic[1];
    const rest = topic[2] ?? "";
    needColumn("content");
    if (method === "GET" && rest === "") {
      if (rejectCrossSite(req, res)) return true;
      send(res, 200, topicCovers(config, works, id));
      return true;
    }
    if (method === "GET" && rest.startsWith("file/")) {
      if (rejectCrossSite(req, res)) return true;
      const relative = rest.slice(5).split("/").map(decodePart).join("/");
      // 图会被覆盖（封面-选定）或者一直不变（候选）：不缓存，免得选定了换张图页面上还是旧的
      streamFile(res, coverFile(config, works, id, relative), { "Cache-Control": "no-cache" });
      return true;
    }
    if (method === "POST" && rest === "annotate") {
      if (rejectBinary(req, res)) return true;
      const buffer = await readBuffer(req, 20 * 1024 * 1024, "批注图太大了。");
      send(res, 201, saveAnnotation(works, id, url.searchParams.get("no"), buffer, { name: url.searchParams.get("name") }));
      return true;
    }
    if (method === "POST" && ["select", "unselect", "trash", "favorite", "open"].includes(rest)) {
      if (rejectCrossSite(req, res, { requireJson: true })) return true;
      const body = await readJson(req);
      let result;
      if (rest === "select") result = selectCover(config, works, id, body.no);
      else if (rest === "unselect") result = unselectCover(config, works, id);
      else if (rest === "trash") result = trashCover(config, works, id, body.no);
      else if (rest === "favorite") result = favoriteCover(config, works, id, body.no, body.on !== false);
      else {
        // 在访达中打开这条内容的封面候选（还没有就先建好）
        const detail = readWorkDetail(id, works);
        if (!detail.draftDir) throw fail(`${id} 还没有草稿文件夹。`, 404, "no-draft");
        const target = path.join(works.draftsDir, detail.draftDir.name, COVER_DIR);
        mkdirSync(target, { recursive: true });
        const opened = await opener.open(target, { reveal: true });
        result = { ok: true, message: "已在访达中打开封面候选。", dryRun: opener.dryRun || opened?.dryRun || undefined };
      }
      send(res, 200, { ...result, covers: topicCovers(config, works, id) });
      return true;
    }
    return false;
  }

  // 市场调研的接口：处理了返回 true
  async function handleResearch(req, res, url, route, method) {
    const dirs = config.paths;
    if (method === "GET" && route === "/api/research/accounts") {
      if (rejectCrossSite(req, res)) return true;
      needColumn("research");
      const settings = readCoverSettings(config);
      const reports = listReports(dirs.researchReports);
      const accounts = listAccounts(dirs.benchmarkAccounts).map((account) => ({ ...account, vi: accountVi(config, account.name, { settings, reports }) }));
      send(res, 200, { folder: dirs.benchmarkAccounts, platforms: PLATFORMS, accounts });
      return true;
    }
    // 拆 VI 用的封面（对标账号/<名字>/封面/K01.jpg …）
    const viPicture = method === "GET" && route.match(/^\/api\/research\/accounts\/([^/]+)\/vi\/([^/]+)$/);
    if (viPicture) {
      if (rejectCrossSite(req, res)) return true;
      needColumn("research");
      streamFile(res, viImage(config, decodePart(viPicture[1]), decodePart(viPicture[2])), { "Cache-Control": "private, max-age=300" });
      return true;
    }
    if (method === "POST" && route === "/api/research/accounts/vi-default") {
      if (rejectCrossSite(req, res, { requireJson: true })) return true;
      needColumn("research");
      const body = await readJson(req);
      send(res, 200, setDefaultBenchmark(config, body.name));
      return true;
    }
    if (method === "POST" && route === "/api/research/accounts") {
      if (rejectCrossSite(req, res, { requireJson: true })) return true;
      needColumn("research");
      const body = await readJson(req);
      const result = saveAccount(dirs.benchmarkAccounts, body);
      send(res, result.created ? 201 : 200, result);
      return true;
    }
    if (method === "POST" && route === "/api/research/accounts/trash") {
      if (rejectCrossSite(req, res, { requireJson: true })) return true;
      needColumn("research");
      const body = await readJson(req);
      send(res, 200, trashAccount(dirs.benchmarkAccounts, dirs.trash, body.name));
      return true;
    }
    if (method === "POST" && route === "/api/research/accounts/image") {
      if (rejectBinary(req, res)) return true;
      needColumn("research");
      const result = await saveAccountImage(dirs.benchmarkAccounts, {
        name: url.searchParams.get("name"),
        filename: url.searchParams.get("filename"),
        req,
      });
      send(res, 201, result);
      return true;
    }
    const image = method === "GET" && route.match(/^\/api\/research\/accounts\/([^/]+)\/([^/]+)$/);
    if (image) {
      if (rejectCrossSite(req, res)) return true;
      needColumn("research");
      streamFile(res, accountImage(dirs.benchmarkAccounts, decodePart(image[1]), decodePart(image[2])), { "Cache-Control": "private, max-age=300" });
      return true;
    }
    if (method === "GET" && route === "/api/research/reports") {
      if (rejectCrossSite(req, res)) return true;
      needColumn("research");
      send(res, 200, { folder: dirs.researchReports, reports: listReports(dirs.researchReports) });
      return true;
    }
    const page = method === "GET" && route.match(/^\/api\/research\/reports\/([^/]+)\/(.+)$/);
    if (page) {
      if (rejectCrossSite(req, res)) return true;
      needColumn("research");
      const relative = page[2].split("/").map(decodePart).join("/");
      streamFile(res, reportFile(dirs.researchReports, decodePart(page[1]), relative), { "Content-Security-Policy": REPORT_CSP });
      return true;
    }
    if (method === "GET" && route === "/api/research/sources") {
      if (rejectCrossSite(req, res)) return true;
      needColumn("research");
      send(res, 200, await sourcesInfo());
      return true;
    }
    if (method === "POST" && route === "/api/research/comments/import") {
      if (rejectBinary(req, res)) return true;
      needColumn("research");
      const buffer = await readBuffer(req, 50 * 1024 * 1024, "这份表超过 50 MB 了，请分成几份导出。");
      const result = importCommentTable(dirs.commentImports, { filename: url.searchParams.get("filename"), buffer });
      send(res, 201, { ...result, imports: scanCommentImports(dirs.commentImports) });
      return true;
    }
    // TikHub 的 key：只接受本机工作台页面发来的 JSON 请求；回给页面的只有状态、后四位、余额
    if (method === "POST" && route === "/api/research/tikhub/connect") {
      if (rejectCrossSite(req, res, { requireJson: true })) return true;
      needColumn("research");
      const body = await readJson(req);
      const key = cleanKey(body.key);
      const check = await checkKey(key, "keychain");
      // 检测通过才存；没通过时钥匙串里原来的（如果有）不动
      const status = check.result === "ok" ? await keyStore.save(key) : await keyStore.status();
      if (check.result === "ok") lastCheck = check;
      const { last4: _last4, ...shown } = check;
      send(res, 200, { ...shown, saved: check.result === "ok", status, cost: priceBook.estimate() });
      return true;
    }
    if (method === "POST" && route === "/api/research/tikhub/check") {
      if (rejectCrossSite(req, res, { requireJson: true })) return true;
      needColumn("research");
      const found = await keyStore.effectiveKey();
      if (!found) throw fail("还没有接好 TikHub：先粘贴 key，点「检测并保存」。", 404, "no-key");
      const check = await checkKey(found.key, found.source);
      lastCheck = check;
      const { last4: _last4, ...shown } = check;
      send(res, 200, { ...shown, status: await keyStore.status(), cost: priceBook.estimate() });
      return true;
    }
    if (method === "POST" && route === "/api/research/tikhub/delete") {
      if (rejectCrossSite(req, res, { requireJson: true })) return true;
      needColumn("research");
      const status = await keyStore.remove();
      lastCheck = null;
      send(res, 200, {
        ok: true,
        status,
        message: status.configured ? "钥匙串里的 key 删掉了；现在用的是环境变量 TIKHUB_API_KEY 里的 key。" : "已从钥匙串里删掉 TikHub 的 key。",
      });
      return true;
    }
    return false;
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://local");
    const route = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && route === "/") {
        if (rejectCrossSite(req, res)) return;
        res.writeHead(302, { Location: `http://127.0.0.1:${uiPort}/`, "Cache-Control": "no-store" });
        res.end();
        return;
      }
      if (method === "GET" && route === "/api/health") {
        if (rejectCrossSite(req, res)) return;
        // instance：这一份工作台的记号；ui：界面这次的端口（pnpm start 发现已经在运行时，打印这个地址）
        send(res, 200, { ok: true, app: BRAND.id, version: VERSION, instance: config.file ? instanceId(config.file) : null, ui: uiPort });
        return;
      }
      if (method === "GET" && route === "/api/app") {
        if (rejectCrossSite(req, res)) return;
        send(res, 200, await appInfo());
        return;
      }
      if (method === "POST" && route === "/api/open") {
        if (rejectCrossSite(req, res, { requireJson: true })) return;
        const body = await readJson(req);
        send(res, 200, await openPlace(body.place));
        return;
      }

      // —— 内容 ——
      if (method === "GET" && route === "/api/works") {
        if (rejectCrossSite(req, res)) return;
        needColumn("content");
        send(res, 200, readWorks(works));
        return;
      }
      const text = method === "GET" && route.match(/^\/api\/works\/(T\d{3,4})\/text$/);
      if (text) {
        if (rejectCrossSite(req, res)) return;
        needColumn("content");
        send(res, 200, readWorkText(text[1], url.searchParams.get("ref") ?? "", works));
        return;
      }
      const detail = method === "GET" && route.match(/^\/api\/works\/([^/]+)$/);
      if (detail) {
        if (rejectCrossSite(req, res)) return;
        needColumn("content");
        send(res, 200, readWorkDetail(decodeURIComponent(detail[1]), works));
        return;
      }
      if (method === "POST" && ["/api/works/open", "/api/works/resume", "/api/works/draft-folder"].includes(route)) {
        if (rejectCrossSite(req, res, { requireJson: true })) return;
        needColumn("content");
        const body = await readJson(req);
        const result = route.endsWith("/resume")
          ? await resumeWork(body.id, works, { opener })
          : route.endsWith("/draft-folder")
            ? await openDraftFolder(body.id, works, { opener })
            : await openWorkTarget(body.id, body.ref, body.as, works, { opener });
        send(res, 200, result);
        return;
      }
      if (method === "POST" && route === "/api/workspace/restore-overview") {
        if (rejectCrossSite(req, res, { requireJson: true })) return;
        needColumn("content");
        const created = restoreOverview(config);
        send(res, 200, { ok: true, created: created.length > 0, message: created.length ? "已经重新建了一份空白的选题总览。" : "选题总览还在，没有改动。" });
        return;
      }

      // —— 封面（1.1 加）——
      if (route.startsWith("/api/covers") || /^\/api\/works\/[^/]+\/covers(?:\/|$)/.test(route)) {
        if (await handleCovers(req, res, url, route, method)) return;
      }

      // —— 市场调研 ——
      if (route.startsWith("/api/research/")) {
        if (await handleResearch(req, res, url, route, method)) return;
      }

      // —— 提示词 ——
      if (method === "GET" && route === "/api/prompts") {
        if (rejectCrossSite(req, res)) return;
        needColumn("prompts");
        send(res, 200, readPromptLibrary(prompts));
        return;
      }
      if (method === "POST" && ["/api/prompts/use", "/api/prompts/star", "/api/prompts/order", "/api/prompts/delete"].includes(route)) {
        if (rejectCrossSite(req, res, { requireJson: true })) return;
        needColumn("prompts");
        const body = await readJson(req);
        const result = route.endsWith("/use")
          ? recordPromptUse(prompts, { id: body.id })
          : route.endsWith("/star")
            ? setPromptStar(prompts, { id: body.id, starred: body.starred })
            : route.endsWith("/order")
              ? savePromptOrder(prompts, { ids: body.ids })
              : trashPrompts(prompts, { ids: body.ids });
        send(res, route.endsWith("/use") ? 201 : 200, result);
        return;
      }

      send(res, 404, { error: "没有这个接口。" });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      if (status >= 500) log(`[接口出错] ${method} ${route}：${error?.stack ?? error}`);
      if (!res.headersSent) send(res, status, { error: error?.message ?? String(error), code: error?.code });
      else res.end();
    }
  };
}
