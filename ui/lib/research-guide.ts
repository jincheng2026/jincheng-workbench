// 「市场调研」页上的引导：空白时说什么、三种调研缺什么、要几分钟、约花多少钱、旁边放什么按钮。
// 「复制给 AI 的话」本身在 ask-ai.ts。只放类型和纯函数（不引别的模块），页面和测试（tests/research-guide.test.mjs）都直接用它。

export type Account = {
   name: string; // 账号文件夹名「平台-账号名」
   platform: string | null;
   accountName: string;
   url: string | null;
   note: string | null;
   tags: string[];
   followers: number | string | null;
   bio: string | null;
   source: string | null; // tikhub：AI 用 TikHub 拉的；manual：手动加的
   images: string[];
   updatedAt: string | null;
   problem: string | null;
   // 封面 VI（1.1 加）：拆过没有、风格名、封面/ 里几张、是不是默认对标、对照网页在哪份调研报告里；旧的后台没有这一项
   vi?: {
      done: boolean;
      style: string | null;
      covers: number;
      samples: string[];
      isDefault: boolean;
      report: { id: string; page: string } | null;
   };
};

export type ReportPage = { file: string; title: string; subtitle: string | null };
export type Report = {
   id: string;
   title: string;
   date: string | null;
   type: string;
   source: string | null;
   pages: ReportPage[];
   updatedAt: string | null;
   problem: string | null;
};

export type CostEstimate = {
   live: boolean;
   checkedOn: string | null;
   video: string;
   account: string;
   comments: string;
   lines: string[];
   note: string;
};

export type ImportsSummary = {
   folder: string;
   exists: boolean;
   tables: { name: string; ok: boolean; comments: number; notes: number | null; unit: string | null; problem: string | null; modifiedAt: string }[];
   recognized: number;
   comments: number;
   notes: number | null;
   unit: string | null;
   configured: boolean;
   line: string | null;
};

export type TikhubResult = 'ok' | 'bad-key' | 'forbidden' | 'no-balance' | 'network' | 'busy' | 'server';
export type TikhubCheck = {
   result: TikhubResult;
   message: string;
   at: string;
   balance?: number;
   freeCredit?: number;
   source?: string;
};

export const REPORT_TYPES = ['评论洞察', '视频拆解', '账号研究', '封面VI'] as const;
export type ResearchKind = 'comments' | 'video' | 'account';

/** 空白的对标账号页：两种加法 */
export function accountsEmpty(tikhubReady: boolean) {
   return {
      text: '还没有对标账号',
      hint:
         '两种加法：自己加，点「添加对标账号」，填账号名和主页链接，放一张主页截图；或者让 AI 加，点「复制给 AI 的话」粘贴给 AI，在后面贴上主页链接发出去，' +
         (tikhubReady ? 'AI 会用 TikHub 拉他的资料和作品。' : 'AI 会用 TikHub 拉他的资料和作品（要先在上面接好 TikHub）。'),
   };
}

/** 空白的调研报告：三种调研里有能做的，就叫他点那张卡片上的「复制给 AI 的话」；都还缺东西时先去配，旁边也给一段话 */
export function reportsEmpty(anyReady: boolean) {
   const where = 'AI 做好的报告放进「市场调研/调研报告」，这里就会出现。';
   return anyReady
      ? {
           text: '还没有调研报告',
           hint: `从上面三种调研里挑一种，点它的「复制给 AI 的话」粘贴给 AI，在后面贴上视频或主页链接发出去。${where}`,
           copy: false,
        }
      : {
           text: '还没有调研报告',
           hint: `先接好上面的数据来源（TikHub，或者社媒助手导出的评论表），再点「复制给 AI 的话」粘贴给 AI，在后面贴上视频链接发出去。${where}`,
           copy: true,
        };
}

export type ResearchCard = {
   kind: ResearchKind | 'cover-vi'; // cover-vi：封面 VI（1.1 加），复制的话用封面 Skill（ask-ai.ts 的 askCoverViAny）
   type: string;
   title: string;
   what: string;
   ready: boolean;
   line: string;
   // 缺东西时旁边的按钮：去接 TikHub、去导出评论；不缺时是「复制给 AI 的话」
   action: 'copy' | 'tikhub' | 'social';
   actionLabel: string;
};

