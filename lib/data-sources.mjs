// 市场调研的两样数据来源：TikHub（付费接口，批量拉博主作品和数据）和社媒助手（第三方浏览器插件，导出评论表）。
// 这里只放写死的地址、钥匙串位置、单价兜底值和「大概花多少钱」的算法；key 的存取和连 TikHub 在 lib/tikhub.mjs，
// 评论表的读法在 lib/comment-tables.mjs。地址和单价 2026-10-03 查过（出处写在每项旁边），以后变了改这一个文件。

export const TIKHUB = Object.freeze({
  // 注册（要验证邮箱）：官网首页的「注册」按钮指向这里
  registerUrl: "https://user.tikhub.io/register",
  // 拿 key：官网「获取密钥」指向这里（https://tikhub.io/zh/integrations）。创建时要把权限范围全部勾上，不勾会报 403
  keysUrl: "https://user.tikhub.io/dashboard/api",
  // 充值：最低 5 美元，按次扣，没有月费
  addCreditUrl: "https://user.tikhub.io/dashboard/add-credit",
  pricingUrl: "https://tikhub.io/zh/pricing",
  // 只用 api.tikhub.io：官方现行公告要求用它，别用 api.tikhub.dev
  apiBase: "https://api.tikhub.io",
  // 检测 key：查账户信息和余额，官方单价查询接口查到它是 0 美元一次
  userInfoPath: "/api/v1/tikhub/user/get_user_info",
  // 公开的单价查询接口，不用 key
  priceInfoPath: "/api/v1/tikhub/user/get_endpoint_info",
});

// key 在 macOS 登录钥匙串里的位置：服务名 tikhub-api、账户名 tikhub（和原作者本机已有的那一项一样，换到这个工作台不用再填）。
// 环境变量 WORKBENCH_KEYCHAIN_SERVICE 能换服务名，只给测试和验收用，免得碰到真的那一项。
export const KEYCHAIN = Object.freeze({ service: "tikhub-api", account: "tikhub" });

export const SOCIAL_HELPER = Object.freeze({
  name: "社媒助手",
  maker: "深圳隙生科技有限公司",
  // 2026 年 7 月 22 日旧的商店地址被停用，7 月 28 日换了新地址重新上架（https://socialext.com/notice/chrome-store-republished）
  storeUrl: "https://chromewebstore.google.com/detail/iecafjejbggeoldcjiehgoolokaebpdf",
  // 打不开 Chrome 应用商店时（比如在中国大陆），官网下载页有离线安装包
  downloadUrl: "https://socialext.com/download",
  // 官方的小红书安全采集建议：单号每天不超过 200 篇、每次间隔 30 到 60 秒
  safetyUrl: "https://socialext.com/notice/xiaohongshu-safe-collect",
});

// 评论表：社媒助手导出的 Excel（.xlsx）、CSV、TSV，也收 JSON
export const COMMENT_TABLE_EXTS = Object.freeze([".xlsx", ".csv", ".tsv", ".json"]);

// —— 大概花多少钱 ——————————————————————————————
// 算法：常见调研要调几次哪个接口 × 每次的单价。单价先用 TikHub 公开的单价查询接口现查，查不到用下面的兜底值。
// 兜底值是 2026-10-03 用单价查询接口查到的（美元/次）。报错的请求不扣钱；小红书的接口不能用新号送的额度。
export const PRICE_CHECKED_ON = "2026-10-03";
export const PRICE_ENDPOINTS = Object.freeze({
  douyinVideo: "/api/v1/douyin/app/v3/fetch_one_video",
  douyinProfile: "/api/v1/douyin/app/v3/handler_user_profile",
  douyinPosts: "/api/v1/douyin/app/v3/fetch_user_post_videos",
  douyinStats: "/api/v1/douyin/app/v3/fetch_multi_video_statistics",
  douyinComments: "/api/v1/douyin/app/v3/fetch_video_comments",
  douyinReplies: "/api/v1/douyin/app/v3/fetch_video_comment_replies",
  xhsComments: "/api/v1/xiaohongshu/app_v2/get_note_comments",
});
export const FALLBACK_PRICES = Object.freeze({
  douyinVideo: 0.001,
  douyinProfile: 0.001,
  douyinPosts: 0.001,
  douyinStats: 0.025,
  douyinComments: 0.001,
  douyinReplies: 0.001,
  xhsComments: 0.01,
});
export const USD_TO_CNY = 7; // 粗算，页面上写明「1 美元约 7 元」
export const NEW_ACCOUNT_CREDIT_USD = 0.05; // 新号一次性送的额度（https://tikhub.io/zh/getting-started）
export const MIN_TOP_UP_USD = 5; // 最低充值

