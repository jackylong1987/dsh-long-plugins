---
name: dsh-web-start-panel-install
description: 在一台已装好 DSH 的机器上生成并启动 web 启动面板（纯 Node、无依赖），网页点「启动/重启 dsh web」即可拉起或重启 DSH。自动探测 DSH_HOME/Node 与目标平台（Windows/NAS）、写 server.mjs / start.sh（或 start-dsh.cmd）/ start-panel.sh（或 start-panel.cmd）、启动并验证；重启由用户手动点按钮。用户说「生成启动面板」「装启动面板」「重装后建面板」「web 启动面板」时调用。
whenToUse: 用户要求生成/安装 DSH web 启动面板，或重装后重建该面板时调用。
---

# dsh-web-start-panel-install

# DSH 启动面板（web start panel）安装/生成

作为部署助手，在一台**已装好 DSH** 的机器上生成并启动一个极简 **web 启动面板**：纯 Node、无依赖，一个网页上点「启动/重启 dsh web」即可拉起重启 DSH。**支持 Windows 与 NAS/Linux**（本 skill 以 NAS/Linux 为默认完整示例，Windows 差异在「关键差异」表与「Windows 关键」处标注）。

> 本 skill 是**操作指引**，由你（agent）在目标机器上执行。真实 shell/文件权限来自该机器；凡**远程 push / 打 tag / 发 Release** 一律停下，等用户明确确认（硬性安全边界）。

## 前置检查（先探测，再动手）

执行前先探测环境，**不要假设本机路径**。逐项确认，缺了就停下让用户填：

```
dsh --version                      # 是否装了 DSH；没有则提示先按官方文档装 DSH
echo "$DSH_HOME"                   # 未设则查 /volume1/dsh、$HOME/.dsh 常见位置
ls -d <候选>/profiles/web          # 定位 profile 目录（一般 web）
node --version                     # 需 >=22（面板用原生 fetch / --expose-internals 依赖）
where node ; ls <node套件>/bin/node # 找 node 真实路径；找不到让用户给
```

- **node 路径**：Windows 常为 `C:\Program Files\nodejs\node.exe`；NAS 常为 `/volume1/@appstore/Node.js_vXX/usr/local/bin/node`。以探测值为准，不要写死。
- **DSH_HOME**：默认 `$HOME/.dsh`（Windows/`D:\.dsh`）或 `/volume1/dsh`（NAS），以用户实际值为准。
- **profile**：默认 `web`；用 `dsh --profile <p> --dump-config` 核对。
- **dsh web 端口**：默认 `3080`（面板做健康检查与 PID 检测用）。

## 文件构成（部署目录 `$DSH_HOME/web-start/`）

| 文件 | 作用 | 平台差异 |
|---|---|---|
| `server.mjs` | 面板服务（纯 Node，无依赖），默认监听 `0.0.0.0:3456`（局域网可访问；设 `DSH_START_HOST=127.0.0.1` 仅本机） | **核心差异点**：`/api/start` 的 spawn、`findDshPid`、`START_SCRIPT` 路径 |
| `start-dsh.cmd` | 「启动/重启 dsh web」按钮调用的脚本：停旧 dsh → 带正确环境启动 | Windows 用 `.cmd`；NAS 用 `start.sh` |
| `start-panel.cmd` | 面板自身 start/stop/status | Windows 用 `.cmd`；NAS 用 `start-panel.sh` |

## 目录约定（先确认，再动手）

- 面板部署目录 = **`$DSH_HOME/web-start/`**（缺失则创建，不要落到用户工作目录/当前目录）。
- 面板只做「启动 + 状态」，不提供停止；点「启动」只会执行启动脚本（NAS 为 `start.sh`、Windows 为 `start-dsh.cmd`，脚本内部会**先停旧再启新**），不会执行任意命令。
- 用户工作目录与上传目录与本面板无关；启动脚本（`start.sh`/`start-dsh.cmd`）里会带上 `DSH_UPLOAD_DIR`，以符合 dsh-long-plugins 的目录约定（若已配置）。

