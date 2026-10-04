'use client';

// 新手指引，工作台这一边。写什么、带用户做哪几件事在 lib/tour-steps.ts；这里管怎么走：
// - 「内容」页顶部那张卡（TourCard，嵌在页面里、不压暗）：作者的口吻一句话、一张清单「N/4」按真实进度打勾，「带我走一遍」「我自己看」；
//   「我自己看」以后收成一行「新手指引」，清单全勾上以后收成一行「重看引导」。
// - 一步一步：点的那种画面变暗、只亮一个按钮（暗层、亮框、气泡由 driver.js 画，MIT），用户亲手点了才往下走，点完弹一句完成反馈；
//   等的那种不压暗，气泡贴在按钮旁边（TourFloat），顶上细栏「等 AI 写完」每隔几秒问一下后台有没有创作页，有了自动往下走。
//   等 AI 那一步只说「粘贴给 Codex 或 Claude Code，发出去」：那句话在哪个对话里发都行。这台 Mac 上装了 Codex、Claude Code 的，
//   气泡里再放一键打开的按钮（AiLinksBlock，Codex 在前），在工作文件夹里新开对话、那句话已经填好。
// - 走到第几步记在浏览器里（localStorage 的 workbench-tour）：换页面、刷新、切去 AI 窗口再回来都接着走；
//   不在这一步的页面时，顶上细栏「接着走」。到了页面、数据到齐以后还找不到要亮的按钮，这一步跳过。
// - 最后点「打开创作页」时给链接加上参数，创作页（保存服务的另一个网页）接着带第二段，工作台这边就算走完了。
// - 每一步都能跳过（Esc 也是），跳的时候说清在哪重看。左下角（窄屏在右上角）「新手指引」从第 1 步重走。
// - 用到时再提示（TourHint，嵌在页面里）：第一次进某个页面、第一次点某个按钮提一句，只出一次；「不再显示这类提示」一起关掉。
// 页面告诉这里自己的数据到齐了没有：「内容」页用 useTourBoard，详情页用 useTourDetail（数据到齐再亮，免得亮一个空位置）。
import 'driver.js/dist/driver.css';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import { AppWindow, Check, ChevronRight, Compass, Lightbulb, PenLine, SquareTerminal } from 'lucide-react';
import type { Driver, PopoverDOM } from 'driver.js';
import { useAppInfo } from '@/components/jc/app-info';
import { Spinner } from '@/components/jc/ui';
import { APP_AUTHOR } from '@/lib/app-info';
import { askAiText, fetchWorkDetail } from '@/lib/works';
import {
   AI_LINKS,
   availableAiLinks,
   TOUR_CARD,
   TOUR_HINTS,
   TOUR_STEPS,
   TOUR_TEXT,
   TOUR_VERSION,
   TOUR_WORK,
   type AiLink,
   type TourHint,
   type TourStep,
   type TourTarget,
} from '@/lib/tour-steps';

const SAVED_KEY = 'workbench-tour';
const HINTS_KEY = 'workbench-hints';
const RELOAD_EVENT = 'workbench:reload'; // 等到创作页以后让页面重新读一次，「打开创作页」才会出来
const NARROW = '(max-width: 720px)';
const MISSING_GRACE = 1200; // 页面数据到齐以后，要亮的按钮最多再等这么久（页面还在重画）
const NAV_GRACE = 6000; // 点完以后页面在换、在重新读：下一步的按钮最多等这么久
const POLL_MS = 3000; // 等 AI 时多久问一次
const COUNTED = TOUR_STEPS.filter((step) => !step.uncounted);
const HANDOFF = Math.max(0, TOUR_STEPS.findIndex((step) => step.openParam)); // 打开创作页那一步

type Status = 'idle' | 'running' | 'done' | 'skipped';
type Saved = { v: number; status: Status; step: number; card: 'open' | 'collapsed'; opened: boolean };
type Hints = { off: boolean; seen: string[] };
type Example = { exists: boolean; tab: string; creation: boolean; adopted: boolean };
type Board = { ready: boolean; tab: string; example: Example };
type Detail = { id: string; ready: boolean; creation: boolean };
type Snap = {
   saved: Saved; // 记在浏览器里的进度和那张卡收没收
   hints: Hints;
   path: string;
   board: Board | null; // 「内容」页：数据到齐了没有、在哪个页签、示例选题在哪、有没有创作页、采纳过没有
   detail: Detail | null; // 详情页：哪一条、数据到齐了没有、有没有创作页
   active: number | null; // 正亮着第几步（压暗的那种）
   floating: number | null; // 正贴着按钮显示第几步的气泡（不压暗的那种）
   feedback: { key: number; text: string } | null;
   hint: { id: string; text: string } | null;
   slots: number; // 这一页放了几处提示（TourHint）：没有放的页面不提，免得白白记成「提过了」
   waitNote: string;
};
const FRESH: Saved = { v: TOUR_VERSION, status: 'idle', step: 0, card: 'open', opened: false };

