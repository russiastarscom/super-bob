@echo off
chcp 65001 >nul
title SUPER BOB - сервер связи
cd /d "%~dp0"
echo.
echo   SUPER BOB: сервер для игры вдвоём по сети
echo   ==========================================
where node >nul 2>nul
if errorlevel 1 (
   echo.
   echo   НЕ УСТАНОВЛЕН NODE.JS
   echo   Скачай и установи его с https://nodejs.org
   echo   ^(кнопка LTS^), затем запусти этот файл снова.
   echo.
   pause
   exit /b 1
)
if not exist "net\node_modules\peer" (
   echo   Первая установка сервера связи, секунд 20-40...
   call npm install --prefix net --no-audit --no-fund --loglevel=error
   if errorlevel 1 (
      echo   Не удалось скачать сервер. Проверь интернет и запусти снова.
      pause
      exit /b 1
   )
)
echo.
node net/server.js
echo.
pause
