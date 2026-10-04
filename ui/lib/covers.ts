// 封面（1.1 加）：页面和后台（lib/covers.mjs）之间的类型和请求。出图、拆 VI 交给 AI（复制的话在 ask-ai.ts），
// 这里只有不用 AI 的事：读全貌、选定、取消选定、删除、收藏、存批注图、放照片、设默认对标、在访达中打开。
import { postFile, postJson, request } from '@/lib/api';

export type CoverSettings = { photo: string | null; benchmark: string | null; batchSize: number; problem: string | null };

export type CoverItem = {
   no: string; // 两位编号「03」
   image: string | null; // 封面-03.png；Claude Code 只出了提示词时是 null
   prompt: string | null; // 生图描述-03.md
   promptText?: string | null;
   change: string | null; // 本张变化
   check: string | null; // 自检：「通过」或者问题
   note: string | null; // 最近一张批注图
   favorite: boolean;
   selected: boolean;
   modifiedAt: string | null;
};

export type CoverBatch = { no: number | null; info: string | null; items: CoverItem[] };

export type TopicCovers = {
   id: string;
   folder: string | null; // 草稿文件夹名；还没有是 null
   settings: CoverSettings;
   batches: CoverBatch[];
   selected: { name: string; from: string | null; modifiedAt: string } | null;
   favorites: string[];
   events?: string[];
   next: { no: string; batch: number };
   total: number;
};

export type AccountVi = {
   done: boolean;
   style: string | null;
   covers: number;
   samples: string[];
   isDefault: boolean;
   report: { id: string; page: string } | null;
};

export type CoverInfo = {
   folder: string;
   settings: CoverSettings;
   photos: { name: string; shown: boolean; modifiedAt: string }[];
   favorites: { name: string; id: string | null; no: string | null; modifiedAt: string }[];
   benchmarks: { name: string; accountName: string; platform: string | null; vi: AccountVi }[];
};

type Done = { ok: boolean; message: string; covers: TopicCovers };

export const fetchTopicCovers = (id: string) => request<TopicCovers>(`/api/works/${encodeURIComponent(id)}/covers`);
export const fetchCoverInfo = () => request<CoverInfo>('/api/covers');
export const selectCover = (id: string, no: string) => postJson<Done>(`/api/works/${encodeURIComponent(id)}/covers/select`, { no });
export const unselectCover = (id: string) => postJson<Done>(`/api/works/${encodeURIComponent(id)}/covers/unselect`, {});
export const trashCover = (id: string, no: string) => postJson<Done>(`/api/works/${encodeURIComponent(id)}/covers/trash`, { no });
export const favoriteCover = (id: string, no: string, on: boolean) =>
   postJson<Done>(`/api/works/${encodeURIComponent(id)}/covers/favorite`, { no, on });
export const openCoverFolder = (id: string) => postJson<Done & { dryRun?: boolean }>(`/api/works/${encodeURIComponent(id)}/covers/open`, {});
export const saveAnnotation = (id: string, no: string, png: Blob, name?: string) =>
   postFile<{ ok: boolean; name: string; relative: string }>(
      `/api/works/${encodeURIComponent(id)}/covers/annotate?no=${encodeURIComponent(no)}${name ? `&name=${encodeURIComponent(name)}` : ''}`,
      png
   );
export const uploadPhoto = (file: File) =>
   postFile<{ ok: boolean; name: string; message: string; settings: CoverSettings }>(`/api/covers/photo?filename=${encodeURIComponent(file.name)}`, file);
export const setDefaultBenchmark = (name: string) =>
   postJson<{ ok: boolean; message: string; settings: CoverSettings }>('/api/research/accounts/vi-default', { name });

const part = (value: string) => value.split('/').map(encodeURIComponent).join('/');
/** 一条内容的封面图：封面候选/封面-03.png、封面候选/批注/…、封面-选定.png（v 是改动时间，换了图浏览器不拿旧的） */
export const coverUrl = (id: string, relative: string, v?: string | null) =>
   `/api/works/${encodeURIComponent(id)}/covers/file/${part(relative)}${v ? `?v=${encodeURIComponent(v)}` : ''}`;
export const photoUrl = (name: string) => `/api/covers/photo/${encodeURIComponent(name)}`;
export const favoriteUrl = (name: string) => `/api/covers/favorite/${encodeURIComponent(name)}`;
export const viImageUrl = (account: string, file: string) =>
   `/api/research/accounts/${encodeURIComponent(account)}/vi/${encodeURIComponent(file)}`;

export { checkTone, nextNoteName, photoName } from '@/lib/cover-names';
