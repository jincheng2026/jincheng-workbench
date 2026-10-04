// 请求接口：全部走同一个地址下的 /api/*（由 app/api/[...path]/route.ts 转给接口服务）。
// 出错时把接口给的中文原因带出来；接口没有原因时，换成看得懂的话。

export class ApiError extends Error {
   status: number;
   code: string | null;
   constructor(message: string, status: number, code: string | null = null) {
      super(message);
      this.status = status;
      this.code = code;
   }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
   let response: Response;
   try {
      response = await fetch(path, { cache: 'no-store', ...init });
   } catch {
      throw new ApiError('连不上后台。运行 pnpm start 的那个终端窗口还开着吗？', 0);
   }
   const raw = await response.text();
   let body: unknown = null;
   try {
      body = raw ? JSON.parse(raw) : null;
   } catch {
      body = null;
   }
   const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
   const message = typeof record?.error === 'string' ? record.error : null;
   const code = typeof record?.code === 'string' ? record.code : null;
   if (!response.ok) {
      throw new ApiError(
         message ??
            (response.status >= 500
               ? `后台出错了（HTTP ${response.status}），可以看一下终端里的提示。`
               : `后台没有给出结果（HTTP ${response.status}）。`),
         response.status,
         code
      );
   }
   if (body === null) throw new ApiError('后台返回的内容读不懂，请稍后再试。', response.status);
   return body as T;
}

export function postJson<T>(path: string, payload: Record<string, unknown>) {
   return request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
   });
}

/** 传文件（图片、评论表）：请求体就是文件本身 */
export function postFile<T>(path: string, file: Blob) {
   return request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
   });
}

export function errorText(error: unknown) {
   return error instanceof Error ? error.message : String(error);
}

/** 界面上「在访达中打开 / 打开」能用的固定位置 */
export type Place =
   | 'workFolder'
   | 'topics'
   | 'overview'
   | 'drafts'
   | 'writingMethod'
   | 'benchmarkAccounts'
   | 'researchReports'
   | 'commentImports'
   | 'prompts'
   | 'promptFormat'
   | 'coverAssets'
   | 'trash';

export function openPlace(place: Place) {
   return postJson<{ ok: boolean; message: string }>('/api/open', { place });
}
