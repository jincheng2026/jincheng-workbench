// 界面里的 /api/* 在这里转给接口服务。接口地址由启动脚本在运行时给（WORKBENCH_API_ORIGIN），
// 所以接口换了端口也不用重新编译界面。
// 只接受从本机地址（127.0.0.1 / localhost）打开的页面发来的请求，挡住把别的域名解析到本机的网页。
export const dynamic = 'force-dynamic';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const PASS_REQUEST = ['content-type', 'accept', 'origin'];
// content-security-policy：调研报告的网页靠它放进隔开的环境里打开，碰不到工作台的接口；不能在这里丢掉
const PASS_RESPONSE = ['content-type', 'cache-control', 'content-disposition', 'location', 'content-security-policy', 'x-content-type-options'];

function apiOrigin() {
   return (process.env.WORKBENCH_API_ORIGIN || 'http://127.0.0.1:18878').replace(/\/+$/, '');
}

function hostnameOf(host: string | null) {
   if (!host) return '';
   if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
   return host.split(':')[0];
}

async function forward(request: Request) {
   if (!LOCAL_HOSTS.has(hostnameOf(request.headers.get('host')))) {
      return Response.json({ error: '只接受本机地址打开的页面。' }, { status: 403 });
   }
   const url = new URL(request.url);
   const headers = new Headers();
   for (const name of PASS_REQUEST) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
   }
   const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
   let upstream: Response;
   try {
      upstream = await fetch(`${apiOrigin()}${url.pathname}${url.search}`, {
         method: request.method,
         headers,
         body: hasBody ? await request.arrayBuffer() : undefined,
         cache: 'no-store',
         redirect: 'manual',
      });
   } catch {
      return Response.json(
         { error: '连不上后台。运行 pnpm start 的那个终端窗口还开着吗？' },
         { status: 502 }
      );
   }
   const out = new Headers();
   for (const name of PASS_RESPONSE) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
   }
   return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { forward as GET, forward as POST };
