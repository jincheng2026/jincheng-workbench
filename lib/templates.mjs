// 第一次启动时写进工作文件夹的文件：给 AI 看的 AGENTS.md / CLAUDE.md、选题总览、一张示例选题卡、
// 写稿方法（仓库 templates/写稿方法/ 里的 Markdown 原样拷过去）、提示词的格式说明和两条示例提示词。文字按设置里的内容类型和文件夹名生成。
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "./brand.mjs";
import { RESEARCH_PATH_KEYS, displayPath } from "./config.mjs";
import { KEYCHAIN, SOCIAL_HELPER } from "./data-sources.mjs";

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
export const SKILL_NAME = `${BRAND.id}-write`;
// 调研 Skill：批量拉博主作品和数据（TikHub）、读社媒助手导出的评论表、出调研报告，结果放进「市场调研」的三个文件夹
export const RESEARCH_SKILL = `${BRAND.id}-research`;
// 封面 Skill（1.1 加）：拆对标账号的封面 VI、给一条内容出一批封面、按工作台上的备注改一张
export const COVER_SKILL = `${BRAND.id}-cover`;

/**
 * 写稿方法：仓库 templates/写稿方法/ 里的每个 .md 文件，返回 [{ name, text }]。
 * 文件里的 {{Skill}} 换成写稿 Skill 的名字，{{作者}} 换成 brand.json 的署名，{{工作台}} 换成工作台的名字。
 */
export function writingMethodFiles() {
  const dir = path.join(TEMPLATES, "写稿方法");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b, "zh"))
    .map((name) => ({
      name,
      text: readFileSync(path.join(dir, name), "utf8")
        .replaceAll("{{Skill}}", SKILL_NAME)
        .replaceAll("{{作者}}", BRAND.holder || "作者")
        .replaceAll("{{工作台}}", BRAND.name),
    }));
}

export const EXAMPLE_ID = "T001";
export const EXAMPLE_TITLE = "示例：用 AI 三分钟想好一条视频的开头";
export const TABLE_HEAD = "| 编号 | 选题 | 来源 | 状态 | 发布日期 | 效果 |\n| --- | --- | --- | --- | --- | --- |";

/** 工作文件夹里的东西写成相对路径（「选题库/」），放在别处的写完整路径。 */
export function placeOf(config, target, { folder = false } = {}) {
  const inner = path.relative(config.workFolder, target);
  const inside = inner && !inner.startsWith("..") && !path.isAbsolute(inner);
  const text = inside ? inner.split(path.sep).join("/") : displayPath(target, config.home);
  return folder ? `${text}/` : text;
}

export function exampleCardName(type) {
  return `${type}/待做/${EXAMPLE_ID}_示例选题.md`;
}

export function overviewTemplate(config, { example = true } = {}) {
  const [first] = config.contentTypes;
  const groups = config.contentTypes
    .map((type) => {
      const todoRow =
        example && type === first
          ? `\n| ${EXAMPLE_ID} | ${EXAMPLE_TITLE}（可以改成你自己的，或者把这一行和对应的选题卡一起删掉） | 自己的想法 | 待写 |  |  |`
          : "";
      return `### ${type}\n\n**待做**\n\n${TABLE_HEAD}${todoRow}\n\n**已做**\n\n${TABLE_HEAD}\n`;
    })
    .join("\n");
  return `# 选题总览

> 这张表是全部选题的总账，${BRAND.name}的「内容」栏就是读这个文件。改完切回工作台，点「重新读取」就能看到。
> 新加一条选题：在对应类型的「待做」表里加一行，编号接着往下排（第一条是 T001），编号定了就不改、不复用。
> 状态写：待写 / 草稿 / 已发布。录完或拍完的，在选题前面加 ✅，并把这一行挪到同一类的「已做」表。
> 每条选题还要在 \`${placeOf(config, config.paths.topics, { folder: true })}<类型>/待做/\` 里放一张选题卡，文件名用编号开头，比如 \`${EXAMPLE_ID}_选题名.md\`。

## 选题总表

${groups}
## 近三天内容安排

可以不填。写了哪天做哪条，工作台会把安排显示在那条选题旁边；「安排」里写了「顺序」两个字，会按「对应选题」列的先后排拍摄顺序。

| 日期 | 安排 | 对应选题 |
| --- | --- | --- |

## 顺延事项

可以不填。往后推的选题写在这里，工作台会把它放进「暂缓」。

| 安排 | 新日期 | 对应选题 |
| --- | --- | --- |
`;
}

