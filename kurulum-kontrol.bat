@echo off
setlocal EnableExtensions
chcp 65001 >nul
title StudyLab AI - Kurulum ve Sistem Kontrolu
cd /d "%~dp0"

set "NODE_ONLY=0"
if /i "%~1"=="--node-only" set "NODE_ONLY=1"

echo.
echo  ============================================================
echo    StudyLab AI - Sistem ve Kurulum Kontrolu
echo  ============================================================
echo.

:: ------------------------------------------------------------
:: 1) Node.js ve npm kontrolu
:: ------------------------------------------------------------
call :CHECK_NODE
if not errorlevel 1 goto :NODE_READY

echo  [EKSIK] Node.js bu bilgisayarda kurulu gorunmuyor.
echo.
echo  StudyLab AI'nin calismasi icin Node.js ^(LTS^) gereklidir.
echo.

where winget >nul 2>nul
if not errorlevel 1 (
    echo  Node.js ^(LTS^) otomatik olarak kurulabilir ^(winget^).
    choice /c EH /n /m "  Simdi otomatik kurulsun mu? [E] Evet / [H] Hayir: "
    if errorlevel 2 goto :NODE_MANUAL
    echo.
    echo  [KURULUM] Node.js LTS indiriliyor ve kuruluyor...
    echo  ^(Windows onay penceresi acilirsa Evet'e tiklayin.^)
    echo.
    winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
    echo.
    call :CHECK_NODE
    if not errorlevel 1 (
        echo  [OK] Node.js basariyla kuruldu!
        goto :NODE_READY
    )
    echo  [UYARI] Otomatik kurulum tamamlanamadi veya yeni oturum gerekiyor.
    goto :NODE_MANUAL
)

:NODE_MANUAL
echo.
echo  Node.js'i resmi siteden kolayca kurabilirsiniz:
echo    https://nodejs.org
echo.
choice /c EH /n /m "  Indirme sayfasini tarayicida acalim mi? [E] Evet / [H] Hayir: "
if not errorlevel 2 (
    start "" "https://nodejs.org"
)
echo.
echo  Kurulumu tamamladiktan sonra bu dosyaya veya baslat.bat'a tekrar cift tiklayin.
echo.
pause
exit /b 1

:NODE_READY
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
for /f "delims=" %%v in ('npm -v') do set "NPM_VER=%%v"
echo  [OK] Node.js kurulu: %NODE_VER% ^(npm v%NPM_VER%^)

:: Node.js minimum surum kontrolu (v18+)
for /f "tokens=1 delims=." %%m in ("%NODE_VER:v=%") do set "NODE_MAJOR=%%m"
if defined NODE_MAJOR (
    if %NODE_MAJOR% LSS 18 (
        echo  [UYARI] Node.js surumunuz eski ^(%NODE_VER%^). Onerilen: v20 veya uzeri ^(LTS^).
        echo          Sorun yasarsaniz https://nodejs.org adresinden guncelleyin.
    )
)

:: baslat.bat sadece Node.js kurulumu icin cagirdiysa burada basariyla don
if "%NODE_ONLY%"=="1" (
    exit /b 0
)

echo.

:: ------------------------------------------------------------
:: 2) Proje paketleri (node_modules) kontrolu
:: ------------------------------------------------------------
if exist "node_modules" (
    echo  [OK] Proje paketleri ^(node_modules^) hazir.
) else (
    echo  [EKSIK] Proje paketleri ^(node_modules^) henuz yuklenmemis.
    choice /c EH /n /m "  Paketler simdi yuklensin mi ^(npm install^)? [E] Evet / [H] Hayir: "
    if not errorlevel 2 (
        echo.
        echo  [KURULUM] Paketler yukleniyor ^(1-2 dakika surebilir^)...
        echo.
        call npm install
        if errorlevel 1 (
            echo.
            echo  [HATA] npm install basarisiz oldu. Internet baglantinizi kontrol edin.
            echo.
            pause
            exit /b 1
        )
        echo.
        echo  [OK] Proje paketleri yuklendi.
    )
)

echo.

:: ------------------------------------------------------------
:: 3) Antigravity CLI (agy) kontrolu
:: ------------------------------------------------------------
call :CHECK_AGY
if not errorlevel 1 goto :AGY_FOUND

echo  [BILGI] Antigravity CLI ^(agy^) henuz kurulu degil.
echo          Isterseniz simdi kurabilir veya StudyLab acilinca ekrandaki sihirbazdan tek tikla kurabilirsiniz.
choice /c EH /n /m "  Antigravity CLI ^(agy^) simdi kurulsun mu? [E] Evet / [H] Hayir: "
if not errorlevel 2 (
    echo.
    echo  [KURULUM] Antigravity CLI ^(agy^) indiriliyor...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference = 'SilentlyContinue'; irm https://antigravity.google/cli/install.ps1 | iex"
    call :CHECK_AGY
    if not errorlevel 1 (
        echo  [OK] Antigravity CLI ^(agy^) kuruldu!
        goto :AGY_DONE
    )
    echo  [UYARI] Kurulum dogrulanamadi. Uygulama icindeki sihirbazdan tekrar deneyebilirsiniz.
)
goto :AGY_DONE

:AGY_FOUND
set "AGY_VER="
for /f "delims=" %%v in ('agy --version 2^>nul') do if not defined AGY_VER set "AGY_VER=%%v"
if defined AGY_VER (
    echo  [OK] Antigravity CLI ^(agy^) kurulu ^(v%AGY_VER%^).
) else (
    echo  [OK] Antigravity CLI ^(agy^) kurulu.
)

:AGY_DONE

echo.
echo  ============================================================
echo    Sistem kontrolu tamamlandi!
echo  ============================================================
echo.
choice /c EH /n /m "  StudyLab AI'yi simdi baslatmak ister misiniz? [E] Evet / [H] Hayir: "
if not errorlevel 2 (
    call "%~dp0baslat.bat"
    exit /b %ERRORLEVEL%
)

exit /b 0

:: ------------------------------------------------------------
:: Yardimci alt rutinler
:: ------------------------------------------------------------
:CHECK_NODE
where node >nul 2>nul
if not errorlevel 1 (
    where npm >nul 2>nul
    if not errorlevel 1 exit /b 0
)
if exist "C:\Program Files\nodejs\node.exe" (
    set "PATH=C:\Program Files\nodejs;%PATH%"
) else if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
) else if exist "C:\Program Files (x86)\nodejs\node.exe" (
    set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
)
where node >nul 2>nul
if errorlevel 1 exit /b 1
where npm >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0

:CHECK_AGY
where agy >nul 2>nul
if not errorlevel 1 exit /b 0
if exist "%LOCALAPPDATA%\agy\bin\agy.exe" (
    set "PATH=%LOCALAPPDATA%\agy\bin;%PATH%"
) else if exist "%USERPROFILE%\.gemini\bin\agy.exe" (
    set "PATH=%USERPROFILE%\.gemini\bin;%PATH%"
) else if exist "%USERPROFILE%\.local\bin\agy.exe" (
    set "PATH=%USERPROFILE%\.local\bin;%PATH%"
)
where agy >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0
