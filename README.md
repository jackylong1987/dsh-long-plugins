# dsh-long-plugins

Merged plugin bundle for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH) Web:
upload manager, workspace **输出文件** section, **技能文档** (skill docs) browser, and
DeepSeek account balance — all in one installable plugin.

一个插件整合 DSH Web 的常用增强：上传管理、工作区「输出文件」面板、技能文档浏览、账户余额显示。

## Features / 功能

| Feature | 说明 |
|---|---|
| Upload manager | 输入框回形针按钮上传本地文件，待发送文件栏管理，设置面板「上传文件」（预览/下载/删除） |
| Workspace output files | 设置面板「输出文件」：按工作区文件夹分组、预览、**编辑/保存**、复制全部、**放大窗口** |
| Skill docs | 设置面板「技能文档」：按技能目录浏览 SKILL.md、弹窗预览、编辑/保存、复制、放大窗口 |
| Account balance | 输入框下方显示 DeepSeek 账户余额（60s 自动刷新） |
| md2docx | DSH 工具：把 Markdown 一键转成带页码页脚的 Word（`.docx`），标题/表格/加粗/列表/引用，生成的文件作为可点击交付物出现在消息里 |
| Turn ruler | 会话右侧轮次导航：3 个比例刻度（最早/中间/最新）+ 预览窗列出全部轮次标题，光标点亮、点击蓝色标记并定位会话，滚到顶部自动加载更早历史，手机端竖向把手打开预览窗 |
| Mobile layout | 手机端布局优化（输入栏、设置面板、主题选择、模型选择器） |

## Turn ruler / 轮次导航

- 桌面端：会话右侧 3 个比例刻度点，悬停打开「历史提问」预览窗
- 预览窗：列出全部已加载轮次的标题；光标悬停点亮该行，点击行以蓝色标记并定位主会话
- 滚动到预览窗顶部自动加载更早历史（内容锚定恢复焦点，无震动、不跳跃）；手机端触摸滚动已做性能优化
- 手机端：右边缘竖向把手点击打开预览窗（居中弹窗，✕ 关闭）

## Install / 安装

> ⚠️ **目录约定（先看再装）**：插件源码应放在 **`$DSH_HOME/plugins/dsh-long-plugins`**（DSH_HOME 默认 `~/.dsh`，即 `~/.dsh/plugins/dsh-long-plugins`）——这是**后续所有 DSH 插件的统一安装目录**；DSH 运行脚本（含 `restart-dsh.ps1`、`python3.exe` shim）放 **`$DSH_HOME/bin`**。**不要把插件/bin 放到你的工作目录或当前目录**（如 `C:\dsh\workspace`）。你的**工作目录**（名字不固定，可能叫 `workspace`/`jobs`/`project` 等）由你指定，其中 `upload` 子目录是上传根（`DSH_UPLOAD_DIR`）。这些目录缺失时请先创建（`mkdir -p`）。

### 方式 A：`install.sh`（Unix/Linux/NAS）
clone 到 DSH 插件目录（不是当前目录），然后运行脚本：
```sh
mkdir -p "$HOME/.dsh/plugins" "$HOME/.dsh/bin"
git clone https://github.com/jackylong1987/dsh-long-plugins.git "$HOME/.dsh/plugins/dsh-long-plugins"
cd "$HOME/.dsh/plugins/dsh-long-plugins"
./install.sh web "$HOME/.dsh" "$HOME/.dsh/plugins/dsh-long-plugins"
```
`install.sh` 会把 `file:` 依赖 + bundle 写入该 profile 的 `package.json`，`pnpm install`，追加 `cordis.patch.yml` 配置示例，**并自动把仓库内的部署 skill（`skill/dsh-long-plugins-install/SKILL.md`）复制到 `$DSH_HOME/skills/`** —— 之后在 DSH 会话里说"帮我安装 dsh-long-plugins"，agent 就会按这个 skill 指引执行。

