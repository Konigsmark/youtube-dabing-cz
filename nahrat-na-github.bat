@echo off
chcp 65001 >nul
setlocal
title YouTube Dabing CZ -> GitHub (auto)

set "SRC=%~dp0"
set "DEST=%USERPROFILE%\Projects\youtube-dabing-cz"
set "REPO=https://github.com/Konigsmark/youtube-dabing-cz.git"

echo ============================================================
echo  Nahravam YouTube Dabing CZ na GitHub
echo  Cil: %REPO%
echo ============================================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [CHYBA] Git neni nainstalovan: https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

echo [1/5] Kopiruji projekt mimo OneDrive do:
echo       %DEST%
robocopy "%SRC%." "%DEST%" /E /XD .git >nul

cd /d "%DEST%" || (echo [CHYBA] Nelze otevrit slozku & pause & exit /b 1)

echo [2/5] Inicializuji repozitar...
if not exist ".git" git init >nul
git symbolic-ref HEAD refs/heads/main 2>nul
git config user.name "Frantisek Konigsmark"
git config user.email "konigsmark@seznam.cz"

echo [3/5] Pridavam soubory a vytvarim commit...
git add -A
git -c commit.gpgsign=false commit -m "YouTube Dabing CZ - prvni verze (MV3, dabing pres preklad titulku)"
if errorlevel 1 echo (commit uz mozna existuje - pokracuji)

echo [4/5] Nastavuji vzdaleny repozitar...
git remote remove origin >nul 2>nul
git remote add origin "%REPO%"
git branch -M main

echo [5/5] Nahravam na GitHub...
echo     Pokud vyskoci okno prohlizece "Authorize / Sign in", potvrd ho.
git push -u origin main

echo.
if errorlevel 1 (
  echo ============================================================
  echo  PUSH SELHAL. Opis prosim cervene radky vyse zpet do chatu.
  echo  (Caste reseni: v okne prohlizece dokoncit prihlaseni a spustit znovu.)
  echo ============================================================
) else (
  echo ============================================================
  echo  HOTOVO! Soubory jsou na: 
  echo  https://github.com/Konigsmark/youtube-dabing-cz
  echo ============================================================
)
echo.
echo (Toto okno zustane otevrene. Zavri ho rucne krizkem.)
pause >nul
