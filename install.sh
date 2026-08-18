#!/bin/sh
# install.sh — 安装 / 更新 dsh-long-plugins 到指定 dsh profile
#
# dsh-long-plugins 是公开仓库（jackylong1987/dsh-long-plugins），通过
# file: 本地路径引用安装到 profile（与当前 NAS 一致的方式）。
#
# 用法：
#   ./install.sh <profile> <DSH_HOME> [插件本地目录]
#
# 参数：
#   profile         profile 名，默认 web
#   DSH_HOME        dsh 主目录，默认 $HOME/.dsh（NAS 上通常是 /volume1/dsh）
#   插件本地目录    默认 <DSH_HOME>/plugins/dsh-long-plugins
#
# 示例（NAS）：
#   ./install.sh web /volume1/dsh
#
# 脚本做的事：
#   1) clone 公开仓库到插件目录（已存在则 git pull 更新）
#   2) profile package.json 的 dependencies 加 file: 引用
#   3) profile dsh.profile.bundles 追加 dsh-long-plugins
#   4) pnpm install
#   5) 提示补充 cordis.patch.yml（trustedHosts / skillsRoot）并重启
set -e

PROFILE="${1:-web}"
DSH_HOME="${2:-$HOME/.dsh}"
PLUGIN_DIR="${3:-$DSH_HOME/plugins/dsh-long-plugins}"
REPO_URL="https://github.com/jackylong1987/dsh-long-plugins.git"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

[ -d "$PROFILE_DIR" ] || { echo "错误：profile 目录不存在 $PROFILE_DIR" >&2; exit 1; }

# 1) 拉取插件源码
if [ -d "$PLUGIN_DIR/.git" ]; then
  echo "== 更新已有插件目录 $PLUGIN_DIR =="
  git -C "$PLUGIN_DIR" -c http.version=HTTP/1.1 pull --ff-only origin main
else
  echo "== clone 插件到 $PLUGIN_DIR =="
  mkdir -p "$(dirname "$PLUGIN_DIR")"
  git -c http.version=HTTP/1.1 clone "$REPO_URL" "$PLUGIN_DIR"
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

# 5) 自动注入 profile 层的 patch 配置（若尚未存在）
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
if [ ! -f "$PATCH_FILE" ]; then
  echo "# dsh profile patch — composed over bundle layers" > "$PATCH_FILE"
fi
if grep -q "id: dsh-long-plugins" "$PATCH_FILE"; then
  echo "== $PATCH_FILE 已有 dsh-long-plugins 配置，跳过 =="
else
  cat >> "$PATCH_FILE" <<'PATCH_EOF'

# dsh-long-plugins：工作区输出文件 / 技能文档 / 余额（trustedHosts 复用内置 Web API 信任域）
- id: dsh-long-plugins
  config:
    priority: -10
    trustedHosts: !!js ctx.webRuntime.trustedHosts
    # 技能文档根目录；如不是 <DSH_HOME>/skills 请改成你的实际路径
    skillsRoot: !!js dshHomePath('skills')
PATCH_EOF
  echo "== 已追加 dsh-long-plugins 配置到 $PATCH_FILE =="
  echo "   （skillsRoot 默认 <DSH_HOME>/skills，如需改路径请编辑该文件）"
fi

echo
echo "✅ 安装完成。最后一步：重启 dsh web。"
echo "   NAS 上直接：/volume1/dsh/start.sh"
echo "   或手动用带 --expose-internals 和原有 --trusted-host 参数的方式启动。"
