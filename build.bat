@echo off
cd /d "%~dp0"
title QwenProxy - Build TypeScript

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
echo   QwenProxy - Compilation TypeScript
echo ============================================
echo.

call npm run build
if %errorlevel% neq 0 (
    echo.
    echo [ERREUR] La compilation a echoue.
    pause
) else (
    echo.
    echo [OK] Build terminee avec succes.
    pause
)
