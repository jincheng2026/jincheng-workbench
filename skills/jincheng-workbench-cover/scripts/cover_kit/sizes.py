"""封面的三种尺寸，和存图时从中间裁（约定见 docs/开发记录.md「封面 Skill」第二版）：

    | 尺寸        | 给谁用               | 生图出      | 存进封面候选                 |
    | 竖版 3:4    | 视频封面、小红书图文  | 1024×1536  | 从中间裁成 3:4（1024×1365）   |
    | 横版 2.35:1 | 公众号头图           | 1536×1024  | 从中间裁成 2.35:1（1536×654） |
    | 方形 1:1    | 公众号次图、朋友圈    | 1024×1024  | 不用裁                        |

- 生成记录每批第一行末尾写「；尺寸：竖版 3:4」这样的固定写法（三种之一），工作台按它认。
- 没说尺寸时的默认（和工作台一样）：这条内容上一批用的 → 内容类型的名字带「文章」「图文」「公众号」「长文」「星球」「帖子」「笔记」的算文章，
  用横版 2.35:1 → 其余算视频，用竖版 3:4。
- 裁图只用 macOS 自带的 sips（`sips -c 高 宽` 默认从中间裁），不装别的；sips 写不了 webp，webp 裁完存成 png。
  测试用环境变量 COVER_SIPS 指定 sips 在哪（写一个不存在的路径就当作没有 sips），别的时候不用它。
"""
import os
import re
import shutil
import subprocess

from . import UserError
from . import images as I

ARTICLE_WORDS = ("文章", "图文", "公众号", "长文", "星球", "帖子", "笔记")


class Size(object):
    def __init__(self, kind, ratio_text, ratio, canvas, use, cut):
        self.kind = kind              # 竖版、横版、方形
        self.ratio_text = ratio_text  # 3:4、2.35:1、1:1
        self.ratio = ratio            # 宽 ÷ 高
        self.canvas = canvas          # 生图出多大：(宽, 高)
        self.use = use                # 给谁用
        self.cut = cut                # 裁掉哪里、字和脸放哪（写进提示词和生成计划）

    @property
    def text(self):
        """生成记录里的写法：「竖版 3:4」。"""
        return "%s %s" % (self.kind, self.ratio_text)

    @property
    def arg(self):
        """命令里的写法：「竖版3:4」（中间不空格，不用加引号）。"""
        return "%s%s" % (self.kind, self.ratio_text)

    def target(self, width, height):
        """这张图从中间裁成这个比例以后多大：(宽, 高)。已经是这个比例（差不到 1 像素）就原样。"""
        if width <= 0 or height <= 0:
            return width, height
        if width / float(height) > self.ratio:
            return max(1, int(round(height * self.ratio))), height
        return width, max(1, int(round(width / self.ratio)))

    @property
    def final(self):
        """照约定的生图尺寸出图、裁完以后多大。"""
        return self.target(*self.canvas)

    def plan(self):
        """一句话：生图出多大、存的时候裁成多大、字和脸放哪。"""
        w, h = self.canvas
        fw, fh = self.final
        if (fw, fh) == (w, h):
            return "生图出 %d×%d，存的时候不用裁，%s" % (w, h, self.cut)
        return "生图出 %d×%d，存的时候从中间裁成 %d×%d：%s" % (w, h, fw, fh, self.cut)

    def __eq__(self, other):
        return isinstance(other, Size) and other.kind == self.kind

    def __hash__(self):
        return hash(self.kind)

    def __repr__(self):
        return "Size(%s)" % self.text


PORTRAIT = Size("竖版", "3:4", 3 / 4.0, (1024, 1536), "视频封面、小红书图文",
                "上下各约 85 像素会被裁掉，字和脸别贴着上下两边")
WIDE = Size("横版", "2.35:1", 2.35, (1536, 1024), "公众号头图",
            "上下各约 185 像素会被裁掉，字和脸都放在中间那一条里")
SQUARE = Size("方形", "1:1", 1.0, (1024, 1024), "公众号次图、朋友圈",
              "字和脸离四边留出一点空")
SIZES = (PORTRAIT, WIDE, SQUARE)
CHOICES_TEXT = "、".join(s.text for s in SIZES)


def parse(text):
    """「竖版 3:4」「竖版3:4」「竖版」「3:4」「3：4」都认成竖版 3:4；另外两种同理。认不出报错。"""
    raw = str(text or "").strip()
    value = re.sub(r"\s+", "", raw).replace("：", ":").replace("∶", ":")
    for size in SIZES:
        if value in (size.kind, size.ratio_text, size.arg):
            return size
    raise UserError("尺寸只能写 %s 之一（收到的是「%s」）。" % (CHOICES_TEXT, raw))


