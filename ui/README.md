# 界面

用 Next.js 写的网页界面，fork 自 [ln-dev7/circle](https://github.com/ln-dev7/circle)（MIT 许可证，原版权声明见本目录的 LICENSE.md）。保留了它的组件写法（shadcn/ui、Tailwind CSS），页面和视觉改成了工作台自己的。

- 平时不用单独启动：在仓库根目录运行 `pnpm start`，会一起拉起接口和界面。
- 开发时：先在仓库根目录运行 `node server.mjs`（接口，默认 18878），再在这里运行 `pnpm dev`（界面，18879）。
- 界面里的 `/api/*` 由 `app/api/[...path]/route.ts` 转给接口，接口地址来自环境变量 `WORKBENCH_API_ORIGIN`。
