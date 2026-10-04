import type { NextConfig } from 'next';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// 名字只在仓库根目录的 brand.json 里写一次，编译时带进界面。
// 编译和启动都在 ui/ 文件夹里运行，所以仓库根目录就是上一层。
const root = path.resolve(process.cwd(), '..');
const brand = JSON.parse(readFileSync(path.join(root, 'brand.json'), 'utf8')) as {
   id: string;
   name: string;
   tagline?: string;
   copyrightHolder?: string;
   repository?: string;
};

const nextConfig: NextConfig = {
   devIndicators: false,
   poweredByHeader: false,
   outputFileTracingRoot: root,
   images: { unoptimized: true },
   // 仓库里不装 ESLint；类型检查照常在编译时跑。
   eslint: { ignoreDuringBuilds: true },
   env: {
      NEXT_PUBLIC_APP_ID: brand.id,
      NEXT_PUBLIC_APP_NAME: brand.name,
      NEXT_PUBLIC_APP_TAGLINE: brand.tagline ?? '',
      // 新手指引开场卡「我是{作者}」用署名，不在代码里写死名字
      NEXT_PUBLIC_APP_AUTHOR: brand.copyrightHolder ?? '',
      // 交给 AI 的话里写「没装好就照这个仓库里的安装说明装」
      NEXT_PUBLIC_APP_REPO: brand.repository ?? '',
   },
   // 接口不走这里的 rewrites：接口端口是启动时才挑的，rewrites 会在编译时写死。
   // 界面里 /api/* 由 app/api/[...path]/route.ts 在运行时转给接口。
};

export default nextConfig;
