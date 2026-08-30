---
name: dsh-upgrade
description: 升级 DeepSeek Harness（DSH）后重新应用本地补丁，防止升级覆盖核心定制（如反代信任、WebSocket 心跳、插件 dsh-long-plugins）。自动升级核心、重打全部补丁（privileged 信任 / 反代 loopback / 心跳）、同步插件、重启并健康检查。用户说"升级 DSH"、"升级后重打补丁"、"dsh 升级了要重打"时调用。
whenToUse: 用户要求升级 DSH（@deepseek-ai/dsh）到最新/指定版本，或升级后发现补丁失效、设置 403、提问窗口消失、功能异常时调用。
---

# DSH 升级后重打补丁

作为升级助手，帮用户**升级 DSH 核心并重新应用本地补丁**。DSH 升级（`npm install -g @deepseek-ai/dsh`）会覆盖核心包的本地定制补丁，需重新应用，否则会出现：设置页 403、反向代理域名访问异常、提问/审批窗口自己消失等。

> 本 skill 是**操作指引**，由 agent 在目标机器执行。涉及**远程 push / 打 tag / 发 Release** 一律停下等用户确认。升级本身会重启 DSH 服务（可能中断会话），先向用户说明。

## 前置检查（先探测，再动手）
```
dsh --version            # 当前版本
echo "$DSH_HOME"         # DSH_HOME（默认 $HOME/.dsh；NAS 常用 /volume1/dsh）
ls <DSH_HOME>/bin/upgrade-dsh.sh   # 是否有现成升级脚本
which npm ; npm --version          # 升级用 npm -g
ls <DSH_HOME>/bin/apply-dsh-patches.sh  # 是否有重打补丁脚本
```

## 推荐方式 A：用现成脚本一键升级（最简单）
若目标机器有 `/volume1/dsh/bin/upgrade-dsh.sh`（或等价脚本），直接调它，一条命令完成 升级核心 + 重打补丁 + 同步插件 + 重启：
```sh
/volume1/dsh/bin/upgrade-dsh.sh              # 升级到最新
/volume1/dsh/bin/upgrade-dsh.sh 0.1.1-rc.2   # 升级到指定版本
```
脚本已内置步骤：备份配置 → 升级核心 → 重打补丁（apply-dsh-patches.sh，含补丁1/2/3）→ 同步 dsh-long-plugins 安装副本 → 重启 → 健康检查。

## 手动方式 B（无脚本/要逐步做）
### 1. 备份
```sh
cp "$DSH_HOME/profiles/web/cordis.patch.yml" "$DSH_HOME/profiles/web/cordis.patch.yml.bak-$(date +%Y%m%d-%H%M)"
```

### 2. 升级 DSH 核心
```sh
npm install -g --prefix /volume1/npm/global "@deepseek-ai/dsh@latest"
# 或指定版本：@deepseek-ai/dsh@0.1.1-rc.2
```
> 若 DSH 装在别处，`--prefix` 换成 `npm root -g` 的父目录。

### 3. 重打本地补丁
```sh
/volume1/dsh/bin/apply-dsh-patches.sh
```
它幂等重打三处（已打过会跳过）：
- 补丁1：privileged 方法接受 trustedHosts（修设置 403）
- 补丁2：反代域名视为 loopback（修设置页"未暴露命名空间"）
- 补丁3：**WebSocket 心跳**（修反代下提问/审批窗口自己消失）

### 4. 重打心跳补丁（若装 dsh-long-plugins 的 install.sh 带补丁脚本）
插件安装时会自动打心跳补丁；若拿不到 apply-dsh-patches.sh，可单独跑插件自带脚本：
```sh
sh <插件目录>/patches/dsh-client-connection-heartbeat.sh
```

### 5. 同步插件安装副本
```sh
cd "$DSH_HOME/profiles/web" && pnpm install
```

### 6. 重启 dsh + 强刷浏览器
```sh
/volume1/dsh/start.sh        # 或按当前环境的重启方式
# 浏览器 Ctrl/Cmd+Shift+R 强刷
```

## 验证清单（逐项）
1. `dsh --version` 为升级后的目标版本。
2. 设置页各 tab 可进、不再 403/未暴露命名空间（重启后，用浏览器访问，非 raw 127.0.0.1）。
3. 反代域名访问正常。
4. 提问/审批窗口：弹出一个问题，等 60s+ 不再自己消失（心跳补丁生效）。
5. 插件设置面板「上传文件」「输出文件」「技能文档」都在。
6. `grep -q WEBSOCKET_HEARTBEAT_MS <核心解压路径>/dsh-client-connection/lib/index.js` → 心跳在位。
7. **RA-Span 玻璃观感**：左栏/顶栏文字图标、会话区过程内容配色、输入框、提问卡、耗时统计等是否仍正常（见下文"RA-Span 升级后需重新校准"）。
8. **「dsh-long」设置区**：设置面板多了一个「dsh-long」区（各模块开关 + 补丁状态只读）。若升级目标是新版 DSH（如带自带回合导航/原生心跳），可在这里**关掉插件对应模块**避免冲突；「补丁状态」只读显示 3 个 DSH 核心补丁的已打/未打/原生无需。

## 「dsh-long」设置区（模块开关 + 补丁状态）⚙️

