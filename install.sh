#!/bin/sh
# install.sh — 安装 / 更新 dsh-long-plugins 到指定 dsh profile
#
# dsh-long-plugins 是私有仓库（jackylong1987/dsh-long-plugins），通过
# file: 本地路径引用安装到 profile（与当前 NAS 一致的方式）。
#
# 用法：
#   ./install.sh <profile> <DSH_HOME> <GITHUB_TOKEN> [插件本地目录]
#
# 参数：
#   profile         profile 名，默认 web
#   DSH_HOME        dsh 主目录，默认 $HOME/.dsh（NAS 上通常是 /volume1/dsh）
#   GITHUB_TOKEN    有 repo 权限的 GitHub token（用于 clone 私有仓库）
#   插件本地目录    默认 <DSH_HOME>/plugins/dsh-long-plugins
#
# 示例（NAS）：
#   ./install.sh web /volume1/dsh ghp_xxx
#
# 脚本做的事：
#   1) clone 私有仓库到插件目录（已存在则 git pull 更新）
#   2) profile package.json 的 dependencies 加 file: 引用
#   3) profile dsh.profile.bundles 追加 dsh-long-plugins
#   4) pnpm install
#   5) 提示补充 cordis.patch.yml（trustedHosts / skillsRoot）并重启
set -e

PROFILE="${1:-web}"
DSH_HOME="${2:-$HOME/.dsh}"
TOKEN="${3:-}"
PLUGIN_DIR="${4:-$DSH_HOME/plugins/dsh-long-plugins}"
REPO_URL="https://github.com/jackylong1987/dsh-long-plugins.git"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

[ -n "$TOKEN" ] || { echo "错误：缺少 GITHUB_TOKEN 参数" >&2; exit 1; }
[ -d "$PROFILE_DIR" ] || { echo "错误：profile 目录不存在 $PROFILE_DIR" >&2; exit 1; }

# 1) 拉取插件源码
if [ -d "$PLUGIN_DIR/.git" ]; then
  echo "== 更新已有插件目录 $PLUGIN_DIR =="
  git -C "$PLUGIN_DIR" -c http.version=HTTP/1.1 pull --ff-only origin main
else
  echo "== clone 插件到 $PLUGIN_DIR =="
  mkdir -p "$(dirname "$PLUGIN_DIR")"
  git -c http.version=HTTP/1.1 clone "https://x-access-token:${TOKEN}@${REPO_URL#https://}" "$PLUGIN_DIR"
fi

# 2) 检查 node 可用
NODE_BIN="$(command -v node || echo /volume1/@appstore/Node.js_v22/usr/local/bin/node)"
PNPM_BIN="$(command -v pnpm || echo /volume1/npm/global/bin/pnpm)"
export PATH="$(dirname "$NODE_BIN"):$(dirname "$PNPM_BIN"):$PATH"

# 3) profile package.json 注入依赖
cd "$PROFILE_DIR"
if [ -f package.json ]; then
  node -e "
    const fs = require('fs');
    const path = '$PLUGIN_DIR';
    const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    p.dependencies = p.dependencies || {};
    p.dependencies['dsh-long-plugins'] = 'file:' + path;
    p.dsh = p.dsh || {};
    p.dsh.profile = p.dsh.profile || {};
    p.dsh.profile.bundles = p.dsh.profile.bundles || [];
    if (!p.dsh.profile.bundles.includes('dsh-long-plugins')) p.dsh.profile.bundles.push('dsh-long-plugins');
    fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
    console.log('package.json 已更新：dsh-long-plugins = file:' + path);
  "
else
  echo "错误：profile 没有 package.json" >&2; exit 1
fi

# 4) 安装
echo "== pnpm install =="
"$PNPM_BIN" install

echo
echo "✅ 安装完成。还差两步："
echo "  1) 确认 $PROFILE_DIR/cordis.patch.yml 里有："
echo "     - id: dsh-long-plugins"
echo "       config:"
echo "         priority: -10"
echo "         trustedHosts: !!js ctx.webRuntime.trustedHosts"
echo "         skillsRoot: <你的技能目录，如 /volume1/homes/dsh/skills>"
echo "  2) 用带 --expose-internals 和原有 --trusted-host 参数的方式重启 dsh web。"