// ======================= 记在浏览器里的东西 =======================
function readJson<T>(key: string): T | null {
   try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
   } catch {
      return null;
   }
}
function writeJson(key: string, value: unknown) {
   try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
   } catch {
      /* 记不住也不影响这一次用 */
   }
}
function loadSaved(): Saved {
   const p = readJson<Partial<Saved>>(SAVED_KEY);
   if (!p || p.v !== TOUR_VERSION) return { ...FRESH };
   const status = (['idle', 'running', 'done', 'skipped'] as const).find((s) => s === p.status) ?? 'idle';
   const step = Number.isInteger(p.step) && Number(p.step) >= 0 && Number(p.step) <= TOUR_STEPS.length ? Number(p.step) : 0;
   return { v: TOUR_VERSION, status, step, card: p.card === 'collapsed' ? 'collapsed' : 'open', opened: !!p.opened };
}
function loadHints(): Hints {
   const h = readJson<Partial<Hints>>(HINTS_KEY);
   return { off: !!h?.off, seen: Array.isArray(h?.seen) ? h.seen.filter((x): x is string => typeof x === 'string') : [] };
}

// ======================= 一份全局的状态，页面换了也还在 =======================
const SERVER_SNAP: Snap = {
   saved: FRESH,
   hints: { off: false, seen: [] },
   path: '',
   board: null,
   detail: null,
   active: null,
   floating: null,
   feedback: null,
   hint: null,
   slots: 0,
   waitNote: '',
};
let snap: Snap = SERVER_SNAP;
let loaded = false;
const listeners = new Set<() => void>();
function set(patch: Partial<Snap>) {
   snap = { ...snap, ...patch };
   listeners.forEach((listener) => listener());
}
function getSnap(): Snap {
   if (!loaded && typeof window !== 'undefined') {
      loaded = true;
      snap = { ...snap, saved: loadSaved(), hints: loadHints() };
      installListeners();
   }
   return snap;
}
function subscribe(listener: () => void) {
   listeners.add(listener);
   return () => {
      listeners.delete(listener);
   };
}
function useTour() {
   return useSyncExternalStore(subscribe, getSnap, () => SERVER_SNAP);
}
function save(patch: Partial<Saved>) {
   const saved = { ...snap.saved, ...patch };
   writeJson(SAVED_KEY, saved);
   set({ saved });
}

// ======================= 小工具 =======================
const isNarrow = () => window.matchMedia(NARROW).matches;
const stepText = (step: TourStep) => (isNarrow() && step.textNarrow ? step.textNarrow : step.text);
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const frame = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
// 字数：汉字、字母、数字各算一个（和创作页一样），完成反馈停多久按字数算
const countChars = (text: string) => (text.match(/[\p{Script=Han}\p{L}\p{N}]/gu) ?? []).length;
/** 「我是{作者}，…」：换成 brand.json 的署名；没有署名时「我是{作者}，」这几个字不显示 */
const withAuthor = (text: string) => (APP_AUTHOR ? text.replaceAll('{作者}', APP_AUTHOR) : text.replace(/我是\{作者\}[，,]?/g, '').replaceAll('{作者}', ''));

/** 一键打开的链接：{路径} 换成工作文件夹、{话} 换成复制给 AI 的那句话（和详情页上的一字不差），都按网址编码 */
function openLink(app: AiLink, folder: string, skill: string) {
   if (!folder) return '';
   return app.url.replaceAll('{路径}', encodeURIComponent(folder)).replaceAll('{话}', encodeURIComponent(askAiText({ id: TOUR_WORK }, skill)));
}

/** 气泡角上那一行：「第 N 步，共 M 步」，不算步数的那步写「新手指引」 */
function countLabel(index: number) {
   const step = TOUR_STEPS[index];
   if (!step || step.uncounted) return TOUR_TEXT.uncounted;
   return TOUR_TEXT.count.replace('{n}', String(COUNTED.indexOf(step) + 1)).replace('{total}', String(COUNTED.length));
}
/** 清单四项：装好就算；打开过示例选题；示例选题有了创作页；创作页里采纳过一条 */
function checklist(s: Snap) {
   const ex = s.board?.example;
   const done = [true, !!(s.saved.opened || ex?.creation), !!ex?.creation, !!ex?.adopted];
   return { done, count: done.filter(Boolean).length };
}

/** 「内容」页顶部那张卡是整张摊开（正走着、还没走完也没点「我自己看」），还是收成了一行 */
function cardOpen(s: Snap) {
   const { done, count } = checklist(s);
   return s.saved.status === 'running' || !(count === done.length || s.saved.card === 'collapsed');
}

/** 页面地址写法：'/content'、'/content?tab=topics'（地址加页签）、'/content/T001' */
function parsePage(page: string) {
   const [path, query = ''] = page.split('?');
   return { path, tab: new URLSearchParams(query).get('tab') };
}
function onPage(page: string) {
   const { path, tab } = parsePage(page);
   if (snap.path !== path) return false;
   return !tab || snap.board?.tab === tab;
}
function pageReady(page: string) {
   const { path } = parsePage(page);
   if (path === '/content') return !!snap.board?.ready;
   const detail = path.match(/^\/content\/([^/]+)$/);
   if (detail) return !!snap.detail?.ready && snap.detail.id === decodeURIComponent(detail[1]);
   return true;
}
/** 这条内容已经有创作页了（详情页或「内容」页读到的） */
function creationKnown(id: string) {
   return (snap.detail?.id === id && snap.detail.creation) || (id === TOUR_WORK && !!snap.board?.example.creation);
}
/** 这一步要点的是示例选题那一行，示例选题却在另一个页签（比如已经开始写了，在「在做」里） */
function exampleOnOtherTab(step: TourStep) {
   const board = snap.board;
   if (!board?.ready || !board.example.exists || board.tab === board.example.tab) return false;
   return parsePage(step.page).path === '/content' && JSON.stringify(step.target ?? '').includes(`data-work=\\"${TOUR_WORK}\\"`);
}