### 方式 B：Windows（PowerShell，不走 install.sh）
`install.sh` 是 shell 脚本，Windows 用 DSH CLI + 绝对路径：
```powershell
mkdir -p "$env:USERPROFILE\.dsh\plugins" | Out-Null
mkdir -p "$env:USERPROFILE\.dsh\bin" | Out-Null
git clone https://github.com/jackylong1987/dsh-long-plugins.git "$env:USERPROFILE\.dsh\plugins\dsh-long-plugins"
dsh plugin --profile web add "file:$env:USERPROFILE\.dsh\plugins\dsh-long-plugins"
# 手动把 "dsh-long-plugins" 追加到 profile package.json 的 dsh.profile.bundles
```
> **Windows 注意**：① `python3` 常是 Windows Store 的坏 stub，md2docx 需要把真实 python 拷贝为 `python3.exe` 放进 `$env:USERPROFILE\.dsh\bin` 并加入 DSH 服务的 PATH；② 若 `github.com` 连不上，可用 codeload tarball：`Invoke-WebRequest https://codeload.github.com/jackylong1987/dsh-long-plugins/tar.gz/refs/heads/main -OutFile p.tgz` + `tar -xzf`，把内层目录移到 `$env:USERPROFILE\.dsh\plugins\dsh-long-plugins`。

### 方式 C：用 skill 安装（推荐，让 agent 按指引一键装）
**前置：把部署 skill 放进 DSH。** 如 `$DSH_HOME/skills/`（安装后见方式 A/B 已自动放好；若没有，手动放一次 skill 文件）。

**在 DSH 会话中：** 安装 `dsh-long-plugins`，agent 会加载该 skill 自动完成安装（关键决策点会停下来问你）。

### 手动（任意平台）
把 `file:` 依赖（**用绝对路径**）和 bundle 加进 `<DSH_HOME>/profiles/<profile>/package.json`：
```json
{
  "dependencies": { "dsh-long-plugins": "file:/home/me/.dsh/plugins/dsh-long-plugins" },
  "dsh": { "profile": { "bundles": ["dsh-long-plugins"] } }
}
```
然后 `pnpm install`。

### 工作目录 / 上传目录
- 用户指定**真实工作目录**（名字任意），在其下（或指定位置）设上传根：
  ```sh
  mkdir -p "/home/me/project/upload"
  export DSH_UPLOAD_DIR="/home/me/project/upload"    # 工作区根自动 = /home/me/project
  ```
  把它写进你的启动脚本（start.sh / restart-dsh.ps1），并确认 DSH 进程对 `DSH_UPLOAD_DIR` 可写。
- 目录缺失用 `mkdir -p` 补建，不要默认落到当前目录。

## Configuration / 配置

Add to the profile's `cordis.patch.yml`:

```yaml
- id: dsh-long-plugins
  config:
    priority: -10
    trustedHosts: !!js ctx.webRuntime.trustedHosts
    skillsRoot: !!js dshHomePath('skills')   # default <DSH_HOME>/skills; override with your path
```

- `trustedHosts` — required for the browser trust fence (same as the built-in Web API).
- `skillsRoot` — root directory browsed by the「技能文档」section. Defaults to `<DSH_HOME>/skills`.
- `md2docxScript` — (optional) override the Markdown→Word script path. Defaults to the bundled `lib/md2docx.py`.

## md2docx 工具（Markdown → Word）

Agent 可直接调用 `md2docx` 工具，把 Markdown 转成带页码页脚的 Word 文档：

- 输入 `input`（必填）：`.md` 文件绝对路径。
- 输出 `output`（可选）：`.docx` 路径；缺省为同目录同名 `.docx`。
- 生成的文件会作为可点击交付物卡片出现在消息里（复用插件内置预览/打开链路）。

**前置依赖：** 宿主需安装 `python3` 与 `python-docx`（`pip install python-docx`）。转换脚本随包分发（`lib/md2docx.py`），无需额外安装脚本；也无需 pandoc。

## Server routes / 服务端路由

```
/api/dsh-uploads/workspace               output files (grouped by folder)
/api/dsh-uploads/workspace-file          preview / download
/api/dsh-uploads/workspace-file/delete   delete (POST)
/api/dsh-uploads/workspace-file/save     save edited content (POST)
/dsh-skill-docs/skill-docs               skill docs list (grouped by skill)
/dsh-skill-docs/skill-doc                preview / download
/dsh-skill-docs/skill-doc/save           save (POST)
/dsh-token-usage/balance                 DeepSeek account balance proxy
```

Plus the upload manager's core routes (`/api/dsh-uploads`, download, preview).

## Important / 注意

- The web server must be started with `--expose-internals` (the bundled
  `start.sh` already does) so the plugin can be resolved from the profile.
- The bundle patch declares `inject: [webRuntime]` so `trustedHosts` is
  evaluated only after the web runtime mounts.

## License

MIT