### 「打开 dsh 会话界面」链接（可选；本机面板未内置）
本机运行的面板 = 「启动按钮 + 状态灯」，**没有**单独的「打开 dsh 会话界面」链接——页脚只显示局域网/本机地址，供人记着地址去开。若想面板醒目地直达 dsh 会话界面（多设备/反代访问时方便），按下述**可选**增强实现：

- 在 `server.mjs` 加一个 `DSH_OPEN_URL`（独立于健康检查地址）：`const DSH_OPEN_URL = process.env.DSH_OPEN_URL ?? "http://你的域名或局域网IP:3080";`
- 在 PAGE 的 `.card` 里加：`<div class="open" style="margin-top:16px"><a id="open" href="${DSH_OPEN_URL}" target="_blank" rel="noopener" style="color:#93c5fd;text-decoration:none;font-size:14px;opacity:.35;pointer-events:none">打开 dsh 会话界面</a></div>`
- 在 JS 里取 `open` 元素并加一个 `setOpen(on)` 辅助函数，在 `poll()` 中随 `running` 切换 `open.style.opacity`/`pointerEvents`（运行中才可点）。
- 生成前可用 `ask_user_question` 让用户填**实际能访问到的地址**（反代域名如 `https://你的域名` / 局域网 IP 如 `http://192.168.x.x:3080` / 仅本机 `http://127.0.0.1:3080`），或直接把该值写进 `DSH_OPEN_URL`。

**注意**：健康检查地址 `DSH_WEB_URL` 保持 `http://127.0.0.1:3080/` 不变（后端本机探测必须用它），与 `DSH_OPEN_URL` **解耦**——这样从反代域名访问面板时，「打开 dsh 会话界面」也能跳到正确地址，而不是跳到访问者自己的 127.0.0.1。

## 关键：Windows 与 NAS/Linux 的差异

下面 `server.mjs` 是 NAS/Linux 写法，**Windows 必须按下表改这三处**，否则面板按钮无效/状态假：

| 项 | NAS/Linux | Windows |
|---|---|---|
| `/api/start` 启动 | `spawn("sh", [START_SCRIPT], {detached:true, stdio:"ignore"})` | 让 `server.mjs` 直接 `spawn(NODE, [...], {detached:true, stdio:"ignore", windowsHide:true})`，先 `killDsh()` → `waitPortFree(3080)` → 再启动；**勿**用 `spawn(.cmd,{shell:true})`（见「Windows 关键」） |
| `findDshPid` | `spawn("sh", ["-c", "ps aux \\| grep -F 'bin.js web' \\| grep -v grep …"])` | `spawn("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile","-Command","Get-CimInstance …"])` 查 node 进程 |
| `START_SCRIPT` 默认 | `/volume1/dsh/start.sh` | `D:\.dsh\web-start\start-dsh.cmd` |
| 面板管理脚本 | `start-panel.sh`（chmod +x，`start|stop|status`，用 `ps`/`kill`） | `start-panel.cmd`（`start|stop|status`，用 `taskkill`/PowerShell） |

> 可用环境变量覆盖（面板已支持）：`DSH_START_PORT`（默认 3456）、`DSH_START_HOST`（NAS 示例默认 `0.0.0.0`；只留本机设 `127.0.0.1`）、`DSH_START_SCRIPT`。

> ⚠️ **Windows 关键（实测过的坑）**：`/api/start` 用 `spawn(START_SCRIPT, {shell:true})` 去跑 `.cmd`，或手动 `start /b 跑 .cmd` 拉起 dsh，**会踩两个坑**——① cmd 控制台一关就把子进程带走；② 不等 3080 端口释放就绑端口 → `EADDRINUSE`，新 dsh 起来即崩、面板一直「正在启动」。**Windows 建议让 `server.mjs` 自己直接 `spawn(NODE, ["--expose-internals","--max-old-space-size=8192", DSH_BIN, "web", "--port","3080"], {detached:true, stdio:"ignore", windowsHide:true, env:{...process.env, DSH_HOME, DSH_WORKSPACE, DSH_UPLOAD_DIR, NODE_OPTIONS:"", PATH: DSH_PYBIN+";"+...}})`**，且 `/api/start` 内部**先 `killDsh()` → 轮询 `waitPortFree(3080)` → 再启动**，`start-dsh.cmd` 仅作手动备用。`DSH_UPLOAD_DIR`/`DSH_WORKSPACE` 等由启动脚本显式传入 env，保证输出文件目录正确。NAS 版用 `start.sh`（内建停旧+健康检查）已足够可靠，可沿用 `spawn("sh",[START_SCRIPT],…)`。

