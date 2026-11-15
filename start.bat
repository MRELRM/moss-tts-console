@echo off
setlocal
title MOSS TTS Console
cd /d "%~dp0"

if not exist "server.js" (
  echo.
  echo  [ERROR] server.js not found. Please extract the whole ZIP to a folder first.
  echo.
  pause
  exit /b 1
)

rem ---- Locate Node runtime: bundled node.exe first, then system Node ----
if exist "node.exe" (
  set "NODECMD=%~dp0node.exe"
) else (
  set "NODECMD=node"
)

rem ---- First run: create .env from .env.example and open it in Notepad ----
if not exist ".env" (
  echo.
  echo  [FIRST RUN] Creating .env from .env.example ...
  copy /y ".env.example" ".env" >nul
  echo  [FIRST RUN] Fill in your MOSS API Key in the Notepad window, like:
  echo                MOSS_API_KEY=xxxxxxxxxxxxxxxx
  echo                Then SAVE and CLOSE Notepad. The server will start automatically.
  echo.
  start "" /wait notepad ".env"
)

rem ---- Read PORT from .env (default 8788) to open the browser ----
set "PORT=8788"
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  if /i "%%a"=="PORT" set "PORT=%%b"
)

echo.
echo  [START] MOSS TTS local console  -  http://127.0.0.1:%PORT%/
echo  [TIP]   First speech generation may take tens of seconds.
echo  [STOP]  Close this window to stop the server.
echo.

start "" /min cmd /c "ping -n 4 127.0.0.1 >nul & start http://127.0.0.1:%PORT%/"

"%NODECMD%" "server.js"

echo.
echo  Server stopped. Press any key to close this window...
pause >nul
