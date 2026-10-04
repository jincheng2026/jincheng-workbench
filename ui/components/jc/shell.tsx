'use client';

// 工作台外框：电脑上是固定的左边菜单和顶上的磨砂工具栏，手机上是顶栏和底部导航。
// 左边菜单显示哪几栏由设置文件的 columns 决定（经 /api/app 传过来），栏目定义在 lib/columns.ts。
// 有页签的栏目（内容、市场调研）在左边菜单里是一组：点一下栏目名在下面展开子菜单、再点收起，点子菜单换页面
// （原作者 2026-10-04 定，照 WorkBuddy 左边「专家·技能·连接器」那样；页面上方不再放那排页签，手机上还放）。
// 选中底色落在开着的子菜单上（栏目收起来时落在栏目名上），换页时从上一个位置滑过来；同一栏里换页签时外框不重新淡入。
// 新手指引（jc/tour.tsx）：每个页面都带着它的细栏和浮层；「新手指引」按钮在左下角工作文件夹下面，手机上在顶栏右边。
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Clapperboard, FolderOpen, PenLine, ScrollText, Telescope, type LucideIcon } from 'lucide-react';
import { useAppInfo, useTildify } from '@/components/jc/app-info';
import { COLUMNS, type ColumnKey, type ColumnTab } from '@/lib/columns';
import { useActiveTab } from '@/lib/active-tab';
import { PlaceButton } from '@/components/jc/place-button';
import { useSlideIndicator } from '@/components/jc/slide-indicator';
import { CopyPath, SemBanner } from '@/components/jc/ui';
import { TourLayer, TourReplayButton } from '@/components/jc/tour';
import { APP_NAME, APP_TAGLINE } from '@/lib/app-info';
import { useResearchMissing } from '@/lib/research-status';

const ICONS: Record<ColumnKey, LucideIcon> = {
   content: Clapperboard,
   research: Telescope,
   prompts: ScrollText,
};

/** 市场调研还差几步没配好（TikHub、评论表）；配好了是 0，不显示 */
function useMissing() {
   const { info } = useAppInfo();
   return useResearchMissing(info.research?.missing ?? 0);
}

/** 「还差 2 样」（TikHub、评论表各算一样，不叫「步」：卡片里本来就有 1、2、3 的步骤）：窄一点的窗口里写「差 2 样」 */
function MissingBadge({ n }: { n: number }) {
   if (n <= 0) return null;
   return (
      <span className="jc-nav-badge" title={`市场调研还差 ${n} 样没配好：在市场调研页顶部接好 TikHub、导入评论表`}>
         <span className="jc-nav-badge-long">还</span>差 {n} 样
      </span>
   );
}

type NavItem = { key: ColumnKey; label: string; href: string; match: string[]; icon: LucideIcon; tabs: ColumnTab[] };

function useNav(): NavItem[] {
   const { info } = useAppInfo();
   return info.columns
      .filter((key): key is ColumnKey => key in COLUMNS)
      .map((key) => ({ key, label: COLUMNS[key].title, href: COLUMNS[key].href, match: COLUMNS[key].match, icon: ICONS[key], tabs: COLUMNS[key].tabs }));
}

function isActive(pathname: string, item: NavItem) {
   return item.match.some((m) => pathname === m || pathname.startsWith(`${m}/`));
}

export function BrandMark({ size = 34 }: { size?: number }) {
   return (
      <span className="jc-brand-mark" style={{ width: size, height: size }} aria-hidden="true">
         <PenLine size={Math.round(size * 0.5)} strokeWidth={2} />
      </span>
   );
}

function WorkFolder() {
   const { info, reachable } = useAppInfo();
   const tildify = useTildify();
   if (!reachable || !info.workFolder) {
      return (
         <div className="jc-workfolder">
            <p className="jc-nav-label">工作文件夹</p>
            <p className="jc-workfolder-note">连不上后台，读不到工作文件夹在哪。</p>
         </div>
      );
   }
   return (
      <div className="jc-workfolder">
         <p className="jc-nav-label">工作文件夹</p>
         <p className="jc-workfolder-path" title={info.workFolder}>
            {/* 长路径只在斜杠后面换行，不把文件夹名从中间断开 */}
            {tildify(info.workFolder)
               .split('/')
               .map((part, index) => (
                  <span key={index}>
                     {index > 0 && '/'}
                     {index > 0 && <wbr />}
                     {part}
                  </span>
               ))}
         </p>
         <PlaceButton place="workFolder" title="在访达中打开工作文件夹" tour="open-work-folder">
            <FolderOpen size={14} /> 在访达中打开
         </PlaceButton>
         <TourReplayButton />
      </div>
   );
}