## 安装步骤

### 1. 确保部署目录存在
```sh
# Windows / NAS 通用：$DSH_HOME/web-start/ 缺失则创建
mkdir -p "$DSH_HOME/web-start"
```

### 2. 生成 `server.mjs`（NAS/Linux 版，完整内容）
在 `$DSH_HOME/web-start/server.mjs` 写入以下内容。**改默认 `START_SCRIPT`/端口/健康检查地址以匹配本机**（下文中已标 `← 改我` 的地方）：

```js
#!/usr/bin/env node
/**
 * dsh 启动面板 — 一个极简网页，点击按钮即可启动 dsh web（类似 WOL 面板）。
 *
 * 端点：
 *   GET  /            启动面板页面
 *   GET  /api/status  {"running": true|false, "pid": <node pid>|null, "checkedAt": ...}
 *   POST /api/start   触发 <START_SCRIPT>（立即返回；页面轮询状态直到 running）
 *
 * 监听：默认 0.0.0.0:3456（局域网可访问；页脚地址由 lanIp() 自动探测，可用 DSH_START_LAN 覆盖）。
 * 可用环境变量覆盖：DSH_START_HOST / DSH_START_PORT / DSH_START_SCRIPT / DSH_START_LAN。
 * 安全提示：局域网内任何人都能点"启动"按钮；如需限制请挂反代+认证，
 * 或把 DSH_START_HOST 设回 127.0.0.1。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

const PORT = Number(process.env.DSH_START_PORT ?? 3456);
const HOST = process.env.DSH_START_HOST ?? "0.0.0.0";
// ← 改我：本机已有的 dsh 启动脚本（面板只执行它，不执行任意命令），NAS 复用现有 start.sh
const START_SCRIPT = process.env.DSH_START_SCRIPT ?? "/volume1/dsh/start.sh";
const DSH_WEB_URL = "http://127.0.0.1:3080/";
// ← 改我：检测 dsh 是否运行的进程特征串
const WEB_PID_PATTERN = "bin.js web";

function dshRunning() {
	return new Promise((resolve) => {
		const req = fetch(DSH_WEB_URL, { signal: AbortSignal.timeout(2000) });
		req.then(() => resolve(true), () => resolve(false));
	});
}

function findDshPid() {
	return new Promise((resolve) => {
		spawn("sh", ["-c", `ps aux | grep -F '${WEB_PID_PATTERN}' | grep -v grep | awk '{print $2}' | head -1`])
			.stdout.on("data", (d) => resolve(String(d).trim() || null))
			.on("error", () => resolve(null));
	});
}

// 自动探测局域网 IP（跳过 docker/容器/虚拟网卡，取第一个剩下的非回环 IPv4；任何 NAS 都适用，不写死）。
// 仍可能取到不想要的网卡，可用 DSH_START_LAN 覆盖成真正对外的局域网 IP。
function lanIp() {
	const skip = /^(docker|br-|veth|virbr|tailscale|zt|tun)/;
	let lan = null;
	for (const [name, list] of Object.entries(networkInterfaces())) {
		if (skip.test(name)) continue;
		for (const it of list ?? []) {
			if (it.family === "IPv4" && !it.internal) { lan = it.address; break; }
		}
		if (lan) break;
	}
	return lan;
}
// 面板页脚展示的局域网地址（可覆盖，避免误选 docker/tailscale 网卡）
const LAN = process.env.DSH_START_LAN ?? lanIp();

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 启动面板</title>
<style>
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background:#0f1720; color:#e5e7eb; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  .card { background:#1a2530; border:1px solid #2c3a47; border-radius:14px; padding:36px 44px; text-align:center; box-shadow:0 8px 30px rgba(0,0,0,.4); }
  h1 { font-size:20px; margin:0 0 8px; font-weight:600; }
  .status { font-size:14px; color:#9ca3af; margin-bottom:26px; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; vertical-align:middle; }
  .dot.on { background:#22c55e; box-shadow:0 0 8px #22c55e; }
  .dot.off { background:#ef4444; box-shadow:0 0 8px #ef4444; }
  .dot.busy { background:#f59e0b; box-shadow:0 0 8px #f59e0b; animation:blink 1s infinite; }
  @keyframes blink { 50% { opacity:.3; } }
  button { background:#2563eb; color:#fff; border:none; border-radius:10px; font-size:16px; padding:14px 44px; cursor:pointer; transition:background .15s; }
  button:hover { background:#1d4ed8; }
  button:disabled { background:#374151; cursor:not-allowed; }
  .msg { margin-top:18px; font-size:13px; color:#f59e0b; min-height:18px; }
  .ok { color:#22c55e !important; }
  .err { color:#ef4444 !important; }
  .hint { margin-top:22px; font-size:12px; color:#6b7280; }
</style>
</head>
<body>
<div class="card">
  <h1>DSH 启动面板</h1>
  <div class="status"><span class="dot" id="dot"></span><span id="text">检测中…</span></div>
  <button id="btn" disabled>启动 dsh web</button>
  <div class="msg" id="msg"></div>
  <div class="hint">局域网：${LAN ? `http://${LAN}:${PORT} · ` : ""}本机：http://127.0.0.1:${PORT}</div>
