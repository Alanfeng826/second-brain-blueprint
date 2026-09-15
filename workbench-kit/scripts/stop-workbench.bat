@echo off
rem ---------------------------------------------------------------------------
rem  stop-workbench.bat - stop the detached Workbench dev server.
rem  Keep this file ASCII-only (no chcp / no non-English text): .bat files are
rem  read with the OEM codepage and non-ASCII comments turn into mojibake.
rem ---------------------------------------------------------------------------
setlocal
title Stop Workbench
cd /d "%~dp0"

call :ResolveNode
if not defined NODE set "NODE=node.exe"

echo.
echo   Stopping Workbench ...
echo.
"%NODE%" "%~dp0standalone-launcher.mjs" --stop
echo.
echo   Done.
pause
endlocal
exit /b 0

rem --- Resolve a usable node.exe -------------------------------------------
:ResolveNode
set "NODE="
if defined WORKBENCH_NODE if exist "%WORKBENCH_NODE%" set "NODE=%WORKBENCH_NODE%"
if defined NODE goto :eof
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if defined NODE goto :eof
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODE goto :eof
set "NODEROOT=%USERPROFILE%\.workbuddy\binaries\node\versions"
if exist "%NODEROOT%\current" set /p VER=<"%NODEROOT%\current"
if defined VER if exist "%NODEROOT%\%VER%\node.exe" set "NODE=%NODEROOT%\%VER%\node.exe"
goto :eof
