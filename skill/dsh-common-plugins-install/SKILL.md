---
name: dsh-common-plugins-install
description: 在一台已装好 DSH 的机器上自动安装"常用插件"清单（当前：dsh-market/dsh-market、jasonrale/dsh-archive-manager；可扩展）。优先用 `dsh plugin --profile web add <npm包名>`（一条命令装依赖+bundle+install）；未上 npm 的源码插件才用本地 file:链接。凡涉及远程 push 一律停下等用户确认。用户说"安装常用插件"、"装 dsh-market"、"装 dsh-archive-manager"、"新机器装插件清单"时调用。
whenToUse: 用户要求安装/部署 dsh-market、dsh-archive-manager 等常用 DSH 插件，或在一台新机器上按清单安装常用插件时调用。
---

# DSH 常用插件安装

作为部署助手，在一台**已装好 DSH** 的机器上安装"常用插件"清单。这些插件都是**自描述的 DSH 插件**（自带 `cordis.patch.yml` / `dsh.bundle.patch`），安装步骤统一；**清单可扩展**——往后加插件只需在"插件目录"加一行。

> 本 skill 是**操作指引**，由你（agent）在目标机器上执行。真实 shell/文件权限来自该机器；凡**远程 push / 打 tag / 发 Release** 一律停下，等用户明确确认（硬性安全边界）。

## 插件目录（当前收录）

| 插件 | 包名 (bundle名) | 安装命令（npm 发布，推荐） | 简介 | 备注 |
|---|---|---|---|---|
| dsh-market | `dshmarket` | `dsh plugin --profile web add dshmarket` | DSH 可视化插件市场（浏览/搜索/一键安装社区插件） | npm 已发布；cordis id `dsh-market`；仓库 `dsh-market/dsh-market`（main）；本机已装 1.19.0（latest） |
| dsh-archive-manager | `dsh-archive-manager` | `dsh plugin --profile web add dsh-archive-manager` | 归档会话管理器（重开/取消归档/硬删归档会话，带搜索与同步） | npm 已发布 v1.1.1；仓库 `jasonrale/dsh-archive-manager`（master）；cordis id `archive-manager`；引擎 node ≥22 |

> **bundle 名 = 该包 `package.json` 的 `name`**。**npm 已发布的插件直接用 `dsh plugin --profile web add <包名>` 安装**——该命令会自动写入 `dependencies`、加入 `dsh.profile.bundles`、并跑 `pnpm install`（本机已实证）。仅当插件**未发布到 npm** 时，才用下方"源码插件"的 git clone + `file:` 方式。

## 前置检查（先探测，再动手）

执行前先探测环境，**不要假设本机路径**。缺了就让用户补：

```
dsh --version                      # 是否装了 DSH；没有则提示先按官方文档装 DSH
echo "$DSH_HOME"                   # 未设则查 /volume1/dsh、$HOME/.dsh 常见位置
ls -d <候选>/profiles/web          # 定位 profile 目录（一般 web）
node --version                     # 需 >=22（--expose-internals 依赖；archive-manager 也要求 >=22）
which node ; command -v node       # 找 node 真实路径；找不到让用户给
```

- **DSH_HOME**：默认 `$HOME/.dsh`（Windows）或 `/volume1/dsh`（NAS），以用户实际值为准。
- **profile**：默认 `web`；用 `dsh --profile <p> --dump-config` 核对。

## 目录约定（先确认，再动手）

- 插件目录 = `<DSH_HOME>/plugins`（习惯上源码插件放这里；npm 插件由 pnpm 装进 profile 的 `node_modules`，两处不冲突）。
- bin 目录 = `<DSH_HOME>/bin`（放 DSH 运行时脚本，缺失则创建）。
- 用户工作/上传目录与本插件清单无关（这两个插件不是文件上传类），**无需**设置 `DSH_UPLOAD_DIR`。
- 若未约定插件目录，默认用 `<DSH_HOME>/plugins`，并告知"以后所有插件都放这里"。

## 安装步骤（统一机制）

> **两种来源**：① npm 已发布的插件 → `dsh plugin --profile web add <包名>`（推荐）；② 未上 npm 的源码插件 → git clone + `file:` 链接（更新靠手动 `git pull`）。不用 `github:` 依赖（会失去本地 clone 目录、依赖解析更不稳）。

### 路径 A —— npm 已发布的插件（一条命令）
```sh
dsh plugin --profile web add <包名>
# 等效：npx @deepseek-ai/dsh plugin --profile web add <包名>
```
> 该命令自动完成：写入 `dependencies` → 加入 `dsh.profile.bundles` → `pnpm install`。装完用 `dsh --profile web --dump-config` 确认插件已插入。

### 路径 B —— 源码插件（未发布到 npm）
#### B1. 获取源码 → 放入 DSH 插件目录
```sh
mkdir -p "$DSH_HOME/plugins" "$DSH_HOME/bin"      # 确保存在，缺失即创建
git clone https://github.com/<owner>/<repo>.git "$DSH_HOME/plugins/<包名>"
# 已有则更新：
git -C "$DSH_HOME/plugins/<包名>" pull --ff-only origin <默认分支>
```
> **Windows 下 clone github.com 超时/被墙**时，用 codeload tarball：
> `Invoke-WebRequest https://codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/<分支> -OutFile p.tgz` + `tar -xzf`，把解压后内层目录移动为 `$DSH_HOME/plugins/<包名>`。