</div>
<script>
const dot=document.getElementById('dot'),text=document.getElementById('text'),
      btn=document.getElementById('btn'),msg=document.getElementById('msg');
let last='unknown';
async function poll(){
  try{
    const r=await fetch('/api/status'); const s=await r.json();
    if(s.running){ dot.className='dot on'; text.textContent='dsh web 运行中'+(s.pid?'（PID '+s.pid+'）':''); btn.disabled=false; btn.textContent='重启 dsh web'; }
    else { dot.className='dot off'; text.textContent='dsh web 未运行'; btn.disabled=false; btn.textContent='启动 dsh web'; }
    if(last==='starting'&&s.running){ msg.className='msg ok'; msg.textContent='✅ dsh web 已就绪'; last='running'; }
    if(last==='starting'&&!s.running){ msg.className='msg'; msg.textContent='⏳ 正在重启/启动中…'; }
  }catch(e){ dot.className='dot off'; text.textContent='无法连接面板服务'; }
}
btn.onclick=async()=>{
  const isRun=btn.textContent.indexOf('重启')===0;
  if(isRun&&!confirm('确认重启 dsh web？正在进行的对话会被中断，重启约 20 秒。'))return;
  btn.disabled=true; msg.className='msg'; msg.textContent=isRun?'⏳ 正在重启…':'⏳ 正在启动…'; last='starting';
  try{ await fetch('/api/start',{method:'POST'}); }
  catch(e){ msg.className='msg err'; msg.textContent='❌ 触发失败：'+e; btn.disabled=false; last='unknown'; }
};
poll(); setInterval(poll,2000);
</script>
</body>
</html>`;

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
	if (req.method === "GET" && url.pathname === "/") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(PAGE);
		return;
	}
	if (req.method === "GET" && url.pathname === "/api/status") {
		dshRunning().then(async (running) => {
			const pid = running ? await findDshPid() : null;
			res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(JSON.stringify({ running, pid, checkedAt: Date.now() }));
		});
		return;
	}
	if (req.method === "POST" && url.pathname === "/api/start") {
		console.log(new Date().toISOString(), "start triggered");
		const child = spawn("sh", [START_SCRIPT], { detached: true, stdio: "ignore" });
		child.unref();
		res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify({ ok: true, script: START_SCRIPT }));
		return;
	}
	res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	res.end("not found");
});

server.listen(PORT, HOST, () => {
	console.log(`dsh start panel: http://${HOST}:${PORT}`);
});
```

> 本机（NAS/Linux）基准版要改的地方就是代码里 `改我` 标记处，其余照抄即可：
> - `START_SCRIPT`：指向本机已有的 `start.sh`（如 `/volume1/dsh/start.sh`）；目标机没有才按第 3 步 NAS 版生成。
> - `WEB_PID_PATTERN`：dsh 进程命令行特征串（默认 `bin.js web`，与 `start.sh` 里的 `grep` 一致）。
> - 页脚局域网地址已由 `lanIp()` 自动探测、不再写死（任何 NAS 都适用）；仅在多网卡/反代/取错网卡时用环境变量 `DSH_START_LAN=` 覆盖成真正对外的地址。
> - node / dsh 入口路径不在本文件里，在第 3、4 步的 `start.sh` / `start-panel.sh` 中。

> **Windows 版差异**：`findDshPid` 用 PowerShell（`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bin\\.js' -and $_.CommandLine -match '\\bweb\\b' }` 查进程）；`/api/start` **不要**用 `spawn` 去跑 `start-dsh.cmd`（即 `spawn(file,{shell:true})` 那种写法，见「Windows 关键」），而是让 `server.mjs` 直接 `spawn(NODE, [...], {detached:true, stdio:"ignore", windowsHide:true})`，内部先 `killDsh()` → 轮询 `waitPortFree(3080)` → 再启动；`START_SCRIPT` 默认改为 `$DSH_HOME\web-start\start-dsh.cmd`，`start-dsh.cmd` 仅作手动备用。