export function exampleCard() {
  return `# ${EXAMPLE_ID} ${EXAMPLE_TITLE}

- **来源**：自己的想法
- **状态**：待写
- **发布日期**：
- **效果**：

## 选题内容

- **写给谁**：刚开始做短视频、每次都卡在开头的人
- **解决什么问题**：开头 5 秒留不住人，不知道第一句该说什么
- **大概怎么讲**：先给一个反面例子，再用一条提示词让 AI 写 5 个开头，挑一个念出来

## 备注

这是一张示例选题卡，用来演示选题卡怎么写。可以直接改成你自己的选题；不要了就把它和选题总览里 ${EXAMPLE_ID} 那一行一起删掉。
`;
}

// 示例选题的草稿文件夹：放一份虚构的参考视频逐字稿和一份照「写稿方法/03_拆参考怎么拆」写好的拆解，
// 新用户第一次让 AI 写 T001 时有东西可拆、可借，写得出第一版。参考材料不算开始写（lib/works.mjs 的 isReference）。
export const EXAMPLE_DRAFT_DIR = `${EXAMPLE_ID}_示例选题`;

export function exampleReferenceTranscript() {
  return `# 参考视频逐字稿（虚构的示例）

- **说明**：这是一条虚构的参考视频，给示例选题 ${EXAMPLE_ID} 用，让 AI 第一次写稿有东西可拆。写你自己的选题时，把真实参考视频的逐字稿放进这个「参考素材」文件夹。
- **时长**：约 1 分钟
- **讲什么**：开头总卡住，怎么让 AI 帮你三分钟想好

## 逐字稿

0:00 你做视频，最难的是不是第一句？
0:03 我之前拍一条，光开头就改了十几遍，越改越不像人话。
0:08 后来我换了个办法：不自己憋，让 AI 先给我一堆开头，我只负责挑。
0:15 具体这么做。打开随便一个 AI，把这几样告诉它：
0:20 这条视频讲什么，拍给谁看，看完你希望他做什么。
0:26 然后加一句：给我写十个开头，每个不超过二十个字，要让人想往下听。
0:33 它给你十个，你别全信。挑的标准就一个：念出来顺不顺口。
0:40 不顺口的划掉，剩下两三个，对着镜头各念一遍。
0:46 哪个你念的时候最不别扭，就用哪个。
0:50 我现在定一个开头，三分钟就够了。
0:54 你也试试，把你下一条视频讲什么发给 AI，十个开头里总有一个能用。
1:00 觉得有用就收藏，下次卡住了翻出来照着做。
`;
}

export function exampleBreakdown() {
  return `# 参考拆解（示例）

拆的是「参考素材」文件夹里那条虚构的参考视频（约 1 分钟），按「写稿方法」里的 03_拆参考怎么拆.md 写。

1. **开头怎么抓人**：第一句直接问「最难的是不是第一句」，拍过视频的人都会点头；第二句马上用自己「改了十几遍」接住，观众会觉得说的就是自己。
2. **靠什么让人信**：靠亲身经历和前后对比：以前一个开头改十几遍，现在三分钟定下来。没有演示画面，也没给数据。
3. **结构怎么排**：一共三件事。先说痛点（0:00 到 0:08），再说换个办法（0:08 到 0:15），最后三步怎么做（0:15 到 0:50：告诉 AI 讲什么、给谁看；要十个开头；念出来挑），结尾一句叫人收藏。
4. **它没讲什么**：没给提示词原文，观众听完记不住那几句话；也没演示 AI 给的开头长什么样，挑的过程只说了一句「顺不顺口」。这两处是机会：把提示词原样给出来，再当场挑一次给观众看。
5. **能借什么、不能借什么**：可以借「先戳痛点、再换办法、最后三步」的结构，和「念出来顺口」这个挑法；不照搬它的原句，「改了十几遍」这段经历换成你自己的。
`;
}

