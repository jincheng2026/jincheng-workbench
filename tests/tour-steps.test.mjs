// 新手指引的步骤文件（ui/lib/tour-steps.ts）：改步骤时最容易出的错，在这里先拦住。
// Node 24 能直接读 .ts（只去掉类型），所以直接导入那个文件。真的在浏览器里走一遍在 tests/browser/test_tour.py。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AI_LINKS, CREATION_PAGE, TOUR_CARD, TOUR_HINTS, TOUR_STEPS, TOUR_TEXT, TOUR_VERSION, TOUR_WORK, availableAiLinks } from "../ui/lib/tour-steps.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
// 字数：汉字、字母、数字各算一个，标点和空格不算（和创作页数字数一样）
const count = (text) => (String(text).match(/[\p{Script=Han}\p{L}\p{N}]/gu) ?? []).length;

/** 界面代码（ui/ 下的 .ts、.tsx、.css，不含依赖、编译产物和步骤文件本身）连成一段字 */
function uiSources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx?|css)$/.test(name) && name !== "tour-steps.ts") out.push(readFileSync(full, "utf8"));
    }
  };
  walk(path.join(ROOT, "ui"));
  return out.join("\n");
}

test("每一步都写全了：编号不重复，在哪个页面、亮哪个按钮、说什么", () => {
  assert.ok(Number.isInteger(TOUR_VERSION) && TOUR_VERSION >= 1);
  assert.match(TOUR_WORK, /^T\d{3,4}$/);
  const ids = TOUR_STEPS.map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length, `步骤编号有重复：${ids.join("、")}`);
  for (const step of TOUR_STEPS) {
    assert.ok(step.page.startsWith("/"), `${step.id}：page 要写工作台里的地址（/ 开头）`);
    assert.ok(step.text.trim(), `${step.id}：要有气泡里那一句`);
    assert.ok([undefined, "click", "wait"].includes(step.kind), `${step.id}：kind 只能是 click 或 wait`);
    // 点的那种要用户亲手点一个按钮才往下走，等的那种气泡要贴在一个按钮旁边：都要写 target
    assert.ok(step.target, `${step.id}：要写 target（亮哪个按钮、气泡贴在哪）`);
    if (step.kind === "wait") {
      assert.ok(step.waitFor, `${step.id}：等的那一步要写 waitFor（等什么）`);
      assert.match(step.waitFor.creation, /^T\d{3,4}$/, `${step.id}：waitFor.creation 写选题编号`);
      for (const key of ["text", "button", "notYet"]) assert.ok(String(step.waitFor[key] ?? "").trim(), `${step.id}：waitFor.${key} 不能空`);
    } else assert.ok(!step.waitFor, `${step.id}：waitFor 只用在 kind 为 wait 的步骤上`);
    if (step.openParam) assert.match(step.openParam, /^[a-z-]+=[a-z0-9-]+$/, `${step.id}：openParam 写成 名字=值`);
  }
  // 最后一步把用户交给创作页（带参数打开），第二段在创作页里接着走
  assert.ok(TOUR_STEPS.at(-1).openParam, "最后一步要用 openParam 把链接带到创作页");
  assert.ok(TOUR_STEPS.some((step) => !step.uncounted), "至少要有一步算在「第 N 步」里");
  assert.equal(TOUR_CARD.checklist.length, 4, "清单四项：装好、打开示例选题、交给 AI 写第一版、采纳一条（打勾的条件写在 tour.tsx）");
  assert.ok(TOUR_CARD.title.includes("{作者}") || !TOUR_CARD.title.includes("我是"), "开场卡的名字用 {作者}，不写死");
});