- 设置面板「dsh-long」区提供**各模块开关**：RA-Span、会话导航（轮次刻尺）、附件上传（回形针）、附件拖放上传、附件粘贴上传、上传文件预览/管理、技能文档、账户余额、移动端布局、输出文件预览/管理。关掉某模块即**禁用对应功能**（开关下次刷新生效）。
- **用途**：新版本 DSH 若自带某项功能（如"紧凑回合导航"、"原生 WebSocket 心跳"），可在此关掉插件对应功能避免重复/冲突；也便于按需精简。
- **补丁状态（只读）**：显示 3 个 DSH 核心补丁的已打 / 未打 / **原生无需**——若 DSH 已原生实现（如心跳），显示"原生无需"即不必打该补丁。
- 模块开关存于 `~/.dsh-long-plugins/glass.json` 的 `modules` 字段；页面加载时同步读取缓存（localStorage）让 `apply` 门控生效，保存后下次刷新生效。

## RA-Span（统一桌面/玻璃）升级后需重新校准 ⚠️

dsh-long-plugins 的「RA-Span（统一桌面/玻璃）」**大量依赖 DSH 内部混淆类名**（`o3BgMG_*`/`CY-8Ka_*`/`QWLzLg_*`/`M8wy4a_*`/`uV2eYG_*`/`wSkVaW_*`/`osXY9a_*`/`p-xYUq_*`/`lXshSW_*`/`_7yHdaG_*` 及菜单 `_root_`/`_list_`/`_viewport_`/`_item_` 等）与 DSH 内部 DOM 结构。DSH 升级重打包后**这些类名前缀会变**，导致插件里靠类名压样式的规则/JS **静默失效**（不报错，只是观感/配色不对）。

升级流程会**同步插件代码（逻辑保住）**，但**不会自动重抓新的类名**，所以升级后必须**人工复核**玻璃观感。

### 升级后重点复核 + 处理
1. 浏览器强刷（Ctrl/Cmd+Shift+R）。
2. 逐项看 RA-Span 是否仍正常：
   - 左栏/顶栏文字与图标（白字+深影、品牌区不被白化）
   - 会话区过程内容配色（Bash 绿 / Read 蓝 / Edit 橙 / Write 紫 / Think 琥珀、错误红、工具输出水绿）
   - 状态/统计行余额（走 `data-slot-conversation="composer.dock"` 的相对稳）
   - 输入框（无重影、背景/文字随主题、可调色）
   - 「新会话」按钮去白底
   - 待办/任务面板、排队消息面板（`lXshSW_*`/`_7yHdaG_*`，磨砂底+可读文字）
   - 权限下拉菜单（点 Full access 弹出，`_list_`/`_root_`/`_viewport_`/`_item_`，不透明）
   - 提问弹窗（`M8wy4a_card`，不透明磨砂）
   - 背景图（文件+引用，走 `/api/dsh-uploads/glass-background` 路由；若 DSH webServer 接口/路由注册 API 变化，此路由可能 404 → 背景图不显示）
3. 若某项观感/配色不对 → **新类名变了**。让用户在对应元素「右键 → 检查」，把高亮元素及父级的 class 发我，把 `client/client.js` 里对应的 `[class*="..."]` 前缀更新成新类名（只改选择器，不动逻辑）。
4. 稳定项无需动：用 `data-slot-*` 的（状态栏）、注入 `<head>` 的 CSS、`data-dsh-theme` 属性、背景图文件存储（`~/.dsh-long-plugins/backgrounds/current.uri` 与 `glass.json` 的 `bgImage:"current"` 引用，不依赖 DSH 类名）。

### 各依赖类名的功能清单（升级后最可能失效）
| 功能 | 依赖类名 | 失效表现 |
|---|---|---|
| 工具名配色(Bash/Read/Edit/Write) | `o3BgMG_title` / `CY-8Ka_title` | 标签不变色 |
| Think 配色 | `QWLzLg_*` | Think 不琥珀 |
| 提问/弹窗不透明 | `M8wy4a_card` | 弹窗透明重叠 |
| 输入框 | `uV2eYG_*` | 重影/背景不随主题 |
| 耗时统计 | `osXY9a_*` / `p-xYUq_*` | 统计字淡/重影 |
| 待办/任务面板 | `lXshSW_*` | 面板透明/字淡 |
| 排队消息/等待任务 | `_7yHdaG_*` | 面板透明/字淡 |
| 权限下拉菜单 | `uV2eYG_card` 内 `_root_/_list_/_viewport_/_item_` | 菜单透明/字不清 |
| 左栏「新会话」 | `newSession` | 白底回来 |
| 背景图(文件+引用) | 服务器路由 `/api/dsh-uploads/glass-background` + `current.uri` | 若 DSH webServer 路由 API 变 → 背景图 404/不显示 |

## 硬性安全边界（必须遵守）
- **不主动 push / 打 tag / 发 Release**；需要发布版本时停下用 ask_user_question 等确认。
- 升级会重启 DSH 服务，可能中断当前会话——先向用户说明再执行。
- 若升级脚本/补丁脚本报"未找到待替换代码"（DSH 已改逻辑），停下提示用户，不强上。

## 常见坑速查
| 症状 | 原因 | 解决 |
|---|---|---|
| 升级后设置页 403 | 补丁1 被覆盖 | 重跑 apply-dsh-patches.sh |
| 升级后设置页"未暴露命名空间" | 补丁2 被覆盖 | 重跑 apply-dsh-patches.sh |
| 升级后提问窗口自己消失 | 心跳补丁(补丁3)被覆盖 | 重跑 apply-dsh-patches.sh 或装插件补丁脚本 |
| 升级后插件不显示 | 插件安装副本未同步 | 步骤 5 `pnpm install` |
| 升级后 RA-Span 观感/配色不对（输入框重影、标签不变色、弹窗透明、统计字淡等） | DSH 混淆类名变了 | 见 RA-Span 校准节：强刷 + 逐项检查，让用户右键给出新类名，更新 `client/client.js` 对应选择器 |
| 按钮全没了/界面异常 | 浏览器缓存了旧前端 | 强刷 Ctrl/Cmd+Shift+R |
