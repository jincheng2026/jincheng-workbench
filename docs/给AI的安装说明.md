# 给 AI 的安装说明

这份说明写给替用户安装的 AI（Codex、Claude Code 等）。用户把仓库链接交给你，说「照这个帮我装好」，你照下面做。做完的样子：工作台在用户的浏览器里打开了，三个 Skill（写稿、调研、封面）装进了这台 Mac 上的 AI 工具，你用几句话告诉用户结果。

这份说明也管更新和重新打开：用户以后再发一次同样的话（电脑重启以后，或者想更新到新版本），你从第 0 步看装到哪一步了，做好的步骤跳过。

## 先看这几条

- 一步只做一件事。每步做完都跑那一步的「检查」，看到「算成功」写的结果再往下走。
- 检查结果不对，先看那一步的「不对时」；还解决不了，停下来，把命令和完整输出告诉用户，不要跳步。
- 能自己查清的不问用户：缺什么就直接装（Git、Python、Node、pnpm，没有 Homebrew 时连 Homebrew 一起装），开装前用一句话告诉用户在装什么；用户用的是 Codex 还是 Claude Code、代码装在哪、上网要不要代理，都自己查。
- 只有你做不了的事才请用户动手，而且做到那一步再说：系统弹窗要点「安装」或「允许」、要输入电脑的开机密码、你的 AI 工具弹出请求要用户点「允许」。用一句话说清点哪里、输什么，等用户回「好了」就接着做，不用他重新发话。
- 你的 AI 工具要是默认不让命令联网、开本机端口、写打开的文件夹以外的地方（Codex 默认就是这样），装的过程中会请用户点好几次「允许」（下载代码和依赖、跑测试、启动、装 Skill 各一两次）。第一次弹之前用一句话告诉用户：接下来会弹几次请求，都点允许就行。
- 下载代码只用 `git clone`。不要用浏览器下载 GitHub 上的压缩包（Download ZIP）：压缩包没有 git 记录，以后没法 `git pull` 更新。
- 下面的命令都在 macOS 自带的终端（zsh）里运行。`<仓库地址>` 换成用户给你的链接；用户没给的话，正式地址是 https://github.com/jincheng2026/jincheng-workbench 。
- 下面写的 `~/jincheng-workbench` 是代码文件夹的默认位置；第 0 步发现装在别处，后面命令里的这个路径都换成实际的。

## 第 0 步：看看装到哪一步了

```bash
git -C ~/jincheng-workbench remote get-url origin 2>/dev/null || echo 没有
```

- 输出「没有」，并且 `~/jincheng-workbench` 这个文件夹不存在：还没装，从第 1 步开始。
- 输出的地址是这个仓库（用户给的链接，或者上面的正式地址；结尾多一个 `.git` 也算）：装过了，先更新代码：

  ```bash
  cd ~/jincheng-workbench
  git pull --ff-only
  ```

  - 打印 `Already up to date.`：代码已经是最新的。跳到第 10 步启动，接着做第 11 到 15 步（第 12、13、14 步会认出装过的 Skill，直接往下走）。
  - 拉到了新的提交：先停掉正在运行的旧版本，再从第 6 步往下做（装依赖、跑测试、编译都要重新做）：

    ```bash
    pnpm stop
    ```

    打印「已经停了」或者「没在运行，不用停」都算成功。提示找不到 pnpm 时，写成 `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm stop`。
  - 报错说本地有改动（`Your local changes would be overwritten`）：用户改过这里的代码。不要丢掉他的改动，停下，把报错原样告诉用户。
  - 报错 `Not possible to fast-forward`（或者 `refusing to merge unrelated histories`）：先看是不是仓库从头换过一次。1.0 起换了一个从头开始的新仓库，链接没变，0.1 时装的那份和它接不上：

    ```bash
    git merge-base HEAD origin/main >/dev/null && echo 接得上 || echo 接不上
    ```

    - 输出「接不上」：这是 0.1 时装的那份，换成新代码。用户的选题、稿子在工作文件夹里，设置在 `~/Library/Application Support/jincheng-workbench/` 里，都不在这个代码文件夹里，换代码不会动到它们。旧代码挪到旁边留着，不删（`~/jincheng-workbench-0.1` 被占了就在后面加 `-2`、`-3`），下载新代码，再用新代码停掉正在运行的旧版本：

      ```bash
      mv ~/jincheng-workbench ~/jincheng-workbench-0.1
      git clone <仓库地址> ~/jincheng-workbench
      cd ~/jincheng-workbench && node scripts/stop.mjs
      ```

      打印「已经停了」或者「没在运行，不用停」都算成功。然后从第 6 步往下做（装依赖、跑测试、编译、启动）。第 12、13 步照常做：用软链装的 Skill 会自动指到新代码，复制装的照那里说的换成新的。最后告诉用户结果时加一句：旧代码挪到了哪个文件夹，新版用着没问题，可以自己把它删掉。
    - 输出「接得上」：用户在这里提交过自己的改动。不要动，停下，把报错原样告诉用户。