export function agentsGuide(config) {
  const p = (key, folder = true) => placeOf(config, config.paths[key], { folder });
  const types = config.contentTypes;
  const typeList = types.map((type) => `「${type}」`).join("、");
  return `# 给 AI 的说明：这个文件夹怎么用

这里就是「${BRAND.name}」的工作文件夹，写稿、调研、做封面都在这里做。做内容的全部文件都放在这里：选题、草稿、提示词、市场调研、封面素材。工作台网页只读这里的文件，一切以这里的文件为准；你（AI）改了文件，用户切回工作台点「重新读取」就能看到。

## 每类东西放在哪

| 放什么 | 位置 |
| --- | --- |
| 选题总览：全部选题一张表 | \`${p("overview", false)}\` |
| 选题卡：每条选题一张 | \`${p("topics")}<类型>/待做/\`，做完挪到 \`${p("topics")}<类型>/已做/\` |
| 草稿：每条内容一个文件夹 | \`${p("drafts")}T001_选题名/\` |
| 创作页：每条内容一个，放在它的草稿文件夹里 | \`${p("drafts")}T001_选题名/T001_创作页.html\` |
| 封面候选：每条内容出的候选封面，放在它的草稿文件夹里 | \`${p("drafts")}T001_选题名/封面候选/\`，选定的那张是 \`T001_选题名/封面-选定.png\` |
| 写稿方法：用户自己的写法和判断 | \`${p("writingMethod")}\` |
| 对标账号：每个账号一个文件夹 | \`${p("benchmarkAccounts")}<平台>-<账号名>/\` |
| 调研报告：每份报告一个文件夹 | \`${p("researchReports")}<日期_主题>/\` |
| 社媒助手导出的评论 | \`${p("commentImports")}\` |
| 提示词：一条一个 md 文件 | \`${p("prompts")}<分类>/名字.md\` |
| 封面素材：人物参考图片（用户自己的照片）、用户放进来的几组封面图、封面设置 | \`${p("coverAssets")}\` |
| 不要了的文件 | \`${p("trash")}\`（不要直接删除） |

内容类型现在是 ${typeList}，每一类在选题库里有一个同名文件夹。类型是在工作台的设置文件里定的，要加减类型先改设置，再在选题库里建对应的文件夹、在选题总览里加对应的「### 类型」一节。

## T 编号

- 每条选题一个编号：T 加三位数字，从 T001 开始往下排。
- 编号定了就不改、不复用；作废的选题，编号也不再给别的选题。
- 新编号 = 选题总览里最大的编号加一。

## 加一条选题（三处都要做）

用写稿 Skill（${SKILL_NAME}）里「加选题」的做法加：编号、加在选题总览哪一格、选题卡都由工作台仓库里的 \`scripts/add-topic.mjs\` 写，不会编错号、加错格。没有这个 Skill 时照下面三步手动加。

1. 在选题总览「## 选题总表」下面、对应类型的「**待做**」表里加一行：编号、选题、来源、状态（新选题写「待写」），发布日期和效果先空着。
2. 在 \`${p("topics")}<类型>/待做/\` 里建选题卡，文件名「编号_选题名.md」，格式照下面。
3. 开始写稿时，在 \`${p("drafts")}\` 里建「编号_选题名」文件夹，稿子都放进去。

## 选题总览的格式

- 表头固定是：| 编号 | 选题 | 来源 | 状态 | 发布日期 | 效果 |
- 状态只写：待写 / 草稿 / 已发布。
- 录完或拍完的，选题前面加 ✅，这一行挪到同一类的「**已做**」表；选题卡也从 \`待做/\` 挪到 \`已做/\`，标题编号后面加 ✅。
- 「## 近三天内容安排」表（日期 | 安排 | 对应选题）和「## 顺延事项」表（安排 | 新日期 | 对应选题）可以不填；对应选题里写编号。

## 选题卡的格式

\`\`\`
# T001 选题标题

- **来源**：自己的想法 / 参考别人 / 混合
- **状态**：待写
- **发布日期**：
- **效果**：

## 选题内容

写给谁、解决什么问题、大概怎么讲。
\`\`\`

选题卡顶部这几行和选题总览那一行要一致；改一处，另一处一起改。

## 草稿文件夹里的文件怎么起名

工作台按文件名认出每份文件是什么：

- 名字里有「工作稿」「初稿」「逐字稿」：正在写的稿子，工作台的「接着写」会打开最近改过的那份。
- 名字里有「定稿」「最终稿」「录制版」：定稿；有「提词器」：提词器版。这两类在详情页可以一键复制全文。
- 名字里有「改稿日志」：改稿记录。
- 旧版本放进草稿文件夹里的「版本」子文件夹，工作台只数个数，不一条条列出来。
- 稿子用 .md 或 .txt；图片、视频也可以放，工作台只数个数。

## 写稿和创作页

- 写稿、给改稿建议之前，先读 \`${p("writingMethod")}\` 里的文件：那是用户自己的写稿方法，用户改了就按新的来。文件还写着「待填」的，按写稿 Skill 里最基本的做法来。
- 第一版逐字稿写好后，用写稿 Skill（${SKILL_NAME}）把它做成创作页：\`${p("drafts")}T001_选题名/T001_创作页.html\`。用户在页面上直接改稿，改动自动存回这个文件；工作台「内容」栏的详情页能一键打开它。
- 创作页只用写稿 Skill 里写的命令读和改（工作台仓库里的 creation-page/brain_page.py），不要用编辑工具直接改这个 HTML 文件，也不要复制它做备份。
- 以 . 开头的 \`.jc-locks\`、\`.jc-versions\`、\`.jc-changes\` 是创作页自动留的锁、备份和改动记录，不要动。

## 市场调研

- 对标账号、调研报告、评论导入三个文件夹放什么、文件格式是什么，写在 \`${researchReadmePlace(config)}\` 里，动手前先读它。
- 调研（拉博主的作品和数据、分析评论区、出调研报告）用调研 Skill（${RESEARCH_SKILL}）。
- TikHub 的 key 只存在这台 Mac 的钥匙串里，不要写进任何文件，也不要打印出来。

## 封面

- 拆封面 VI（对标博主的，或者用户放进来的几张图）、给一条选题出一批封面、按用户的评论改一张、记下用户定了用哪张，都用封面 Skill（${COVER_SKILL}）：人物参考图片、风格、编号、生成记录都由它的脚本读写，文件放在哪也写在它里面。
- 用户自己的照片放在 \`${p("coverAssets")}人物参考图片/\`（工作台上也叫「人物参考图片」），放一张或几张，一张封面最多参考排在前面的 3 张；默认照哪个风格做，记在 \`${p("coverAssets")}封面设置.json\`。对标博主的封面图和 VI 拆解放在他的对标账号文件夹里；用户放进来的几组图在 \`${p("coverAssets")}风格/\` 下面，一组一个文件夹。
- 候选封面一直往后编号（封面-01、封面-02……），不覆盖、不复用；按评论改一张，也存成新的一张。
- 挑一张、改一张在 Codex 桌面版里做：用户点开生成的图，在 Canvas 里用 Comment 标出要改的地方发给你；用户说了「就用 03」，才把那张存成草稿文件夹里的「封面-选定」。工作台「内容」栏的「封面」页和每条选题的页面只用来看，不改封面。

## 提示词的格式

一条提示词一个 .md 文件，放在哪个子文件夹就属于哪个分类。文件开头用三条横线包住几行说明，下面是要复制的正文：

\`\`\`
---
title: 卡片上显示的名字
when: 什么时候会想起它，用自己当时会说的话写
summary: 一句话说清它会做什么
tags: 可选，多个用顿号分开
source: 可选，来自哪里
---
提示词正文。要每次填写的地方写成 {{名称}}，复制前工作台会先让你填。
\`\`\`

文件名以 _ 开头的不会被当成提示词：\`_格式说明.md\` 是说明，\`_分类顺序.md\` 定分类的先后，\`_排序.md\` 是工作台记的卡片顺序，\`_使用记录.jsonl\` 是工作台记的复制和收藏记录。后两个由工作台维护，不要手改。

## 规矩

- 不要直接删除任何文件；不要的东西挪进 \`${p("trash")}\`，文件名前面加上日期，比如「2026-01-01_原文件名」。
- 不要改已有的编号，不要重排编号。
- 不确定一条选题属于哪个类型时，先问用户。
`;
}

