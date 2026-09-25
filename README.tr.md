# FloCafe

**Kafeler, restoranlar ve küçük mutfaklar için ücretsiz, açık kaynaklı ve çevrimdışı çalışmaya öncelik veren satış noktası uygulaması.**

[English](README.md) | [Español](README.es.md) | [Português](README.pt.md) | [Français](README.fr.md) | **Türkçe** | [Filipino](README.fil.md) | [Deutsch](README.de.md) | [简体中文](README.zh-CN.md)

FloCafe doğrudan işletmenin kendi bilgisayarında çalışır. Siparişler, müşteriler, fişler ve yedekler yerel bir SQLite veritabanında saklanır. Böylece internet bağlantısı olmadan da kasa hizmeti ve mutfak ekranları çalışmaya devam eder. Temel satış noktası işlemleri için barındırılan veya bulut tabanlı bir hesap gerekmez. Google Drive yedekleme, WhatsApp ile fiş gönderme ve bulut bağlantılı raporlama gibi isteğe bağlı entegrasyonlar gerektiğinde etkinleştirilebilir.

## FloCafe’yi edinin

En yeni yükleyiciyi [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases) sayfasından indirin veya platformunuzun uygulama mağazasından yükleyin. Ayrıca [Mac App Store](https://apps.apple.com/in/app/flo-cafe/id6763136018), [Microsoft Store](https://apps.microsoft.com/detail/9n1md6585p4q) veya [Snap Store](https://snapcraft.io/flocafe) kullanılabilir.

Sürümlerde Windows yükleyicileri, macOS DMG dosyaları ve Linux için AppImage, `.deb`, `.rpm` ve Snap paketleri bulunur. Linux paketleri, güncellemeler, FUSE, yazdırma izinleri ve sistem tepsisi davranışı hakkında bilgi için [Linux kurulum ve destek kılavuzuna](docs/linux.md) bakın.

### Sistem gereksinimleri

| Gereksinim | Minimum |
| --- | --- |
| İşletim sistemi | Windows 10+, macOS 12+ veya güncel desteklenen bir Linux dağıtımı |
| Bellek | 4 GB RAM |
| Depolama | 500 MB boş alan ve yerel yedekler için ek alan |

Node.js yalnızca FloCafe geliştirmek için gereklidir; paketlenmiş sürümü çalıştırmak için gerekmez.

<details>
<summary>Doğrudan indirilen yapıyı kaldırma</summary>

App Store ve Microsoft Store kurulumları ilgili mağaza veya işletim sistemi üzerinden kaldırılmalıdır.

```sh
# macOS
curl -fsSL https://github.com/FreeOpenSourcePOS/FloCafe/releases/latest/download/uninstall-macos.sh -o uninstall-macos.sh
chmod +x uninstall-macos.sh
./uninstall-macos.sh
```

```powershell
# Windows PowerShell
irm https://github.com/FreeOpenSourcePOS/FloCafe/releases/latest/download/uninstall-windows.ps1 -OutFile uninstall-windows.ps1
powershell -ExecutionPolicy Bypass -File .\uninstall-windows.ps1
```

Her iki komut dosyası da uygulama verilerinin korunup korunmayacağını sorar. Yerel veritabanını ve yedekleri kaldırmak istemiyorsanız veri silme seçeneklerini seçmeyin.

</details>

## Öne çıkan özellikler

- **Sipariş akışları:** Masa yönetimi ve bekletilen siparişlerle birlikte kasada, masada, paket ve teslimat siparişleri.
- **Değiştiriciler ve fiyatlandırma:** Ürün değiştiricileri, ek ürün grupları, indirimler ve müşteri sadakat puanları.
- **Fiş yazdırma:** USB, yerel TCP ağı ve işletim sistemi yazdırma kuyrukları üzerinden ESC/POS termal yazdırma; uyumlu tarayıcılarda WebUSB desteği ve 58 mm ile 80 mm kâğıt desteği.
- **Mutfak işlemleri:** Bağımsız Mutfak Ekranı (KDS) sunucusu ve kategoriye göre mutfak istasyonu yönlendirmesi.
- **Katalog yönetimi:** Ürün görselleri, barkod tarama ve CSV menü içe/dışa aktarma.
- **Yönetim:** Personel hesapları ve roller (sahip, yönetici, kasiyer, sunucu ve şef), satış analizleri ve denetim kayıtları.
- **Veri koruması:** Yerel SQLite veritabanı, geçişlerden önce otomatik yedekler, manuel geri yükleme araçları ve isteğe bağlı Google Drive yedekleme.

## Proje durumu

FloCafe aktif olarak geliştirilmektedir ve gerçek kurulumlarda kullanılmaktadır. Müşteri verileri ve yükseltme güvenliği açık veritabanı geçişleri ve kurtarma mekanizmalarıyla dikkatle korunur. Dahili ve genişletmeye yönelik mimarinin bazı bölümleri hâlâ gelişmektedir; bu nedenle uygulama ayrıntıları ve dahili sözleşmeler değişebilir.

## Çevrimdışı çalışacak şekilde tasarlandı

Temel satış noktası işlemleri ve yerel veriler çevrimdışı çalışır. Sipariş girişi, faturalandırma, KDS koordinasyonu ve fiş yazdırma internet bağlantısına veya harici bulut hizmetlerine bağlı değildir.

- SQLite veritabanı ve yerel yedekler, kurulu uygulama ikili dosyalarından ayrı olarak kullanıcı veri dizininde saklanır. Normal güncellemeler bunları kaldırmaz; yeniden yüklemeden, bilgisayar değiştirmeden veya dağıtım kanalını değiştirmeden önce manuel yedek oluşturmanız önerilir.
- FloCafe şema geçişlerini çalıştırmadan önce tarih ve saat içeren otomatik bir yedek oluşturur.
- Google Drive yedekleme, WhatsApp ile fiş gönderme ve bulut bağlantılı raporlama gibi hizmetler yalnızca işletme sahibi tarafından açıkça yapılandırılıp etkinleştirildiğinde ağ üzerinden iletişim kurar.

## Diller ve bölgesel destek

FloCafe arayüzü İngilizce, İspanyolca, Fransızca, Brezilya Portekizcesi, Filipince, Türkçe, Farsça (RTL desteğiyle), Almanca, İtalyanca, Japonca, Basitleştirilmiş Çince, Korece ve Bahasa Indonesia dillerinde kullanılabilir. Arayüz dili, mağazanın ülke ve bölgesel ayarlarından bağımsızdır. Vergi hesaplama kuralları ayrı bir konudur. Çevirilere katkıda bulunmak veya dil eklemek için [uluslararasılaştırma ve çeviri kılavuzuna](docs/architecture/internationalization.md) bakın.

FloCafe 131 ülke ve 109 para birimi için profiller içerir. Her profil varsayılan para birimi, yerel ayar ve saat dilini belirler; işletme sahibi saat dilini kurulum sırasında veya daha sonra Ayarlar bölümünden değiştirebilir.

## Vergi desteği

FloCafe bölgesel kurallar, vergi kategorileri ve yuvarlama politikaları için genel bir hesaplama motoru ile imzalı ve sürümlenmiş bölgesel vergi paketleri içerir. Ülke kapsamı katalog aracılığıyla genişletilir ve kullanılabilirlik değişir. Manuel vergi kuralları ve oranları da yerel olarak yapılandırılabilir.

> **Uyarı:** FloCafe yazılımdır; hukuki veya vergisel danışmanlık değildir. Vergi paketleri ve yapılandırma araçları tek başına yerel mevzuata uyumluluğu belgelemez; işletmeciler kendi işletmeleri için geçerli gereklilikleri doğrulamakla sorumludur.

Paketlerin yazımı, doğrulanması ve şeması hakkında ayrıntılar için [vergi paketi geliştirici kılavuzuna](docs/reference/tax-packs.md) bakın.

## Geliştirme

FloCafe geliştirmek için Node.js 22 veya üzeri gerekir:

```sh
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe
npm install
npm run dev
```

`npm run dev`, frontend ve backend’i derler ve ardından Electron’u başlatır.

### Mimari

```text
Electron ana süreci
├── Express API ve WebSocket sunucusu       :3001
├── Bağımsız mutfak ekranı sunucusu         :3002
├── Sunucu / garson uygulaması sunucusu     :3003
└── SQLite veritabanı, geçişler ve yazdırma
                 ↕ HTTP ve WebSocket
Next.js renderer
└── React arayüzü ve Zustand istemci durumu
```

Geliştirme akışları, kod standartları ve test prosedürleri için [CONTRIBUTING.md](CONTRIBUTING.md) dosyasına bakın.

## Katkıda bulunma

Katkılar memnuniyetle karşılanır. Başlamadan önce [CONTRIBUTING.md](CONTRIBUTING.md) dosyasına bakın:

- **Küçük hata düzeltmeleri, belge iyileştirmeleri ve odaklanmış testler** serbestçe başlatılabilir.
- **Yeni özellikler, veritabanı şeması değişiklikleri ve mimari yeniden düzenlemeler** uygulanmadan önce bakım ekibiyle görüşme ve onay gerektirir.

FloCafe sizin için yararlıysa depoya yıldız vermeyi düşünün.

## Yardım ve belgeler

- [Belge dizini](docs/README.md)
- [Yazıcı kılavuzu](docs/printers.md)
- [Linux kurulumu ve desteği](docs/linux.md)
- [Uluslararasılaştırma ve çeviriler](docs/architecture/internationalization.md)
- [Vergi paketi geliştirici kılavuzu](docs/reference/tax-packs.md)
- [Google Drive yedekleme kurulumu](docs/google-drive-setup.md)
- [GitHub Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues)
- [GitHub Discussions](https://github.com/FreeOpenSourcePOS/FloCafe/discussions)

## Lisans

FloCafe, [MIT lisansı](LICENSE) ile lisanslanmış açık kaynaklı bir yazılımdır.
