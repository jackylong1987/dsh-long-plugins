---
name: dsh-web-win-service-install
description: 在一台已装好 DSH 的 Windows 机器上，把 dsh web 注册成 Windows 服务（NSSM），使关闭任何 cmd 窗口都不影响服务；自动安装 nssm、生成启动器/安装/卸载脚本、自提权注册、开机自启、崩溃自动重启并验证。用户说"把 dsh 做成 windows 服务"、"关 cmd 不能被服务"、"新电脑装 dsh 服务"时调用。
whenToUse: 用户要求在 Windows 上把 DeepSeek Harness（dsh web）注册为 Windows 服务（含 nssm 安装），或在一台新电脑上用服务方式运行 dsh 时调用。
---

# DSH web 注册为 Windows 服务（含 NSSM 安装）

作为部署助手，在一台**已装好 DSH 的 Windows 机器**上，把 `dsh web` 注册成 **NSSM Windows 服务** `DSHWeb`，让它：
- 后台常驻、**关闭任意 cmd 窗口都不受影响**（服务挂在 services.exe 下）；
- **开机自启**（SERVICE_AUTO_START）、**崩溃自动重启**（AppExit=Restart）；
- 带 `--expose-internals`（插件路由必需）+ 插件所需环境变量（DSH_UPLOAD_DIR / PYTHONHOME / PATH）。

> 本 skill 是**操作指引**，由你（agent）在目标机器上执行。NSSM 安装与服务注册都需要**真正提权**（用户点 UAC），你 **不可自称已提权**——把"提权"交给脚本里的自提权（RunAs）或用户手动跑。凡**远程 push / 打 tag / 发 Release** 一律停下等用户确认（硬性安全边界）。

## 你会在目标机器上生成 4 个脚本（都在 `<DSH_HOME>\bin`）
| 脚本 | 作用 |
|---|---|
| `start-dsh-service.cmd` | 服务底层启动器：**绝对路径**起 node + `--expose-internals` + 插件 env（LocalSystem 安全） |
| `install-dsh-service.cmd` | **自提权**：装/配置/启动 `DSHWeb` 服务（幂等，可重复跑） |
| `restart-dsh.bat` | **自提权**：可靠的"停 → 等 STOPPED → 启"重启服务，带确认提示 + 自动开浏览器（**日常重启用这个**） |
| `remove-dsh-service.cmd` | 自提权卸载服务 |

**NSSM** 放到用户 PATH 目录（如 `%APPDATA%\npm\nssm.exe`，无需管理员）。