- `~/jincheng-workbench` 存在，但输出「没有」或者别的地址：那里放的不是这个仓库，不动它。代码换一个文件夹装：后面命令里的 `~/jincheng-workbench` 都换成 `~/jincheng-workbench-app`（这个也被占了，就在后面加 2、3），从第 1 步开始，装完告诉用户代码在哪。
- 用户说装过，默认位置却没有：工作台正在运行的话，运行 `pgrep -f 'scripts/start.mjs' | while read p; do lsof -a -p "$p" -d cwd -Fn | sed -n 's/^n//p'; done`，打印的就是代码文件夹；没在运行，用 `mdfind -name where.py | grep '/creation-page/where.py$'` 找，往上两层是代码文件夹。找到了就照上面「装过了」做，都找不到就当没装。

## 第 1 步：确认是 Apple 芯片的 Mac

```bash
uname -sm
```

- 算成功：输出 `Darwin arm64`。
- 不对时：输出别的（比如 `Darwin x86_64` 是 Intel 芯片的 Mac），停下，告诉用户这一版只支持 Apple 芯片的 Mac。

## 第 2 步：确认有 Git

```bash
git --version
```

- 算成功：输出 `git version 2.` 开头的一行。
- 不对时：如果弹出「需要安装命令行开发者工具」的窗口，请用户点「安装」，装完再跑一次检查。没有弹窗也没有版本号，你直接运行 `xcode-select --install`，弹出窗口时请用户点「安装」。

## 第 3 步：确认有 Python 3

写稿用的「创作页」靠一个小的保存服务把用户在网页上改的字存回文件，它用 Python 3 运行；三个 Skill 的脚本也用 Python 3。都只用 Python 自带的模块，不用另外装别的包。macOS 的「命令行开发者工具」（第 2 步装 Git 时多半已经装了）里就带着 Python 3。

```bash
python3 --version
```

- 算成功：输出 `Python 3.` 开头的一行，版本 3.8 或更新（3.9、3.12、3.13 都行）。
- 不对时：
  - 弹出「需要安装命令行开发者工具」的窗口：请用户点「安装」，装完再跑一次检查。
  - 提示 `command not found`，或者没有弹窗也没有版本号：你直接运行 `xcode-select --install`，弹出窗口时请用户点「安装」，装完再跑一次检查。
  - 版本比 3.8 旧：直接装新的。有 Homebrew（`brew --version` 能输出版本号）就运行 `brew install python`；没有就先照下面第 4 步「没有 Homebrew」那条装好 Homebrew 再装。装完新开一个终端窗口，重跑检查。

## 第 4 步：确认 Node 是 24 或更新的版本

```bash
node --version
```

- 算成功：输出 `v24.` 开头（`v25.`、`v26.` 也行）。
- 不对时：找不到 node，或者版本小于 24，直接装 Node 24：
  - 有 Homebrew（`brew --version` 能输出版本号）：运行 `brew install node@24`，再照 brew 最后打印的提示把 node@24 加进 PATH，新开一个终端窗口，重跑检查。
  - 没有 Homebrew：先装 Homebrew，用官方的一行命令 `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`（官网 https://brew.sh ）。它中途要输入一次电脑的开机密码：你的终端里输不了的话，把这条命令给用户，请他在 macOS 自带的「终端」里粘贴运行、输密码，装完告诉你。装好后照它最后打印的提示把 brew 加进 PATH，再按上一条装 Node 24。
  - Homebrew 实在装不上：请用户打开 https://nodejs.org ，下载 24 版的 macOS 安装包，双击装好，再重跑检查。