/** 看得见：在页面上、有大小（display: none、收起的 details、窄屏藏起来的左栏都算看不见） */
function visible(el: Element | null): el is HTMLElement {
   if (!(el instanceof HTMLElement) || !el.isConnected) return false;
   const r = el.getBoundingClientRect();
   return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}
const CLICKABLE = 'a, button, summary, label, [role="button"], [data-tour]';
function findOne(target: TourTarget): HTMLElement | null {
   try {
      if (typeof target === 'string') return [...document.querySelectorAll(target)].find(visible) ?? null;
      const want = target.text.replace(/\s+/g, ' ').trim();
      const scopes = target.in ? [...document.querySelectorAll(target.in)] : [document.body];
      for (const scope of scopes) {
         const hit = [...scope.querySelectorAll(CLICKABLE)].find((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim() === want && visible(el));
         if (hit) return hit as HTMLElement;
      }
   } catch (error) {
      console.warn('新手指引：要亮的东西写错了', target, error);
   }
   return null;
}
function findTarget(target: TourStep['target']): HTMLElement | null {
   if (!target) return null;
   for (const one of Array.isArray(target) ? target : [target]) {
      const el = findOne(one);
      if (el) return el;
   }
   return null;
}
/** 等要亮的按钮出来；页面还在换、还在读的时候多等一会儿。cancelled() 为真就不等了 */
async function waitTarget(target: TourStep['target'], ms: number, cancelled: () => boolean) {
   const end = Date.now() + ms;
   for (;;) {
      const el = findTarget(target);
      if (el || cancelled() || Date.now() >= end) return el;
      await sleep(100);
   }
}
/** 等它不动了再亮：内容刚浮上来时还在位移，量早了亮框会偏 */
async function settle(el: HTMLElement) {
   let last = el.getBoundingClientRect();
   const end = Date.now() + 900;
   while (Date.now() < end) {
      await frame();
      await frame();
      const r = el.getBoundingClientRect();
      if (Math.abs(r.top - last.top) < 0.5 && Math.abs(r.left - last.left) < 0.5 && Math.abs(r.width - last.width) < 0.5 && Math.abs(r.height - last.height) < 0.5) return;
      last = r;
   }
}

// ======================= 亮按钮（driver.js）和贴着按钮的气泡 =======================
let drv: Driver | null = null;
let shownEl: HTMLElement | null = null; // 压暗时亮着的按钮
let floatEl: HTMLElement | null = null; // 不压暗时气泡贴着的按钮
let run = 0; // 每次重新判断加 1，旧的等待作废
let navGraceUntil = 0;
let router: { push: (href: string) => void } | null = null;

async function getDriver(): Promise<Driver> {
   if (drv) return drv;
   const { driver } = await import('driver.js');
   if (drv) return drv;
   const still = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
   drv = driver({
      animate: still,
      duration: 460,
      smoothScroll: still,
      overlayColor: '#0b1322',
      overlayOpacity: 0.55,
      stagePadding: 6,
      stageRadius: 12,
      popoverOffset: 10,
      allowClose: true, // Esc 等于跳过
      allowKeyboardControl: true,
      disableActiveInteraction: false, // 亮着的按钮要能点
      overlayClickBehavior: () => nudge(), // 点暗处不关，气泡晃一下，提醒点亮着的那个
      showButtons: [],
      popoverClass: 'jc-tour',
      onPopoverRender: (popover) => decorate(popover),
      // 第一次亮时要先把按钮滚到眼前：driver.js 在滚动前就摆好气泡，动画没播完又不理滚动，气泡会留在滚动前的位置。播完再摆一次
      onHighlighted: () => drv?.refresh(),
      onDestroyStarted: () => skip(),
   });
   return drv;
}

/** 气泡：最上面一行「第 N 步，共 M 步」和「跳过」，下面那一句由 driver.js 放 */
function decorate(popover: PopoverDOM) {
   const index = snap.active;
   const top = document.createElement('div');
   top.className = 'jc-tour-top';
   const count = document.createElement('span');
   count.className = 'jc-tour-count';
   count.textContent = index === null ? '' : countLabel(index);
   const skipButton = document.createElement('button');
   skipButton.type = 'button';
   skipButton.className = 'jc-tour-skip';
   skipButton.textContent = TOUR_TEXT.skip;
   skipButton.addEventListener('click', () => skip());
   top.append(count, skipButton);
   popover.wrapper.insertBefore(top, popover.title);
   // driver.js 把焦点放在气泡里第一个按钮（「跳过」）上，回车就跳过了：挪到亮着的按钮上，回车等于点它
   const el = shownEl;
   window.setTimeout(() => {
      const focusable = el && (el.matches('a, button') ? el : el.querySelector<HTMLElement>('a, button'));
      focusable?.focus({ preventScroll: true });
   }, 0);
}

function nudge() {
   const popover = drv?.getState('popover') as PopoverDOM | undefined;
   if (!popover) return;
   popover.wrapper.classList.remove('jc-tour-nudge');
   void popover.wrapper.offsetWidth;
   popover.wrapper.classList.add('jc-tour-nudge');
}

function clearHighlight() {
   shownEl = null;
   if (snap.active !== null) set({ active: null });
   const d = drv;
   drv = null;
   d?.destroy();
}
function clearAll() {
   run += 1;
   clearHighlight();
   floatEl = null;
   if (snap.floating !== null) set({ floating: null });
}

async function show(index: number, el: HTMLElement, token: number) {
   const d = await getDriver();
   if (token !== run) return;
   const step = TOUR_STEPS[index];
   shownEl = el;
   set({ active: index, hint: null });
   d.highlight({ element: el, popover: { description: escapeHtml(stepText(step)), side: step.side ?? 'bottom', align: 'start' } });
}

async function locateAndShow(index: number, token: number) {
   const step = TOUR_STEPS[index];
   const el = await waitTarget(step.target, Math.max(MISSING_GRACE, navGraceUntil - Date.now()), () => token !== run);
   if (token !== run) return;
   if (!el) return advance(index + 1); // 这一步要亮的东西不在（比如 T001 已经有创作页，交给 AI 的那句话就不显示）：跳过
   await settle(el);
   if (token !== run) return;
   await show(index, el, token);
}

async function locateFloat(index: number, token: number) {
   const step = TOUR_STEPS[index];
   const el = await waitTarget(step.target, Math.max(MISSING_GRACE, navGraceUntil - Date.now()), () => token !== run);
   if (token !== run) return;
   floatEl = el;
   set({ floating: el ? index : null });
}

/** 看现在该干什么：亮第几步、贴哪个气泡，还是什么都不做。进度、页面、页面数据一变就叫一次 */
function sync() {
   if (typeof window === 'undefined') return;
   const token = ++run;
   const { saved } = snap;
   if (saved.status !== 'running') {
      clearHighlight();
      if (snap.floating !== null) set({ floating: null });
      return;
   }
   // 示例选题不在了：这一套走不了，说一声
   if (snap.board?.ready && !snap.board.example.exists && snap.path === '/content') {
      clearHighlight();
      save({ status: 'idle' });
      feedback(TOUR_TEXT.noExample);
      return;
   }
   const step = TOUR_STEPS[saved.step];
   if (!step) {
      clearHighlight();
      save({ status: 'done' });
      return;
   }
   if (step.kind === 'wait') {
      clearHighlight();
      if (step.waitFor && creationKnown(step.waitFor.creation)) return advance(saved.step + 1, true);
      if (onPage(step.page) && pageReady(step.page)) {
         if (snap.floating !== saved.step || !floatEl?.isConnected) void locateFloat(saved.step, token);
      } else if (snap.floating !== null) set({ floating: null });
      return;
   }
   if (snap.floating !== null) set({ floating: null });
   if (snap.active === saved.step && shownEl?.isConnected) return; // 已经亮着
   if (!onPage(step.page)) return clearHighlight(); // 顶上的细栏「接着走」
   if (exampleOnOtherTab(step)) return router?.push(`/content?tab=${snap.board!.example.tab}`);
   if (!pageReady(step.page)) return; // 数据到齐时页面会再叫
   void locateAndShow(saved.step, token);
}

/** 走到第 index 步（超过最后一步就算走完）。点的多半是链接，页面在换，下一步的按钮多等一会儿 */
function advance(index: number, reload = false) {
   navGraceUntil = Date.now() + NAV_GRACE;
   save(TOUR_STEPS[index] ? { status: 'running', step: index } : { status: 'done', step: index });
   set({ waitNote: '' });
   if (reload) window.dispatchEvent(new Event(RELOAD_EVENT));
   sync();
}

/** 用户亲手点了亮着的按钮 */
function stepDone(index: number) {
   if (snap.active !== index) return;
   const step = TOUR_STEPS[index];
   clearHighlight();
   if (step.doneText) feedback(step.doneText);
   if (step.openParam || !TOUR_STEPS[index + 1]) save({ status: 'done', step: index + 1 }); // 打开了创作页：工作台这边走完了
   else advance(index + 1);
}

function skip() {
   clearAll();
   save({ status: 'skipped' });
   set({ waitNote: '' });
   feedback(isNarrow() ? TOUR_TEXT.skippedNarrow : TOUR_TEXT.skipped);
}

function start(step = 0) {
   clearFeedback(); // 刚才「我自己看」那句还挂着的话，开始走了就收起
   save({ status: 'running', step, card: 'open' });
   const target = TOUR_STEPS[step];
   if (target && !onPage(target.page) && parsePage(target.page).path !== '/content') router?.push(target.page);
   sync();
}

/** 「我自己看」：卡收成一行，正在走的停下 */
function later() {
   clearAll();
   save({ card: 'collapsed', status: snap.saved.status === 'running' ? 'skipped' : snap.saved.status });
   feedback(isNarrow() ? TOUR_TEXT.skippedNarrow : TOUR_TEXT.skipped);
}

function resume() {
   const step = TOUR_STEPS[snap.saved.step];
   if (step && !onPage(step.page)) router?.push(step.page);
   else sync();
}

/** 「新手指引」「重看引导」：从第 1 步重走，用到时的提示也重新打开 */
export function restartTour() {
   clearAll();
   clearFeedback();
   writeJson(HINTS_KEY, null);
   set({ hints: { off: false, seen: [] }, hint: null, waitNote: '' });
   save({ status: 'running', step: 0, card: 'open' });
   if (snap.path !== '/content') router?.push('/content');
   else sync();
}

// ---------- 等 AI ----------
async function checkCreation(manual: boolean) {
   const step = snap.saved.status === 'running' ? TOUR_STEPS[snap.saved.step] : undefined;
   const wait = step?.kind === 'wait' ? step.waitFor : undefined;
   if (!wait) return;
   try {
      if ((await fetchWorkDetail(wait.creation)).creation && TOUR_STEPS[snap.saved.step] === step) return advance(snap.saved.step + 1, true);
   } catch {
      /* 读不到就等下一次 */
   }
   if (manual) set({ waitNote: wait.notYet });
}

// ---------- 完成反馈和提示 ----------
let feedbackKey = 0;
let feedbackTimer = 0;
function feedback(text: string) {
   window.clearTimeout(feedbackTimer);
   set({ feedback: { key: ++feedbackKey, text } });
   feedbackTimer = window.setTimeout(() => set({ feedback: null }), Math.min(7000, 2600 + countChars(text) * 90));
}
function clearFeedback() {
   window.clearTimeout(feedbackTimer);
   if (snap.feedback) set({ feedback: null });
}
function offerHint(hint: TourHint) {
   const hints = snap.hints;
   if (hints.off || hints.seen.includes(hint.id)) return;
   if (snap.active !== null) return; // 正亮着一步，不插话；下次再提
   if (snap.slots === 0) return; // 这一页没有放提示的地方：不提也不记，换到有地方的页面再提
   const next = { off: hints.off, seen: [...hints.seen, hint.id] };
   writeJson(HINTS_KEY, next);
   set({ hints: next, hint: { id: hint.id, text: hint.text } });
}
function closeHint(off: boolean) {
   if (off) {
      const next = { off: true, seen: snap.hints.seen };
      writeJson(HINTS_KEY, next);
      set({ hints: next, hint: null });
   } else set({ hint: null });
}

// ---------- 点击：亮着的按钮被点了、打开创作页的链接、要提示的按钮 ----------
function decorateCreationLink(link: HTMLAnchorElement) {
   const params: string[] = [];
   const index = snap.active;
   const param = index !== null && shownEl?.contains(link) ? TOUR_STEPS[index].openParam : undefined;
   if (param) params.push(param);
   if (snap.hints.off) params.push('hints=off');
   if (!params.length) return;
   const original = link.getAttribute('href');
   const url = new URL(link.href);
   for (const p of params) {
      const [key, value = ''] = p.split('=');
      url.searchParams.set(key, value);
   }
   // 点击还没处理完时改地址，浏览器按新地址打开；之后改回来，页面上的链接还是原样
   link.setAttribute('href', url.toString());
   window.setTimeout(() => {
      if (original !== null) link.setAttribute('href', original);
   }, 0);
}
function onDocClick(event: MouseEvent) {
   const target = event.target instanceof Element ? event.target : null;
   if (!target) return;
   const link = target.closest<HTMLAnchorElement>('a[data-tour="open-creation"]');
   if (link) decorateCreationLink(link);
   const index = snap.active;
   if (index !== null && shownEl?.contains(target)) window.setTimeout(() => stepDone(index), 0);
   for (const hint of TOUR_HINTS) {
      if ('click' in hint.when && target.closest(hint.when.click)) window.setTimeout(() => offerHint(hint), 400);
   }
}
function installListeners() {
   document.addEventListener('click', onDocClick, true);
   // 另一个标签页里走了一步、跳过了、关了提示：这边跟着变
   window.addEventListener('storage', (event) => {
      if (event.key === SAVED_KEY) {
         set({ saved: loadSaved() });
         sync();
      } else if (event.key === HINTS_KEY) set({ hints: loadHints() });
   });
   // 给以后改步骤时试用，见 lib/tour-steps.ts 开头
   (window as unknown as { workbenchTour?: unknown }).workbenchTour = {
      state: () => ({ saved: snap.saved, hints: snap.hints, active: snap.active, floating: snap.floating, path: snap.path, board: snap.board, detail: snap.detail }),
      restart: restartTour,
      reset: () => {
         clearAll();
         save({ ...FRESH });
         sync();
      },
   };
}

// ======================= 页面告诉这里数据到齐了没有 =======================
/** 「内容」页：数据到齐了没有、正在看哪个页签、示例选题在哪个页签、有没有创作页、采纳过没有 */
export function useTourBoard({ ready, tab, example }: Board) {
   const { exists, tab: exampleTab, creation, adopted } = example;
   useEffect(() => {
      set({ board: { ready, tab, example: { exists, tab: exampleTab, creation, adopted } } });
   }, [ready, tab, exists, exampleTab, creation, adopted]);
   useEffect(
      () => () => {
         set({ board: null });
      },
      []
   );
}
/** 详情页：哪一条、数据到齐了没有、有没有创作页。打开过示例选题，清单第二项就打勾 */
export function useTourDetail(id: string, ready: boolean, creation: boolean) {
   useEffect(() => {
      set({ detail: { id, ready, creation } });
      if (ready && id === TOUR_WORK && !snap.saved.opened) save({ opened: true });
   }, [id, ready, creation]);
   useEffect(
      () => () => {
         set({ detail: null });
      },
      []
   );
}
/** 新手指引等到创作页以后，让页面重新读一次 */
export function useTourReload(load: () => void) {
   useEffect(() => {
      const handler = () => load();
      window.addEventListener(RELOAD_EVENT, handler);
      return () => window.removeEventListener(RELOAD_EVENT, handler);
   }, [load]);
}

// ======================= 画出来的部分 =======================
/** 放在每个页面的外框里：顶上的细栏照常排在内容最上面；完成反馈、不压暗的气泡浮在页面上 */
export function TourLayer() {
   const s = useTour();
   const pathname = usePathname();
   const nextRouter = useRouter();
   const [mounted, setMounted] = useState(false);
   useEffect(() => {
      router = nextRouter;
      setMounted(true);
   }, [nextRouter]);
   // 换了页面或页签：上一处的提示收起
   const place = `${pathname}|${s.board?.tab ?? ''}`;
   useEffect(() => {
      if (snap.path !== pathname) set({ path: pathname });
      if (snap.hint) set({ hint: null });
   }, [place, pathname]);
   // 进度、页面、页面数据一变：看现在该干什么
   useEffect(() => {
      sync();
   }, [s.path, s.saved, s.board, s.detail]);
   // 第一次进某个页面：提一句（页面画出来以后）
   useEffect(() => {
      const hint = TOUR_HINTS.find((h) => 'page' in h.when && onPage(h.when.page));
      if (!hint || ('page' in hint.when && parsePage(hint.when.page).path === '/content' && !s.board?.ready)) return;
      const timer = window.setTimeout(() => {
         if ('page' in hint.when && onPage(hint.when.page)) offerHint(hint);
      }, 600);
      return () => window.clearTimeout(timer);
   }, [s.path, s.board?.tab, s.board?.ready, s.active, s.slots]);
   // 等 AI：每隔几秒问一下，切回这个窗口时马上问
   const waiting = s.saved.status === 'running' && TOUR_STEPS[s.saved.step]?.kind === 'wait';
   useEffect(() => {
      if (!waiting) return;
      const check = () => {
         if (document.visibilityState === 'visible') void checkCreation(false);
      };
      check();
      const timer = window.setInterval(check, POLL_MS);
      window.addEventListener('focus', check);
      return () => {
         window.clearInterval(timer);
         window.removeEventListener('focus', check);
      };
   }, [waiting]);

   return (
      <>
         <TourBar s={s} />
         {mounted &&
            createPortal(
               <>
                  {s.floating !== null && <TourFloat key={s.floating} index={s.floating} />}
                  {s.feedback && <Feedback key={s.feedback.key} text={s.feedback.text} />}
               </>,
               document.body
            )}
      </>
   );
}

/** 顶上细栏：等 AI 写完（所有页面都在），或者不在这一步的页面时「接着走」 */
function TourBar({ s }: { s: Snap }) {
   const [checking, setChecking] = useState(false);
   if (s.saved.status !== 'running' || s.active !== null) return null;
   const step = TOUR_STEPS[s.saved.step];
   if (!step) return null;
   if (step.kind === 'wait' && step.waitFor) {
      const wait = step.waitFor;
      return (
         <div className="jc-tour-bar" data-tour="tour-bar">
            <span className="jc-tour-bar-icon" aria-hidden="true">
               <Spinner size={14} />
            </span>
            <span className="jc-tour-bar-text" role="status">
               <b>{wait.text}</b>
               <span className="jc-tour-bar-note">{s.waitNote || '写好了会自动进下一步'}</span>
            </span>
            <span className="jc-tour-bar-actions">
               <button
                  type="button"
                  className="jc-button jc-button-secondary h-[30px] px-3 text-[12.5px] font-medium"
                  disabled={checking}
                  onClick={() => {
                     setChecking(true);
                     void checkCreation(true).finally(() => setChecking(false));
                  }}
               >
                  {wait.button}
               </button>
               <button type="button" className="jc-tour-bar-skip" onClick={() => skip()}>
                  {TOUR_TEXT.skip}
               </button>
            </span>
         </div>
      );
   }
   if (onPage(step.page)) return null;
   return (
      <div className="jc-tour-bar" role="status" data-tour="tour-bar">
         <span className="jc-tour-bar-icon" aria-hidden="true">
            <Compass size={15} />
         </span>
         <span className="jc-tour-bar-text">
            <b>{countLabel(s.saved.step)}</b>
            <span className="jc-tour-bar-note">{step.barText ?? TOUR_TEXT.bar.replace('{n}', String(COUNTED.indexOf(step) + 1)).replace('{total}', String(COUNTED.length))}</span>
         </span>
         <span className="jc-tour-bar-actions">
            <button type="button" className="jc-button jc-button-primary h-[30px] px-3.5 text-[12.5px] font-semibold" onClick={() => resume()}>
               {TOUR_TEXT.resume}
            </button>
            <button type="button" className="jc-tour-bar-skip" onClick={() => skip()}>
               {TOUR_TEXT.skip}
            </button>
         </span>
      </div>
   );
}

/** 不压暗的那一步：气泡贴在按钮下面（放不下放上面），页面照常能用 */
function TourFloat({ index }: { index: number }) {
   const step = TOUR_STEPS[index];
   const ref = useRef<HTMLDivElement>(null);
   const [box, setBox] = useState<{ left: number; top: number; above: boolean; over: boolean; arrow: number } | null>(null);
   useEffect(() => {
      let raf = 0;
      const place = () => {
         raf = 0;
         const el = floatEl;
         const pop = ref.current;
         if (!el?.isConnected || !pop) return;
         const r = el.getBoundingClientRect();
         const vw = document.documentElement.clientWidth;
         const vh = document.documentElement.clientHeight; // 不用 innerHeight：手机上页面一撑宽它就跟着变大
         const w = pop.offsetWidth;
         const h = pop.offsetHeight;
         const left = Math.max(12, Math.min(r.left, vw - w - 12));
         // 下面留出完成反馈（窄屏还有底部导航）的位置，放不下就放到按钮上面
         const bottom = vh - (isNarrow() ? 150 : 80);
         // 顶上的细栏（等 AI 写完、AI 写好了、怎么在 AI 里打开）不能被气泡挡住
         const barBottom = document.querySelector('[data-tour="tour-bar"]')?.getBoundingClientRect().bottom ?? 0;
         const minTop = barBottom > 0 && barBottom < vh ? barBottom + 8 : 12;
         let top = r.bottom + 12;
         let above = false;
         let over = false;
         if (top + h > bottom && r.top - h - 12 >= minTop) {
            top = r.top - h - 12;
            above = true;
         } else if (top + h > bottom && r.bottom > 0) {
            // 上下都放不下（按钮很高，比如那句话带着很长的路径）：往上挪进屏幕里，压住按钮下半截，不让气泡伸出屏幕（伸出去就得翻页，一翻它又跟着跳）
            top = Math.max(minTop, bottom - h);
            over = top < r.bottom;
         }
         const arrow = Math.max(18, Math.min(r.left + Math.min(r.width / 2, 40) - left, w - 18));
         setBox((b) =>
            b && b.left === left && b.top === top && b.above === above && b.over === over && b.arrow === arrow ? b : { left, top, above, over, arrow }
         );
      };
      const later = () => {
         if (!raf) raf = window.requestAnimationFrame(place);
      };
      place();
      const timer = window.setInterval(later, 300); // 页面重画、内容浮上来：隔一会儿量一次
      window.addEventListener('scroll', later, { passive: true });
      window.addEventListener('resize', later);
      return () => {
         window.clearInterval(timer);
         window.removeEventListener('scroll', later);
         window.removeEventListener('resize', later);
         if (raf) window.cancelAnimationFrame(raf);
      };
   }, [index]);
   if (!step) return null;
   return (
      <div
         ref={ref}
         className={`jc-tour-float${box?.above ? ' is-above' : ''}${box?.over ? ' is-over' : ''}${step.aiLinks ? ' has-links' : ''}`}
         data-tour="tour-float"
         style={{ left: box?.left ?? -9999, top: box?.top ?? 0, visibility: box ? 'visible' : 'hidden', ['--jc-arrow' as string]: `${box?.arrow ?? 24}px` }}
      >
         <div className="jc-tour-top">
            <span className="jc-tour-count">{countLabel(index)}</span>
            <button type="button" className="jc-tour-skip" onClick={() => skip()}>
               {TOUR_TEXT.skip}
            </button>
         </div>
         <div role="status" aria-live="polite">
            {step.title && <p className="jc-tour-float-title">{step.title}</p>}
            <p className="jc-tour-float-text">{stepText(step)}</p>
         </div>
         {step.aiLinks && <AiLinksBlock />}
      </div>
   );
}

// ---------- 等 AI 那一步：一键打开 Codex、Claude Code ----------
/** 气泡里的一键打开：这台 Mac 上装好了处理官方链接的程序才有（接口 /api/app 的 aiLinks），一个都没有就什么都不放 */
function AiLinksBlock() {
   const { info, reachable } = useAppInfo();
   const folder = reachable ? info.workFolder : '';
   const links = availableAiLinks(info.aiLinks).flatMap((app) => {
      const url = openLink(app, folder, info.creation.skill);
      return url ? [{ app, url }] : [];
   });
   if (!links.length) return null;
   return (
      <div className="jc-tour-links" data-tour="ai-links">
         <p className="jc-tour-links-caption">{AI_LINKS.caption}</p>
         <div className="jc-tour-links-actions">
            {links.map(({ app, url }) => (
               <a key={app.id} href={url} className="jc-button jc-button-primary jc-tour-mini" data-tour={`open-in-${app.id}`} title={app.note}>
                  {app.app === 'terminal' ? <SquareTerminal size={13} aria-hidden="true" /> : <AppWindow size={13} aria-hidden="true" />}
                  {app.label}
               </a>
            ))}
         </div>
      </div>
   );
}

function Feedback({ text }: { text: string }) {
   return (
      <div className="jc-tour-feedback" role="status" aria-live="polite" data-tour="feedback">
         <span className="jc-tour-feedback-icon" aria-hidden="true">
            <Check size={13} strokeWidth={3} />
         </span>
         {text}
      </div>
   );
}

/**
 * 开场卡这会儿摊开着没有。摊开时「选题」页先不出「下一步：加你自己的选题」：两个下一步抢注意力，
 * 走完引导（最后一句是「下一步把你自己的选题交给 AI」）或者点了「我自己看」，它再出来。
 */
export function useTourCardOpen(): boolean {
   const s = useTour();
   return Boolean(s.board?.ready && s.board.example.exists && cardOpen(s));
}

/** 「内容」页顶部那张卡（嵌在页面里，不压暗）；「我自己看」以后、清单全勾上以后收成一行 */
export function TourCard() {
   const s = useTour();
   const board = s.board;
   if (!board?.ready || !board.example.exists) return null;
   const { done, count } = checklist(s);
   const all = count === done.length;
   const running = s.saved.status === 'running';
   if (!cardOpen(s)) {
      return (
         <button type="button" className="jc-tour-entry" data-tour="tour-entry" onClick={() => (all ? restartTour() : save({ card: 'open' }))}>
            <Compass size={15} aria-hidden="true" />
            <span>{all ? TOUR_CARD.replay : TOUR_CARD.collapsed}</span>
            <span className="jc-tour-entry-count">
               {count}/{done.length}
            </span>
            <ChevronRight size={14} aria-hidden="true" />
         </button>
      );
   }
   // 主按钮：正走着就「接着走」；已经有了第一版、还没采纳过，就接着去打开创作页；不然从头「带我走一遍」
   const midway = !running && board.example.creation && !board.example.adopted;
   const primary = running ? () => resume() : midway ? () => start(HANDOFF) : () => start(0);
   return (
      <section className="jc-tour-card" aria-label={TOUR_TEXT.uncounted} data-tour="tour-card">
         <div className="jc-tour-card-head">
            <span className="jc-brand-mark jc-tour-avatar" aria-hidden="true">
               <PenLine size={17} strokeWidth={2} />
            </span>
            <div className="min-w-0 flex-1">
               <h2 className="jc-tour-card-title">{withAuthor(TOUR_CARD.title)}</h2>
               <p className="jc-tour-card-body">{TOUR_CARD.body}</p>
            </div>
            <span className="jc-tour-card-count" aria-label={`完成了 ${count} 项，共 ${done.length} 项`}>
               {count}/{done.length}
            </span>
         </div>
         <ol className="jc-tour-checklist">
            {TOUR_CARD.checklist.map((text, i) => (
               <li key={text} data-done={done[i] ? 'true' : undefined}>
                  <span className="jc-tour-check" aria-hidden="true">
                     {done[i] && <Check size={11} strokeWidth={3.2} />}
                  </span>
                  {text}
               </li>
            ))}
         </ol>
         <div className="jc-tour-card-actions">
            <button type="button" className="jc-tour-card-later" onClick={() => later()}>
               {TOUR_CARD.later}
            </button>
            <button type="button" className="jc-button jc-button-primary h-[34px] px-5 text-[13px] font-semibold" onClick={primary}>
               {running || midway ? TOUR_CARD.resume : TOUR_CARD.start}
            </button>
         </div>
      </section>
   );
}

/** 用到时再提示：嵌在页面里的一行（放在页面内容最上面），只出一次；「不再显示这类提示」一起关掉 */
export function TourHint() {
   const s = useTour();
   // 记下这一页有放提示的地方（页面数据到齐、画出来以后才算）
   useEffect(() => {
      set({ slots: snap.slots + 1 });
      return () => set({ slots: Math.max(0, snap.slots - 1) });
   }, []);
   if (!s.hint) return null;
   return (
      <div className="jc-tour-hint" role="status" aria-live="polite" data-tour="hint">
         <Lightbulb size={15} aria-hidden="true" className="jc-tour-hint-icon" />
         <span className="jc-tour-hint-text">{s.hint.text}</span>
         <span className="jc-tour-hint-actions">
            <button type="button" className="jc-tour-hint-off" onClick={() => closeHint(true)}>
               {TOUR_TEXT.hintOff}
            </button>
            <button type="button" className="jc-button jc-button-secondary h-[28px] px-3 text-[12px] font-medium" onClick={() => closeHint(false)}>
               {TOUR_TEXT.hintOk}
            </button>
         </span>
      </div>
   );
}

/** 左下角（窄屏在右上角）的「新手指引」：从第 1 步重走。设置里关了「内容」栏、或者连不上后台时不放 */
export function TourReplayButton() {
   const { info, reachable } = useAppInfo();
   if (!reachable || !info.columns.includes('content')) return null;
   return (
      <button type="button" className="jc-tour-replay" data-tour="replay" onClick={() => restartTour()} title="从第 1 步重走一遍新手指引">
         <Compass size={14} aria-hidden="true" />
         新手指引
      </button>
   );
}
