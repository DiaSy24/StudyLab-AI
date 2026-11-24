@echo off
setlocal EnableExtensions
chcp 65001 >nul
title StudyLab AI - Guncelleme ve Release Araci
cd /d "%~dp0"

echo.
echo  ============================================================
echo    StudyLab AI - Hizli Guncelleme ve Release Araci
echo  ============================================================
echo.

:: ------------------------------------------------------------
:: 1) Node.js, npm, Git ve GitHub CLI (gh) PATH kontrolu
:: ------------------------------------------------------------
call :ENSURE_PATHS

where node >nul 2>nul
if errorlevel 1 goto :ERR_NO_NODE
where npm >nul 2>nul
if errorlevel 1 goto :ERR_NO_NODE
where git >nul 2>nul
if errorlevel 1 goto :ERR_NO_GIT

if exist "node_modules" goto :DEPS_OK
echo  [KURULUM] node_modules bulunamadi, paketler yukleniyor...
call npm install
if errorlevel 1 (
    echo  [HATA] npm install basarisiz oldu.
    pause
    exit /b 1
)

:DEPS_OK
set "BRANCH="
for /f "delims=" %%b in ('git branch --show-current 2^>nul') do set "BRANCH=%%b"
if not defined BRANCH set "BRANCH=main"

set "CUR_VER="
for /f "delims=" %%v in ('node -p "require('./package.json').version" 2^>nul') do set "CUR_VER=%%v"
if not defined CUR_VER set "CUR_VER=1.0.0"

for /f "tokens=1,2,3 delims=|" %%a in ('node -e "const [ma,mi,pa]=require('./package.json').version.split('.').map(n=>parseInt(n,10)||0);console.log([ma+'.'+mi+'.'+(pa+1),ma+'.'+(mi+1)+'.0',(ma+1)+'.0.0'].join('|'))"') do (
    set "NEXT_PATCH=%%a"
    set "NEXT_MINOR=%%b"
    set "NEXT_MAJOR=%%c"
)

:: ------------------------------------------------------------
:: Komut satiri kisayollari (--help, --quick "mesaj", --push "mesaj")
:: ------------------------------------------------------------
if /i "%~1"=="--help" goto :SHOW_HELP
if /i "%~1"=="-h" goto :SHOW_HELP
if /i "%~1"=="/?" goto :SHOW_HELP

if /i "%~1"=="--quick" (
    set "MODE=1"
    set "BUMP_ARG=patch"
    set "NEW_VER=%NEXT_PATCH%"
    set "COMMIT_MSG=%~2"
    set "NON_INTERACTIVE=1"
    goto :CHECK_AUTH_IF_NEEDED
)

if /i "%~1"=="--push" (
    set "MODE=2"
    set "BUMP_ARG=none"
    set "NEW_VER=%CUR_VER%"
    set "COMMIT_MSG=%~2"
    set "NON_INTERACTIVE=1"
    goto :RUN_PIPELINE
)

set "NON_INTERACTIVE=0"

echo  Mevcut Dal ^(Branch^) : %BRANCH%
echo  Mevcut Surum        : v%CUR_VER%
echo.
echo  Degisen dosyalar ^(git status^):
git status -s
echo.

echo  Yapmak istediginiz islemi secin:
echo    [1] Tam Guncelleme: Surum artir + GitHub'a Pushla + Release ^(.exe^) Yayinla  ^(Varsayilan^)
echo    [2] Sadece Proje Dosyalarini GitHub'a Pushla ^(commit + push^)
echo    [3] Sadece Mevcut Surumu ^(v%CUR_VER%^) Release Olarak Yayinla
echo    [I] Iptal
echo.
set "MODE=1"
set /p "MODE=  Seciminiz [1]: "
if /i "%MODE%"=="I" goto :CANCELLED
if "%MODE%"=="1" goto :PICK_VERSION
if "%MODE%"=="2" goto :MODE_PUSH_ONLY
if "%MODE%"=="3" goto :MODE_RELEASE_ONLY

echo.
echo  [HATA] Gecersiz secim: %MODE%
pause
exit /b 1

:MODE_PUSH_ONLY
set "BUMP_ARG=none"
set "NEW_VER=%CUR_VER%"
goto :ASK_COMMIT_MSG

:MODE_RELEASE_ONLY
set "BUMP_ARG=none"
set "NEW_VER=%CUR_VER%"
goto :CHECK_AUTH_IF_NEEDED

:PICK_VERSION
echo.
echo  Yeni surum secin ^(Mevcut: %CUR_VER%^):
echo    [1] Patch -^> %NEXT_PATCH%  ^(Hata duzeltme / ozellik guncellemesi - Varsayilan^)
echo    [2] Minor -^> %NEXT_MINOR%  ^(Yeni ozellik paketi^)
echo    [3] Major -^> %NEXT_MAJOR%  ^(Buyuk surum gecisi^)
echo    [4] Surumu degistirme ^(%CUR_VER% olarak kalsin^)
echo    veya dogrudan surum numarasi yazin ^(orn: 1.0.5^)
echo.
set "VER_CHOICE=1"
set /p "VER_CHOICE=  Surum seciminiz [1]: "