## 第 5 步：下载代码

```bash
git clone <仓库地址> ~/jincheng-workbench
```

检查：

```bash
git -C ~/jincheng-workbench log --oneline -1
```

- 算成功：输出一行，开头是一串字母和数字（这是最新一次提交）。
- 不对时：提示 `already exists and is not an empty directory`，说明 `~/jincheng-workbench` 已经有东西了。不要删也不要覆盖，回到第 0 步，照那里说的做。

## 第 6 步：进到代码文件夹，确认能用 pnpm

后面所有命令都在这个文件夹里运行。

```bash
cd ~/jincheng-workbench
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --version
```

- 算成功：输出 `12.8.1`。后面的命令照写 `pnpm`。
- 不对时：提示找不到 pnpm（`command not found`），改用 Node 自带的 corepack：

  ```bash
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --version
  ```

  输出 `12.8.1` 就算成功，**后面所有命令里的 `pnpm` 都写成 `corepack pnpm`**。corepack 也找不到时，直接运行 `npm install -g pnpm@12.8.1`，再重跑本步检查。
- 第一次运行时 corepack 会下载 pnpm，要等十几秒，这是正常的。

## 第 7 步：安装依赖

```bash
pnpm install
```

检查：

```bash
ls ui/node_modules/.bin/next
```

- 算成功：输出 `ui/node_modules/.bin/next`；安装命令最后一行是 `Done in …`。
- 不对时：网络报错（`ETIMEDOUT`、`ECONNRESET`、`ERR_PNPM_FETCH`）就隔一会儿重跑 `pnpm install`。还不行，看这台 Mac 有没有设代理：运行 `scutil --proxy`，里面有 `HTTPSEnable : 1` 的，用它的 `HTTPSProxy` 和 `HTTPSPort` 设好再重跑，写成 `HTTPS_PROXY=http://地址:端口 pnpm install`。没设代理也连不上：请用户把平时上网用的代理软件打开，回「好了」再重跑。

## 第 8 步：跑一遍测试

```bash
pnpm test
```

- 算成功：最后几行里有 `ℹ fail 0`。这一步要等半分钟到一分钟：创作页的 Python 测试也在里面，会起几个临时的保存服务。还有两条测试会在这台 Mac 的登录钥匙串里临时存一项测试用的条目（服务名里带 `-test-`），测完马上删掉；钥匙串锁着时（比如远程登录）这两条会显示跳过（`skipped`），不算失败。
- 不对时：有 `fail` 不是 0，把完整输出给用户看，不要往下走。

## 第 9 步：编译界面

```bash
pnpm build
```

检查：

```bash
ls ui/.next/BUILD_ID
```

- 算成功：编译最后打印「界面编译好了」，检查命令输出 `ui/.next/BUILD_ID`。大约一两分钟。
- 不对时：打印「界面编译失败」，把上面的报错给用户看。

## 第 10 步：启动

```bash
cd ~/jincheng-workbench
pnpm start --background
```

它在后台启动工作台，等到能打开了才结束：一般十几秒，界面要先编译时一两分钟。启动好以后，关掉终端、关掉这个对话，工作台都还在运行。