### 3. 生成 `start-dsh.cmd`（面板要执行的 dsh 启动脚本，含正确环境）
在 `$DSH_HOME/web-start/start-dsh.cmd` 写入（**改 DSH_HOME / DSH_UPLOAD_DIR / Python PATH 以匹配本机**）：

```bat
@echo off
REM dsh web 启动脚本 (面板调用): 停旧 dsh -> 带正确环境启动
set DSH_HOME=D:\.dsh
set DSH_UPLOAD_DIR=D:\dsh\workspace\upload
set PATH=C:\Users\Jackypc\AppData\Local\Programs\Python\Python312;%PATH%
set NODE_OPTIONS=
REM 停旧 dsh web (仅杀匹配 bin.js + web 的 node)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'bin\.js' -and $_.CommandLine -match '\bweb\b' } | ForEach-Object { Write-Host ('  停止 PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
cd /d D:\dsh\workspace
start "" /b "C:\Program Files\nodejs\node.exe" --expose-internals --max-old-space-size=8192 "C:\Users\Jackypc\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" web
```

> **NAS/Linux 版**：**优先复用目标机已有的 `start.sh`**（把 `server.mjs` 的 `START_SCRIPT` 指向它，如 `/volume1/dsh/start.sh`），不要重新生成极简版——可靠的 `start.sh` 应含：精确 kill 旧进程、`setsid + nohup` 双层脱离 + `</dev/null`、`--host 127.0.0.1`、`--trusted-host ...`、`DSH_UPLOAD_*` 上限、health check 等待 HTTP 200。`--expose-internals` 必须有，否则插件路由 404。仅当目标机没有 `start.sh` 时才生成，起步例如：`setsid nohup <node> --expose-internals --max-old-space-size=8192 <dsh 入口> web --port 3080 &`（并补上 kill 旧进程 + health check）。**换机必改**：`--host`/`--trusted-host`、`DSH_UPLOAD_DIR`、node 与 dsh 入口路径都要按目标机设，别照抄本机的 IP/域名/路径。

### 4. 生成 `start-panel.cmd`（面板自身 start/stop/status）
在 `$DSH_HOME/web-start/start-panel.cmd` 写入：

