// 「内容」栏：每个 T 编号一张卡。数据全部由后台 /api/works 从文件现算，
// 这里只放类型定义、请求和展示用的小工具，不保存任何状态。
import { postJson, request, ApiError } from '@/lib/api';
import { askWrite } from '@/lib/ask-ai';
import { APP_NAME, APP_REPO } from '@/lib/app-info';

export type WorkStage = 'todo' | 'doing' | 'done';

export type WorkResume = {
   kind: 'draft' | 'final' | 'teleprompter' | 'doc';
   label: string; // 工作稿 / 定稿 / 提词器版 / 文档
   ref: string;
   name: string;
   modifiedAt: string;
};

/** 这条内容的创作页：草稿文件夹里写稿 Skill 生成的网页，url 是保存服务给的页面链接（在页面上改的字自动存回文件） */
export type WorkCreation = {
   ref: string;
   name: string; // T001_创作页.html
   pageId: string;
   url: string; // http://127.0.0.1:端口/p/页面标识
   modifiedAt: string;
   adopted: number; // 用户在页面上采纳了几条修改建议（新手指引的清单用）
};

export type Work = {
   id: string; // "T001"
   number: number;
   title: string; // 选题卡标题去掉编号和 ✅；没有卡时用总览「选题」列去掉括号说明
   summary: string; // 总览「选题」列全文
   type: string; // 内容类型，来自设置
   stage: WorkStage;
   stageReason: string;
   overviewStatus: string | null; // 待写 / 草稿 / 已发布
   recorded: boolean; // ✅
   publishDate: string | null;
   effect: string | null;
   source: string | null;
   format: string | null;
   priority: string | null;
   plan: { date: string; text: string } | null;
   deferred: { text: string; date: string } | null;
   card: { ref: string; name: string } | null;
   draftDir: { ref: string; name: string } | null;
   lastModified: string | null;
   counts: { texts: number; html: number; files: number; versions: number; media: number };
   issues: string[];
   // 拍摄顺序里排第几（选题总览「近三天内容安排」里最后一次写了顺序的那一行），不在里面是 null
   order: number | null;
   // 从哪里接着写：草稿文件夹里最近改过的文字稿；做完的是 null
   resume: WorkResume | null;
   // 创作页；还没有是 null
   creation: WorkCreation | null;
};

export type WorkFile = {
   ref: string;
   name: string;
   kind: string;
   modifiedAt: string;
   size: number;
   latestVersion?: boolean; // 草稿文件夹里只有「版本」时，后台把最新的一份拿出来当工作稿
};

export type WorkDetail = Work & {
   cardStatus: string | null; // 选题卡「状态」一栏原话
   files: WorkFile[];
};

export type WorksResult = {
   generatedAt: string;
   types: string[];
   works: Work[];
   schedule: { date: string; ids: string[]; text: string } | null;
   notices: string[];
};

export type WorkOpenAs = 'default' | 'finder';

export { ApiError };

export async function fetchWorks(): Promise<WorksResult> {
   const result = await request<WorksResult>('/api/works');
   if (!Array.isArray(result.works)) throw new ApiError('后台返回的选题列表不完整。', 200);
   return result;
}

export function fetchWorkDetail(id: string): Promise<WorkDetail> {
   return request<WorkDetail>(`/api/works/${encodeURIComponent(id)}`);
}

export async function fetchWorkText(id: string, ref: string): Promise<string> {
   const result = await request<{ ref: string; text: string }>(
      `/api/works/${encodeURIComponent(id)}/text?ref=${encodeURIComponent(ref)}`
   );
   if (typeof result.text !== 'string') throw new ApiError('没有读到这份稿子的正文。', 200);
   return result.text;
}

/** 接着写：后台用默认程序打开草稿文件夹里最近改过的那份稿子 */
export function resumeWork(id: string) {
   return postJson<{ ok: boolean; message: string }>('/api/works/resume', { id });
}