- 算成功：最后打印「已经启动」，还有一行「打开：http://127.0.0.1:18879」和一行「创作页保存服务：http://127.0.0.1:18977」。端口可能不是这两个（默认端口被别的程序占了会自动换一个），以打印出来的为准。
- 也算成功：打印「已经在运行了，直接打开：http://127.0.0.1:…」，说明已经启动过，用它打印的地址；保存服务的端口在第 11 步用 `where.py` 看。
- 第一次启动会在 `~/Documents/jincheng-workbench/` 建好工作文件夹，在 `~/Library/Application Support/jincheng-workbench/config.json` 写一份设置，这是正常的。
- 不对时：打印「启动没成功：」，后面那句话就是原因，照着做（比如「还没装依赖」回第 6 步；「找不到能用的 python3」回第 3 步；「设置文件写坏了」照提示改好设置文件）。还看不懂就看日志：`tail -50 ~/Library/Logs/jincheng-workbench/workbench.log`。
- 你的 AI 工具不让命令在后台留下程序（第 10 步打印了「已经启动」，第 11 步却查不到）：请用户打开 macOS 自带的「终端」App，粘贴运行 `cd ~/jincheng-workbench && pnpm start`，看到「已经启动」后回你「好了」，并告诉他那个终端窗口别关。

## 第 11 步：检查真的在运行

把下面的 18879 换成第 10 步打印的界面端口：

```bash
curl -s http://127.0.0.1:18879/api/health
```

- 算成功：输出 `{"ok":true,"app":"jincheng-workbench",…}`。
- 不对时：没有输出，说明第 10 步的程序已经停了，回到第 10 步看它打印了什么。

再看创作页的保存服务：

```bash
python3 ~/jincheng-workbench/creation-page/where.py
```

- 算成功：有一行「保存服务：正在运行，http://127.0.0.1:18977（根目录就是工作文件夹）」，端口和第 10 步打印的一样。
- 不对时：写着「保存服务：没在运行」，说明第 10 步的程序已经停了，回到第 10 步看它打印了什么。

## 第 12 步：装写稿 Skill

写稿 Skill（`jincheng-workbench-write`）教 AI 怎么写稿、怎么生成和读改创作页，在仓库的 `skills/jincheng-workbench-write/` 里。

装到哪，自己查，不用问用户：

- 你自己是哪个 AI 工具，就装进哪个。
- 这台 Mac 上另一个也在，也一起装上，用户以后换着用都认得：有 `~/.codex` 文件夹（或者 `command -v codex` 有输出）就是装了 Codex；有 `~/.claude` 文件夹（或者 `command -v claude` 有输出）就是装了 Claude Code。
- Codex 的 Skill 放在 `~/.codex/skills/`（设了环境变量 `CODEX_HOME` 的，放在 `$CODEX_HOME/skills/`，下面的命令跟着换）；Claude Code 的放在 `~/.claude/skills/`。

用软链装：Skill 文件夹直接指着仓库里的那份，以后 `git pull` 更新了，Skill 也跟着是新的。命令里的 `-n` 不能省：已经装过时，不带它的 `ln` 不报错，反而在仓库的 Skill 文件夹里再建一个指向自己的链接。

**Codex**：

```bash
mkdir -p ~/.codex/skills
ln -sn ~/jincheng-workbench/skills/jincheng-workbench-write ~/.codex/skills/jincheng-workbench-write
```

检查：

```bash
head -3 ~/.codex/skills/jincheng-workbench-write/SKILL.md
```

- 算成功：第 2 行是 `name: jincheng-workbench-write`。
- 不对时：`ln` 提示 `File exists`，说明那里已经有东西了，先运行 `ls -l ~/.codex/skills/jincheng-workbench-write` 看看是什么，不要直接删：
  - 已经指向 `~/jincheng-workbench/skills/jincheng-workbench-write`：装过了，往下走。
  - 是一个普通文件夹，里面 `SKILL.md` 的第 2 行也是 `name: jincheng-workbench-write`：这是以前复制装的旧版本。把它挪进废纸篓（`mv ~/.codex/skills/jincheng-workbench-write ~/.Trash/jincheng-workbench-write-旧版`），再运行一次上面的 `ln -sn`。
  - 别的东西（指向别处的链接、名字对不上的文件夹）：不动它，告诉用户这个位置被占了、占着的是什么。

**Claude Code**：

```bash
mkdir -p ~/.claude/skills
ln -sn ~/jincheng-workbench/skills/jincheng-workbench-write ~/.claude/skills/jincheng-workbench-write
```

检查：

```bash
head -3 ~/.claude/skills/jincheng-workbench-write/SKILL.md
```