/** 三种调研都显示，不藏：缺东西的那张变灰，写一句缺什么、要几分钟、约花多少钱，按钮就在旁边 */
export function researchCards({
   tikhubReady,
   importedComments,
   cost,
}: {
   tikhubReady: boolean;
   importedComments: number;
   cost: Pick<CostEstimate, 'video' | 'account' | 'comments'>;
}): ResearchCard[] {
   const needTikhub = (spend: string) => `还缺 TikHub：接好约 5 分钟，${spend}。`;
   const comments: ResearchCard = importedComments
      ? {
           kind: 'comments',
           type: '评论洞察',
           title: '评论洞察',
           what: '读一条视频或笔记的评论区，看观众在问什么、要什么。',
           ready: true,
           line: `评论表里已经有 ${importedComments.toLocaleString('zh-CN')} 条评论，可以直接让 AI 做。`,
           action: 'copy',
           actionLabel: '复制给 AI 的话',
        }
      : tikhubReady
        ? {
             kind: 'comments',
             type: '评论洞察',
             title: '评论洞察',
             what: '读一条视频或笔记的评论区，看观众在问什么、要什么。',
             ready: true,
             line: `可以让 AI 用 TikHub 采少量评论：${cost.comments}。要完整的评论区，用社媒助手导出。`,
             action: 'copy',
             actionLabel: '复制给 AI 的话',
          }
        : {
             kind: 'comments',
             type: '评论洞察',
             title: '评论洞察',
             what: '读一条视频或笔记的评论区，看观众在问什么、要什么。',
             ready: false,
             line: `还缺评论：用社媒助手导出一份评论表，第一次约 10 分钟，不花钱；或者接好 TikHub（约 5 分钟，${cost.comments}）。`,
             action: 'social',
             actionLabel: '去导出评论',
          };
   return [
      comments,
      {
         kind: 'video',
         type: '视频拆解',
         title: '视频拆解',
         what: '拆一条爆款视频：开头怎么抓人、怎么往下讲、为什么能火。',
         ready: tikhubReady,
         line: tikhubReady ? `${cost.video}。` : needTikhub(cost.video),
         action: tikhubReady ? 'copy' : 'tikhub',
         actionLabel: tikhubReady ? '复制给 AI 的话' : '去接 TikHub',
      },
      {
         kind: 'account',
         type: '账号研究',
         title: '账号研究',
         what: '研究一个对标博主：拉他的作品和数据，看他靠什么涨粉。',
         ready: tikhubReady,
         line: tikhubReady ? `${cost.account}。` : needTikhub(cost.account),
         action: tikhubReady ? 'copy' : 'tikhub',
         actionLabel: tikhubReady ? '复制给 AI 的话' : '去接 TikHub',
      },
      // 封面 VI（1.1 加）：没接 TikHub 也能做，把博主的封面放进一个文件夹贴给 AI 就行，所以一直是能做的样子
      {
         kind: 'cover-vi',
         type: '封面VI',
         title: '封面 VI',
         what: '拆一个博主的封面：逐张看他最近 30 张封面，找出能照着做的规律，以后出封面照他的风格来。',
         ready: true,
         line: tikhubReady
            ? `贴他的主页链接，AI 用 TikHub 拉他最近的封面：${cost.account}。也可以贴一个放着他封面的文件夹，不花钱。`
            : '把他的封面图放进一个文件夹，把文件夹贴给 AI，不花钱；接好 TikHub 以后贴主页链接就行。',
         action: 'copy',
         actionLabel: '复制给 AI 的话',
      },
   ];
}

/** 「数据来源」收起来时的一行，和「还差几步」 */
export function sourcesLine({
   tikhubReady,
   balanceText,
   importsLine,
}: {
   tikhubReady: boolean;
   balanceText: string | null;
   importsLine: string | null;
}): { missing: number; parts: string[] } {
   const parts = [
      tikhubReady ? `TikHub 已接好${balanceText ? `，${balanceText}` : ''}` : 'TikHub 还没接',
      importsLine ? `评论表${importsLine}` : '评论表还没导入',
   ];
   return { missing: (tikhubReady ? 0 : 1) + (importsLine ? 0 : 1), parts };
}

/** 检测 key 的结果：什么颜色、旁边放什么按钮 */
export function checkAdvice(check: Pick<TikhubCheck, 'result' | 'balance' | 'freeCredit'>, links: { keys: string; addCredit: string }) {
   const empty = check.result === 'ok' && (check.balance ?? 0) + (check.freeCredit ?? 0) <= 0;
   switch (check.result) {
      case 'ok':
         return { tone: empty ? ('warn' as const) : ('ok' as const), action: empty ? { label: '去充值', href: links.addCredit } : null };
      case 'bad-key':
         return { tone: 'err' as const, action: { label: '回 TikHub 重新复制', href: links.keys } };
      case 'forbidden':
         return { tone: 'warn' as const, action: { label: '去勾权限', href: links.keys } };
      case 'no-balance':
         return { tone: 'warn' as const, action: { label: '去充值', href: links.addCredit } };
      default:
         return { tone: check.result === 'network' ? ('err' as const) : ('warn' as const), action: { label: '重试', href: null } };
   }
}

/** 余额写成「余额 $3.20」 */
export function balanceText(check: Pick<TikhubCheck, 'result' | 'balance' | 'freeCredit'> | null): string | null {
   if (!check || check.result !== 'ok' || typeof check.balance !== 'number') return null;
   const usd = (n: number) => `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2)}`;
   return `余额 ${usd(check.balance)}${check.freeCredit ? `（送的额度还剩 ${usd(check.freeCredit)}）` : ''}`;
}

/** 主页链接比较用：域名不分大小写、去掉 www、问号后面的参数和结尾的斜杠（和后台 sameUrlKey 一样） */
export function urlKey(url: string | null | undefined): string {
   if (!url) return '';
   try {
      const u = new URL(url.trim());
      return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
   } catch {
      return '';
   }
}

const nameKey = (text: string) => text.replace(/\s+/g, '').toLowerCase();

/** 和一个对标账号有关的报告：报告的 source 就是他的主页链接，或者报告标题、文件夹名里带着他的账号名 */
export function relatedReports(account: Pick<Account, 'accountName' | 'url'>, reports: Report[]): Report[] {
   const home = urlKey(account.url);
   const name = nameKey(account.accountName);
   return reports.filter(
      (r) => (home && urlKey(r.source) === home) || (name.length >= 2 && nameKey(`${r.title} ${r.id}`).includes(name))
   );
}

/** 粉丝数：12000 写成「1.2 万粉丝」，已经是文字的原样 */
export function followersText(value: number | string | null): string | null {
   if (value === null || value === undefined || value === '') return null;
   if (typeof value === 'string') return /粉/.test(value) ? value : `${value} 粉丝`;
   if (!Number.isFinite(value)) return null;
   if (value >= 10000) return `${Number((value / 10000).toFixed(value >= 100000 ? 0 : 1))} 万粉丝`;
   return `${value} 粉丝`;
}
