---
name: dsh-long-plugins-install
description: 在一台新装 DSH 的机器上自动安装并配置 dsh-long-plugins（上传文件/工作区输出文件/技能文档/DeepSeek 余额/md2docx 工具/文件预览增强）。自动探测 DSH_HOME 与 Node 环境、安装插件、写 cordis.patch.yml 配置、启动并验证；凡涉及远程 push 一律停下等用户确认。用户说"在另一台电脑安装 dsh-long-plugins"、"新机器部署插件"、"帮我装 dsh-long-plugins"时调用。
whenToUse: 用户要求在另一台/新机器上安装、部署或配置 dsh-long-plugins 插件，或把本机 DSH 插件环境迁移到新机器时调用。
---

# dsh-long-plugins 新机器自动安装

作为部署助手，在一台**已装好 DSH** 的机器上自动安装并配置 `dsh-long-plugins`（≥v1.2.6）。目标：让上传管理、工作区「输出文件」、技能文档、DeepSeek 余额、md2docx 工具、文件预览增强（md 渲染真实效果、文件类型标签、预览/删除/下载）都能用。**支持 NAS（Linux/Unix）与 Windows 安装，无需区分平台**。

> 本 skill 是**操作指引**，由你（agent）在目标机器上执行。真实 shell/文件权限来自该机器；凡**远程 push / 打 tag / 发 Release** 一律停下，等用户明确确认（硬性安全边界）。

## 前置检查（先探测，再动手）

执行前先探测环境，**不要假设本机路径**。逐项确认，缺了就停下让用户填：

```
dsh --version                      # 是否装了 DSH；没有则提示先按官方文档装 DSH
echo "$DSH_HOME"                   # 未设则查 /volume1/dsh、$HOME/.dsh 常见位置
ls -d <候选>/profiles/web          # 定位 profile 目录
node --version                     # 需 >=22（--expose-internals 依赖）
python3 -c "import docx"           # 可选：md2docx 工具需要；缺则提示 pip install python-docx
which node ; ls <node套件>/bin/node  # 找 node 真实路径；找不到让用户给
```

- **node 路径**：本机用 `/volume1/@appstore/Node.js_v22/usr/local/bin/node`，但**不要写死**——优先 `command -v node`，找不到再探测套件目录，仍找不到就让用户提供。
- **DSH_HOME**：默认 `$HOME/.dsh`，但很多用户用 `/volume1/dsh`。以用户实际值为准。

## 跨平台（Windows / NAS）说明

插件**不做"安装时检测平台"**——它靠运行时自动适配，同一份代码在 NAS 和 Windows 都能工作，部署时**不需要区分平台、不用手动改配置**。机制分三层：

