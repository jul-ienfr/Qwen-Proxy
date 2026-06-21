@echo off
cd /d "%~dp0"
title QwenProxy - Gestion des comptes

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
echo   QwenProxy - Gestion interactive des comptes
echo ============================================
echo.

call npm run login
if %errorlevel% neq 0 (
    echo.
    echo [ERREUR] La gestion des comptes s'est arretee avec une erreur.
    pause
)
