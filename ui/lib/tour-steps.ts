// 新手指引写什么、带用户做哪几件事，全在这个文件里。改步骤、改字只改这里。
//
// 怎么走（2026-10-03 原作者批准的方案）：
// - 「内容」页顶部嵌一张卡（不是弹窗、不压暗）：作者的口吻说一句，下面一张清单「1/4」，随真实进度打勾；
//   「带我走一遍」开始，「我自己看」收成一行「新手指引」入口；清单全勾上以后收成一行「重看新手指引」。
// - 第一段在工作台里（TOUR_STEPS），气泡角上「第 N 步，共 3 步」：每一步画面变暗、只亮一个按钮，用户亲手点了才往下走，
//   点完弹一句完成反馈；「等 AI 写」那一步不压暗，页面照常能用，顶上细栏等 AI 写完自动往下走。
// - 第二段在创作页里（CREATION_PAGE），创作页是保存服务给的另一个网页，由创作页模板自己亮。
// - 走到第几步记在浏览器里：换页面、刷新、切去 AI 窗口再回来都接着走。每一步都能跳过；跳过时说清在哪重看。
// 引导怎么画、怎么记在 components/jc/tour.tsx，一般不用动。
//
// 这个文件不带 'use client'，也不引别的文件：测试（tests/tour-steps.test.mjs）直接读它，核对每一步写全了、
// 每句不超过 40 个字、引用的页面记号页面上真的有、创作页里的那几句和创作页模板一样。
// {作者} 换成 brand.json 的署名（copyrightHolder），没有署名时「我是{作者}，」这几个字不显示。
//
// ── 一步能写的 ──
//   id         这一步叫什么，测试和排查用，不显示。不能重复。
//   page       这一步在哪个页面：工作台里的地址，比如 '/content'（「内容」栏，哪个页签都行）、'/content?tab=topics'（只在「选题」页签）、
//              '/content/T001'（T001 的详情页）。用户不在这个页面时，页面顶上一条细栏「接着走」，点了打开这个地址。
//   target     亮哪个按钮或链接。CSS 选择器，比如 '[data-tour="ask-ai"]'；也可以按上面的字找：{ text: '打开创作页', in: 'main' }；
//              写成数组就按顺序找第一个看得见的。到了这个页面、数据到齐以后还找不到，这一步自动跳过。
//   kind       'click'（不写就是它）：画面变暗、只亮 target，用户亲手点了才往下走。
//              'wait'：不压暗，页面照常能用，气泡贴在 target 旁边；顶上细栏等 waitFor 的事办完，自动往下走。
//   title      气泡里加粗的第一行，可以不写。和 text 合起来是一句话，加起来不超过 40 个字。
//   text       气泡里那一句：只说点哪里、点了会怎样，不超过 40 个字。
//   textNarrow 窄屏（宽度 720 及以下）时换用的那一句，不写就用 text。
//   aiLinks    true：气泡里放一键打开 Codex、Claude Code 的按钮（字在下面的 AI_LINKS），那句话已经填好；
//              这台 Mac 上没装处理链接的程序就不放。
//   doneText   用户点完以后弹的一句完成反馈，不写就不弹。
//   barText    用户不在这一步的页面时，顶上细栏写的那句；不写是「新手指引还没走完。」（左边加粗写着第几步）。
//   uncounted  true：不算在「第 N 步，共 M 步」里，气泡角上只写「新手指引」。
//   waitFor    kind 为 'wait' 时等什么：{ creation: 'T001', text, button, notYet }。每隔几秒问一下这条内容有没有创作页，
//              有了就往下走；细栏写 text，按钮 button 是兜底（马上再问一次，还没有就显示 notYet）。
//   openParam  点的是打开创作页的链接时，给链接加上这个参数（'guide=first-suggestion'），创作页看到它就接着带第二段。
//   side       气泡放在按钮哪一边：'top' 'right' 'bottom' 'left'，不写放下面，放不下自动换一边。
//
// ── 页面上给引导留的记号（新步骤要亮别的东西，可以在页面代码里照样加一个 data-tour） ──
//   选题列表的每一行、「在做」的每张卡  [data-work="T001"]（进详情的是里面的链接：'[data-work="T001"] a[href="/content/T001"]'）
//   详情页「交给 AI 的那句话」          [data-tour="ask-ai"]（点一下就复制）
//   「打开创作页」                     [data-tour="open-creation"]
//   「选题」「在做」页签                [data-tour="tab-topics"]、[data-tour="tab-doing"]
//   左边菜单、底部导航的栏目            [data-nav="content"]、[data-nav="prompts"]
//   左下角「在访达中打开」              [data-tour="open-work-folder"]
//   「新手指引」按钮                   [data-tour="replay"]
//
// ── 改完想先在浏览器里试 ──
// 打开工作台，在开发者工具的控制台里运行：workbenchTour.state() 看走到哪一步；workbenchTour.restart() 从第 1 步重走
// （和点「新手指引」一样，也重新打开提示）；workbenchTour.reset() 回到第一次打开的样子。改了这个文件要重新编译界面才生效。

