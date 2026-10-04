'use client';

// 「市场调研」栏：上面是「数据来源」（TikHub、社媒助手），下面两个页签：对标账号、调研报告（地址里的 ?tab=）。
// 三样数据（数据来源、对标账号、调研报告）一起读，到齐了再一起出来；从别的程序切回来时重读（AI 可能刚加了账号、做好了报告）。
// 页面只记两件事：上次看的是哪个页签、「数据来源」是不是被你收起来了（还差几步时）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { FolderOpen, Plus } from 'lucide-react';
import { ColumnHeader } from '@/components/jc/column';
import { PlaceButton } from '@/components/jc/place-button';
import { TourHint } from '@/components/jc/tour';
import { PrimaryButton, SecondaryButton, SemBanner } from '@/components/jc/ui';
import { BenchmarkAccounts } from '@/components/workbench/benchmark-accounts';
import { DataSources, type SourcesFocus } from '@/components/workbench/data-sources';
import { ReportViewer, ResearchReports } from '@/components/workbench/research-reports';
import { errorText } from '@/lib/api';
import {
   checkTikhub,
   fetchAccounts,
   fetchReports,
   fetchSources,
   type Account,
   type AccountsResult,
   type ReportsResult,
   type Sources,
} from '@/lib/research';
import { setResearchMissing } from '@/lib/research-status';

type Tab = 'accounts' | 'reports';
const isTab = (v: string | null | undefined): v is Tab => v === 'accounts' || v === 'reports';
const TAB_KEY = 'workbench-research-tab';
const SOURCES_KEY = 'workbench-research-sources';
const REFRESH_GAP = 15_000;
const CHECK_GAP = 10 * 60_000; // 余额：10 分钟内查过就不再查
const TAB_INTRO: Record<Tab, string> = {
   accounts: '图当脸，扫一眼就认出是谁；点图打开他的主页，做过调研的账号卡上直接看报告。',
   reports: 'AI 做好的调研报告都在这里，点开在工作台里看。要做新的，从下面三种调研里挑一种。',
};

function readLocal(key: string): string | null {
   try {
      return window.localStorage.getItem(key);
   } catch {
      return null;
   }
}
function writeLocal(key: string, value: string | null) {
   try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
   } catch {
      /* 记不住也不影响使用 */
   }
}

