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
| Turn ruler | 会话右侧轮次导航：3 个比例刻度（最早/中间/最新）+ 预览窗列出全部轮次标题，光标点亮、点击蓝色标记并定位会话，滚到顶部自动加载更早历史，手机端竖向把手打开预览窗 |
| Mobile layout | 手机端布局优化（输入栏、设置面板、主题选择、模型选择器） |

## Turn ruler / 轮次导航

- 桌面端：会话右侧 3 个比例刻度点，悬停打开「历史提问」预览窗
- 预览窗：列出全部已加载轮次的标题；光标悬停点亮该行，点击行以蓝色标记并定位主会话
- 滚动到预览窗顶部自动加载更早历史（内容锚定恢复焦点，无震动、不跳跃）；手机端触摸滚动已做性能优化
- 手机端：右边缘竖向把手点击打开预览窗（居中弹窗，✕ 关闭）

## Install / 安装

Clone anywhere, then run `install.sh` against a DSH profile:

```sh
git clone https://github.com/jackylong1987/dsh-long-plugins.git
cd dsh-long-plugins
./install.sh web "$HOME/.dsh"      # profile, DSH_HOME
```

`install.sh` adds the `file:` dependency and bundle entry to the profile's
`package.json`, then runs `pnpm install`.

### Manual / 手动

Add to `<DSH_HOME>/profiles/<profile>/package.json`:

```json
{
  "dependencies": { "dsh-long-plugins": "file:/path/to/dsh-long-plugins" },
  "dsh": { "profile": { "bundles": ["dsh-long-plugins"] } }
}
```

Then `pnpm install`.

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