export function openWorkTarget(id: string, ref: string, as: WorkOpenAs) {
   return postJson<{ ok: boolean; message: string }>('/api/works/open', { id, ref, as });
}

/** 建草稿文件夹（已经有就用已有的），然后在访达里打开 */
export function openDraftFolder(id: string) {
   return postJson<{ ok: boolean; created: boolean; name: string; message: string }>(
      '/api/works/draft-folder',
      { id }
   );
}

/**
 * 没有创作页时，详情页上交给 AI 的那句话（点一下就复制；新手指引第 2 步复制的、一键打开 Codex 时填好的也是它）。
 * 字在 lib/ask-ai.ts 的 askWrite：不带这台电脑的路径，在哪个对话、哪个文件夹里发都行，写稿 Skill 自己查工作文件夹。
 * skill 是写稿 Skill 的名字（接口 /api/app 的 creation.skill）。界面上显示的就是复制出去的，一字不差。
 */
export function askAiText(work: { id: string }, skill: string): string {
   return askWrite(work.id, { name: APP_NAME, repo: APP_REPO, skill });
}

export function restoreOverview() {
   return postJson<{ ok: boolean; created: boolean; message: string }>(
      '/api/workspace/restore-overview',
      {}
   );
}

/* ── 展示用小工具 ── */

export const STAGE_LABEL: Record<WorkStage, string> = {
   doing: '在做',
   todo: '待做',
   done: '做完了',
};

export const FILE_KIND_LABEL: Record<string, string> = {
   creation: '创作页',
   html: '网页',
   teleprompter: '提词器版',
   final: '定稿',
   draft: '工作稿',
   log: '改稿日志',
   doc: '文档',
   file: '文件',
};

/** 按「3 天前改过」这样的说法描述最近改动；没有时间就返回 null，不编。 */
export function changedAgo(iso: string | null | undefined, now = Date.now()): string | null {
   if (!iso) return null;
   const time = new Date(iso).valueOf();
   if (Number.isNaN(time)) return null;
   const diff = Math.max(0, now - time);
   const hours = diff / 3600000;
   if (hours < 1) return '刚刚改过';
   if (hours < 24) return `${Math.floor(hours)} 小时前改过`;
   const days = Math.floor(hours / 24);
   if (days <= 60) return `${days} 天前改过`;
   const d = new Date(time);
   return `${d.getMonth() + 1}月${d.getDate()}日改过`;
}

/** 「2026-01-05」→「1月5日」；不是标准日期的文字（如「待定」）原样返回。 */
export function shortDate(value: string | null | undefined): string {
   if (!value) return '';
   const m = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
   if (!m) return value.trim();
   return `${Number(m[2])}月${Number(m[3])}日`;
}

/** 只留第一小句（到第一个「；」或「，」），最多 limit 字；完整原话放在详情页。 */
function firstClause(text: string, limit = 20): string {
   const first = text.split(/[；;，,]/)[0]?.trim() || text.trim();
   const chars = [...first];
   return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : first;
}

function todayKey(now: number) {
   const d = new Date(now);
   return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 安排写的日期都早于今天，就是一条过去的记录；「本周内」这类没有标准日期的文字不算过去。 */
export function planIsPast(date: string | null | undefined, now = Date.now()): boolean {
   const dates = String(date ?? '').match(/\d{4}-\d{2}-\d{2}/g);
   if (!dates) return false;
   const today = todayKey(now);
   return dates.every((d) => d < today);
}

/** 顺延在列表里只写一句短话：新日期是标准日期写「顺延到1月5日」，待定写「暂缓，日期待定」；原话在详情页。 */
export function deferredLine(deferred: { text: string; date: string }): string {
   const date = deferred.date?.trim() ?? '';
   if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(date)) return `顺延到${shortDate(date)}`;
   if (!date || date.startsWith('待定')) return '暂缓，日期待定';
   return `暂缓，新日期：${firstClause(date, 12)}`;
}