/**
 * 市场调研三个文件夹共同的上一层（默认是工作文件夹里的「市场调研」），说明文件 README.md 放在这里。
 * 三个文件夹在设置里改到了别处、没有共同的上一层（或者上一层就是工作文件夹本身）时返回 null，不写说明文件。
 */
export function researchRoot(config) {
  const dirs = RESEARCH_PATH_KEYS.map((key) => config.paths[key]);
  let common = path.dirname(dirs[0]);
  while (!dirs.every((dir) => dir.startsWith(common + path.sep))) {
    const up = path.dirname(common);
    if (up === common) return null;
    common = up;
  }
  const inner = path.relative(config.workFolder, common);
  if (!inner || inner.startsWith("..") || path.isAbsolute(inner)) return null;
  return common;
}

function researchReadmePlace(config) {
  const root = researchRoot(config);
  return root ? placeOf(config, path.join(root, "README.md")) : "工作台仓库里的 docs/配置说明.md";
}

/** 「市场调研/README.md」：三个文件夹放什么、文件格式、调研 Skill 怎么用它们。给用户看，也给 AI 看。 */
export function researchGuide(config) {
  const p = (key) => placeOf(config, config.paths[key], { folder: true });
  return `# 市场调研

这个文件夹是「${BRAND.name}」「市场调研」栏的全部来源：工作台只读这里的文件，页面上的对标账号和调研报告都是从这里现读的。AI 用调研 Skill（${RESEARCH_SKILL}）调研完，也把结果放在这里。

## 三个文件夹

| 文件夹 | 放什么 | 怎么放进来 |
| --- | --- | --- |
| \`${p("benchmarkAccounts")}\` | 对标账号：每个账号一个文件夹，名字是「平台-账号名」，里面一份 \`档案.json\` 和几张图片（头像、主页截图、代表作封面）；拆过封面 VI 的，还有 \`封面/\`、\`VI研究/\` 和 \`VI拆解.md\` | 在工作台「对标账号」页点「添加对标账号」；或者在 AI 里说「把这个博主加进对标账号：（主页链接）」 |
| \`${p("researchReports")}\` | 调研报告：每份报告一个文件夹，名字是「日期_主题」，比如 \`2026-10-03_某条视频的评论区\`，里面一个或几个网页（.html）和一份 \`meta.json\` | 在 AI 里说「帮我分析这条视频的评论区：（视频链接）」，调研 Skill 做好放进来 |
| \`${p("commentImports")}\` | 评论表：用「${SOCIAL_HELPER.name}」浏览器插件导出的评论（Excel、CSV、TSV 都行，也收 JSON） | 在工作台「市场调研」页把导出的表拖进来（工作台会认一下是不是评论表），或者自己放进这个文件夹；AI 分析评论时读这里 |

## 档案.json 的格式

\`\`\`json
{
  "platform": "抖音",
  "account_name": "账号名",
  "url": "https://…（主页链接）",
  "note": "为什么对标、学它什么",
  "tags": ["口播", "低粉爆款"],
  "updated_at": "2026-10-03T10:00:00+08:00",
  "followers": 12000,
  "bio": "主页上的简介",
  "source": "manual"
}
\`\`\`

- 前六项每个账号都有；\`followers\`（粉丝数）、\`bio\`（简介）、\`source\`（这份档案从哪来：\`tikhub\` 是 AI 用 TikHub 拉的，\`manual\` 是手动加的）可以没有。
- 账号文件夹里的图片（jpg、png、webp）就是工作台上这个账号卡片的样子：名字以「头像」开头的那张当封面，其余按名字排。

## meta.json 的格式

\`\`\`json
{
  "title": "某条视频的评论区",
  "date": "2026-10-03",
  "type": "评论洞察",
  "source": "https://…（分析的视频或账号的链接）",
  "pages": [
    { "file": "index.html", "title": "总览" },
    { "file": "需求.html", "title": "评论里的需求" }
  ]
}
\`\`\`

- \`type\` 写「评论洞察」「视频拆解」「账号研究」「封面VI」四种之一，工作台按它分类筛选。
- \`pages\` 是这份报告里的网页，第一页是主页；不写时，工作台把文件夹里的 .html 都列出来，按文件名排。
- 没有 \`meta.json\` 时，工作台从文件夹名认日期和标题。写 \`"workbenchVisible": false\` 的报告不在工作台上显示。
- 研究某个对标账号的报告，\`source\` 写这个账号的主页链接（或者标题里带上账号名），工作台的账号卡片上就能直接打开它。
- 报告做成自己带全部内容的网页：样式、数据、图表都写在网页里，图片可以放在同一个文件夹、用相对路径引用。工作台打开报告时把它放在隔开的环境里：报告里的脚本照常能画图，但用不了浏览器存储（localStorage 这类），也碰不到工作台本身。

## 调研 Skill 会怎么用它们

- 批量拉博主的资料、作品和数据（播放、点赞、评论数这些）用 TikHub，也能用它快速采少量评论。TikHub 是付费接口，用你自己的账号和 key，按调用次数扣钱。key 在工作台「市场调研」页上接：粘贴进去点「检测并保存」，检测通过才存进这台 Mac 的登录钥匙串（服务名 \`${KEYCHAIN.service}\`，账户名 \`${KEYCHAIN.account}\`），不写进任何文件。环境变量 \`TIKHUB_API_KEY\` 有值时优先用它。
- 评论用${SOCIAL_HELPER.name}（第三方浏览器插件）导出成表，在工作台页面上拖进来，或者直接放进 \`${p("commentImports")}\`，AI 直接读这些表。要完整的评论区就用插件导出：不花钱，也比 TikHub 拉得全（TikHub 拉抖音评论时翻页会重复，拿到的比平台显示的少）。插件用的是浏览器里登录的账号，所以要用小号登录。
- 做好的报告放进 \`${p("researchReports")}\`，拉到的账号资料写进 \`${p("benchmarkAccounts")}\` 对应账号的 \`档案.json\`。
- 不要的东西挪进 \`${placeOf(config, config.paths.trash, { folder: true })}\`，不直接删除。

## 封面 VI

拆一个对标博主的封面风格用封面 Skill（${COVER_SKILL}）：他最近 20 张封面放进他账号文件夹的 \`封面/\`（按 K01、K02 排，从新到旧），研究数据放 \`VI研究/\`，给出封面时读的拆解写成 \`VI拆解.md\`（第二行是「风格名：……」），默认参考哪几张构图写在 \`默认构图.json\`；能点原图对照的网页放进 \`${p("researchReports")}\`，\`meta.json\` 的 \`type\` 写「封面VI」，\`source\` 写这个账号文件夹的名字（用户放进来的几张图拆的，写「风格/<文件夹名>」），工作台的对标账号卡片和「内容」栏的「封面」页上就能打开它。
`;
}

