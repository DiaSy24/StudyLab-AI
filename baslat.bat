@echo off
setlocal EnableExtensions
chcp 65001 >nul
title StudyLab AI - Baslatici
cd /d "%~dp0"

echo.
echo  ============================================================
echo    StudyLab AI - Etkilesimli Ders Calisma Studyosu
echo  ============================================================
echo.

:: 1) Node.js ve npm kontrolu (yeni kurulduysa standart klasorleri de kontrol et)
call :ENSURE_NODE_PATH
where node >nul 2>nul
if errorlevel 1 goto :MISSING_NODE
where npm >nul 2>nul
if errorlevel 1 goto :MISSING_NODE
goto :NODE_OK

:MISSING_NODE
echo  [HATA] Node.js bu bilgisayarda kurulu gorunmuyor.
echo.
if exist "%~dp0kurulum-kontrol.bat" (
    echo  Otomatik kurulum yardimcisi ^(kurulum-kontrol.bat^) ile Node.js kurabilirsiniz.
    choice /c EH /n /m "  Kurulum yardimcisini simdi acalim mi? [E] Evet / [H] Hayir: "
    if not errorlevel 2 (
        call "%~dp0kurulum-kontrol.bat" --node-only
        call :ENSURE_NODE_PATH
        where node >nul 2>nul
        if not errorlevel 1 (
            where npm >nul 2>nul
            if not errorlevel 1 goto :NODE_OK
        )
        exit /b 1
    )
)
echo.
echo  StudyLab AI'yi calistirmak icin Node.js ^(LTS^) kurmalisiniz:
echo    https://nodejs.org
echo.
echo  Kurulumu tamamladiktan sonra bu dosyaya tekrar cift tiklayin.
echo.
pause
exit /b 1

:NODE_OK
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
echo  [OK] Node.js hazir ^(%NODE_VER%^)

:: 2) Ilk calistirmada node_modules yoksa otomatik npm install
if not exist "node_modules" (
    echo.
    echo  [KURULUM] Ilk acilis tespit edildi - gerekli paketler yukleniyor...
    echo  Bu islem internet hiziniza gore 1-2 dakika surebilir.
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  [HATA] Paket kurulumu ^(npm install^) basarisiz oldu.
        echo  Internet baglantinizi kontrol edip tekrar deneyin.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo  [OK] Paketler basariyla yuklendi.
)

:: 3) Antigravity CLI (agy) PATH takviyesi (yeni kurulduysa terminali kapatmadan bulsun)
where agy >nul 2>nul
if errorlevel 1 (
    if exist "%LOCALAPPDATA%\agy\bin\agy.exe" (
        set "PATH=%LOCALAPPDATA%\agy\bin;%PATH%"
    ) else if exist "%USERPROFILE%\.gemini\bin\agy.exe" (
        set "PATH=%USERPROFILE%\.gemini\bin;%PATH%"
    ) else if exist "%USERPROFILE%\.local\bin\agy.exe" (
        set "PATH=%USERPROFILE%\.local\bin;%PATH%"
    )
)

where agy >nul 2>nul
if errorlevel 1 (
    echo  [BILGI] Antigravity CLI ^(agy^) henuz kurulu degil.
    echo          Uygulama acilinca ekrandaki Kurulum Sihirbazi ile tek tikla kurabilirsiniz.
) else (
    echo  [OK] Antigravity CLI ^(agy^) tespit edildi.
)

:: 4) Zaten calisiyorsa tarayiciyi acip cik
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', 5173); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
    echo.
    echo  ============================================================
    echo    [OK] StudyLab AI zaten acik! Tarayici aciliyor...
    echo    Adres: http://127.0.0.1:5173
    echo  ============================================================
    echo.
    start "" "http://127.0.0.1:5173"
    timeout /t 3 /nobreak >nul
    exit /b 0
)

echo.
echo  ============================================================
echo    KULLANIM YONERGELERI
echo  ============================================================
echo    1. Sunucu hazir olunca tarayiciniz OTOMATIK acilacaktir.
echo       Otomatik acilmazsa tarayiciniza su adresi yapistirin:
echo         http://127.0.0.1:5173
echo.
echo    2. Ilk acilista ekranda "Antigravity ^(agy^) Kurulum ve Giris
echo       Sihirbazi" acilir. Tek tikla kurulumu yapip Google hesabinizla
echo       giris yaparak Gemini ogretmenini aktif edebilirsiniz.
echo.
echo    3. ONEMLI: Uygulamayi kullanirken BU SIYAH PENCEREYI KAPATMAYIN.
echo       Pencereyi kapatirsaniz site kapanir.
echo.
echo    4. Calismaniz bitince kapatmak icin bu pencereyi kapatabilir
echo       veya Ctrl + C tuslarina basabilirsiniz.
echo  ============================================================
echo.
echo  [BASLATILIYOR] Sunucu ^(3456^) ve arayuz ^(5173^) hazirlaniyor...
echo.

:: 5) Hem arayuz (5173) hem sunucu (3456) hazir oldugunda tarayiciyi otomatik ac
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "$url='http://127.0.0.1:5173'; for ($i=0; $i -lt 120; $i++) { Start-Sleep -Milliseconds 500; $web=$false; $api=$false; try { $c=New-Object Net.Sockets.TcpClient('127.0.0.1',5173); $c.Close(); $web=$true } catch {}; try { $c=New-Object Net.Sockets.TcpClient('127.0.0.1',3456); $c.Close(); $api=$true } catch {}; if ($web -and ($api -or $i -ge 30)) { try { Start-Process $url } catch { Start-Process cmd -ArgumentList '/c','start','',$url }; break } }"

:: 6) Gelistirme sunucusunu baslat
call npm run dev
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo  ============================================================
    echo  [HATA] StudyLab AI beklenmedik bir hata ile durdu ^(kod: %EXIT_CODE%^).
    echo  Sorun gidermek icin kurulum-kontrol.bat dosyasini calistirabilirsiniz.
    echo  ============================================================
    echo.
    pause
)

exit /b %EXIT_CODE%

:ENSURE_NODE_PATH
where node >nul 2>nul
if not errorlevel 1 exit /b 0
if exist "C:\Program Files\nodejs\node.exe" (
    set "PATH=C:\Program Files\nodejs;%PATH%"
) else if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
) else if exist "C:\Program Files (x86)\nodejs\node.exe" (
    set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
)
exit /b 0
