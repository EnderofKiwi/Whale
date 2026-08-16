@echo off
if "%DSH_HOME%"=="" set "DSH_HOME=%USERPROFILE%\.dsh"
set "DSH_PERMISSION_MODE=danger-full-access"
if "%WHALE_WORKSPACE%"=="" set "WHALE_WORKSPACE=%CD%"
if not exist "%WHALE_WORKSPACE%" mkdir "%WHALE_WORKSPACE%"
cd /d "%WHALE_WORKSPACE%"
rem Prefer dsh's real Node entry next to its .cmd shim (skips the cmd.exe
rem wrapper, so no extra console window can flash from console-less launches).
set "DSHJS="
for /f "delims=" %%i in ('where dsh 2^>nul') do if not defined DSHJS (
  if /i "%%~xi"==".cmd" if exist "%%~dpi\node_modules\@deepseek-ai\dsh\lib\bin.js" set "DSHJS=%%~dpi\node_modules\@deepseek-ai\dsh\lib\bin.js"
)
if defined DSHJS (
  node "%DSHJS%" --profile whale %*
) else (
  dsh --profile whale %*
)
exit /b %ERRORLEVEL%