- 算成功：第 2 行是 `name: jincheng-workbench-write`。
- 不对时：同上，`File exists` 先看已有的是什么，按上面三种情况办。

**不能用软链时**（比如用户的同步软件不认软链）：改成复制，`ln -sn` 那一行换成

```bash
cp -R ~/jincheng-workbench/skills/jincheng-workbench-write ~/.codex/skills/
```

（Claude Code 把 `~/.codex/skills/` 换成 `~/.claude/skills/`），检查方法一样。复制的不会跟着更新：以后每次更新完都要再复制一次（第 0 步拉到新提交时，做到这一步会照样复制）。

装好以后，新开的 Codex 或 Claude Code 对话最稳；新对话里还是找不到这个 Skill，就把 Codex（ChatGPT 桌面版）或 Claude Code 整个退出再打开。

## 第 13 步：装调研 Skill

调研 Skill（`jincheng-workbench-research`）教 AI 做写视频前的调研：把博主加进对标账号、分析一条视频的评论区、拆参考视频、看一个博主最近什么最火，结果写进工作文件夹的「市场调研」。它在仓库的 `skills/jincheng-workbench-research/` 里，脚本只用 Python 自带的模块（第 3 步确认过的 Python 3 就够）。装到哪和第 12 步一样（你自己是哪个就装哪个，这台 Mac 上另一个也在就一起装），命令里的 `-n` 同样不能省。

**Codex**：

```bash
mkdir -p ~/.codex/skills
ln -sn ~/jincheng-workbench/skills/jincheng-workbench-research ~/.codex/skills/jincheng-workbench-research
```

检查：

```bash
head -3 ~/.codex/skills/jincheng-workbench-research/SKILL.md
python3 ~/.codex/skills/jincheng-workbench-research/scripts/research.py where
```

- 算成功：第一条命令的第 2 行是 `name: jincheng-workbench-research`；第二条打印「工作文件夹：」「市场调研：」开头的几行，还有一行「TikHub 密钥：」（这时候多半是「没读到」，正常，见下面）。
- 不对时：`ln` 提示 `File exists`，照第 12 步的办法先看已有的是什么，按那里的三种情况办。工作文件夹那一行后面写着「还没有」，说明第 10 步的工作台还没启动过，回第 10 步。

**Claude Code**：

```bash
mkdir -p ~/.claude/skills
ln -sn ~/jincheng-workbench/skills/jincheng-workbench-research ~/.claude/skills/jincheng-workbench-research
```

检查：

```bash
head -3 ~/.claude/skills/jincheng-workbench-research/SKILL.md
python3 ~/.claude/skills/jincheng-workbench-research/scripts/research.py where
```

- 算成功、不对时：同上。

**不能用软链时**：和第 12 步一样改成复制，`ln -sn` 那一行换成 `cp -R ~/jincheng-workbench/skills/jincheng-workbench-research ~/.codex/skills/`（Claude Code 换成 `~/.claude/skills/`），以后每次更新完再复制一次。

**TikHub 不在这一步配**：批量拉博主作品和数据要用 TikHub（按次付费的数据服务，用用户自己的账号和密钥）。用户第一次让 AI 做调研时，AI 会请他去工作台「市场调研」页顶部的「数据来源」里配；不用 TikHub 也能用（评论用社媒助手导出，博主资料手动给）。不要在安装时问用户要密钥，也不要让用户把密钥发进对话。

## 第 14 步：装封面 Skill

封面 Skill（`jincheng-workbench-cover`）教 AI 做封面：拆一个对标博主的封面 VI、给一条选题出一批封面、按用户在工作台上写的备注改一张。它在仓库的 `skills/jincheng-workbench-cover/` 里，脚本只用 Python 自带的模块。出图用 Codex 自带的生图；Claude Code 没有自带生图，会把每张的生图提示词写好。装到哪和第 12 步一样（你自己是哪个就装哪个，这台 Mac 上另一个也在就一起装），命令里的 `-n` 同样不能省。

**Codex**：

