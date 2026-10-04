# 给 AI 的项目说明

- 用户让你**安装、更新或者打开**这个工作台：照 [docs/给AI的安装说明.md](docs/给AI的安装说明.md) 从第 0 步做，别的不用看。
- 用户让你**改代码**：先读 [docs/开发记录.md](docs/开发记录.md)（为什么这么设计），再守下面的规矩。

## 规矩

1. **文件说了算，不另存状态**：选题、草稿、提示词都是工作文件夹里的普通文件，页面上的状态全部从文件现算。不新增要人手动维护的状态文件；一个功能要用户「再填一遍」，就不做。
2. **能点的都要真能用**：页面上每个按钮都接真实动作，接不了就删掉，不放演示用的假按钮。写文件以后读回来核对一致，才告诉用户成功。
3. **空白时也要有样子**：每个页面都要想好什么都没有时显示什么——说清下一步做什么，旁边就放能点的操作。
4. **界面文字用平常话**，简体中文，不用术语和代号；出错时说清楚原因和怎么办。
5. **界面不从零手写**：沿用 `ui/components/jc/` 里的组件和 `ui/app/globals.css` 的样式；缺组件从 shadcn 补，视觉跟着现有样式走。切换时的滑动动效和「数据到齐再一起出来」要保留（`slide-indicator.ts`、`column.tsx` 的 `ready`）。
6. **不写死任何人的东西**：路径、内容类型、栏目都从设置读（`lib/config.mjs`）；名字和署名只在 `brand.json`。代码、文档、示例里不出现真实的人名、本机路径、域名、账号。
7. **只在本机**：服务只监听 127.0.0.1；接口检查 Host、Origin 和 JSON；打开文件只走 `lib/open.mjs`（系统默认程序 / 访达），路径必须在设置里的文件夹里面。
8. **接口只用 Node 24 自带的模块**，不加运行时依赖；界面依赖能少就少。创作页（`creation-page/`）只用 Python 3 自带的模块，页面模板是不依赖网络的原生 JavaScript。
9. **密钥只放钥匙串**：TikHub 这类第三方的 key 只存 macOS 登录钥匙串（`lib/tikhub.mjs`），不写进设置文件或任何文件，不回传给页面（页面只拿后四位），不进日志；第三方接口的报错原文可能带着 key，不往外传。测试和验收一律用测试专用的钥匙串服务名（`WORKBENCH_KEYCHAIN_SERVICE`），绝不碰真的 `tikhub-api`。

## 交给 AI 的话怎么写（提示词标准，原作者 2026-10-03 定）

我们写出去的每一段提示词，对方复制、粘贴、发给他自己的 AI，AI 就能自己摸清对方的情况，把我们要他达成的目的做完。必须由人来做的那几步，AI 做到那一步时主动提醒人去做，人做完，AI 接着做。核心目标是用户体验，自动化只是手段：容易做错的环节宁可让人来做，不硬去自动化。

管哪些：所有交给 AI 执行的话。页面上「复制给 AI」的（字在 `ui/lib/ask-ai.ts`）、新手指引里的、README 里的安装那句、安装说明、三个 Skill、发给别人的更新说明。

每段都要做到：

1. 写目的，不只写一步：说清最后要达成什么、做完是什么样。
2. 自适应，不写死对方的环境：不写某一台电脑的路径、用户名、装了什么；让 AI 自己查用的是 Codex 还是 Claude Code、缺什么、东西放在哪、当前打开的是哪个文件夹。
3. 从任何起点都能做完：缺前提（没装、版本旧、文件夹不对），AI 先补齐再接着做，不让用户先做准备。
4. 不让用户填空，也不让用户回答问题：能查的自己查，有默认值就用默认值。只有用户自己知道的东西（比如要分析哪条视频），写明「贴在这句后面」，只留这一处。
5. 人必须做的步骤到了再提醒：输电脑密码、点系统授权、注册账号、充值、粘贴 key、登录平台账号。AI 做到这一步停下，一句话说清点哪里、输什么；用户回「好了」接着做，不用重发提示词。
6. 默认一个目的一段话，每段从任何状态出发都能完成。
7. 最后只给结果：告诉用户结果在哪、下一步能做什么，过程细节不往用户面前摆。

验收：每段至少从两种起点各跑一遍，一种是什么都没装的新电脑，一种是已经装好、但在别的文件夹里打开 AI 的电脑；Codex 优先，Claude Code 也要跑。用户除了复制、粘贴、发送和第 5 条那几件事，别的什么都不用做就达成了目的，才算合格。`tests/ask-ai.test.mjs` 查得出来的几条（带仓库地址、不带本机路径、要贴的只在最后一处）由 `pnpm test` 拦，真跑的结果记在 [docs/开发记录.md](docs/开发记录.md)「交给 AI 的话」。

## 改完要跑

