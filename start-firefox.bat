@echo off
cd /d "%~dp0"
title QwenProxy - Serveur (Firefox)

:: Verifier les dependances
if not exist "node_modules" (
    echo.
    echo Les dependances ne sont pas installees. Lancement de l'installation...
    echo.
    call install.bat
    if not exist "node_modules" (
        echo.
        echo [ERREUR] L'installation a echoue. Installez manuellement avec : npm install
        pause
        exit /b 1
    )
)

echo ============================================
echo   QwenProxy - Demarrage avec Firefox
echo ============================================
echo.

call npm run start:firefox
if %errorlevel% neq 0 (
    echo.
    echo [ERREUR] Le serveur s'est arrete avec une erreur.
    pause
)