1. **服务端（node）**：全程用 Node 跨平台 `path` API（`resolve`/`join`/`relative`/`dirname`/`sep`）。`sep` 在 NAS 是 `/`、在 Windows 是 `\`，Node 运行时自己知道在哪，无需判断。
2. **前端（浏览器 JS）**：没有 `process.platform`。改用**按路径形状判断**，同时识别 Unix 与 Windows 两类绝对路径——`isAbsPath(p)` 匹配 `/` 开头（Unix）、`X:\` 盘符或 `\\` UNC（Windows）；`normPath(p)` 把 `\` 与 `/` 统一成 `/`。所以不依赖"当前是哪个系统"，同一份代码两平台通用（≥v1.2.6 已修复 Windows 下"工作区 0 文件 / 点击文件 500"两个路径 bug）。
3. **安装**：纯 npm 包，安装机制 NAS/Windows 完全相同。**Windows 不跑 `install.sh`（那是 shell 脚本，仅 Unix-like）**，改用 DSH 标准方式：`dsh plugin --profile web add file:...`（DSH CLI 在 Windows 也能跑，会转发给 pnpm）。

### Windows 与 NAS 的差异点
| 项 | NAS / Linux | Windows |
|---|---|---|
| 路径分隔符 | `/` | `\` |
| 安装方式 | `./install.sh web <DSH_HOME>` | `dsh plugin --profile web add file:<path>` |
| 启动命令 | `<DSH_HOME>/start.sh` 或 node + `--expose-internals` | 同样 `dsh web`（node 命令路径不同） |
| 无头 `xdg-open` | 无图形界面才需禁原生打开 | 桌面通常有 `xdg-open`（或系统默认浏览器），一般无需设 |
| python3 | `python3` + `python-docx`（md2docx 用） | 用 `python`（可能无 `python3` 别名），需 `pip install python-docx`；**`python3` 常是 Windows Store 的坏 stub**，插件 `spawn("python3")` 会命中它——需把真实 python 拷贝成 `python3.exe` 放进 `$DSH_HOME\bin` 并加入 DSH 服务的 PATH |

> 前端 `client.js`、服务端 `lib/index.js` 都无需按平台改；只需按上表用对命令即可。

## 概念澄清（换机器最容易错的地方）

DSH 是"profile 层叠"结构，插件不是放进去就生效，要三处配合：

1. **依赖**：`<DSH_HOME>/profiles/<profile>/package.json` 里加 `"dsh-long-plugins": "file:/path/to/dsh-long-plugins"`。
2. **bundles**：同一 `package.json` 的 `dsh.profile.bundles` 数组里**追加** `"dsh-long-plugins"`（数组顺序=层叠顺序，追加到末尾）。
3. **配置**：profile 的 `cordis.patch.yml` 里写 `trustedHosts`/`skillsRoot`（见下）。

- `cordis.yml` 是 `[]`（勿编辑），补丁一律写 **`cordis.patch.yml`**。
- `dsh plugin --profile <p> add <pkg>` 只是把参数转发给 pnpm，可以做"依赖注入"；bundles 要单独加。

## 目录约定（先用 ask_user_question 确认，再动手）

部署前**先确认 DSH 的目录约定**，尤其 Windows 上曾因未确认导致插件/bin 错落到工作区 `C:\dsh\workspace`。用 `ask_user_question` 问用户，以下几点都要确认（DSH 已有约定/用户已指定则按其值）：

1. **插件目录** = `<DSH_HOME>/plugins`（插件源码放 `<DSH_HOME>/plugins/dsh-long-plugins`）——这也是**后续所有 DSH 插件的统一安装目录**。
2. **bin 目录** = `<DSH_HOME>/bin`（放 `restart-dsh.ps1`、`python3.exe` 等 DSH 运行时脚本）。
3. **若用户/DSH 尚未约定插件目录** → 必须停下来提示：默认用 `<DSH_HOME>/plugins`，并告知"以后安装的所有插件都放这里"。
4. **工作目录**：用户的工作目录（名字不固定，如 `C:\dsh\workspace`、`C:\dsh\jobs`、`/home/me/project`），**由用户指定**；在其下（或用户指定位置）放 **`upload` 子目录**作上传根（`DSH_UPLOAD_DIR`）。不强制目录叫 `workspace`。

**主动创建目录（不依赖用户提前建好）**：确认后，用命令创建缺失的目录——
- `<DSH_HOME>/plugins`：插件安装目录，**缺失则创建**（`mkdir -p`）；
- `<DSH_HOME>/bin`：DSH 运行时脚本目录，缺失则创建；
- **用户工作目录**（用户指定，已有则直接用它）及其下的 **`upload` 子目录**：确认/创建（`mkdir -p <工作目录>/upload`），并设为 `DSH_UPLOAD_DIR`。

> 原则：**插件和 bin 都放 `$DSH_HOME` 下（`$DSH_HOME/plugins`、`$DSH_HOME/bin`），不要放到用户工作目录/当前目录**。**用户工作目录**（如 `C:\dsh\workspace`）只放用户内容——其中 `upload` 子目录是上传根（`DSH_UPLOAD_DIR`），路径和目录名由用户指定并创建，不混放插件源码和 bin。**不强制创建名为 `workspace` 的目录**；用户已有工作目录就用它。若这些目录不存在，部署脚本必须 `mkdir -p` 补建，而不是报错或退到其它位置。

## 安装步骤

> ⚠️ **安装方式：统一用本地 `file:` 链接**——插件源码放 `$DSH_HOME/plugins/dsh-long-plugins`，`file:` 引用它；更新靠手动 `git pull`。**不用 `github:` 依赖**（github: 会让插件失去本地 clone 目录、且依赖 `@deepseek-ai/dsh-tools` 解析更不稳）。注意 dshmarket 市场对 `file:`/`link:` 安装的插件**不会显示更新提示**（这是市场的硬编码行为，`updateAvailable:false`），如需更新提示请手动 `git pull`。

### 1. 获取插件源码 → 放到 DSH 插件目录
**clone 到绝对目标目录**（不要只 `git clone` 落在当前目录）；`$DSH_HOME/plugins` 不存在则先建：
```sh
# Unix-like / PowerShell 通用（先确保插件目录与 bin 目录存在，缺失则创建）
mkdir -p "$DSH_HOME/plugins" "$DSH_HOME/bin"
git clone https://github.com/jackylong1987/dsh-long-plugins.git "$DSH_HOME/plugins/dsh-long-plugins"
# 已存在则更新
git -C "$DSH_HOME/plugins/dsh-long-plugins" pull --ff-only origin main
```
> 这样插件源码一定在 `$DSH_HOME/plugins/dsh-long-plugins`，且 `<DSH_HOME>/plugins`、`<DSH_HOME>/bin` 都确保存在（缺失即创建），不随当前目录变化。

### 2. 注入依赖 + 加 bundle
用 `file:` 引用**绝对路径**（必用绝对路径，勿用相对路径 `./...`，否则会解析到当前目录/工作区）。
```sh
# Unix-like（NAS/桌面 Linux）：在 profile 目录执行
cd "$DSH_HOME/profiles/<profile>"
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.dependencies=p.dependencies||{};p.dependencies['dsh-long-plugins']='file:'+'$DSH_HOME/plugins/dsh-long-plugins';p.dsh=p.dsh||{};p.dsh.profile=p.dsh.profile||{};p.dsh.profile.bundles=p.dsh.profile.bundles||[];if(!p.dsh.profile.bundles.includes('dsh-long-plugins'))p.dsh.profile.bundles.push('dsh-long-plugins');fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
```
```powershell
# Windows（PowerShell）：也用绝对路径，<profile> 通常为 web
dsh plugin --profile web add "file:C:\Users\iprla\.dsh\plugins\dsh-long-plugins"
# 再手动把插件加入 bundles（dsh plugin add 只装依赖，不自动加 bundle）：
```
> 任何平台都要把 `dsh-long-plugins` 加进 `dsh.profile.bundles`。Windows 下 `dsh plugin add` 只装了依赖，bundle 需手动加（写入 profile 的 `package.json` 的 `dsh.profile.bundles`）。

### 3. pnpm install
```sh
cd "$DSH_HOME/profiles/<profile>"
pnpm install        # 或用探测到的 pnpm 绝对路径
```
> `@deepseek-ai/dsh-tools` 是插件的 `peerDependencies`(optional)——插件**复用宿主 DSH 的 dsh-tools**，不会自行安装（避免遮蔽宿主版本/重复）。宿主需已带该包（DSH 核心自带），不必额外安装。

### 4. 写 cordis.patch.yml 配置
在 `<profile>/cordis.patch.yml` 里追加（若文件不存在先建）：
```yaml
- id: dsh-long-plugins
  config:
    priority: -10
    trustedHosts: !!js ctx.webRuntime.trustedHosts   # 必填，浏览器信任域
    skillsRoot: !!js dshHomePath('skills')            # 默认 <DSH_HOME>/skills
    # md2docxScript: /your/path/md2docx.py           # 可选，默认用包内 lib/md2docx.py
