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
| 按钮全没了/界面异常 | 浏览器缓存了旧前端 | 强刷 Ctrl/Cmd+Shift+R |