// 左边子菜单哪几组展开着：换页时外框会重新挂载，记在模块变量里，这次打开工作台期间一直记得；没点过的组，当前所在的那一栏展开
const opened: Partial<Record<ColumnKey, boolean>> = {};

/** 有页签的栏目：栏目名是一个开关，下面是子菜单（不放展开收起的小箭头：原作者 10-04 定「不要有这个箭头」） */
function NavGroup({ n, active, missing, onToggle }: { n: NavItem; active: boolean; missing: number; onToggle: () => void }) {
   const tab = useActiveTab(n.key);
   const [open, setOpen] = useState(() => opened[n.key] ?? active);
   // 展开的动画播完了没有：播完再把「选中」交给子菜单，选中底色才从栏目名滑到量得准的位置
   const subRef = useRef<HTMLDivElement>(null);
   const [shown, setShown] = useState(open);
   useEffect(() => {
      if (!open) {
         setShown(false);
         return;
      }
      const el = subRef.current;
      if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
         setShown(true);
         return;
      }
      const done = (e: TransitionEvent) => {
         if (e.target === el) setShown(true);
      };
      el.addEventListener('transitionend', done);
      const timer = window.setTimeout(() => setShown(true), 400); // 没收到动画结束的通知，到时间也算展开好了
      return () => {
         el.removeEventListener('transitionend', done);
         window.clearTimeout(timer);
      };
   }, [open]);
   useEffect(() => {
      onToggle();
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [shown]);
   const Icon = n.icon;
   const toggle = () => {
      opened[n.key] = !open;
      setOpen(!open);
      onToggle();
   };
   return (
      <div className="jc-nav-group-item" data-open={open || undefined}>
         <button
            type="button"
            className="jc-nav-link jc-nav-parent"
            aria-expanded={open}
            aria-current={active && !(open && shown) ? 'page' : undefined}
            data-active={active || undefined}
            data-nav={n.key}
            onClick={toggle}
         >
            <Icon aria-hidden="true" />
            <span>{n.label}</span>
            {n.key === 'research' && <MissingBadge n={missing} />}
         </button>
         <div ref={subRef} className="jc-nav-sub">
            <div className="jc-nav-sub-inner" role="group" aria-label={`${n.label}的子菜单`}>
               {n.tabs.map((t) => (
                  <Link
                     key={t.key}
                     href={t.href}
                     scroll={false}
                     tabIndex={open ? undefined : -1}
                     className="jc-nav-link jc-nav-child"
                     aria-current={active && open && shown && tab === t.key ? 'page' : undefined}
                     data-nav-tab={`${n.key}:${t.key}`}
                  >
                     <span>{t.label}</span>
                  </Link>
               ))}
            </div>
         </div>
      </div>
   );
}

function DesktopSidebar({ pathname, nav }: { pathname: string; nav: NavItem[] }) {
   // 选中底色是一块单独的底板，换页时从上一个位置滑过来
   const navRef = useRef<HTMLDivElement>(null);
   const pillRef = useRef<HTMLSpanElement>(null);
   const activeItem = nav.find((n) => isActive(pathname, n)) ?? null;
   const activeTab = useActiveTab(activeItem?.key ?? '');
   const [toggles, setToggles] = useState(0);
   const missing = useMissing();
   useSlideIndicator(navRef, pillRef, 'sidebar', `${activeItem?.key ?? ''}:${activeTab ?? ''}:${toggles}`);
   return (
      <aside className="jc-sidebar">
         <div className="jc-brand">
            <BrandMark size={35} />
            <span className="min-w-0">
               <span className="jc-brand-name">{APP_NAME}</span>
               {APP_TAGLINE && <span className="jc-brand-note">{APP_TAGLINE}</span>}
            </span>
         </div>
         <div ref={navRef} className="jc-nav-area">
            <span ref={pillRef} className="jc-nav-pill" aria-hidden="true" />
            <nav className="jc-nav-group" aria-label="栏目">
               <div className="jc-nav-links">
                  {nav.map((n) => {
                     if (n.tabs.length) {
                        return <NavGroup key={n.href} n={n} active={activeItem?.key === n.key} missing={missing} onToggle={() => setToggles((x) => x + 1)} />;
                     }
                     const Icon = n.icon;
                     return (
                        <Link key={n.href} href={n.href} className="jc-nav-link" aria-current={isActive(pathname, n) ? 'page' : undefined} data-nav={n.key}>
                           <Icon aria-hidden="true" />
                           <span>{n.label}</span>
                        </Link>
                     );
                  })}
               </div>
            </nav>
         </div>
         <WorkFolder />
      </aside>
   );
}

