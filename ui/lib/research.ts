// 「市场调研」栏：类型定义和请求。数据全部由后台从文件和钥匙串现算（lib/research.mjs、lib/tikhub.mjs），
// 这里不保存任何状态。TikHub 的 key 只在「检测并保存」时发给后台一次，后台回来的只有后四位和余额。
import { postFile, postJson, request } from '@/lib/api';
import type { Account, CostEstimate, ImportsSummary, Report, TikhubCheck } from '@/lib/research-guide';

export type { Account, CostEstimate, ImportsSummary, Report, ReportPage, TikhubCheck } from '@/lib/research-guide';

export type AccountsResult = { folder: string; platforms: string[]; accounts: Account[] };
export type ReportsResult = { folder: string; reports: Report[] };

export type TikhubStatus = {
   configured: boolean;
   source: 'keychain' | 'env' | null;
   last4: string | null;
   keychainOk: boolean;
};

export type Sources = {
   tikhub: TikhubStatus & {
      check: TikhubCheck | null;
      cost: CostEstimate;
      links: { register: string; keys: string; addCredit: string; pricing: string };
      newCredit: number;
      minTopUp: number;
   };
   social: {
      name: string;
      maker: string;
      storeUrl: string;
      downloadUrl: string;
      safetyUrl: string;
      imports: ImportsSummary;
   };
   missing: number;
};

export type ConnectResult = TikhubCheck & { saved: boolean; status: TikhubStatus; cost: CostEstimate };
export type CheckResult = TikhubCheck & { status: TikhubStatus; cost: CostEstimate };
export type ImportResult = {
   ok: boolean;
   file: string;
   comments: number;
   notes: number | null;
   unit: string | null;
   message: string;
   imports: ImportsSummary;
};

export const fetchAccounts = () => request<AccountsResult>('/api/research/accounts');
export const fetchReports = () => request<ReportsResult>('/api/research/reports');
export const fetchSources = () => request<Sources>('/api/research/sources');

export type AccountForm = {
   name?: string;
   platform: string;
   accountName: string;
   url: string;
   note: string;
   tags: string[];
};

export function saveAccount(form: AccountForm) {
   return postJson<{ ok: boolean; created: boolean; name: string; message: string; account: Account }>(
      '/api/research/accounts',
      form
   );
}

export function uploadAccountImage(name: string, file: File) {
   return postFile<{ ok: boolean; file: string }>(
      `/api/research/accounts/image?name=${encodeURIComponent(name)}&filename=${encodeURIComponent(file.name)}`,
      file
   );
}

export function trashAccount(name: string) {
   return postJson<{ ok: boolean; message: string }>('/api/research/accounts/trash', { name });
}

export function importCommentTable(file: File) {
   return postFile<ImportResult>(`/api/research/comments/import?filename=${encodeURIComponent(file.name)}`, file);
}

export function connectTikhub(key: string) {
   return postJson<ConnectResult>('/api/research/tikhub/connect', { key });
}

export function checkTikhub() {
   return postJson<CheckResult>('/api/research/tikhub/check', {});
}

export function deleteTikhubKey() {
   return postJson<{ ok: boolean; status: TikhubStatus; message: string }>('/api/research/tikhub/delete', {});
}

/** 账号图片、报告网页的地址（经界面转给后台） */
export const accountImageUrl = (name: string, file: string) =>
   `/api/research/accounts/${encodeURIComponent(name)}/${encodeURIComponent(file)}`;

export const reportFileUrl = (id: string, file: string) =>
   `/api/research/reports/${encodeURIComponent(id)}/${file.split('/').map(encodeURIComponent).join('/')}`;

/** 在工作台里看一份报告的地址 */
export const reportViewHref = (id: string, file: string) =>
   `/research?tab=reports&report=${encodeURIComponent(id)}&page=${encodeURIComponent(file)}`;
