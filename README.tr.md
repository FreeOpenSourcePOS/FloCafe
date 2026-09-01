# FloCafe

**Kafeler, restoranlar ve küçük mutfaklar için ücretsiz, açık kaynaklı ve çevrimdışı çalışmaya öncelik veren satış noktası uygulaması.**

[English](README.md) | [Español](README.es.md) | [Português](README.pt.md) | [Français](README.fr.md) | **Türkçe** | [Filipino](README.fil.md) | [Deutsch](README.de.md)


FloCafe doğrudan işletmenin kendi bilgisayarında çalışır. Siparişler, müşteriler, fişler ve yedekler yerel bir SQLite veritabanında saklanır. Böylece internet bağlantısı olmadan da kasa hizmeti ve mutfak ekranları çalışmaya devam eder. Temel satış noktası işlemleri için barındırılan veya bulut tabanlı bir hesap gerekmez. Google Drive yedekleme, WhatsApp ile fiş gönderme ve bulut bağlantılı raporlama gibi isteğe bağlı entegrasyonlar gerektiğinde etkinleştirilebilir.

## FloCafe’yi edinin

En yeni yükleyiciyi [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases) sayfasından indirin veya platformunuzun uygulama mağazasından yükleyin.

Sürümlerde Windows yükleyicileri, macOS DMG dosyaları ve Linux için AppImage, `.deb`, `.rpm` ve Snap paketleri bulunur. Linux paketleri, güncellemeler, FUSE, yazdırma izinleri ve sistem tepsisi davranışı hakkında bilgi için [Linux kurulum ve destek kılavuzuna](docs/linux.md) bakın.

### Sistem gereksinimleri

| Gereksinim | Minimum |
| --- | --- |
| İşletim sistemi | Windows 10+, macOS 12+ veya güncel desteklenen bir Linux dağıtımı |
| Bellek | 4 GB RAM |
| Depolama | 500 MB boş alan ve yerel yedekler için ek alan |

Node.js yalnızca FloCafe geliştirmek için gereklidir; paketlenmiş sürümü çalıştırmak için gerekmez.

## Öne çıkan özellikler

- **Sipariş akışları:** Masa yönetimi ve bekletilen siparişlerle birlikte kasada, masada, paket ve teslimat siparişleri.
- **Değiştiriciler ve fiyatlandırma:** Ürün değiştiricileri, ek ürün grupları, indirimler ve müşteri sadakat puanları.
- **Fiş yazdırma:** USB, yerel TCP ağı ve işletim sistemi yazdırma kuyrukları üzerinden ESC/POS termal yazdırma; uyumlu tarayıcılarda WebUSB desteği.
- **Mutfak işlemleri:** Bağımsız Mutfak Ekranı (KDS) sunucusu ve kategoriye göre mutfak istasyonu yönlendirmesi.
- **Katalog yönetimi:** Ürün görselleri, barkod tarama ve CSV menü içe/dışa aktarma.
- **Yönetim:** Personel rolleri, satış analizleri ve denetim kayıtları.
- **Veri koruması:** Yerel SQLite veritabanı, geçişlerden önce otomatik yedekler, manuel geri yükleme araçları ve isteğe bağlı Google Drive yedekleme.

## Proje durumu

FloCafe aktif olarak geliştirilmektedir ve gerçek kurulumlarda kullanılmaktadır. Müşteri verileri ve yükseltme güvenliği açık veritabanı geçişleri ve kurtarma mekanizmalarıyla dikkatle korunur.

## Çevrimdışı çalışacak şekilde tasarlandı

Temel satış noktası işlemleri ve yerel veriler çevrimdışı çalışır. Sipariş girişi, faturalandırma, KDS koordinasyonu ve fiş yazdırma internet bağlantısına veya harici bulut hizmetlerine bağlı değildir.

- SQLite veritabanı ve yerel yedekler, kurulu uygulama ikili dosyalarından ayrı olarak kullanıcı veri dizininde saklanır.
- FloCafe şema geçişlerini çalıştırmadan önce tarih ve saat içeren otomatik bir yedek oluşturur.
- İsteğe bağlı ağ özellikleri yalnızca işletme sahibi tarafından açıkça yapılandırılıp etkinleştirildiğinde iletişim kurar.

## Diller ve bölgesel destek

FloCafe arayüzü İngilizce, İspanyolca, Brezilya Portekizcesi, Fransızca, Farsça, Türkçe, Filipince ve Almanca dillerinde kullanılabilir. Farsça RTL desteği içerir; Türkçe, Filipince ve Almanca soldan sağa yazılır. Arayüz dili, mağazanın ülke ve bölgesel ayarlarından bağımsızdır. Vergi hesaplama kuralları ayrı bir konudur.

FloCafe 131 ülke ve 109 para birimi için profiller içerir. Her profil varsayılan para birimi, yerel ayar ve saat dilini belirler; işletme sahibi saat dilini kurulum sırasında veya daha sonra Ayarlar bölümünden değiştirebilir.

## Vergi desteği

FloCafe genel bir hesaplama motoru ve imzalı, sürümlenmiş bölgesel vergi paketleri içerir. Manuel vergi kuralları ve oranları da yerel olarak yapılandırılabilir.

> **Uyarı:** FloCafe yazılımdır; hukuki veya vergisel danışmanlık değildir. Vergi paketleri ve yapılandırma araçları tek başına yerel mevzuata uyumluluğu belgelemez.

## Geliştirme

FloCafe geliştirmek için Node.js 22 veya üzeri gerekir:

```sh
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe
npm install
npm run dev
```

`npm run dev`, frontend ve backend’i derler ve ardından Electron’u başlatır.

Geliştirme akışları, kod standartları ve test prosedürleri için [CONTRIBUTING.md](CONTRIBUTING.md) dosyasına bakın.

## Yardım ve belgeler

- [Belge dizini](docs/README.md)
- [Yazıcı kılavuzu](docs/printers.md)
- [Linux kurulumu ve desteği](docs/linux.md)
- [Uluslararasılaştırma ve çeviriler](docs/i18n.md)
- [Google Drive yedekleme kurulumu](docs/google-drive-setup.md)
- [GitHub Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues)
- [GitHub Discussions](https://github.com/FreeOpenSourcePOS/FloCafe/discussions)

## Lisans

FloCafe, [MIT lisansı](LICENSE) ile lisanslanmış açık kaynaklı bir yazılımdır.
