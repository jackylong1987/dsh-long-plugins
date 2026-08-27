# dsh-long-plugins

Merged plugin bundle for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH) Web:
upload manager, workspace **输出文件** section, top-bar **文件** browser with real **Word / PPT (docx / pptx) preview**,
**技能文档** (skill docs) browser, DeepSeek account balance, and **turn ruler (session navigation)** — all in one installable plugin.
Also ships an auto-repair install that relinks DSH core patches (reverse-proxy WebSocket heartbeat, upgrade relink).

一个插件整合 DSH Web 的常用增强：上传管理、顶栏「📂文件」工作区浏览 + 文件预览（Word、PPT、Excel 格式渲染）、工作区「输出文件」面板、技能文档浏览、账户余额显示。并自带修复安装，自动重连 DSH 核心补丁（反代 WebSocket 心跳、升级重连）。会话记录导航。

## Features / 功能

| Feature | 说明 |
|---|---|
| Upload manager | 输入框回形针按钮上传本地文件，待发送文件栏管理，设置面板「上传文件」（预览/下载/删除、**按日期筛选**、**文件名搜索**） |
| Workspace output files | 设置面板「输出文件」：按工作区文件夹分组、预览、**编辑/保存**、复制全部、**放大窗口**、**按日期筛选**、**文件名搜索** |
| Workspace file browser (顶栏「📂文件」) | 顶栏「📂文件」打开工作区/全部文件浏览，按文件夹分组，**文件夹可点击折叠**；顶栏**日期选择**（选哪天只看那天的文件，含「今天/全部」快捷键）+ **🔍 文件名搜索**（放大镜点击弹出搜索框，支持多词过滤，可与日期筛选叠加）；点文件名或「预览」在面板内预览，**Word (.docx) 用 docx-preview 浏览器端真实渲染（所见即所得）**；支持「←返回」「✕关闭」两层退出回列表，底部仅列表根时才整体退出；含下载/放大 |
| PowerPoint (.pptx) 预览 | 预览 `.pptx` 时用 **PptxViewJS 浏览器端真实渲染**（Canvas 逐页渲染、所见即所得），支持上一页/下一页翻页与**放大/缩小/适合宽度**；随包打包前端库 `client/vendor`（pptxviewjs / chart.js） |
| Skill docs | 设置面板「技能文档」：按技能目录浏览 SKILL.md、弹窗预览、编辑/保存、复制、放大窗口 |
| Account balance | 输入框下方显示 DeepSeek 账户余额（60s 自动刷新） |
| md2docx | DSH 工具：把 Markdown 一键转成带页码页脚的 Word（`.docx`），标题/表格/加粗/列表/引用，生成的文件作为可点击交付物出现在消息里 |
| Turn ruler | 桌面端会话右侧 3 个比例刻度点，悬停打开「历史提问」预览窗；预览窗列出全部已加载轮次的标题，光标悬停点亮该行，点击行以蓝色标记并定位主会话；滚动到预览窗顶部自动加载更早历史（内容锚定恢复焦点，无震动、不跳跃），手机端触摸滚动已做性能优化；手机端右边缘竖向把手点击打开预览窗（居中弹窗，✕ 关闭） |
| Auto-repair install | 安装时自动重打 DSH 核心补丁：反代 WebSocket 心跳（修复提问窗口自己消失）、升级后重连 |
| Mobile layout | 手机端布局优化（输入栏、设置面板、主题选择、模型选择器） |
| Drag & drop upload | 拖任意文件到会话框直接附加为「待发送」卡片（走与回形针同一上传管线）；全屏虚线投掷遮罩提示；消除 DSH 核心"仅支持 PNG/JPG/WebP/GIF 格式的图片"误报 |

## Install / 安装

> **目录约定**：插件放 `$DSH_HOME/plugins/dsh-long-plugins`，DSH 运行脚本（`bin`）放 `$DSH_HOME/bin`，都别放工作目录。你的**工作目录**（名字任意）由用户指定，其下 `upload` 为上传根（`DSH_UPLOAD_DIR`）。目录缺失用 `mkdir -p` 补建。

### 方式 A：`install.sh`（Unix/Linux/NAS）
```sh
git clone https://github.com/jackylong1987/dsh-long-plugins.git "$HOME/.dsh/plugins/dsh-long-plugins"
cd "$HOME/.dsh/plugins/dsh-long-plugins"
./install.sh web "$HOME/.dsh" "$HOME/.dsh/plugins/dsh-long-plugins"
```

