@echo off
cd /d "%~dp0"
title QwenProxy - GUI Mode
set GUI=true
call npm start
pause