```bash
pnpm test         # 接口和文件读写的测试，连同创作页的 Python 测试
pnpm test:browser # 改了创作页的模板、保存脚本，或者新手指引时跑：用 Chrome 真的打字、点按钮（要装 Google Chrome；新手指引那组还要 Python 的 playwright，没装就跳过）
pnpm typecheck    # 界面类型检查
pnpm build        # 编译界面（先停掉正在跑的 pnpm --dir ui dev，两个会抢同一个产物目录；正在运行的工作台先 pnpm stop）
pnpm check:public # 公开前自查：密钥、本机路径、截图里的元数据；加上 PUBLIC_CHECK_WORDS="词1,词2" 查自己不想公开的词
```

README 的截图在 `docs/images/`（只许放在这里）：界面改了样子要重截时，用全新的临时家目录、示例数据、1440×900 截，画面里不能有真实路径、账号和 key，存成不带元数据的 PNG，每张 400KB 以内；`pnpm check:public` 会查位置和元数据。

## 新手指引

- 步骤和所有的字在 `ui/lib/tour-steps.ts`，改步骤只改这里（开头写了每一项是什么、页面上能亮哪些 `data-tour` 记号）；怎么走在 `ui/components/jc/tour.tsx`。为什么这么做见 [docs/开发记录.md](docs/开发记录.md)「新手指引」。
- 第二段在创作页里，它和「不采纳」提示的字同样写在 `creation-page/template/app.js` 的 `GUIDE_TEXT`，改了要两边一起改；`pnpm test` 会核对。
- 开场卡「我是{作者}」的名字从 `brand.json` 的署名来，不在代码里写名字。
- 用到时的提示只在放了 `<TourHint />` 的页面上显示；新加页面要放一个，`pnpm test` 会核对。
- 第 3 步（等 AI 写）只说「粘贴给 Codex 或 Claude Code，发出去」，不摆路径、不让用户先打开哪个文件夹（复制的那句话在哪个对话里发都行，见上面「交给 AI 的话怎么写」）。气泡里一键打开的按钮字在 `tour-steps.ts` 的 `AI_LINKS`，只在这台 Mac 上有程序接官方链接时才放，由 `lib/ai-links.mjs` 查。
- 两家 AI 工具并列时一律 Codex 在前、Claude Code 在后（界面、文档、Skill 都是），原作者 2026-10-03 定，原话见 [docs/开发记录.md](docs/开发记录.md)「新手指引」。

## 创作页

- 代码在 `creation-page/`，从原作者自己用的工作台 2.0 拷来再改成通用版，拷的是哪个提交、改了什么，写在 [docs/开发记录.md](docs/开发记录.md)「创作页」一节。以后从那边同步新改动时，先对着那个提交看差异，再照那一节的改法改。
- 数据格式和三方（生成脚本、读改脚本、保存服务）的约定在 `creation-page/schema/creation-page.md`；界面文字的用词在 `creation-page/文案术语表.md`。
- 保存服务的根目录是设置里的工作文件夹，由 `pnpm start` 一起拉起（`lib/creation.mjs`、`scripts/start.mjs`），不用 launchd，不单独常驻。
- 写稿 Skill 在 `skills/jincheng-workbench-write/SKILL.md`。写稿规则不写进 Skill，放在用户工作文件夹的「写稿方法」里（模板在 `templates/写稿方法/`）。

## 调研 Skill

- 在 `skills/jincheng-workbench-research/`：`SKILL.md` 给 AI 看，脚本是 `scripts/research.py`（只用 Python 自带的模块），测试在 `tests/`（`pnpm test` 会跑）。为什么这么设计见 [docs/开发记录.md](docs/开发记录.md)「调研 Skill」一节。
- 写进工作文件夹「市场调研」的文件格式（档案.json、meta.json 等）是和工作台界面约定好的，写在 `references/数据格式.md`；改格式先改那里和界面那边。
- TikHub 的密钥只在脚本进程里用，不打印、不写进文件；测试只用测试专用的钥匙串名字和本机的假 TikHub，不碰真实的 `tikhub-api` 条目，不连外网。

## 加栏目或页签

- 新栏目：在 `lib/config.mjs` 的 `COLUMN_KEYS` 和 `ui/lib/columns.ts` 的 `COLUMNS` 里登记，左边菜单图标在 `ui/components/jc/shell.tsx` 的 `ICONS` 里配，接口在 `lib/app.mjs` 里加路由，并用 `needColumn()` 管住开关。
- 「内容」栏新页签（比如以后加一个「已发布」）：在 `ui/lib/columns.ts` 的 `content.tabs` 里加一项，页面放在 `ui/app/content/` 下面。
- 「市场调研」栏：页面在 `ui/components/workbench/research-board.tsx`，空白引导和「复制给 AI 的话」的文字和判断在 `ui/lib/research-guide.ts`（只有纯函数，`tests/research-guide.test.mjs` 直接测它）；数据来源的地址、单价兜底值在 `lib/data-sources.mjs`。和调研 Skill 约定的文件格式见工作文件夹「市场调研/README.md」（模板在 `lib/templates.mjs` 的 `researchGuide`），改格式要两边一起改。