test("每句话不超过 40 个字（一个气泡一句话）", () => {
  const sentences = [
    ...TOUR_STEPS.flatMap((step) => [step.text, step.textNarrow, step.doneText, step.barText, step.waitFor?.text, step.waitFor?.notYet].map((text) => [step.id, text])),
    // 气泡里加粗的第一行和下面那句合起来是一句话
    ...TOUR_STEPS.filter((step) => step.title).map((step) => [`${step.id}（title + text）`, `${step.title}${step.text}`]),
    ["AI_LINKS.caption", AI_LINKS.caption],
    ...AI_LINKS.apps.flatMap((app) => [app.label, app.note].map((text) => [`AI_LINKS ${app.name}`, text])),
    ...TOUR_HINTS.map((hint) => [hint.id, hint.text]),
    ...Object.entries(TOUR_TEXT),
    ...Object.entries(TOUR_CARD).flatMap(([key, value]) => (Array.isArray(value) ? value.map((text) => [key, text]) : [[key, value]])),
    ...Object.entries(CREATION_PAGE).flatMap(([key, value]) => (Array.isArray(value) ? value.map((text) => [key, text]) : [[key, value]])),
  ].filter(([, text]) => text);
  for (const [where, text] of sentences) assert.ok(count(text) <= 40, `${where}：「${text}」有 ${count(text)} 个字，超过 40`);
});

test("等 AI 那一步：只说粘贴给 AI、发出去，不让用户先打开哪个文件夹；Codex 写在前面", () => {
  // 提示词标准（原作者 2026-10-03 定，见 AGENTS.md）：复制的那句话在哪个对话、哪个文件夹里发都行，不让用户先做准备
  const wait = TOUR_STEPS.find((step) => step.kind === "wait");
  const said = `${wait.title ?? ""}${wait.text}`;
  assert.match(said, /粘贴/);
  assert.doesNotMatch(said, /打开.*文件夹|新开一个对话/, "不让用户先新开对话、打开哪个文件夹");
  assert.ok(wait.aiLinks, "等 AI 那一步放一键打开的按钮（aiLinks: true）");
  // 原作者 2026-10-03 定：用 Codex 的人多，两家并列时 Codex 在前
  assert.deepEqual(AI_LINKS.apps.map((app) => app.id), ["codex", "claude-desktop", "claude"]);
  for (const text of [wait.title, wait.text, ...TOUR_HINTS.map((hint) => hint.text)].filter(Boolean)) {
    if (text.includes("Codex") && text.includes("Claude Code")) assert.ok(text.indexOf("Codex") < text.indexOf("Claude Code"), `「${text}」：Codex 写在 Claude Code 前面`);
  }
  // 一键打开只用官方文档写明的链接（出处见 docs/开发记录.md「新手指引」），开在工作文件夹、填好那句话；按钮要不要放由接口查（lib/ai-links.mjs）
  for (const app of AI_LINKS.apps) {
    assert.match(app.url, /^(claude-cli|claude|codex):\/\/[^\s]*\{路径\}/, `${app.name}：一键打开的链接要带上工作文件夹`);
    assert.match(app.url, /\{话\}/, `${app.name}：一键打开的链接要填好那句话`);
  }
  // 2026-10-04 原作者试用时发现「在 Claude Code 里打开」开的是终端：装了 Claude 桌面版就开桌面版的 Code，没装才开终端，同名按钮只放一个
  const ids = (found) => availableAiLinks(found).map((app) => app.id);
  assert.deepEqual(ids({ codex: true, "claude-desktop": true, claude: true }), ["codex", "claude-desktop"]);
  assert.deepEqual(ids({ codex: false, "claude-desktop": false, claude: true }), ["claude"]);
  assert.deepEqual(ids({ codex: true, claude: false }), ["codex"], "旧接口没有 claude-desktop 这一项也认");
  assert.deepEqual(ids(null), []);
  assert.equal(AI_LINKS.apps.find((app) => app.id === "claude-desktop").url, "claude://code/new?folder={路径}&q={话}");
});

