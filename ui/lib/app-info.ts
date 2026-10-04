// 工作台的基本信息：名字、开了哪些栏目、内容类型、工作文件夹在哪。
// 由接口 /api/app 从设置文件读出来，根布局在服务端取一次，再交给页面用。

import type { ColumnKey } from '@/lib/columns';

export type AppInfo = {
   app: { id: string; name: string; tagline: string; version: string };
   columns: ColumnKey[];
   contentTypes: string[];
   home: string;
   workFolder: string;
   paths: {
      topics: string;
      overview: string;
      drafts: string;
      writingMethod: string;
      benchmarkAccounts: string;
      researchReports: string;
      commentImports: string;
      prompts: string;
      promptUsage: string;
      trash: string;
   };
   configFile: string;
   issues: string[];
   // 创作页：写稿 Skill 的名字、工作台仓库在哪（「复制给 AI 的话」里要写）、保存服务这次的端口
   creation: { skill: string; repo: string; savePort: number };
   // 市场调研：调研 Skill 的名字、还差几步没配好（TikHub 没接、评论表没导入各算一步）
   research: { skill: string; missing: number };
   // 新手指引第 3 步的一键打开：这台 Mac 上装好了处理官方链接的程序没有（没装好就不放按钮）
   aiLinks: { codex: boolean; 'claude-desktop'?: boolean; claude: boolean };
};

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || '锦成工作台';
export const APP_TAGLINE = process.env.NEXT_PUBLIC_APP_TAGLINE || '';
/** 署名（brand.json 的 copyrightHolder）：新手指引开场卡「我是{作者}」用 */
export const APP_AUTHOR = process.env.NEXT_PUBLIC_APP_AUTHOR || '';
/** 仓库地址（brand.json 的 repository）：交给 AI 的话里「没装好就先照这里的安装说明装」用 */
export const APP_REPO = process.env.NEXT_PUBLIC_APP_REPO || '';

/** 交给 AI 的话（lib/ask-ai.ts）要的三样：工作台的名字、仓库地址、用哪个 Skill */
export function askInfo(info: AppInfo, which: 'write' | 'research') {
   return { name: info.app.name || APP_NAME, repo: APP_REPO, skill: which === 'write' ? info.creation.skill : info.research.skill };
}

/** 接口连不上时先用这一份把页面框架画出来，页面里再说清楚连不上。 */
export function fallbackAppInfo(): AppInfo {
   return {
      app: { id: process.env.NEXT_PUBLIC_APP_ID || '', name: APP_NAME, tagline: APP_TAGLINE, version: '' },
      columns: ['content', 'research', 'prompts'],
      contentTypes: [],
      home: '',
      workFolder: '',
      paths: {
         topics: '',
         overview: '',
         drafts: '',
         writingMethod: '',
         benchmarkAccounts: '',
         researchReports: '',
         commentImports: '',
         prompts: '',
         promptUsage: '',
         trash: '',
      },
      configFile: '',
      issues: [],
      creation: { skill: '', repo: '', savePort: 0 },
      research: { skill: '', missing: 0 },
      aiLinks: { codex: false, 'claude-desktop': false, claude: false },
   };
}

/** 本机绝对路径写成 ~/… 的样子给人看。 */
export function tildify(target: string, home: string): string {
   if (!target) return '';
   if (home && target === home) return '~';
   return home && target.startsWith(`${home}/`) ? `~/${target.slice(home.length + 1)}` : target;
}