```bash
mkdir -p ~/.codex/skills
ln -sn ~/jincheng-workbench/skills/jincheng-workbench-cover ~/.codex/skills/jincheng-workbench-cover
```

**Claude Code**：

```bash
mkdir -p ~/.claude/skills
ln -sn ~/jincheng-workbench/skills/jincheng-workbench-cover ~/.claude/skills/jincheng-workbench-cover
```

检查（Claude Code 把 `~/.codex/` 换成 `~/.claude/`）：

```bash
head -3 ~/.codex/skills/jincheng-workbench-cover/SKILL.md
python3 ~/jincheng-workbench/skills/jincheng-workbench-cover/scripts/cover.py where
```

- 算成功：第一条命令的第 2 行是 `name: jincheng-workbench-cover`；第二条打印工作文件夹、封面素材在哪，照片和默认对标这时候多半是「还没设」，正常：用户第一次出封面时，AI 做到那一步会请他放照片、拆一个对标博主。
- 不对时：`ln` 提示 `File exists`，照第 12 步的办法先看已有的是什么，按那里的三种情况办。

**不能用软链时**：和第 12 步一样改成复制（`cp -R ~/jincheng-workbench/skills/jincheng-workbench-cover ~/.codex/skills/`，Claude Code 换成 `~/.claude/skills/`），以后每次更新完再复制一次。

不要在安装时问用户要照片：出封面时 AI 做到那一步再提醒。

## 第 15 步：打开给用户看，告诉他结果

把下面的 18879 换成第 10 步打印的界面端口：

```bash
open http://127.0.0.1:18879
```

- 算成功：浏览器里出现「选题」页（左边菜单「内容」下面那一项），里面有一条「T001 示例：用 AI 三分钟想好一条视频的开头」；第一次装时，顶部还有新手指引的开场卡（「先带你走一遍」和一张 4 项的清单）。

最后用几句话告诉用户，只说结果和下一步，过程不用讲：

- 工作台装好了（是更新的话，说更新到了哪个版本，版本号用 `node -p "require('./package.json').version"` 看），已经在浏览器里打开，地址是第 10 步打印的那个，可以存成书签。
- 第一次用，点「内容」页顶部的「带我走一遍」：用示例选题 T001 走一遍。中间会复制一句话，粘贴给 Codex 或 Claude Code 发出去就行，在哪个对话里发都可以，AI 会自己找到工作文件夹。
- 以后电脑重启了、或者想更新到新版本，把这次让 AI 装工作台的那句话再发一次就行。
- 代码不在默认的 `~/jincheng-workbench` 时，说一句代码装在哪。

不要让用户先去打开哪个文件夹，也不要把 TikHub 的 key 要到对话里：要用 TikHub 时，工作台「市场调研」页和调研 Skill 会带他在页面上配好。

## 卸载

先停掉工作台（在代码文件夹里运行 `pnpm stop`），再删下面几处（挪进废纸篓就行）。最后两处要先问用户：钥匙串里的 key 别的工具可能也在用；工作文件夹是用户自己的选题和稿子，删之前一定先问要不要留着。

- 写稿 Skill：`~/.codex/skills/jincheng-workbench-write`、`~/.claude/skills/jincheng-workbench-write`（装了哪个删哪个；软链只删链接本身）
- 调研 Skill：`~/.codex/skills/jincheng-workbench-research`、`~/.claude/skills/jincheng-workbench-research`（同上）
- 封面 Skill：`~/.codex/skills/jincheng-workbench-cover`、`~/.claude/skills/jincheng-workbench-cover`（同上）
- 代码：`~/jincheng-workbench`
- 设置：`~/Library/Application Support/jincheng-workbench`
- 日志：`~/Library/Logs/jincheng-workbench`
- 钥匙串里的 TikHub key（配过才有；服务名 `tikhub-api`，账户名 `tikhub`）：先问用户，别的工具可能也在用这一项。要删就请用户在「钥匙串访问」里删，或者运行 `security delete-generic-password -s tikhub-api -a tikhub`（也可以在停掉工作台之前，到「市场调研」页上点「删除 key」）。
- 工作文件夹（用户的内容）：`~/Documents/jincheng-workbench`
