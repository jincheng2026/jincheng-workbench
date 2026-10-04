// 封面（1.1 加）：页面和后台（lib/covers.mjs）之间的类型和请求。拆 VI、出图、挑和改都交给 AI（Codex 桌面版，复制的话在 ask-ai.ts），
// 这里只有不用 AI 的事：读风格、人物参考图片、每条内容出过的封面，放人物参考图片、放图建风格、设默认风格、改默认构图、在访达中打开。
import { postFile, postJson, request } from '@/lib/api';

export type CoverSettings = { photo: string | null; benchmark: string | null; batchSize: number; problem: string | null };
export type CoverSize = '竖版 3:4' | '横版 2.35:1' | '方形 1:1';
export type ContentForm = '视频' | '文章';

export type CoverItem = {
   no: string; // 两位编号「03」
   image: string | null; // 封面-03.png；Claude Code 只出了提示词时是 null
   prompt: string | null; // 生图描述-03.md
   promptText?: string | null;
   change: string | null; // 本张变化
   check: string | null; // 自检：「通过」或者问题
   selected: boolean;
   modifiedAt: string | null;
};

export type CoverBatch = { no: number | null; info: string | null; style: string | null; styleName: string | null; size: string | null; items: CoverItem[] };

export type TopicCovers = {
   id: string;
   title: string;
   type: string | null;
   form: ContentForm;
   folder: string | null; // 草稿文件夹名；还没有是 null
   settings: CoverSettings;
   // 出一批时的默认值：尺寸（上一批用的，没出过按视频、文章）、封面上的字（创作页里定好的）
   defaults: { size: CoverSize; text: string | null; textFrom: string | null };
   batches: CoverBatch[];
   selected: { name: string; from: string | null; modifiedAt: string } | null;
   next: { batch: number };
   total: number;
};

/** 风格：对标账号拆出的封面 VI（id 是账号文件夹名），或者你放进来的几张图（id 是「风格/<文件夹名>」） */
export type Style = {
   id: string;
   kind: 'account' | 'images';
   folder: string;
   name: string | null; // 风格名；还没拆是 null
   done: boolean;
   covers: number;
   images: string[]; // 封面/ 里的图（拆过的叫 K01.jpg …）
   compositions: { ids: string[]; by: 'AI' | '你' } | null;
   isDefault: boolean;
   report: { id: string; page: string } | null;
   platform?: string | null;
   accountName?: string;
   at?: string | null;
   from?: string | null;
};

export type Photo = { name: string; main: boolean; shown: boolean; modifiedAt: string };

export type CoverInfo = {
   folder: string;
   settings: CoverSettings;
   photos: Photo[];
   styles: Style[];
   sizes: CoverSize[];
   research: boolean; // 「市场调研」这一栏开着没有（关着时没有对标账号的风格）
};

export type LibraryCover = {
   no: string;
   image: string;
   modifiedAt: string;
   selected: boolean;
   style: string | null;
   styleName: string | null;
   size: string | null;
   batch: number | null;
};
export type LibraryGroup = {
   id: string;
   title: string;
   type: string | null;
   form: ContentForm;
   selected: { name: string; from: string | null; modifiedAt: string } | null;
   covers: LibraryCover[];
   latest: string | null;
};

type Message = { ok: boolean; message: string };

export const fetchTopicCovers = (id: string) => request<TopicCovers>(`/api/works/${encodeURIComponent(id)}/covers`);
export const fetchCoverInfo = () => request<CoverInfo>('/api/covers');
export const fetchCoverLibrary = () => request<{ groups: LibraryGroup[] }>('/api/covers/library');
export const openCoverFolder = (id: string) => postJson<Message & { dryRun?: boolean }>(`/api/works/${encodeURIComponent(id)}/covers/open`, {});
export const uploadPhoto = (file: File) =>
   postFile<Message & { name: string; settings: CoverSettings }>(`/api/covers/photo?filename=${encodeURIComponent(file.name)}`, file);
export const trashPhoto = (name: string) => postJson<Message & { settings: CoverSettings }>('/api/covers/photo/trash', { name });
export const createImageStyle = (count: number) => postJson<{ ok: boolean; id: string; folder: string }>('/api/covers/styles', { count });
export const uploadStyleImage = (style: string, file: File) =>
   postFile<{ ok: boolean; name: string; count: number }>(`/api/covers/styles/image?style=${encodeURIComponent(style)}&filename=${encodeURIComponent(file.name)}`, file);
export const setDefaultStyle = (style: string) => postJson<Message & { settings: CoverSettings }>('/api/covers/styles/default', { style });
export const saveCompositions = (style: string, ids: string[]) =>
   postJson<Message & { compositions: { ids: string[]; by: '你' } }>('/api/covers/styles/compositions', { style, ids });
export const trashImageStyle = (style: string) => postJson<Message>('/api/covers/styles/trash', { style });

const part = (value: string) => value.split('/').map(encodeURIComponent).join('/');
/** 一条内容的封面图：封面候选/封面-03.png、封面-选定.png（v 是改动时间，换了图浏览器不拿旧的） */
export const coverUrl = (id: string, relative: string, v?: string | null) =>
   `/api/works/${encodeURIComponent(id)}/covers/file/${part(relative)}${v ? `?v=${encodeURIComponent(v)}` : ''}`;
export const photoUrl = (name: string) => `/api/covers/photo/${encodeURIComponent(name)}`;
/** 风格里的一张原图（对标账号的、你放进来的都走这里） */
export const styleImageUrl = (style: string, file: string) =>
   `/api/covers/styles/image?style=${encodeURIComponent(style)}&file=${encodeURIComponent(file)}`;

export { checkTone, defaultCompositions, groupByStyle, kIds, styleName, styleSource } from '@/lib/cover-names';
