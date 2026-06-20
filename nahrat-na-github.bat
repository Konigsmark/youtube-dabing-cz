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

git rm --cached push-log.txt >nul 2>nul
git add -A >> "%LOG%" 2>&1
git -c commit.gpgsign=false commit -m "update %DATE% %TIME%" >> "%LOG%" 2>&1

echo --- PUSH --- >> "%LOG%"
git push -u origin main >> "%LOG%" 2>&1
echo PUSH_EXIT=%ERRORLEVEL% >> "%LOG%"
echo --- HEAD --- >> "%LOG%"
git log -1 --oneline >> "%LOG%" 2>&1
echo DONE >> "%LOG%"