export function claudeGuide() {
  return `# 给 Claude 的说明

这个文件夹的规矩都写在 AGENTS.md 里，两份说的是一回事，以 AGENTS.md 为准。

@AGENTS.md
`;
}

export function promptFormatGuide() {
  return `# 提示词怎么写

这个文件夹是工作台「提示词」栏的全部来源：工作台只读这里，不会改你的正文。要加一条，就在这里新建一个 .md 文件。

- 一条提示词一个 .md 文件。放在哪个子文件夹，页面上就属于哪个分类；直接放在这一层的算「未分类」。
- 文件开头是三条横线包起来的几行说明，下面的正文就是要复制的提示词：

\`\`\`
---
title: 卡片上显示的名字
when: 什么时候会想起它，用自己当时会说的话写，比如「不知道下一条拍什么」
summary: 一句话说清它会做什么
tags: 可选，多个用顿号分开
source: 可选，来自哪里
---
提示词正文，从这里开始整段被复制。
\`\`\`

- \`when\` 是卡片上的第一行小字，也是搜索时最先比对的地方。找提示词时你记得的往往是当时的处境，不是名字，所以这一行最重要。
- 正文里每次要填的地方写成 \`{{名称}}\`，复制前页面会先让你填；\`{{时长|30秒 / 60秒}}\` 竖线后面是给自己看的提示，不会进入复制结果。方括号 \`[…]\` 不算要填的地方。
- 文件名以 \`_\` 或 \`.\` 开头的不会被读成提示词，这份说明就是这样被跳过的。
- \`_分类顺序.md\` 决定分类在页面上从左到右的顺序，新建了分类记得加进去。
- \`_排序.md\` 是你在页面上拖动卡片后记下的顺序，\`_使用记录.jsonl\` 记每次复制和收藏，都由工作台维护，不用手改。
- 在页面上删除一条提示词，文件会挪到工作文件夹的「回收站」，文件名前面加上日期，不会永久删除。
`;
}

