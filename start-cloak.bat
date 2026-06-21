@echo off
cd /d "%~dp0"
title QwenProxy - Serveur (CloakBrowser)

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
echo   QwenProxy - Demarrage avec CloakBrowser
echo ============================================
echo.

:: CloakBrowser gere son propre binaire (telechargement automatique au premier lancement).
:: Aucun BROWSER_EXECUTABLE_PATH n'est necessaire.
set HEADLESS=false

echo Mode: CloakBrowser (anti-detection C++ + humanize)
echo Headless: %HEADLESS%
echo.

call npm start
if %errorlevel% neq 0 (
    echo.
    echo [ERREUR] Le serveur s'est arrete avec une erreur.
    pause
)
