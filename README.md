# StudyLab AI

Antigravity CLI (`agy`) destekli, tamamen yerelde çalışan etkileşimli ders çalışma masaüstü uygulaması.

- **Verileriniz bilgisayarınızda kalır:** PDF, Word, PowerPoint, Excel, kod klasörleri, beyaz tahta çizimleri ve sohbet geçmişiniz yalnızca kendi diskinizde saklanır.
- **Yerel Antigravity (`agy`) girişi:** Kendi Google / Antigravity hesabınızla çalışır; ilk açılışta uygulama içindeki kurulum sihirbazı `agy` kurulumunu ve girişini tek tıkla yönlendirir.
- **Otomatik güncelleme:** Yeni sürümler GitHub Releases üzerinden yayınlandığında uygulama açılışta otomatik indirir ve tek tıkla günceller.

## İndirme ve Kurulum (Windows)

[Releases](https://github.com/DiaSy24/StudyLab-AI/releases/latest) sayfasından `StudyLab-AI-Setup-x.y.z.exe` kurulum dosyasını indirip çalıştırın.

> Not: Kurulum dosyası dijital sertifika ile imzalanmadığı için Windows SmartScreen ilk açılışta uyarı gösterebilir (**Ek bilgi → Yine de çalıştır**).

## Geliştirme

```powershell
npm install
npm run dev           # Tarayıcı geliştirme modu
npm run dev:electron  # Electron masaüstü penceresinde çalıştır
npm test              # Tüm testleri çalıştır
npm run dist:win      # Yerel Windows Setup.exe derle
npm run release:win   # Yeni sürümü derle ve GitHub Releases'a yayınla
```