if "%VER_CHOICE%"=="1" (
    set "BUMP_ARG=patch"
    set "NEW_VER=%NEXT_PATCH%"
    goto :CHECK_AUTH_IF_NEEDED
)
if "%VER_CHOICE%"=="2" (
    set "BUMP_ARG=minor"
    set "NEW_VER=%NEXT_MINOR%"
    goto :CHECK_AUTH_IF_NEEDED
)
if "%VER_CHOICE%"=="3" (
    set "BUMP_ARG=major"
    set "NEW_VER=%NEXT_MAJOR%"
    goto :CHECK_AUTH_IF_NEEDED
)
if "%VER_CHOICE%"=="4" (
    set "BUMP_ARG=none"
    set "NEW_VER=%CUR_VER%"
    goto :CHECK_AUTH_IF_NEEDED
)

set "BUMP_ARG=%VER_CHOICE%"
set "NEW_VER=%VER_CHOICE%"

:CHECK_AUTH_IF_NEEDED
call :VERIFY_GH_AUTH
if not errorlevel 1 goto :AUTH_OK

echo.
echo  [UYARI] GitHub Releases yuklemesi icin GitHub girisi veya GH_TOKEN gereklidir.
where gh >nul 2>nul
if errorlevel 1 goto :ASK_TOKEN_MANUAL

choice /c EH /n /m "  Simdi 'gh auth login' ile GitHub girisi yapmak ister misiniz? [E] Evet / [H] Hayir: "
if errorlevel 2 goto :ASK_TOKEN_MANUAL
call gh auth login
call :VERIFY_GH_AUTH
if not errorlevel 1 goto :AUTH_OK

:ASK_TOKEN_MANUAL
echo.
set "INPUT_TOKEN="
set /p "INPUT_TOKEN=  Varsa GitHub Personal Access Token [GH_TOKEN] yapistirin [iptal icin bos birakin]: "
if not defined INPUT_TOKEN (
    echo.
    echo  [IPTAL] GitHub kimlik dogrulamasi olmadan Release yayinlanamaz.
    echo          Sadece kod pushlamak icin [2] secenegini kullanabilirsiniz.
    echo.
    if "%NON_INTERACTIVE%"=="0" pause
    exit /b 1
)
set "GH_TOKEN=%INPUT_TOKEN%"

:AUTH_OK
if "%MODE%"=="3" goto :RUN_RELEASE_STEP
if "%NON_INTERACTIVE%"=="1" goto :RUN_PIPELINE

:ASK_COMMIT_MSG
echo.
set "DEFAULT_MSG=Guncelleme"
if "%MODE%"=="1" set "DEFAULT_MSG=Release v%NEW_VER%"
set "COMMIT_MSG="
set /p "COMMIT_MSG=  Commit mesaji [Enter = %DEFAULT_MSG%]: "
if not defined COMMIT_MSG set "COMMIT_MSG=%DEFAULT_MSG%"
set "COMMIT_MSG=%COMMIT_MSG:"='%"

:RUN_PIPELINE
if not defined COMMIT_MSG (
    if "%MODE%"=="1" (
        set "COMMIT_MSG=Release v%NEW_VER%"
    ) else (
        set "COMMIT_MSG=Guncelleme"
    )
)
set "COMMIT_MSG=%COMMIT_MSG:"='%"

echo.
echo  ------------------------------------------------------------
echo  [ADIM 1] Otomatik testler calistiriliyor ^(npm test^)...
echo  ------------------------------------------------------------
call npm test
if errorlevel 1 (
    echo.
    echo  [HATA] Testler basarisiz oldu! Hata duzeltilmeden push/release yapilmadi.
    echo.
    if "%NON_INTERACTIVE%"=="0" pause
    exit /b 1
)

if /i "%BUMP_ARG%"=="none" goto :STEP_GIT_PUSH

echo.
echo  ------------------------------------------------------------
echo  [ADIM 2] Paket surumu guncelleniyor ^(%CUR_VER% -^> %NEW_VER%^)...
echo  ------------------------------------------------------------
call npm version %BUMP_ARG% --no-git-tag-version
if errorlevel 1 (
    echo.
    echo  [HATA] Surum numarasi guncellenemedi ^(%BUMP_ARG%^).
    echo.
    if "%NON_INTERACTIVE%"=="0" pause
    exit /b 1
)
for /f "delims=" %%v in ('node -p "require('./package.json').version" 2^>nul') do set "NEW_VER=%%v"

:STEP_GIT_PUSH
echo.
echo  ------------------------------------------------------------
echo  [ADIM 3] Proje dosyalari GitHub'a gonderiliyor ^(%BRANCH%^)...
echo  ------------------------------------------------------------
git add -A
if errorlevel 1 (
    echo  [HATA] git add basarisiz oldu.
    if "%NON_INTERACTIVE%"=="0" pause
    exit /b 1
)

