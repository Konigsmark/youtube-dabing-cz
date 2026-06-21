@echo off
chcp 65001 >nul
setlocal
set "SRC=%~dp0"
set "DEST=%USERPROFILE%\Projects\youtube-dabing-cz"
set "REPO=https://github.com/Konigsmark/youtube-dabing-cz.git"
set "LOG=%~dp0push-log.txt"

echo ==== %DATE% %TIME% ==== > "%LOG%"
where git >nul 2>nul || (echo GIT_MISSING >> "%LOG%" & exit /b 1)

robocopy "%SRC%." "%DEST%" /E /XD .git >> "%LOG%" 2>&1
cd /d "%DEST%" || (echo NO_DEST >> "%LOG%" & exit /b 1)

if not exist ".git" git init >> "%LOG%" 2>&1
git config user.name "Frantisek Konigsmark"
git config user.email "konigsmark@seznam.cz"
git remote remove origin >nul 2>nul
git remote add origin "%REPO%"
git branch -M main

REM --- odeber citlivé soubory (API kl��če) z pracovní kopie ---
del /q "YT API Youtube.txt" 2>nul
del /q "*.key" 2>nul
del /q ".env" 2>nul

git fetch origin >> "%LOG%" 2>&1
REM postav ČISTÝ commit nad origin/main (zahodí lokální commity vč. omylem přidaného klíče)
git reset --soft origin/main >> "%LOG%" 2>&1
git rm --cached --ignore-unmatch "YT API Youtube.txt" "push-log.txt" >> "%LOG%" 2>&1
git add -A >> "%LOG%" 2>&1
git -c commit.gpgsign=false commit -m "update %DATE% %TIME%" >> "%LOG%" 2>&1

echo --- PUSH --- >> "%LOG%"
git push origin main >> "%LOG%" 2>&1
echo PUSH_EXIT=%ERRORLEVEL% >> "%LOG%"
echo --- HEAD --- >> "%LOG%"
git log -1 --oneline >> "%LOG%" 2>&1
echo DONE >> "%LOG%"
