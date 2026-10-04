// 栏目登记处：左边菜单一栏对应这里的一项，有页签的栏目页头下面是一排页签。
// 现在三栏：内容（选题、在做）、市场调研（对标账号、调研报告）和提示词。设置文件里的 columns 决定显示哪几栏、按什么先后。
// 加新栏目或新页签：在这里登记（页签就是一个地址），左边菜单的图标在 components/jc/shell.tsx 的 ICONS 里配。
// 这个文件不带 'use client'，服务端的页面（比如首页跳转）也能用。

export type ColumnTab = { key: string; label: string; href: string };
export type ColumnDef = { title: string; href: string; match: string[]; tabs: ColumnTab[] };

export const COLUMNS: Record<'content' | 'research' | 'prompts', ColumnDef> = {
   content: {
      title: '内容',
      href: '/content',
      match: ['/content'],
      tabs: [
         { key: 'topics', label: '选题', href: '/content?tab=topics' },
         { key: 'doing', label: '在做', href: '/content?tab=doing' },
         // 以后加页签写在这里，例如 { key: 'published', label: '已发布', href: '/content?tab=published' }。
         // 创作页不是页签：每条内容一个，从详情页和「在做」的卡片上打开
      ],
   },
   research: {
      title: '市场调研',
      href: '/research',
      match: ['/research'],
      tabs: [
         { key: 'accounts', label: '对标账号', href: '/research?tab=accounts' },
         { key: 'reports', label: '调研报告', href: '/research?tab=reports' },
      ],
   },
   prompts: {
      title: '提示词',
      href: '/prompts',
      match: ['/prompts'],
      tabs: [],
   },
};

export type ColumnKey = keyof typeof COLUMNS;
