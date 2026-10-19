@echo off
REM Lanzador de Feedly Local WebGPU para Windows
cd /d "%~dp0"

if "%PORT%"=="" set PORT=3040
set URL=http://localhost:%PORT%

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
  echo Error: No se encontro Node.js en el sistema.
  echo Instala Node.js v22.5 o superior desde https://nodejs.org/
  pause
  exit /b 1
)

netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  echo Feedly Local ya esta activo en %URL%
  start "" "%URL%"
  exit /b 0
)

echo Iniciando Feedly Local WebGPU en %URL% ...
start "" cmd /c "timeout /t 2 /nobreak >nul & start "" "%URL%""
node --no-warnings server.js
pause