git diff --cached --quiet
if not errorlevel 1 goto :AFTER_COMMIT

git commit -m "%COMMIT_MSG%"
if errorlevel 1 (
    echo  [HATA] git commit basarisiz oldu.
    if "%NON_INTERACTIVE%"=="0" pause
    exit /b 1
)
goto :DO_PUSH

:AFTER_COMMIT
echo  [BILGI] Commitlenecek yeni dosya degisikligi yok; mevcut commit pushlaniyor...

:DO_PUSH
git push -u origin %BRANCH%
if errorlevel 1 (
    echo.
    echo  [HATA] GitHub push islemi basarisiz oldu!
    echo         Once uzak degisiklikleri cekmeniz gerekebilir: git pull --rebase origin %BRANCH%
    echo.
    if "%NON_INTERACTIVE%"=="0" pause
    exit /b 1
)
echo  [OK] Kodlar basariyla GitHub'a pushlandi ^(%BRANCH%^).

if "%MODE%"=="2" goto :ALL_DONE

:RUN_RELEASE_STEP
echo.
echo  ------------------------------------------------------------
echo  [ADIM 4] Windows kurulum dosyasi derleniyor ve GitHub Releases'a yukleniyor ^(v%NEW_VER%^)...
echo  ------------------------------------------------------------
call npm run release:win
if errorlevel 1 (
    echo.
    echo  [HATA] Release olusturma / yukleme islemi basarisiz oldu!
    echo.
    if "%NON_INTERACTIVE%"=="0" pause
    exit /b 1
)

:ALL_DONE
echo.
echo  ============================================================
if "%MODE%"=="2" (
    echo    [BASARILI] Proje dosyalari GitHub'a gonderildi!
    echo    Dal: %BRANCH%
) else (
    echo    [BASARILI] v%NEW_VER% GitHub'a pushlandi ve Release yayinlandi!
    echo    Releases: https://github.com/DiaSy24/StudyLab-AI/releases
)
echo  ============================================================
echo.
if "%NON_INTERACTIVE%"=="0" pause
exit /b 0

:ERR_NO_NODE
echo  [HATA] Node.js veya npm bulunamadi. Lutfen Node.js kurun ^(kurulum-kontrol.bat^).
echo.
pause
exit /b 1

:ERR_NO_GIT
echo  [HATA] Git bulunamadi. Lutfen https://git-scm.com adresinden Git kurun.
echo.
pause
exit /b 1

:CANCELLED
echo.
echo  Islem iptal edildi.
echo.
timeout /t 1 >nul 2>nul
exit /b 0

:SHOW_HELP
echo  Kullanim:
echo    guncelle.bat                     Etkilesimli menu ile calistirir
echo    guncelle.bat --quick "Mesaj"     Patch surum artirir, test eder, pushlar ve Release yayinlar
echo    guncelle.bat --push  "Mesaj"     Test eder, commitler ve sadece kodlari GitHub'a pushlar
echo.
exit /b 0

:: ------------------------------------------------------------
:: Yardimci alt rutinler
:: ------------------------------------------------------------
:VERIFY_GH_AUTH
if defined GH_TOKEN exit /b 0
if defined GITHUB_TOKEN exit /b 0
where gh >nul 2>nul
if errorlevel 1 exit /b 1
gh auth token >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0

:ENSURE_PATHS
where node >nul 2>nul
if errorlevel 1 (
    if exist "C:\Program Files\nodejs\node.exe" (
        set "PATH=C:\Program Files\nodejs;%PATH%"
    ) else if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
        set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
    ) else if exist "C:\Program Files (x86)\nodejs\node.exe" (
        set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
    )
)
where git >nul 2>nul
if errorlevel 1 (
    if exist "C:\Program Files\Git\cmd\git.exe" (
        set "PATH=C:\Program Files\Git\cmd;%PATH%"
    ) else if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" (
        set "PATH=%LOCALAPPDATA%\Programs\Git\cmd;%PATH%"
    ) else if exist "C:\Program Files (x86)\Git\cmd\git.exe" (
        set "PATH=C:\Program Files (x86)\Git\cmd;%PATH%"
    )
)
where gh >nul 2>nul
if errorlevel 1 (
    if exist "C:\Program Files\GitHub CLI\gh.exe" (
        set "PATH=C:\Program Files\GitHub CLI;%PATH%"
    ) else if exist "%LOCALAPPDATA%\Programs\GitHub CLI\gh.exe" (
        set "PATH=%LOCALAPPDATA%\Programs\GitHub CLI;%PATH%"
    ) else if exist "C:\Program Files (x86)\GitHub CLI\gh.exe" (
        set "PATH=C:\Program Files (x86)\GitHub CLI;%PATH%"
    )
)
exit /b 0