```bat
@echo off
REM dsh 启动面板 (Windows) 管理: start-panel.cmd [start|stop|status]
set NODE=C:\Program Files\nodejs\node.exe
set SERVER=D:\.dsh\web-start\server.mjs
set LOGFILE=D:\.dsh\web-start\server.log
set PIDFILE=D:\.dsh\web-start\server.pid
set PORT=%DSH_START_PORT%
if "%PORT%"=="" set PORT=3456

set ACTION=%1
if "%ACTION%"=="" set ACTION=status
if /i "%ACTION%"=="start" goto :start
if /i "%ACTION%"=="stop"  goto :stop
if /i "%ACTION%"=="status" goto :status
echo 用法: start-panel.cmd [start^|stop^|status]
exit /b 1

:start
echo == 启动 dsh 启动面板 (port %PORT%) ==
if exist "%PIDFILE%" ( set /p OLDPID=<"%PIDFILE%" & taskkill /PID %OLDPID% /F /T >nul 2>&1 )
start "" /b "%NODE%" "%SERVER%" > "%LOGFILE%" 2>&1
echo started. 面板: http://127.0.0.1:%PORT%
exit /b 0

:stop
echo == 停止 dsh 启动面板 ==
if exist "%PIDFILE%" ( set /p OLDPID=<"%PIDFILE%" & taskkill /PID %OLDPID% /F /T >nul 2>&1 & del "%PIDFILE%" >nul 2>&1 )
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'web-start\\server\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo stopped.
exit /b 0

:status
echo == dsh 启动面板 状态 ==
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'web-start\\server\.mjs' } | Select-Object -First 1; if($p){ '运行中 PID ' + $p.ProcessId } else { '未运行' }"
exit /b 0
```

> **NAS/Linux 版**：换 `start-panel.sh`（`chmod +x`；用 `start|stop|status`，`SERVER`/`LOG`/`PIDFILE` 用 `$DSH_HOME/web-start/`，`NODE` 用探测到的 node 绝对路径）。**别在脚本里写死局域网 IP**：启动/状态输出的局域网地址用动态获取（如 `ip route get 1.1.1.1 | awk '{print $7}'` 或 `hostname -I | awk '{print $1}'`），取不到就只打 `http://127.0.0.1:$PORT`；也可读 `DSH_START_LAN`。

### 5. 启动面板并验证
```sh
# Windows：在独立终端
D:\.dsh\web-start\start-panel.cmd start
# 或直接后台起：
"C:\Program Files\nodejs\node.exe" D:\.dsh\web-start\server.mjs > D:\.dsh\web-start\server.log 2>&1

# NAS/Linux：
/volume1/dsh/web-start/start-panel.sh start
```
验证（逐项）：
1. `GET http://127.0.0.1:3456/` → HTTP 200，页面正常。
2. `GET http://127.0.0.1:3456/api/status` → `{"running":true|false,"pid":…}`，能正确探测 dsh 运行状态。
3. 页面上按钮随状态切换（未运行显示「启动 dsh web」，运行中显示「重启 dsh web」）。
4. （由用户在浏览器点）「启动/重启 dsh web」→ 触发 `start.sh`（Windows 为 `start-dsh.cmd`）→ 停旧 + 起新，面板约 20 秒后变绿「✅ dsh web 已就绪」。

> **注意**：点「重启」会中断当前 agent 会话（agent 不自重启）。由用户在独立浏览器/终端操作，勿让 agent 触发 `/api/start`。

## 验证清单（逐项）
1. 三个文件都在 `$DSH_HOME/web-start/`。
2. `node --version` ≥22。
3. `GET /` 返回 200。
4. `GET /api/status` 返回正确的 `running`/`pid`（用 `dsh --profile <p> --dump-config` 或看 3080 是否响应核对）。
5. 面板与 dsh 服务分别常驻（面板 3456，dsh 3080）。
6. 若目标 NAS/Linux，确认 `start-panel.sh` 已 `chmod +x`、`NODE` 路径正确。

