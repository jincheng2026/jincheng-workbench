// 交给 AI 的话：页面上「复制给 AI」的那几段（写稿、加选题、三种调研、加对标账号、封面的拆 VI 和出一批），全在这里。
// 只放纯函数（不引别的模块），页面和测试（tests/ask-ai.test.mjs）都直接用。
//
// 每段都照「提示词标准」写（原作者 2026-10-03 定，全文在仓库根目录 AGENTS.md「交给 AI 的话怎么写」）：
// 用户复制、粘贴、发给自己的 AI（Codex 或 Claude Code），AI 就能自己摸清情况，把目的做完。所以每段：
// - 写目的和做完的样子：写成什么、放在哪、最后告诉用户什么；
// - 不写这台电脑的路径：工作文件夹、对标账号、调研报告在哪，两个 Skill 自己从工作台的设置里查；
// - 工作台或 Skill 没装好，AI 先照仓库里的安装说明装好（缺什么直接装），不让用户先做准备；
// - 不让用户在中间填空：只有用户自己知道的东西（视频链接、主页链接）写成「…贴在这句后面：」，放在最后，只留这一处；
// - 要人来做的事（输密码、点允许、接 TikHub、导出评论、同意花钱），AI 做到那一步再停下来提醒。

export type AskInfo = {
   name: string; // 工作台的名字（brand.json 的 name）
   repo: string; // 仓库地址（brand.json 的 repository）；没有时写「工作台仓库」
   skill: string; // 用哪个 Skill：写稿 Skill 或调研 Skill 的名字
};

export type ResearchKind = 'comments' | 'video' | 'account';

/** 只有用户自己知道的东西放在最后，写成「…贴在这句后面：」 */
export const PASTE_HERE = '贴在这句后面：';

/** 每段的后半句：没装好先装；要人做的事到了再提醒 */
function tail(info: AskInfo, human: string) {
   const guide = info.repo ? `${info.repo} 里的安装说明` : '工作台仓库里的安装说明';
   return `工作台或这个 Skill 没装好，就先照 ${guide}装好，缺什么直接装；${human}`;
}

const RESEARCH_HUMAN = '要我接 TikHub、导出评论或者同意花钱的时候，停下来告诉我怎么做。';
const REPORT_PLACE = '放进工作台的「市场调研」';

const WRITE_HUMAN = '要我输密码、点允许的时候提醒我。';

/** 写稿：详情页上那一句（新手指引第 2 步复制的、一键打开 Codex 时填好的也是它） */
export function askWrite(id: string, info: AskInfo): string {
   return `用${info.name}的写稿 Skill（${info.skill}），把选题 ${id} 写成第一版逐字稿，做成创作页，做完把创作页的链接发给我。${tail(info, WRITE_HUMAN)}`;
}

/** 加选题：「选题」页的「复制给 AI：加选题」。编号、加在哪一格由写稿 Skill 里的脚本定，用户只写自己想做什么 */
export function askAddTopic(info: AskInfo): string {
   return `用${info.name}的写稿 Skill（${info.skill}），把我想做的选题加进工作台，让我在工作台「选题」里能看到，做完告诉我每条的编号。${tail(info, WRITE_HUMAN)}选题（一条或几条都行）${PASTE_HERE}`;
}

/** 三种调研各自的「复制给 AI 的话」。评论洞察已经导入了评论表时，不用再贴链接 */
export function askResearch(kind: ResearchKind, info: AskInfo, { importedFiles = [] as string[] } = {}): string {
   const use = `用${info.name}的调研 Skill（${info.skill}）`;
   const after = tail(info, RESEARCH_HUMAN);
   if (kind === 'comments') {
      if (importedFiles.length) {
         return `${use}读我导入工作台的评论表（${importedFiles.join('、')}），看观众在问什么、要什么，写成评论洞察报告${REPORT_PLACE}，做完告诉我结论和能拍的选题。${after}`;
      }
      return `${use}分析一条视频的评论区：看观众在问什么、要什么，写成评论洞察报告${REPORT_PLACE}，做完告诉我结论和能拍的选题。评论先用我导入工作台的评论表，没有就用 TikHub 采。${after}视频链接${PASTE_HERE}`;
   }
   if (kind === 'video') {
      return `${use}拆解一条视频：开头怎么抓人、怎么往下讲、为什么能火，写成视频拆解报告${REPORT_PLACE}，做完告诉我能借的地方。${after}视频链接${PASTE_HERE}`;
   }
   return `${use}研究一个对标博主：拉他的资料、作品和数据，加进对标账号，看他最近哪几条明显比平时火、靠什么涨粉，写成账号研究报告${REPORT_PLACE}，做完告诉我结论。${after}博主的主页链接${PASTE_HERE}`;
}

/** 导入评论表以后的「复制给 AI：生成评论报告」 */
export function askCommentReport(info: AskInfo, files: string[]): string {
   return askResearch('comments', info, { importedFiles: files });
}