```

## 工作目录 / 上传目录匹配（重要决策点）

上传/工作区根**不是写死的**，靠环境变量推导：
```
上传目录  = $DSH_UPLOAD_DIR 或默认 <DSH_HOME>/uploads
工作区根 = dirname(上传目录)     （上传目录的上一级）
skill根  = dshHomePath('skills') = <DSH_HOME>/skills
```

**工作目录的名字不固定**（可能叫 `workspace`、`jobs`、`projects` 或其它），完全由用户指定；`upload` 目录也要指定。**先问用户两个信息**：
1. **真实工作目录路径**：用户的实际工作目录（如 `C:\dsh\workspace`、`C:\dsh\jobs`、`/home/me/project`），**不管它叫什么都按用户给的用**。
2. **upload 存放位置**：默认是工作目录下的 `upload` 子目录；用户也可以指定别处。设 `DSH_UPLOAD_DIR`。

```sh
# 例：用户工作目录 = /home/me/project，upload 放在其下
mkdir -p "/home/me/project/upload"
export DSH_UPLOAD_DIR="/home/me/project/upload"   # 工作区根自动 = /home/me/project
```
- **不强制创建 `workspace` 目录**：若用户已有工作目录，就用它；仅在需要时才 `mkdir -p <工作目录>/upload`。
- 把 `export DSH_UPLOAD_DIR=...` 写进用户启动脚本（start.sh / restart-dsh.ps1 或等价物），这样工作区根自动 = 用户工作目录。
- **目录不存在则 `mkdir -p` 主动创建**（`<工作目录>/upload` 缺失则建），不要报错或退到其它位置。
- **确认上传目录可写**：`dsh` 服务进程需对 `DSH_UPLOAD_DIR` 有写权限（上传/预览/删除都要写），否则启动后上传会失败。

## 无头机器（可选）
若目标机器**无图形界面**（`xdg-open` 不存在），点交付物卡片会报 `spawn xdg-open ENOENT`。在 **profile 的 cordis.patch.yml 顶层**加：
```yaml
- id: api-gateway
  config:
    nativeOpen: false