export type TourTarget = string | { text: string; in?: string };

export type TourStep = {
   id: string;
   page: string;
   target?: TourTarget | TourTarget[];
   kind?: 'click' | 'wait';
   title?: string;
   text: string;
   textNarrow?: string;
   doneText?: string;
   barText?: string;
   uncounted?: boolean;
   waitFor?: { creation: string; text: string; button: string; notYet: string };
   openParam?: string;
   side?: 'top' | 'right' | 'bottom' | 'left';
   aiLinks?: boolean;
};

export type TourHint = {
   id: string;
   /** 什么时候提：第一次进这个页面（地址写法和 page 一样），或者第一次点这个东西（CSS 选择器） */
   when: { page: string } | { click: string };
   text: string;
};

/** 改了步骤、想让已经走完或跳过的人再看到一次开场卡，把这个数字加 1。 */
export const TOUR_VERSION = 1;

/** 带着走一遍的示例选题：选题列表里没有它时不出开场卡，点「新手指引」会说一声。 */
export const TOUR_WORK = 'T001';

/** 「内容」页顶部那张卡。清单四项按真实进度打勾：装好就算；打开过 T001；T001 有了创作页；创作页里采纳过一条（从页面文件里数）。 */
export const TOUR_CARD = {
   title: '我是{作者}，先带你走一遍',
   body: '用示例选题 T001 走一遍：你点 3 下，中间等 AI 写一会儿。',
   start: '带我走一遍',
   resume: '接着走',
   later: '我自己看',
   collapsed: '新手指引',
   replay: '重看新手指引',
   checklist: ['装好工作台', '打开示例选题 T001', '把 T001 交给 AI 写第一版', '在创作页采纳一条建议'],
};

/** 不属于哪一步的几句话。{n}、{total} 换成第几步、一共几步。 */
export const TOUR_TEXT = {
   count: '第 {n} 步，共 {total} 步',
   uncounted: '新手指引',
   skip: '跳过新手指引',
   skipped: '随时能在左下角「新手指引」重看。',
   skippedNarrow: '随时能在右上角「新手指引」重看。',
   bar: '新手指引还没走完。',
   resume: '接着走',
   noExample: '示例选题 T001 不在选题列表里了，没有它，新手指引走不了。',
   hintOk: '知道了',
   hintOff: '不再显示这类提示',
};

// 第一段：在工作台里。第 2 步那句「点这里，把这句话复制给 AI。」方案里没写，是开发时补的。
export const TOUR_STEPS: TourStep[] = [
   {
      id: 'open-topic',
      page: '/content',
      target: '[data-work="T001"] a[href="/content/T001"]',
      text: '先打开这条示例选题。',
   },
   {
      id: 'copy-ask',
      page: '/content/T001',
      target: '[data-tour="ask-ai"]',
      text: '点这里，把这句话复制给 AI。',
      doneText: '已复制。',
      barText: '回到 T001，复制要发给 AI 的那句话。',
   },
   {
      // 第 3 步：复制的那句话在哪个对话、哪个文件夹里发都行（写稿 Skill 自己查工作文件夹，没装好先装），
      // 所以只说粘贴、发出去，不让用户先打开哪个文件夹（原作者 2026-10-03 定的「提示词标准」，见 AGENTS.md）。
      // 这台 Mac 上装了 Codex、Claude Code 的，气泡里再放一键打开的按钮，那句话已经填好。
      id: 'wait-ai',
      kind: 'wait',
      page: '/content/T001',
      target: '[data-tour="ask-ai"]',
      title: '粘贴给 Codex 或 Claude Code，发出去',
      text: '哪个对话都行。',
      aiLinks: true,
      waitFor: {
         creation: 'T001',
         text: '等 AI 写完 T001',
         button: 'AI 写好了',
         notYet: '还没看到 T001 的创作页，AI 说做好了再点一次。',
      },
   },
   {
      id: 'open-creation',
      page: '/content/T001',
      target: '[data-tour="open-creation"]',
      uncounted: true,
      text: '第一版写好了，点这里打开。',
      barText: 'T001 的第一版写好了，回去打开创作页看看。',
      openParam: 'guide=first-suggestion',
   },
];