// 每种调研大概调几次接口：
// - 拆一条视频：单条作品 1 次。
// - 一个博主 100 条作品：主页 1 次 + 作品列表 5 次（每页 20 条）；补播放量用批量统计接口 2 次。
// - 评论每页 20 条：200 条一级评论 10 次，1000 条 50 次。连楼中楼（评论下面的回复）一起采时，
//   按一次真实采集折算平均每次只拿到约 3.6 条，200 条约 56 次、1000 条约 280 次，多出来的都是回复接口。
// - 小红书评论每页条数官方没写，按同样的 10 到 56 次估。
const CALLS = Object.freeze({
  video: { douyinVideo: 1 },
  posts100: { douyinProfile: 1, douyinPosts: 5 },
  stats100: { douyinStats: 2 },
  comments200: { low: { douyinComments: 10 }, high: { douyinComments: 10, douyinReplies: 46 } },
  comments1000: { low: { douyinComments: 50 }, high: { douyinComments: 50, douyinReplies: 230 } },
  xhsComments200: { low: { xhsComments: 10 }, high: { xhsComments: 56 } },
});

function costOf(calls, prices) {
  return Object.entries(calls).reduce((sum, [key, n]) => sum + n * (Number(prices[key]) || 0), 0);
}

/** 美元换成「约 0.04 元」里的数字：不到 1 元留两位小数，1 元以上留一位，去掉多余的 0（0.35 不会被舍成 0.3） */
export function yuan(usd) {
  const value = usd * USD_TO_CNY;
  if (!(value > 0)) return "0";
  const scale = value < 1 ? 100 : 10;
  return String(Math.round(value * scale + 1e-9) / scale);
}

/** 「约 0.04 元」；不到 1 分钱的写「不到 1 分钱」 */
function aboutYuan(usd) {
  return usd * USD_TO_CNY < 0.01 ? "不到 1 分钱" : `约 ${yuan(usd)} 元`;
}

/**
 * 页面上「大概花多少钱」的几句话。prices 是每个接口的单价（美元），缺的用兜底值。
 * live 表示单价是刚从 TikHub 查的，否则是兜底值（写明哪天查的）。
 */
export function costEstimate(prices = {}, { live = false } = {}) {
  const p = { ...FALLBACK_PRICES };
  for (const key of Object.keys(FALLBACK_PRICES)) {
    const value = Number(prices[key]);
    if (Number.isFinite(value) && value >= 0) p[key] = value;
  }
  const range = (calls) => `${yuan(costOf(calls.low, p))} 到 ${yuan(costOf(calls.high, p))} 元`;
  const posts = costOf(CALLS.posts100, p);
  const withStats = posts + costOf(CALLS.stats100, p);
  return {
    live,
    checkedOn: live ? null : PRICE_CHECKED_ON,
    prices: p,
    // 三种调研各自的一句（页面上缺东西时写在灰卡片里）
    video: `拆一条抖音视频${aboutYuan(costOf(CALLS.video, p))}`,
    account: `拉一个抖音博主 100 条作品${aboutYuan(posts)}，带上播放量${aboutYuan(withStats)}`,
    comments: `抖音 200 条评论约 ${range(CALLS.comments200)}，小红书贵 10 倍左右`,
    // TikHub 卡片里的几句
    lines: [
      `抖音：拉一个博主 100 条作品${aboutYuan(posts)}，带上播放量${aboutYuan(withStats)}；200 条评论约 ${range(CALLS.comments200)}，1000 条评论约 ${range(CALLS.comments1000)}（只要一级评论是少的那头，连评论下面的回复一起采是多的那头）。`,
      `小红书贵 10 倍左右：200 条评论约 ${range(CALLS.xhsComments200)}。`,
    ],
    note: `按 1 美元约 ${USD_TO_CNY} 元粗算，报错的请求不扣钱。`,
  };
}