export default function ResearchBoard() {
   const params = useSearchParams();
   const urlTab = params.get('tab');
   const reportId = params.get('report');
   const reportPage = params.get('page') ?? '';
   const accountFilter = params.get('account');
   const [savedTab, setSavedTab] = useState<Tab | null>(null);
   const [sources, setSourcesState] = useState<Sources | null>(null);
   const [accounts, setAccounts] = useState<AccountsResult | null>(null);
   const [reports, setReports] = useState<ReportsResult | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [loaded, setLoaded] = useState(false);
   const [loading, setLoading] = useState(false);
   const [open, setOpen] = useState<boolean | null>(null);
   const [focus, setFocus] = useState<SourcesFocus>(null);
   const [checking, setChecking] = useState(false);
   const [editing, setEditing] = useState<Account | 'new' | null>(null);
   const generation = useRef(0);
   const lastLoad = useRef(0);
   const lastCheck = useRef(0);

   // 地址里带 ?tab= 时以地址为准并记下来；从左边菜单点进来（不带）就打开上次看的页签
   useEffect(() => {
      if (isTab(urlTab)) {
         writeLocal(TAB_KEY, urlTab);
         return;
      }
      const saved = readLocal(TAB_KEY);
      setSavedTab(isTab(saved) ? saved : 'accounts');
   }, [urlTab]);
   const tab: Tab = isTab(urlTab) ? urlTab : (savedTab ?? 'accounts');

   const setSources = useCallback((update: (current: Sources) => Sources) => {
      setSourcesState((current) => (current ? update(current) : current));
   }, []);

   const load = useCallback(async () => {
      const current = ++generation.current;
      lastLoad.current = Date.now();
      setLoading(true);
      const [s, a, r] = await Promise.allSettled([fetchSources(), fetchAccounts(), fetchReports()]);
      if (current !== generation.current) return;
      if (s.status === 'fulfilled') setSourcesState(s.value);
      if (a.status === 'fulfilled') setAccounts(a.value);
      if (r.status === 'fulfilled') setReports(r.value);
      const failed = [s, a, r].find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined;
      setError(failed ? errorText(failed.reason) : null);
      setLoaded(true);
      setLoading(false);
   }, []);

   useEffect(() => {
      void load();
      const onFocus = () => {
         if (Date.now() - lastLoad.current > REFRESH_GAP) void load();
      };
      window.addEventListener('focus', onFocus);
      return () => {
         window.removeEventListener('focus', onFocus);
         generation.current += 1;
      };
   }, [load]);

   // 还差几步：告诉左边菜单；第一次读到时定「数据来源」展不展开（还差几步就展开，除非你收起来过）
   const missing = sources ? (sources.tikhub.configured ? 0 : 1) + (sources.social.imports.configured ? 0 : 1) : null;
   useEffect(() => {
      if (missing === null) return;
      setResearchMissing(missing);
      setOpen((current) => (current !== null ? current : missing > 0 ? readLocal(SOURCES_KEY) !== 'closed' : false));
   }, [missing]);

   // 接好了 TikHub：进来时查一次余额（免费接口，10 分钟内查过就不再查）
   const configured = sources?.tikhub.configured ?? false;
   const checkedAt = sources?.tikhub.check?.at ?? null;
   useEffect(() => {
      if (!configured) return;
      const fresh = checkedAt && Date.now() - Date.parse(checkedAt) < CHECK_GAP;
      if (fresh || Date.now() - lastCheck.current < CHECK_GAP) return;
      lastCheck.current = Date.now();
      setChecking(true);
      checkTikhub()
         .then((answer) => setSources((s) => ({ ...s, tikhub: { ...s.tikhub, ...answer.status, check: answer, cost: answer.cost } })))
         .catch(() => {})
         .finally(() => setChecking(false));
   }, [configured, checkedAt, setSources]);

   const changeOpen = (next: boolean) => {
      setOpen(next);
      if (!next && (missing ?? 0) > 0) writeLocal(SOURCES_KEY, 'closed');
      if (next) writeLocal(SOURCES_KEY, null);
   };
   const go = (which: 'tikhub' | 'social') => {
      changeOpen(true);
      setFocus((old) => ({ which, n: (old?.n ?? 0) + 1 }));
   };
   // 从别的页面点「去接 TikHub」过来（地址带 ?connect=tikhub）：一进来就展开数据来源、亮到 TikHub 那一块
   const connect = params.get('connect');
   const goRef = useRef(go);
   goRef.current = go;
   useEffect(() => {
      if (connect === 'tikhub' || connect === 'social') goRef.current(connect);
   }, [connect]);

   const viewing = tab === 'reports' && reportId ? (reports?.reports.find((r) => r.id === reportId) ?? null) : null;
   const accountList = accounts?.accounts ?? [];
   const reportList = reports?.reports ?? [];
   const tikhubReady = configured;

   const header = (
      <ColumnHeader
         column="research"
         tab={tab}
         ready={loaded}
         description={TAB_INTRO[tab]}
         right={
            <>
               {tab === 'accounts' ? (
                  <>
                     {accountList.length > 0 && (
                        <PrimaryButton size="small" onClick={() => setEditing('new')}>
                           <Plus size={14} /> 添加对标账号
                        </PrimaryButton>
                     )}
                     <PlaceButton place="benchmarkAccounts" title="在访达中打开对标账号文件夹">
                        <FolderOpen size={14} /> 在访达中打开
                     </PlaceButton>
                  </>
               ) : (
                  <PlaceButton place="researchReports" title="在访达中打开调研报告文件夹">
                     <FolderOpen size={14} /> 在访达中打开
                  </PlaceButton>
               )}
               <SecondaryButton size="small" busy={loading} onClick={() => void load()}>
                  重新读取
               </SecondaryButton>
            </>
         }
      />
   );

   if (!loaded) {
      return (
         <div>
            {header}
            <div className="min-h-[240px]" aria-hidden="true" />
         </div>
      );
   }

   return (
      <div>
         {header}
         {error && (
            <SemBanner tone={sources || accounts || reports ? 'warn' : 'err'} className="mb-4">
               有一部分没读出来：{error}
               <div className="mt-2">
                  <SecondaryButton size="small" busy={loading} onClick={() => void load()}>
                     重试
                  </SecondaryButton>
               </div>
            </SemBanner>
         )}
         <TourHint />
         {/* 看报告时不放数据来源，报告直接在页签下面 */}
         {sources && !(tab === 'reports' && reportId) && (
            <DataSources sources={sources} setSources={setSources} open={open ?? false} onOpenChange={changeOpen} focus={focus} checking={checking} />
         )}
         {tab === 'accounts' ? (
            accounts && (
               <BenchmarkAccounts
                  accounts={accountList}
                  platforms={accounts.platforms}
                  reports={reportList}
                  tikhubReady={tikhubReady}
                  editing={editing}
                  onEdit={setEditing}
                  onChanged={() => void load()}
               />
            )
         ) : reportId ? (
            viewing ? (
               <ReportViewer report={viewing} file={reportPage} />
            ) : (
               reports && (
                  <SemBanner tone="warn">
                     找不到这份报告，可能被移走或删掉了。
                     <a href="/research?tab=reports" className="ml-1">
                        回到报告列表
                     </a>
                  </SemBanner>
               )
            )
         ) : (
            reports &&
            sources && (
               <ResearchReports
                  reports={reportList}
                  accounts={accountList}
                  accountFilter={accountFilter}
                  tikhubReady={tikhubReady}
                  importedComments={sources.social.imports.comments}
                  cost={sources.tikhub.cost}
                  onGo={go}
               />
            )
         )}
      </div>
   );
}