def find(text):
    """从一句话（比如生成记录每批的第一行）里找「尺寸：…」写的是哪种；没有返回 None。"""
    m = re.search(r"尺寸[：:]\s*([^；;\n]+)", str(text or ""))
    if not m:
        return None
    try:
        return parse(m.group(1))
    except UserError:
        return None


def is_article(content_type):
    return bool(content_type) and any(word in content_type for word in ARTICLE_WORDS)


def default(previous=None, content_type=None):
    """没说尺寸时用哪种、为什么：(Size, 理由)。和工作台定默认值的顺序一样。"""
    if previous is not None:
        return previous, "这条内容上一批用的"
    if is_article(content_type):
        return WIDE, "内容类型「%s」算文章" % content_type
    if content_type:
        return PORTRAIT, "内容类型「%s」算视频" % content_type
    return PORTRAIT, "没找到这条内容的类型，按视频算"


# ---------- 存图时从中间裁 ----------

def sips_path():
    """macOS 自带的 sips 在哪；没有返回 None。"""
    custom = os.environ.get("COVER_SIPS")
    if custom is not None:
        return custom if custom and os.path.isfile(custom) and os.access(custom, os.X_OK) else None
    found = shutil.which("sips")
    if found:
        return found
    return "/usr/bin/sips" if os.path.isfile("/usr/bin/sips") else None


def crop(source, size, workdir):
    """把 source 从中间裁成 size 的比例，裁好的存进 workdir（会话自己的临时文件夹，不是工作文件夹）。
    返回 {"path", "format", "before": (宽, 高), "after": (宽, 高), "cropped": 裁没裁}。已经是这个比例就不裁，path 是原图。
    宽高按显示的方向算（JPEG 的拍摄方向转过来以后的）；sips 按存的方向裁，竖拍的照片把高和宽对调再交给它。"""
    with open(source, "rb") as f:
        head = f.read(256 * 1024)
    try:
        fmt, width, height, orientation = I.dimensions(head)
    except I.ImageError as e:
        raise UserError("读不出这张图的宽高（%s）：%s" % (e, source))
    turned = orientation in (5, 6, 7, 8)
    before = (height, width) if turned else (width, height)
    after = size.target(*before)
    if after == before:
        return {"path": source, "format": fmt, "before": before, "after": after, "cropped": False}
    sips = sips_path()
    if not sips:
        raise UserError("这台电脑上找不到 sips（macOS 自带的图片工具），裁不了图：这张是 %d×%d，要裁成 %s。"
                        "在 Mac 上再跑一次；或者先不写 --size 原样存，交付时说清这张还没裁。" % (before[0], before[1], size.text))
    out_fmt = "PNG" if fmt == "WEBP" else fmt  # sips 写不了 webp
    out = os.path.join(workdir, "裁好的" + I.EXT_OF_FORMAT[out_fmt])
    cmd = [sips]
    if out_fmt != fmt:
        cmd += ["-s", "format", "png"]
    elif out_fmt == "JPEG":
        cmd += ["-s", "formatOptions", "high"]
    stored = (after[1], after[0]) if turned else after  # 交给 sips 的是存的方向：(宽, 高)
    cmd += ["-c", str(stored[1]), str(stored[0]), source, "--out", out]
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise UserError("用 sips 裁图没成功（%s）：%s" % (e, source))
    if done.returncode != 0 or not os.path.isfile(out):
        said = (done.stderr or done.stdout or "").strip().splitlines()
        raise UserError("用 sips 裁图没成功（%s）：%s" % (said[-1] if said else "退出码 %d" % done.returncode, source))
    got = I.image_size(out)
    if got != after:
        raise UserError("裁出来是 %s，不是要的 %d×%d（%s）：这张先别存，把这句话原样告诉用户。"
                        % ("%d×%d" % got if got else "读不出宽高的图", after[0], after[1], size.text))
    return {"path": out, "format": out_fmt, "before": before, "after": after, "cropped": True}


def shape_note(size, before):
    """生出来的图和这个尺寸该用的生图尺寸方向不一样时，提醒一句（裁会切掉很多）；一样时返回空字符串。"""
    w, h = before
    cw, ch = size.canvas
    want = "竖" if ch > cw else ("横" if cw > ch else "方")
    got = "竖" if h > w else ("横" if w > h else "方")
    if want == got:
        return ""
    return ("这张是 %d×%d 的%s图，%s 要的是 %d×%d 的%s图，从中间裁会切掉不少：看看字和脸还在不在，自检写上，或者照 %d×%d 重新生成。"
            % (w, h, got, size.text, cw, ch, want, cw, ch))