```
> id 是 `api-gateway`（不是 `apiProxy`，用错报 "entry not found"）。桌面/有 xdg-open 的机器可不加。这是**环境配置，不属于插件源码**，不随插件 commit。

## 启动
```sh
# 用探测到的 node 与 dsh 入口，务必保留 --expose-internals
setsid nohup <node绝对路径> --expose-internals --max-old-space-size=8192 \
  <dsh>? 或 <DSH_HOME>/start.sh web ...  &
```
> `--expose-internals` **必须有**，否则插件相关路由 404。启动脚本以目标机器现有方式为准；本机参考：`/volume1/@appstore/Node.js_v22/usr/local/bin/node --expose-internals --max-old-space-size=8192 /volume1/npm/global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080`。

## 验证清单（逐项）
1. 设置面板出现「上传文件」「输出文件」「技能文档」节。
2. 上传/输出列表每行显示类型徽标（PDF/DOCX/MD…）。
3. 预览窗有「打开/下载/放大/删除」；图片点预览是**内嵌显示**而非下载；**`.md` 预览显示渲染后 HTML**（标题/表格/列表等，非源码）——≥1.2.5。
4. 消息正文文件引用（蓝色 chip/path）点击能内联预览。
5. agent 调用 md2docx：`.md` → 带页码 `.docx`，产物作为可点击交付物卡片出现在消息里。
   > **md2docx 工具需新建会话后 agent 才加载**（会话工具集创建时固定），验证时开新会话。
6. 窄屏（手机）下预览窗按钮自动换行不截断。
7. 用 `dsh --profile <p> --dump-config` 核对组合树正确。

## 硬性安全边界（必须遵守）
- **不主动 `git push` / 打 tag / 发 Release**；需要发版本时停下用 `ask_user_question` 等用户确认。
- 所有写操作（改 package.json / cordis.patch.yml / 重启服务）先向用户说明将改哪个文件、做什么，再执行。
- 探测到 `DSH_HOME`/node/uplaod 目录缺失时**停下提示**，让用户补充，不硬猜。

## 常见坑速查
| 症状 | 原因 | 解决 |
|---|---|---|
| 插件/bin/`file:` 引用错落到工作区（如 Windows 下 `C:\dsh\workspace\...`） | clone 时落在当前目录、或 `file:` 用了相对路径，而非 DSH 插件目录 `$DSH_HOME/plugins/dsh-long-plugins` | 把插件源码放到 `$DSH_HOME/plugins/dsh-long-plugins`，`file:` 用绝对路径指向它；修复后再跑 `pnpm install` |
| Windows 插件 `git clone` 连 github.com 超时/被墙 | 网络不通 github.com（但 `raw.githubusercontent.com`/`codeload` 常可达） | 用 codeload tarball 下载后解压：`Invoke-WebRequest https://codeload.github.com/jackylong1987/dsh-long-plugins/tar.gz/refs/heads/main -OutFile p.tgz` + `tar -xzf`，把内层目录移为 `$DSH_HOME/plugins/dsh-long-plugins` |
| Windows 下 md2docx 报 python3 找不到/异常 | `python3` 命中 Windows Store 的坏 stub（`C:\Users\...\WindowsApps\python3.exe`，不返回输出） | 把真实 python 拷贝为 `$DSH_HOME\bin\python3.exe`（+ `python3.dll`）放 PATH 前部；用 `python3 -c "import docx"` 验证 |
| Windows 里 `bin`/`restart-dsh.ps1` 落在工作区 | 部署时用了相对路径、或把 bin 建在了当前目录 | `bin`（含 `restart-dsh.ps1`、`python3.exe`）应放 `$DSH_HOME\bin`，不要让它们落到工作区 `C:\dsh\workspace` |
| 重启 DSH web 时把当前会话杀掉 | DSH 服务进程（如 PID 20360 on :3080）正宿主 agent 会话 | 重启脚本由用户手动执行（脚本会先停旧进程再启新进程带 `--expose-internals`）；agent 不自重启 |
| 设置面板无「上传文件」 | 插件未加 bundle | 步骤 2 加 `dsh.profile.bundles` |
| 插件路由 404 | 缺 `--expose-internals` | 启动命令加该 flag |
| 文件卡片报 `xdg-open ENOENT` | 无头无 xdg-open | 加 `api-gateway nativeOpen:false` |
| 图片预览变下载 | 旧版缺图片扩展名 | 升级到 ≥1.2.3 |
| md2docx 调用失败 | 无 python3/python-docx | `pip install python-docx` 或设 `md2docxScript` |
| agent 找不到 md2docx | 会话工具集固定 | 新建会话 |
| 版本号显示旧 | 运行副本版本文件未同步 | 同步 package.json/dsh.plugin.json 到 node_modules 副本 + 重启 |