## 前置探测（不要假设路径）
```
dsh --version            # 没装 DSH 则先按官方文档装（需 node>=22）
where node               # 找 node 真实路径（如 C:\Program Files\nodejs\node.exe）
where dsh.cmd            # 找 DSH CLI 入口；其所在目录即 npm 全局 bin
echo $env:APPDATA        # npm 全局 bin 通常在 %APPDATA%\npm
where python             # 真实 python（md2docx 用；Windows 常被 Store stub 劫持）
```
据此记下并**写入启动器**的绝对路径：
- `NODE_EXE` = `where node` 的第一个真路径
- `DSH_HOME` = `C:\Users\<用户>\.dsh`（或用户实际值）
- `DSH_BIN` = `<where dsh.cmd 所在目录>\node_modules\@deepseek-ai\dsh\lib\bin.js`（或 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`）
- `UPLOAD_DIR` = 用户工作区下的 upload（如 `C:\dsh\workspace\upload`；没有就默认 `%DSH_HOME%\uploads`）
- `PYTHONHOME` = `where python` 的父目录（如 `C:\Python314`）

> ⚠️ **占位符提醒**：步骤 2/3/4/5 的脚本模板里，`C:\Users\YOURUSER\...`、`C:\dsh\workspace\upload`、`C:\Python314` 等都是**占位符**——写文件前**一律替换**成上面探测到的真实路径（DSH_HOME / NODE_EXE / DSH_BIN / UPLOAD_DIR / PYTHONHOME）。漏换会导致脚本指向不存在的路径。

## 步骤 1：安装 NSSM
```powershell
# 下载并解压 nssm-2.24.zip
Invoke-WebRequest https://nssm.cc/release/nssm-2.24.zip -OutFile "$env:TEMP\nssm.zip"
Expand-Archive "$env:TEMP\nssm.zip" -DestinationPath "$env:TEMP\nssmx" -Force
# 取 64 位 nssm.exe 放到用户 PATH 目录（npm 全局 bin，免管理员）
Copy-Item "$env:TEMP\nssmx\nssm-2.24\win64\nssm.exe" "$env:APPDATA\npm\nssm.exe" -Force
nssm version   # 应输出 Version 2.24 64-bit
```
> 备选：`choco install nssm -y`。验证 `where nssm` 能找到。

## 步骤 2：生成启动器 `start-dsh-service.cmd`
写文件（**纯 ASCII、CRLF**；把占位符替换成上面探测到的绝对路径）：
```cmd
@echo off
rem DSH-Web launcher (paths baked in; service runs as LocalSystem so it
rem must NOT rely on the logged-in user's %USERPROFILE%/PATH).
setlocal EnableDelayedExpansion
if not defined DSH_HOME   set "DSH_HOME=C:\Users\YOURUSER\.dsh"
if not defined NODE_EXE   set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined DSH_BIN    set "DSH_BIN=C:\Users\YOURUSER\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
if not defined UPLOAD_DIR set "UPLOAD_DIR=C:\dsh\workspace\upload"
if not defined PYTHONHOME set "PYTHONHOME=C:\Python314"
if not defined DSH_PORT   set "DSH_PORT=3080"
if not exist "%NODE_EXE%" ( echo [ERR] node not found: %NODE_EXE% & goto :fail )
if not exist "%DSH_BIN%"  ( echo [ERR] bin.js not found: %DSH_BIN% & goto :fail )
set "DSH_UPLOAD_DIR=%UPLOAD_DIR%"
set "PYTHONHOME=%PYTHONHOME%"
set "PATH=%DSH_HOME%\bin;%PATH%"
echo [OK] node=%NODE_EXE%
echo [OK] dsh=%DSH_BIN%
"%NODE_EXE%" --expose-internals --max-old-space-size=8192 "%DSH_BIN%" web --port %DSH_PORT%
goto :eof
:fail
exit /b 1
```
> **要点**：路径**写死**（不要靠 `where`/`%APPDATA%` 运行时探测）——服务以 **LocalSystem** 跑，运行时探测会指向系统账户而失败。想移植其它机器，改开头几行即可。
> `cmd` 批处理**必须 CRLF**。写完后统一转一次：
> ```powershell
> $f="C:\Users\YOURUSER\.dsh\bin\start-dsh-service.cmd"; $c=[IO.File]::ReadAllText($f); $c=$c -replace "`r`n","`n" -replace "`n","`r`n"; [IO.File]::WriteAllText($f,$c,[Text.Encoding]::ASCII)
> ```

## 步骤 3：生成安装脚本 `install-dsh-service.cmd`（自提权）
**纯 ASCII + CRLF**。**关键坑**：`if defined BUSY ( ... )` 块内的 `echo` 文本**不要含 `(`/`)`**（会被 cmd 当作嵌套子块而报"此时不应有 。"）。自提权用 `whoami /groups` 判断 `S-1-16-12288`（High），不要用 `net session`（在该环境会误报 0）：
```cmd
@echo off
setlocal EnableDelayedExpansion
whoami /groups | find /i "S-1-16-12288" >nul 2>&1
if errorlevel 1 (
  echo [*] Needs Administrator. Relaunching elevated...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
set "SVC=DSHWeb"
set "LAUNCHER=C:\Users\YOURUSER\.dsh\bin\start-dsh-service.cmd"
set "UPLOAD=C:\dsh\workspace\upload"
set "PY=C:\Python314"
set "LOG=C:\Users\YOURUSER\.dsh\bin\dsh-service.log"
set "ERRLOG=C:\Users\YOURUSER\.dsh\bin\dsh-service.err.log"
set "PORT=3080"
where nssm >nul 2>&1 || ( echo [X] nssm not found & exit /b 1 )
if not exist "%LAUNCHER%" ( echo [X] launcher missing: %LAUNCHER% & exit /b 1 )
sc query "%SVC%" >nul 2>&1 && (
  echo [*] Service exists, removing old one...
  nssm stop "%SVC%" >nul 2>&1
  nssm remove "%SVC%" confirm >nul 2>&1
)
set "BUSY="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do set "BUSY=%%p"
if defined BUSY (
  echo [W] Port %PORT% is in use by PID !BUSY! likely the running DSH instance.
  echo     Stop it so the new service can bind? This will end that web session.  [Y/N]
  set /p ANS=
  if /i "!ANS!"=="Y" taskkill /PID !BUSY! /F >nul 2>&1
)
nssm install "%SVC%" cmd.exe /c "\"%LAUNCHER%\"" >nul
if errorlevel 1 ( echo [X] nssm install failed & exit /b 1 )
nssm set "%SVC%" AppDirectory "C:\Users\YOURUSER\.dsh\bin" >nul
nssm set "%SVC%" DisplayName "DSH web service" >nul
nssm set "%SVC%" Description "DeepSeek Harness web node expose-internals" >nul
nssm set "%SVC%" Start SERVICE_AUTO_START >nul
nssm set "%SVC%" AppExit Default Restart >nul
nssm set "%SVC%" AppEnvironmentExtra DSH_UPLOAD_DIR=%UPLOAD% PYTHONHOME=%PY% >nul
nssm set "%SVC%" AppStdout "%LOG%" >nul
nssm set "%SVC%" AppStderr "%ERRLOG%" >nul
nssm start "%SVC%" >nul
if errorlevel 1 ( echo [X] nssm start failed, see %ERRLOG% & exit /b 1 )
echo [OK] Service installed and started.
echo      status: nssm status %SVC%
echo      browser: http://127.0.0.1:%PORT%
echo      logs: %LOG% / %ERRLOG%
exit /b 0
```

## 步骤 4：生成卸载脚本 `remove-dsh-service.cmd`（自提权）
```cmd
@echo off
setlocal
set "SVC=DSHWeb"
whoami /groups | find /i "S-1-16-12288" >nul 2>&1
if errorlevel 1 (
  echo [*] Needs Administrator. Relaunching elevated...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
where nssm >nul 2>&1 || ( echo [X] nssm not found & exit /b 1 )
sc query "%SVC%" >nul 2>&1 || ( echo [*] Service %SVC% not present & exit /b 0 )
nssm stop "%SVC%" >nul 2>&1
nssm remove "%SVC%" confirm
echo [OK] Removed.
exit /b 0
```
> 生成的四个脚本（`.cmd`/`.bat`）都要做 **ASCII + CRLF** 归一（每次写完都跑一遍步骤 2 末尾的 PowerShell 片段，把文件名换掉）。

## 步骤 5：生成重启脚本 `restart-dsh.bat`（自提权，可靠的日常重启）
**纯 ASCII + CRLF**。解决 `nssm restart` 因 stop 异步失败（第一次报 `Unexpected status SERVICE_STOP_PENDING`）的问题——用**显式停 → 轮询等到 `STOPPED` → 再启**：
```cmd
@echo off
setlocal EnableDelayedExpansion
whoami /groups | find /i "S-1-16-12288" >nul 2>&1
if errorlevel 1 (
  echo [*] Needs Administrator. Relaunching elevated...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
set "SVC=DSHWeb"
set "PORT=3080"
echo.
echo  This restarts DSH web and will interrupt the current session.
set /p ANS=  Continue? [Y/N]
if /i not "!ANS!"=="Y" ( echo [*] Cancelled. Nothing was restarted. & exit /b 0 )
echo.
sc query "%SVC%" >nul 2>&1
if not %errorlevel% equ 0 (
  echo [*] No service %SVC%. Starting a manual foreground instance...
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do taskkill /PID %%p /F >nul 2>&1
  call "C:\Users\YOURUSER\.dsh\bin\start-dsh-service.cmd"
  exit /b 0
)
echo [*] Stopping service %SVC% ...
nssm stop "%SVC%" >nul 2>&1
set /a tries=0
:waitstop
sc query "%SVC%" | findstr /c:"STOPPED" >nul 2>&1
if not errorlevel 1 goto :stopped
set /a tries+=1
if !tries! geq 30 (
  echo [W] Did not reach STOPPED within 30s; continuing to start anyway.
  goto :stopped
)
timeout /t 1 /nobreak >nul
goto :waitstop
:stopped
echo [*] Starting service %SVC% ...
nssm start "%SVC%" >nul 2>&1
if errorlevel 1 ( echo [X] nssm start failed, check dsh-service.err.log & exit /b 1 )
echo [OK] Service restarted. Waiting for the server to come back up...
timeout /t 5 /nobreak >nul
start "" "http://127.0.0.1:%PORT%"
exit /b 0
```
> 这是**用户日常重启**要用的脚本（装插件/升级后跑它即生效）：自提权 + 确认提示 + 重启后自动开浏览器；无服务时回退为手动前台启动。

## 步骤 6：执行安装
让**用户**（或用户在资源管理器双击 `install-dsh-service.cmd`）运行；脚本会自动 **UAC 提权**，然后：
1. 若 3080 被现有 DSH 手动实例占用，会问 `[Y/N]`——**用户输 `Y`**（停掉当前实例，会中断其当前会话）。
2. `nssm install` + `nssm start` → 打印 `[OK] Service installed and started.`

## 步骤 7：验证清单
1. `nssm status DSHWeb` = `SERVICE_RUNNING`；`sc query DSHWeb` 显示 `AUTO_START`。
2. `dsh-service.log` 显示 `[OK] node=... dsh=...`，无 `bin.js not found`；`dsh-service.err.log`为空。
3. `netstat -ano | findstr :3080` → 服务进程（node + `--expose-internals`）。
4. 刷新 `http://127.0.0.1:3080`；各插件入口/上传/预览正常。
5. `nssm get DSHWeb Start` = `SERVICE_AUTO_START`，`nssm get DSHWeb AppExit Default` = `Restart`。

## 交付：把这些文件位置明确告诉用户
生成并验证后，把下面每个脚本的**完整路径**和用途逐项列给用户：
- `start-dsh-service.cmd` —— 服务底层启动器（一般不用手动动它）
- `install-dsh-service.cmd` —— 装/升级 `DSHWeb` 服务（双击→UAC）
- `restart-dsh.bat` —— **日常重启**（装插件/升级后跑这个；双击→UAC→输 `Y`→自动重启并开浏览器）
- `remove-dsh-service.cmd` —— 卸载服务（双击→UAC）
并告诉用户：平时只需打开 `http://127.0.0.1:<port>`；需要重启就运行 `restart-dsh.bat`。

## 关键坑速查
| 症状 | 原因 | 解决 |
|---|---|---|
| 批次报"此时不应有 。/ . was unexpected" | 文件是 LF（cmd 要 CRLF）或 `if (...)` 块内 `echo` 文本含 `(``)` | CRLF 归一；echo 文本去掉括号 |
| 服务装上但启动 `SERVICE_PAUSED`，日志 `bin.js not found` | 启动器运行时探测路径失败（LocalSystem 下 `where`/`%APPDATA%` 不对） | 启动器**写死绝对路径** |
| `nssm install` 报"需管理员" | 进程非 High integrity | 自提权（RunAs）或用"以管理员身份运行" |
| `net session` 返回 0 却仍无权限建服务 | 该环境下 `net session` 误报 | 用 `whoami /groups` 查 `S-1-16-12288` 判断是否真提权 |
| 服务启动后 3080 起不来 | 旧手动实例仍占 3080 | 先在脚本提示处输 `Y` 停掉，或 `taskkill /PID <pid> /F` |
| `nssm` 找不到 | 未装/不在 PATH | 步骤 1 安装并 `where nssm` 验证 |

## 通用性（换机器/换目录）
只需要改 **`start-dsh-service.cmd` 开头 5 行**（DSH_HOME / NODE_EXE / DSH_BIN / UPLOAD_DIR / PYTHONHOME）和 **`install-dsh-service.cmd` 顶部 5 个 SET**（LAUNCHER / UPLOAD / PY / LOG / ERRLOG），其余完全复用。若 DSH 装在别的用户/盘，把对应绝对路径换成该机器实际值即可。

## 硬性安全边界
- **不主动 `git push` / 打 tag / 发 Release**。
- 所有写操作（生成脚本、改配置、启动/停止服务）先向用户说明做什么再执行。
- 提权必须靠 UAC/用户"以管理员身份运行"，**不要谎称已提权**。
- 端口占用提示处要不要停旧实例，先让用户确认，避免误杀其会话。