/** 一键打开：官方文档写明的链接，{路径} 换成工作文件夹、{话} 换成复制给 AI 的那句话，都按网址编码。 */
export type AiLinkId = 'codex' | 'claude-desktop' | 'claude';
export type AiLink = { id: AiLinkId; name: string; url: string; label: string; note: string; app: 'desktop' | 'terminal' };

/**
 * 第 3 步气泡里的一键打开：在工作文件夹里新开一个对话，那句话已经填好，按回车就行（开在工作文件夹里，Codex 不用再请用户批准写文件）。
 * 这台 Mac 上装好了处理这个链接的程序才放按钮（接口 /api/app 的 aiLinks 由 lib/ai-links.mjs 查），没装好不放：点了没反应的按钮不放。
 * Codex 写在前面（原作者 2026-10-03 定：「大部分人用的是 Codex」）。链接的出处和日期见 docs/开发记录.md「新手指引」。
 */
export const AI_LINKS = {
   caption: '也可以一键打开，那句话已经填好：',
   apps: [
      // ChatGPT 桌面版（Codex 2026 年 7 月起并进了它）接这个链接
      { id: 'codex', name: 'Codex', url: 'codex://threads/new?path={路径}&prompt={话}', label: '在 Codex 里打开', note: '在工作文件夹里新开一个对话，那句话已经填好，按回车就行。', app: 'desktop' },
      // Claude 桌面版的 Code：新开一个会话。链接带的文件夹，桌面版每次都先请用户点一下确认
      { id: 'claude-desktop', name: 'Claude Code', url: 'claude://code/new?folder={路径}&q={话}', label: '在 Claude Code 里打开', note: '在 Claude 桌面版里新开一个对话，确认一下文件夹，按回车就行。', app: 'desktop' },
      // 没装 Claude 桌面版、只用终端里的 Claude Code：开一个终端窗口
      { id: 'claude', name: 'Claude Code', url: 'claude-cli://open?cwd={路径}&q={话}', label: '在 Claude Code 里打开', note: '开一个终端窗口，那句话已经填好，按回车就行。', app: 'terminal' },
   ] as AiLink[],
};

/** 这台 Mac 上放哪几个按钮：接口说有程序接的才放；Claude 桌面版和终端版都有时只放桌面版（客户端对新手更好用，同一个按钮名也不出现两次） */
export function availableAiLinks(found: Partial<Record<AiLinkId, boolean>> | null | undefined): AiLink[] {
   return AI_LINKS.apps.filter((app) => found?.[app.id] && !(app.id === 'claude' && found['claude-desktop']));
}

// 用到时再提示：各一句，只出一次，嵌在页面里（不压暗）；点「不再显示这类提示」一起关掉（点「新手指引」会重新打开）。
export const TOUR_HINTS: TourHint[] = [
   { id: 'prompts-page', when: { page: '/prompts' }, text: '常用的提示词放这里，点卡片上的复制按钮就能复制；有要填的空，先填再复制。' },
   { id: 'doing-tab', when: { page: '/content?tab=doing' }, text: '开始写的选题会来这里。在创作页改完，跟 AI 说「改完了」，它会接着帮你改稿。' },
   { id: 'open-work-folder', when: { click: '[data-tour="open-work-folder"]' }, text: '所有东西都在这个文件夹。把里面的「写稿方法」改成你自己的写法，AI 就照你的写。' },
   { id: 'research-page', when: { page: '/research' }, text: '接好 TikHub、导入评论表，AI 就能替你拉数据、读评论。' },
];

// 第二段：在创作页里，气泡角上「第 N 步，共 2 步」。第 1 步亮第一条待确认的建议和它贴着的原句，点「下一步」；
// 第 2 步只亮它的「采纳」，要亲手点，点完弹完成反馈。第一次点「不采纳」嵌在页面里提一句。
// 创作页读不到这个文件：同样的字也写在 creation-page/template/app.js 的 GUIDE_TEXT 里，改这里要一起改那里（pnpm test 核对两边一样）。
// 第 2 步那句方案里没写，是开发时补的；跳过时那句多了「工作台」三个字（创作页里没有「新手指引」按钮）。
export const CREATION_PAGE = {
   steps: ['AI 的建议贴在要改的那句话旁边。', '觉得这样改更好，就点「采纳」。'],
   next: '下一步',
   done: '漂亮，这条建议已经存回你的稿子。流程走通了，下一步把你自己的选题交给 AI。',
   ok: '好的',
   skipped: '随时能在工作台左下角「新手指引」重看。',
   noSuggestion: '这一稿还没有待确认的修改建议，AI 提了以后，觉得好就点「采纳」。',
   rejectHint: '不采纳也没关系，AI 不会换个说法再提。',
};