#### B2. 读 package.json，确定 bundle 名与依赖
- `name` → bundle 名（加入 `dsh.profile.bundles` 与依赖 `file:` 引用名）
- `dsh.client.platform` / `dsh.client.inject` → 前端是否注入、注入哪些
- `dsh.bundle.patch`（多为 `./cordis.patch.yml`）→ 插件自带 insert，通常无需在 profile 写配置
- `peerDependencies` → 多为 `@deepseek-ai/*`、`react`，DSH 宿主已提供，一般不必额外装

#### B3. 注入依赖 + 加 bundle（file: 绝对路径，勿用相对路径）
```sh
# 在 profile 目录执行，<profile> 通常为 web
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.dependencies=p.dependencies||{};p.dependencies['<包名>']='file:'+'$DSH_HOME/plugins/<包名>';p.dsh=p.dsh||{};p.dsh.profile=p.dsh.profile||{};p.dsh.profile.bundles=p.dsh.profile.bundles||[];if(!p.dsh.profile.bundles.includes('<包名>'))p.dsh.profile.bundles.push('<包名>');fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
```
> 任何平台都要把 `<包名>` 加进 `dsh.profile.bundles`。

#### B4. pnpm install
```sh
cd "$DSH_HOME/profiles/<profile>" && pnpm install
```

### 通用：写 cordis.patch.yml（通常不需要）
插件自带 `cordis.patch.yml`（`dsh.bundle.patch`）会自动 insert 自身。**一般不需要在 profile 的 `cordis.patch.yml` 里加东西。** 仅当要覆盖插件默认配置（如 `priority`、`trustedHosts`、`skillsRoot`）时，才在 `<profile>/cordis.patch.yml` 追加 `- id: <cordis-id>` 的 config 覆盖条目。本清单两个插件都不需要。

### 通用：启动（用户手动执行，agent 不自重启）
```sh
node --expose-internals --max-old-space-size=8192 <dsh/lib/bin.js> web --port 3080 &
```
> **`--expose-internals` 必须有**，否则插件相关路由 404。以目标机器现有启动方式为准；Windows 可参考本机 `<DSH_HOME>/bin/restart-dsh.cmd`（会停旧进程再带 `--expose-internals` 起新进程，会中断当前会话，由用户在独立终端跑）。

## 验证清单（逐项）
1. `dsh --profile <profile> --dump-config` 组合树里出现该插件（id + inject）。
2. 设置面板 / 前端出现对应插件入口（market 有"市场"入口；archive-manager 有归档/会话入口）。
3. 重启后强刷浏览器（Ctrl/Cmd+Shift+R）。
4. 上传/预览/md2docx 等其它插件功能不受影响（若本机已装 dsh-long-plugins）。

## 更新插件版本
- **npm 插件**：`dsh plugin --profile web add <包名>@最新` 或按 npm 版本；之后重启。
- **源码插件（file:）**：`file:` 目录依赖在 `pnpm install`（含 `--force`）下**不会自动重拷**到 profile 的 `node_modules`，需手动同步：
```sh
# 1) 更新源码
git -C "$DSH_HOME/plugins/<包名>" pull --ff-only origin <分支>
# 2) 删除 profile 里的陈旧副本，再重装（否则 bundle 仍指向旧拷贝）
Remove-Item -Recurse -Force "$DSH_HOME/profiles/<profile>/node_modules/<包名>"
cd "$DSH_HOME/profiles/<profile>" && pnpm install
# 3) 重启 DSH web
```
> 否则会出现"版本显示旧 / 改动不生效"——因为运行的是 node_modules 里的**独立拷贝**，不是源码目录（Windows 上 pnpm 常回退为拷贝而非符号链接）。

## 硬性安全边界（必须遵守）
- **不主动 `git push` / 打 tag / 发 Release**；需要发版本时停下用 `ask_user_question` 等用户确认。
- 所有写操作（改 package.json / cordis.patch.yml / 重启服务）先向用户说明将要改哪个文件、做什么，再执行。
- 探测到 `DSH_HOME`/`node`/profile 目录缺失时**停下提示**，让用户补充，不硬猜。

## 往清单里加新插件
只需在"插件目录"表加一行（包名、是否上 npm、仓库 `owner/repo`、默认分支、简介）。**若已上 npm** 就填安装命令 `dsh plugin add <包名>`；**若未上 npm** 用路径 B（clone+file:）。若新插件是文件/上传类或需要 `trustedHosts`/`skillsRoot` 等配置，再在"写 cordis.patch.yml"给出对应覆盖项。

## 常见坑速查
| 症状 | 原因 | 解决 |
|---|---|---|
| 设置面板不出现插件 | 未加 bundle | 用 `dsh plugin add`（自动加）；或手动把 `<包名>` 加入 `dsh.profile.bundles` |
| 插件路由 404 | 启动缺 `--expose-internals` | 启动命令加该 flag |
| **npm 插件 version 显示旧 / 改动不生效** | 版本没更新 | `dsh plugin add <包名>@<目标版本>` 后重启；源码插件则删 `node_modules/<包名>` 重装 |
| `file:` 源码插件改动不生效 | pnpm 不重拷副本 | 删 `node_modules/<包名>` 重装 + 重启 |
| clone github.com 超时/被墙 | 网络不通 github.com（raw/codeload 常可达） | codeload tarball 解压后移动到插件目录 |
| market 检查不到 `file:` 插件更新 | market 硬编码 `updateAvailable:false` | 手动 `git pull` 更新 |