function DesktopToolbar({ pathname, nav }: { pathname: string; nav: NavItem[] }) {
   const current = nav.find((n) => isActive(pathname, n));
   const Icon = current?.icon ?? Clapperboard;
   const workDetail = pathname.match(/^\/content\/(T\d{3,4})$/);
   return (
      <header className="jc-toolbar">
         <div className="jc-toolbar-location">
            <Icon aria-hidden="true" />
            {workDetail ? (
               <>
                  <Link href="/content">内容</Link>
                  <ChevronRight aria-hidden="true" />
                  <span>{workDetail[1]}</span>
               </>
            ) : (
               <span>{current?.label ?? APP_NAME}</span>
            )}
         </div>
      </header>
   );
}

function MobileChrome({ pathname, nav }: { pathname: string; nav: NavItem[] }) {
   const router = useRouter();
   const missing = useMissing();
   return (
      <>
         <header className="jc-topbar">
            <span className="flex items-center gap-2">
               <BrandMark size={27} />
               <span className="text-[13px] font-semibold tracking-[-0.02em]">{APP_NAME}</span>
            </span>
            <TourReplayButton />
         </header>
         <nav className="jc-bottomnav" aria-label="栏目" style={{ gridTemplateColumns: `repeat(${Math.max(nav.length, 1)}, 1fr)`, maxWidth: Math.max(nav.length, 2) * 96 + 10 }}>
            {nav.map((n) => {
               const Icon = n.icon;
               return (
                  <button key={n.href} type="button" onClick={() => router.push(n.href)} aria-current={isActive(pathname, n) ? 'page' : undefined} data-nav={n.key}>
                     <span className="relative">
                        <Icon aria-hidden="true" />
                        {n.key === 'research' && missing > 0 && <span className="jc-nav-dot" aria-label={`市场调研还差 ${missing} 样没配好`} />}
                     </span>
                     {n.label}
                  </button>
               );
            })}
         </nav>
      </>
   );
}

function ConfigIssues() {
   const { info } = useAppInfo();
   if (!info.issues.length) return null;
   return (
      <SemBanner tone="warn" className="mb-6">
         设置文件里有 {info.issues.length} 处没写对，已经按默认值处理：
         <ul className="mt-1 list-disc pl-5">
            {info.issues.map((issue) => (
               <li key={issue}>{issue}</li>
            ))}
         </ul>
         <span className="mt-1 inline-flex flex-wrap items-center gap-1">
            设置文件在 <CopyPath path={info.configFile} />，改完先运行 pnpm stop，再运行 pnpm start 才生效。
         </span>
      </SemBanner>
   );
}

/** 地址属于哪个栏目；不属于任何栏目就返回地址本身 */
function columnOf(pathname: string, nav: NavItem[]): string {
   return nav.find((n) => isActive(pathname, n))?.key ?? pathname;
}
let lastColumn: string | null = null;

export function JcShell({ children }: { children: React.ReactNode }) {
   const pathname = usePathname();
   const nav = useNav();
   // 同一栏里换页签时，外框不跟着整页淡入，只让页签下面的内容上浮。
   // 换页时外框会重新挂载：挂载那一刻定下这次淡不淡入，之后数据刷新重绘也不变，免得动画播一半被掐掉。
   const column = columnOf(pathname, nav);
   const [sameColumn] = useState(() => column === lastColumn);
   useEffect(() => {
      lastColumn = column;
   }, [column]);
   return (
      <div className="jc-shell">
         <DesktopSidebar pathname={pathname} nav={nav} />
         <DesktopToolbar pathname={pathname} nav={nav} />
         <MobileChrome pathname={pathname} nav={nav} />
         <main className="jc-main">
            <div className={sameColumn ? 'jc-main-inner' : 'jc-main-inner jc-fade'}>
               <TourLayer />
               <ConfigIssues />
               {children}
            </div>
         </main>
      </div>
   );
}