### 方式 B：Windows（PowerShell）
```powershell
git clone https://github.com/jackylong1987/dsh-long-plugins.git "$env:USERPROFILE\.dsh\plugins\dsh-long-plugins"
dsh plugin --profile web add "file:$env:USERPROFILE\.dsh\plugins\dsh-long-plugins"
# 把 "dsh-long-plugins" 追加到 profile package.json 的 dsh.profile.bundles
```
Windows 不跑 `install.sh`，skill 需手动放到 `$env:USERPROFILE\.dsh\skills\`。

### 方式 C：用 skill 安装（推荐）
前置把 skill 放进 `$DSH_HOME/skills/`。之后在 DSH 会话中：安装 `dsh-long-plugins`，agent 按 skill 指引自动完成。

### 手动
在 `<DSH_HOME>/profiles/<profile>/package.json` 加 `file:` 依赖与 bundle，然后 `pnpm install`：
```json
{ "dependencies": { "dsh-long-plugins": "file:/home/me/.dsh/plugins/dsh-long-plugins" }, "dsh": { "profile": { "bundles": ["dsh-long-plugins"] } } }
```

### 工作目录 / 上传目录
按你的工作目录设上传根（目录缺失 `mkdir -p` 补建），并写进启动脚本、确认可写：
```sh
mkdir -p "/home/me/project/upload"
export DSH_UPLOAD_DIR="/home/me/project/upload"   # 工作区根 = /home/me/project
```

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
- `excludedWorkspaceNames` — (optional) extra file names to hide from the workspace file browse / 输出文件 (deployment & plugin config clutter). The plugin already hides a default blocklist (`index.html`, `serve.log`, `docker-compose.*`, `package*.json`, `*.log`, `*.lock`, `Dockerfile`, …); add your own here, e.g. `excludedWorkspaceNames: ['jackylong1987__dsh-long-plugins.yml']`. This only hides the listed names — AI-generated `.yml`/`.html`/`.json` reports still show.

## md2docx 工具（Markdown → Word）

Agent 可直接调用 `md2docx` 工具，把 Markdown 转成带页码页脚的 Word 文档：

- 输入 `input`（必填）：`.md` 文件绝对路径。
- 输出 `output`（可选）：`.docx` 路径；缺省为同目录同名 `.docx`。
- 生成的文件会作为可点击交付物卡片出现在消息里（复用插件内置预览/打开链路）。

**前置依赖：** 宿主需安装 `python3` 与 `python-docx`（`pip install python-docx`）。转换脚本随包分发（`lib/md2docx.py`），无需额外安装脚本；也无需 pandoc。

## Server routes / 服务端路由

```
/api/dsh-uploads/workspace               output files (grouped by folder)
/api/dsh-uploads/workspace-browse        workspace file browser (top-bar「📂文件」)
/api/dsh-uploads/workspace-file          preview / download
/api/dsh-uploads/workspace-file/delete   delete (POST)
/api/dsh-uploads/workspace-file/save     save edited content (POST)
/api/dsh-uploads/docx-preview            Word (.docx) real render page (browser-side docx-preview)
/api/dsh-uploads/docx-preview-asset       serve docx-preview / jszip vendor libs
/api/dsh-uploads/xlsx-preview             Excel (.xlsx) static render page (browser-side SheetJS → table)
/api/dsh-uploads/xlsx-preview-asset        serve SheetJS (xlsx) vendor lib
/dsh-skill-docs/skill-docs               skill docs list (grouped by skill)
/dsh-skill-docs/skill-doc                preview / download
/dsh-skill-docs/skill-doc/save           save (POST)
/dsh-token-usage/balance                 DeepSeek account balance proxy
```

Plus the upload manager's core routes (`/api/dsh-uploads`, download, preview).

## License

MIT

## Third-party libraries / 第三方开源库

本插件在浏览器端打包了以下开源库用于文件预览：

- `docx-preview`(docxjs) — Word 真实预览 — **Apache-2.0**
- `JSZip` — 解压 Office 包 — **MIT**（或 GPLv3，本项目按 MIT 使用）
- `Chart.js` — PPT 内图表 — **MIT**
- `PptxViewJS` — PowerPoint 真实预览 — **MIT**
- `SheetJS`(xlsx.full.min.js) — Excel 真实预览 — **Apache-2.0**
- npm 依赖：`mammoth`（BSD-2-Clause）、`exceljs`（MIT）

完整的版权声明与来源见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## Changelog / 更新记录

### v1.3.10
- 新增 `.xlsx` 浏览器端预览：用 SheetJS 解析并显示为表格（行列标头、合并单元格、多工作表切换），预览支持 − / ＋ / 适合宽度缩放，默认整表适配。
- 工作区浏览、工作区文件、上传文件列表中的 `.xlsx` 均接入该预览页；在浏览器端处理，不占用 NAS 本地资源。
- `.csv` / `.tsv` 保留表格预览（首行作表头）。

