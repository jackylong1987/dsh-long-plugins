#!/bin/sh
# dsh-client-connection-heartbeat.sh — 给 DSH 核心下行 WebSocket 加心跳补丁
#
# 作用：反代/中间设备会按只读超时关停长期沉默的上游 WebSocket。提问/审批窗口
#       等待人类作答时 agent 循环被暂停、无帧流动，mux/host 流被切断后前端清空
#       「待回答问题」→ 窗口消失，只能靠刷新重连恢复。
# 修复：给 DSH 核心 dsh-client-connection 的下行 WebSocket 每 15s 只 ping 一次，
#       保持下游流量，让反代下等待作答的问题窗口不再消失。只 ping、不做 pong 判定、
#       不 terminate，避免后台/节流的手机端（pong 延迟）被误判为死连接而断开。
#
# 该补丁改的是 DSH 核心模块（不在本插件内）。装 dsh-long-plugins 时 install.sh 会
# 调本脚本自动重打；DSH 升级会覆盖核心 → 需重跑本脚本（或跑插件升级流程）。
#
# 幂等：可重复执行，已打过会跳过。
# 用法：sh dsh-client-connection-heartbeat.sh
set -e
echo "==> dsh-client-connection 心跳补丁"

# 定位 DSH 核心里 dsh-client-connection 的 index.js
# 优先用 npm root -g；找不到再探测常见全局路径。
NPM_ROOT="$(npm root -g 2>/dev/null || true)"
CANDIDATES=""
[ -n "$NPM_ROOT" ] && CANDIDATES="$NPM_ROOT/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js"
CANDIDATES="$CANDIDATES
/volume1/npm/global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js
/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js
$HOME/.dsh/../node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js"

IDX=""
for c in $CANDIDATES; do
  [ -f "$c" ] && IDX="$c" && break
done
if [ -z "$IDX" ]; then
  echo "错误：找不到 dsh-client-connection/lib/index.js（核心未装或路径不同）" >&2
  echo "  请确认 DSH 已安装，并把 $IDX 路径填入本脚本，或联系维护者。" >&2
  exit 1
fi
echo "    目标: $IDX"

# 幂等：已含心跳常量则跳过
if grep -q 'WEBSOCKET_HEARTBEAT_MS' "$IDX"; then
  echo "    已打过，跳过 ✓"
  exit 0
fi

# 待替换的原始代码未在 -> 提示人工核对
if ! grep -q 'var WebSocketDownlinks = class {' "$IDX"; then
  echo "    警告：未找到 WebSocketDownlinks 类，可能 DSH 已改逻辑，请人工核对" >&2
  exit 1
fi

cp "$IDX" "$IDX.bak-heartbeat-$(date +%Y%m%d-%H%M)"
python3 - "$IDX" <<'PY'
import sys
p = sys.argv[1]
T = "\t"
with open(p, encoding="utf-8") as f:
    s = f.read()

def rep(old, new, label):
    global s
    if old not in s:
        sys.stderr.write("    跳过(未找到): %s\n" % label); return
    if s.count(old) > 1:
        sys.stderr.write("    警告(出现%d次,跳过): %s\n" % (s.count(old), label)); return
    s = s.replace(old, new, 1)
    print("    已应用: %s" % label)

CONST_COMMENT = ("/** Downlink heartbeat interval: keep the browser streams from idling out under\n"
                 "* a reverse proxy, whose read timeout would drop a mux/host socket a paused\n"
                 "* agent leaves silent. Must stay below the proxy's read timeout. */\n")
rep("var WebSocketDownlinks = class {",
    CONST_COMMENT + "const WEBSOCKET_HEARTBEAT_MS = 15_000;\nvar WebSocketDownlinks = class {",
    "心跳常量")

o_ctor = ("host API supplying the typed event streams. */\n" + T + "constructor(api) {\n" + T + T + "this.api = api;")
p_ctor = ("host API supplying the typed event streams. */\n" + T + "constructor(api) {\n" + T + T + "this.api = api;\n" +
          T + T + "// A reverse proxy cuts an upstream WebSocket that stays silent for its\n" +
          T + T + "// read timeout; while a question or approval waits on the human the agent\n" +
          T + T + "// loop is paused and no frames flow, so the mux/host streams drop and the\n" +
          T + T + "// client clears its pending question. Pinging the clients every\n" +
          T + T + "// WEBSOCKET_HEARTBEAT_MS keeps downstream traffic flowing so the proxy does\n" +
          T + T + "// not idle the downlink out. The pings are only sent, never reaped: a\n" +
          T + T + "// throttled/backgrounded mobile client may answer a pong late, and\n" +
          T + T + "// terminating on a missed pong would reopen the very disconnect we are\n" +
          T + T + "// preventing — dead sockets are cleaned by the ws close/error path anyway.\n" +
          T + T + "this.heartbeat = setInterval(() => {\n" +
          T + T + T + "for (const socket of this.server.clients) {\n" +
          T + T + T + T + "if (socket.readyState === WebSocket.OPEN) socket.ping();\n" +
          T + T + T + "}\n" +
          T + T + "}, WEBSOCKET_HEARTBEAT_MS);\n" +
          T + T + "this.heartbeat.unref?.();")
rep(o_ctor, p_ctor, "心跳 interval")

o_close = (T + "async close() {\n" + T + T + "for (const socket of this.server.clients) socket.terminate();")
p_close = (T + "async close() {\n" + T + T + "clearInterval(this.heartbeat);\n" + T + T + "for (const socket of this.server.clients) socket.terminate();")
rep(o_close, p_close, "close 清理心跳")

with open(p, "w", encoding="utf-8") as f:
    f.write(s)
PY

echo "    已应用 ✓"
[ -f "$IDX" ] && node --check "$IDX" >/dev/null 2>&1 && echo "    语法检查 OK" || echo "    语法检查失败(请核对)" >&2
echo
echo "✅ 心跳补丁完成。请重启 dsh 并强刷浏览器。"
echo "   （DSH 升级会覆盖核心，需重跑本脚本）"
