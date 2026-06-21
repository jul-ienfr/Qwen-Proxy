@echo off
cd /d "%~dp0"
title QwenProxy - Tests

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
echo   QwenProxy - Lancement des tests
echo ============================================
echo.

call npm test
if %errorlevel% neq 0 (
    echo.
    echo [ERREUR] Certains tests ont echoue.
) else (
    echo.
    echo [OK] Tous les tests sont passes.
)
pause