// —— 封面（1.1 加，封面 Skill）——
// 原作者 2026-10-04 定：拆一个博主看他最近 20 张封面；一批默认 5 张；挑一张、改一张在 Codex 桌面版里做（看图、评论改图是它自带的），
// 所以没有「按备注改」这类复制的话。风格编号：对标账号是账号文件夹名，你放进来的图是「风格/<文件夹名>」（和封面 Skill 约好的）。
const COVER_HUMAN = '要我放照片、接 TikHub、放封面图或者点允许的时候，停下来告诉我怎么做。';
const VI_DONE = '写成 VI 拆解放进工作台，起好风格名；我还没有默认风格的话，就把它设成默认。';
const VI_LEARN = '做完告诉我他的封面最值得学的几条规律。';

type CoverAccount = { accountName: string; platform?: string | null };
const accountText = (a: CoverAccount) => `「${a.accountName}」${a.platform ? `（${a.platform}）` : ''}`;

/** 对标账号卡片、「封面」页风格卡片上的「拆封面 VI」：账号已知，不用贴东西 */
export function askCoverVi(account: CoverAccount, info: AskInfo): string {
   return `用${info.name}的封面 Skill（${info.skill}），拆对标账号${accountText(account)}的封面 VI：看他最近 20 张封面，${VI_DONE}${VI_LEARN}${tail(info, COVER_HUMAN)}`;
}

/** 「封面」页的「一次全拆」：还没拆封面 VI 的几个对标账号一起交给 AI，一个一个拆 */
export function askCoverViBatch(accounts: CoverAccount[], info: AskInfo): string {
   return `用${info.name}的封面 Skill（${info.skill}），把我还没拆封面 VI 的 ${accounts.length} 个对标账号都拆了：${accounts.map(accountText).join('、')}。每个看他最近 20 张封面，写成 VI 拆解放进工作台，起好风格名；我还没有默认风格的话，把第一个拆完的设成默认。做完告诉我每个的风格名和最值得学的几条规律。${tail(info, COVER_HUMAN)}`;
}

/** 「封面」页拖完图以后的「拆这组图」：不是同一个博主的几张图，拆成一个风格（不是一种就分开拆） */
export function askCoverViImages(style: { id: string; covers: number }, info: AskInfo): string {
   return `用${info.name}的封面 Skill（${info.skill}），拆我放进工作台「封面」里的那组图（${style.id}，${style.covers} 张）：一张张看，写成 VI 拆解放进工作台，起好风格名；不是同一种风格就分开拆、各起名字；我还没有默认风格的话，就把它设成默认。做完告诉我最值得学的几条规律。${tail(info, COVER_HUMAN)}`;
}

/** 「封面」页的「贴主页链接」：页面上贴了链接就直接带上，没贴就照提示词标准写成「…贴在这句后面：」放在最后 */
export function askCoverViLink(info: AskInfo, link = ''): string {
   const url = link.trim();
   return `用${info.name}的封面 Skill（${info.skill}），拆一个博主的封面 VI：看他最近 20 张封面，${VI_DONE}${VI_LEARN}${tail(info, COVER_HUMAN)}${url ? `博主的主页链接：${url}` : `博主的主页链接${PASTE_HERE}`}`;
}

export type MakeCoversOptions = {
   count?: number;
   size?: string;
   /** 照哪个风格出：没有就写「照我设的默认风格出」 */
   style?: { id: string; kind: 'account' | 'images'; name: string | null } | null;
   /** 参考这个风格的哪几张构图（K 编号） */
   compositions?: string[];
   /** 封面上的字：没填就让 AI 用创作页里定好的，没定就用选题名 */
   text?: string | null;
};

/** 选题页面的「出一批封面」：张数、尺寸、风格、参考构图、封面上的字都照页面上选的写进去 */
export function askMakeCovers(id: string, info: AskInfo, { count = 5, size = '竖版 3:4', style = null, compositions = [], text = null }: MakeCoversOptions = {}): string {
   const where = style ? (style.kind === 'account' ? `对标账号「${style.id}」` : `我放进来的图「${style.id}」`) : '';
   const styleText = style
      ? `照风格「${style.name ?? style.id}」（${where}）出${compositions.length ? `，构图参考它的 ${compositions.join('、')}` : ''}；`
      : '照我设的默认风格出；';
   const words = text?.trim() ? `封面上的字用「${text.trim()}」；` : '封面上的字用创作页里定好的，没定就用选题名；';
   return `用${info.name}的封面 Skill（${info.skill}），给选题 ${id} 出一批封面：${count} 张，${size}；${styleText}${words}照片用我在工作台「封面」里放的。放进这条内容的封面候选，做完告诉我出了几张、哪几张自检有问题。${tail(info, COVER_HUMAN)}`;
}

/** 对标账号页的「复制给 AI 的话」：把一个博主加进对标账号 */
export function askAddAccount(info: AskInfo): string {
   return `用${info.name}的调研 Skill（${info.skill}）把一个博主加进对标账号：拉他的资料和最近的作品，建好档案，让我在工作台「市场调研」的对标账号里能看到。${tail(info, RESEARCH_HUMAN)}博主的主页链接${PASTE_HERE}`;
}