## 配置/可选
- **局域网/本机**：默认绑 `0.0.0.0`（局域网可访问，页面自动显示本机局域网 IP）；只留本机则设 `DSH_START_HOST=127.0.0.1`。**注意「放权限」是两步**：① 绑 `0.0.0.0`（已默认）② 在 DSM「控制面板 → 安全性 → 防火墙」放行 **3456** 端口（建议只对局域网网段放行），局域网设备才连得上；只留本机则绑 `127.0.0.1` 即可，无需放行、也不暴露。安全提示：绑 `0.0.0.0` 后内网任何设备都能点「启动」。
- **端口改**：`DSH_START_PORT=xxxx`。
- **启动脚本改**：`DSH_START_SCRIPT=<path>`（NAS 默认 `/volume1/dsh/start.sh`；Windows 默认 `$DSH_HOME\web-start\start-dsh.cmd`）。
- **页脚局域网地址改**：默认由 `lanIp()` 自动探测（跳过 docker/虚拟网卡，任何 NAS 都适用）；多网卡/反代场景取错时设 `DSH_START_LAN=<IP>` 覆盖成真正对外的地址。
- **开机自启**：把 `start-panel.cmd start`（Windows）/`start-panel.sh start`（NAS）加进 DSH 启动脚本或计划任务，先起面板再起 dsh（可选）。

## 常见坑速查
| 症状 | 原因 | 解决 |
|---|---|---|
| 点按钮没反应/接口 500 | `START_SCRIPT` 路径不对，或 `/api/start` 用了 Unix 的 `spawn("sh",…)` | 改 `server.mjs` 的 `START_SCRIPT`；Windows 建议让 `server.mjs` 直接 spawn node（见上文「Windows 关键」），勿用 `spawn(file,{shell:true})` 跑 `.cmd` |
| 点「启动/重启」dsh 起来即崩、面板一直「正在启动」 | Windows 用 `start /b 跑 .cmd` 或 `spawn(.cmd,{shell:true})`：不等 3080 释放就绑端口 → `EADDRINUSE`，且 cmd 控制台关闭带走子进程 | 让 `server.mjs` 直接 spawn node + 内部先 `killDsh()` → 轮询 `waitPortFree(3080)` → 再启动（见上文「Windows 关键」）；先 `netstat -ano | findstr :3080` 确认端口空闲 |
| 页面一直显示「未运行」 | `WEB_PID_PATTERN` 匹配不到 dsh 进程，或 `DSH_WEB_URL` 健康检查地址不对 | 用 PowerShell `Get-CimInstance`（Windows）或 `ps aux | grep dsh`（NAS）看实际命令行，改匹配串/端口 |
| 状态灯红/假 | 健康检查端口/地址不对 | 改 `server.mjs` 的 `DSH_WEB_URL`（默认 3080） |
| 面板启动失败 | `NODE`/node 路径不对 | `where node`（Windows）或 `which node`（NAS）确认真实路径改 `start-panel.cmd`/`start-panel.sh` |
| dsh 重启后插件路由 404 | 启动缺 `--expose-internals` | `start-dsh.cmd`/`start.sh` 启动命令加该 flag |
| `findDshPid` 在 Windows 报错 | 用了 `ps`/`sh` | 换成 PowerShell `Get-CimInstance` 版本 |
| 设置了 `DSH_UPLOAD_DIR` 但输出文件目录还是旧值 | dsh 进程是旧环境启动 | 用面板「重启 dsh web」（或带环境重启），新进程才生效 |

## 硬性安全边界（必须遵守）
- **不主动 `git push` / 打 tag / 发 Release**；需要发版本时停下用 `ask_user_question` 等用户确认。
- 所有写操作（写文件 / 起停服务）先向用户说明将改哪个文件、做什么，再执行。
- 探测到 `DSH_HOME`/`node`/profile 目录缺失时**停下提示**，让用户补充，不硬猜。
- **不要触发 `/api/start`**（会重启 dsh、中断当前会话）；由用户点按钮。