test("步骤和提示里引用的页面记号，页面代码里真的有", () => {
  const source = uiSources();
  const columns = read("ui/lib/columns.ts");
  // 页面上真的画出来的记号：写在标签属性上的 data-tour="…"，或者按钮组件的 tour="…"（选择器里的 [data-tour="…"] 不算）
  const markers = new Set([...source.matchAll(/\s(?:data-)?tour="([^"]+)"/g)].map((m) => m[1]));
  const selectors = [
    ...TOUR_STEPS.flatMap((step) => (Array.isArray(step.target) ? step.target : step.target ? [step.target] : [])).map((t) => (typeof t === "string" ? t : t.in ?? "")),
    ...TOUR_HINTS.map((hint) => ("click" in hint.when ? hint.when.click : "")),
  ].join(" ");
  for (const [, name] of selectors.matchAll(/data-tour="([^"]+)"/g)) {
    const tab = name.match(/^tab-(.+)$/);
    const found = tab ? columns.includes(`key: '${tab[1]}'`) : markers.has(name);
    assert.ok(found, `页面代码里找不到记号 data-tour="${name}"`);
  }
  for (const [, attr] of selectors.matchAll(/\[(data-[a-z-]+)[=\]]/g)) assert.ok(new RegExp(`\\s${attr}=`).test(source), `页面代码里找不到 ${attr}`);
  // 步骤和提示里写的页面地址：栏目登记过
  for (const page of [...TOUR_STEPS.map((step) => step.page), ...TOUR_HINTS.map((hint) => ("page" in hint.when ? hint.when.page : ""))]) {
    if (!page || page === "creation") continue;
    const base = page.split("?")[0].split("/").slice(0, 2).join("/");
    assert.ok(columns.includes(`href: '${base}'`), `${page}：没有这个栏目`);
  }
});

test("提示：编号不重复，写了什么时候提", () => {
  const ids = TOUR_HINTS.map((hint) => hint.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const hint of TOUR_HINTS) assert.ok(("page" in hint.when && hint.when.page.startsWith("/")) || ("click" in hint.when && hint.when.click), `${hint.id}：when 写 page 或 click`);
});

test("用到时的提示：每个页面都放了显示提示的地方（TourHint），在哪个页面触发都看得到", () => {
  // 提示在没放 <TourHint /> 的页面触发时不显示也不记；页面都放上，才不会有哪句提示永远出不来（市场调研页曾经漏了）
  const pages = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "page.tsx") pages.push(full);
    }
  };
  walk(path.join(ROOT, "ui", "app"));
  let checked = 0;
  for (const file of pages) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("MainLayout")) continue; // 首页只负责跳转，不画页面
    const parts = [...text.matchAll(/from '@\/components\/workbench\/([\w-]+)'/g)].map((m) => read(`ui/components/workbench/${m[1]}.tsx`));
    assert.ok(parts.some((code) => code.includes("<TourHint")), `${path.relative(ROOT, file)}：页面里没有放 <TourHint />`);
    checked += 1;
  }
  assert.ok(checked >= 4, "内容、详情、市场调研、提示词四个页面都查到了");
});

test("创作页里的那几句和步骤文件一样（创作页读不到步骤文件，同样的字写在模板里）", () => {
  const app = read("creation-page/template/app.js");
  const block = app.match(/var GUIDE_TEXT = \{([\s\S]*?)\n {2}\};/)?.[1];
  assert.ok(block, "creation-page/template/app.js 里要有 GUIDE_TEXT");
  const one = (key) => block.match(new RegExp(`\\b${key}: '([^']*)'`))?.[1];
  const expected = {
    count: TOUR_TEXT.count,
    next: CREATION_PAGE.next,
    done: CREATION_PAGE.done,
    skip: TOUR_TEXT.skip,
    skipped: CREATION_PAGE.skipped,
    ok: CREATION_PAGE.ok,
    noSuggestion: CREATION_PAGE.noSuggestion,
    rejectHint: CREATION_PAGE.rejectHint,
    hintOk: TOUR_TEXT.hintOk,
    hintOff: TOUR_TEXT.hintOff,
  };
  for (const [key, text] of Object.entries(expected)) assert.equal(one(key), text, `创作页模板 GUIDE_TEXT.${key} 和 ui/lib/tour-steps.ts 不一样，两边要一起改`);
  const steps = block.match(/\bsteps: \[([^\]]*)\]/)?.[1];
  assert.ok(steps, "创作页模板 GUIDE_TEXT 里要有 steps");
  assert.deepEqual([...steps.matchAll(/'([^']*)'/g)].map((m) => m[1]), CREATION_PAGE.steps, "创作页模板 GUIDE_TEXT.steps 和 ui/lib/tour-steps.ts 的 CREATION_PAGE.steps 不一样");
  // 工作台带过去的参数，创作页认得
  const param = TOUR_STEPS.at(-1).openParam.split("=")[1];
  assert.ok(app.includes(`GUIDE_PARAM = '${param}'`), `创作页模板要认得 guide=${param}`);
});
