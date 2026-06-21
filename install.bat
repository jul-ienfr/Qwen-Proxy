@echo off
cd /d "%~dp0"
title QwenProxy - Installation

echo ============================================
echo   QwenProxy - Installation des dependances
echo ============================================
echo.

:: Verifier Node.js
echo Verification de Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERREUR] Node.js n'est pas installe ou n'est pas dans le PATH.
    echo Telechargez-le sur https://nodejs.org/ (version ^>= 20^)
    pause
    exit /b 1
)
node -v
echo [OK] Node.js detecte.
echo.

:: npm install
echo Installation des dependances npm...
call npm install
if %errorlevel% neq 0 (
    echo [ERREUR] L'installation npm a echoue.
    pause
    exit /b 1
)
echo [OK] Dependances installees.
echo.

:: Installation des navigateurs Playwright
echo Installation de Chromium (Playwright^)...
call npx playwright install chromium
if %errorlevel% neq 0 (
    echo [ERREUR] L'installation de Playwright a echoue.
    pause
    exit /b 1
)
echo [OK] Chromium installe.
echo.

:: Copier .env.example vers .env si absent
if not exist ".env" (
    echo Creation du fichier .env a partir du modele...
    copy ".env.example" ".env" >nul
    echo [OK] Fichier .env cree. Editez-le avec vos parametres.
) else (
    echo [INFO] Le fichier .env existe deja, pas de remplacement.
)
echo.

echo ============================================
echo   Installation terminee !
echo   Editez le fichier .env puis lancez start.bat
echo ============================================
pause