export function categoryOrder() {
  return `# 分类顺序

提示词页的分类按这里从上到下的顺序从左往右排。破折号后面是这一步在做什么，鼠标停在分类上会显示。这里没写到的分类排在最后。

1. 选题 — 想清楚下一条拍什么
2. 写稿 — 把想法写成能直接念的稿子
`;
}

export const EXAMPLE_PROMPTS = Object.freeze([
  {
    file: "选题/想十个选题.md",
    text: `---
title: 想十个选题
when: 不知道下一条拍什么，想先多要几个方向
summary: 按你的领域和观众，给出 10 个带开头的选题
tags: 示例
---
我在做 {{领域|比如：AI 工具教程}} 方向的短视频，观众主要是 {{观众|比如：刚开始用 AI 的上班族}}。
请给我 10 个选题，每个选题写三样东西：标题；为什么观众会想看（一句话）；开头前 5 秒怎么说。
选题要具体到一个场景或一个问题，不要泛泛而谈。
`,
  },
  {
    file: "写稿/口语稿整理成逐字稿.md",
    text: `---
title: 口语稿整理成逐字稿
when: 随口录了一段话，想整理成能直接念的稿子
summary: 保留你的说话方式，去掉口头禅和重复，分好段
tags: 示例
---
下面是我随口说的一段话的文字记录。请帮我整理成一条短视频的逐字稿：
1. 保留我的说法和语气，不要改成书面语；
2. 去掉口头禅、重复和说错又改口的地方；
3. 按意思分段，每段不超过三句；
4. 第一句要能让人停下来看。

文字记录贴在这句后面：
`,
  },
]);
