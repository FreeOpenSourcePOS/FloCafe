# FloCafe

**Libre, open-source, at offline-first na point of sale para sa mga café, restaurant, at maliliit na kusina.**

[English](README.md) | [Español](README.es.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Türkçe](README.tr.md) | **Filipino** | [Deutsch](README.de.md)

Direktang tumatakbo ang FloCafe sa computer ng negosyo. Naka-save ang mga order, customer, resibo, at backup sa lokal na SQLite database, kaya patuloy na gagana ang counter service at kitchen display kahit walang koneksyon sa Internet. Hindi kailangan ng hosted o cloud account para sa pangunahing operasyon ng POS. Maaaring paganahin kapag kailangan ang mga opsyonal na integration gaya ng Google Drive backup, pagpapadala ng bill sa WhatsApp, at cloud-connected reporting.

## Kunin ang FloCafe

I-download ang pinakabagong installer mula sa [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases), o i-install ito mula sa app store ng iyong platform.

May Windows installer, macOS DMG, at AppImage, `.deb`, `.rpm`, at Snap package para sa Linux ang mga release. Para sa mga detalye tungkol sa Linux package, update, FUSE, printing permission, at system tray, tingnan ang [Linux installation and support guide](docs/linux.md).

### Mga kinakailangan ng system

| Kinakailangan | Minimum |
| --- | --- |
| Operating system | Windows 10+, macOS 12+, o kasalukuyang suportadong Linux distribution |
| Memory | 4 GB RAM |
| Storage | 500 MB na libre, dagdag pa para sa lokal na backup |

Kailangan lamang ang Node.js para sa pag-develop ng FloCafe, hindi para patakbuhin ang naka-package na bersyon.

## Mga tampok

- **Mga workflow ng order:** Counter, dine-in, takeaway, at delivery order na may table management at held orders.
- **Mga modifier at presyo:** Item modifier, addon group, discount, at customer loyalty point.
- **Pagpi-print ng resibo:** ESC/POS thermal printing sa USB, lokal na TCP network, at operating-system print queue, kasama ang WebUSB sa mga suportadong browser.
- **Mga operasyon sa kusina:** Standalone Kitchen Display System (KDS) server at category-based kitchen station routing.
- **Pamamahala ng catalog:** Product image, barcode scanning, at CSV menu import/export.
- **Administration:** Staff account na may role, sales analytics, at audit log.
- **Proteksyon ng data:** Lokal na SQLite database, awtomatikong backup bago ang migration, manual restore, at opsyonal na Google Drive backup.

## Offline-first

Gumagana offline ang pangunahing POS operation at lokal na data. Hindi nakadepende sa Internet o external cloud service ang order entry, billing, KDS coordination, at receipt printing.

- Nasa user-data directory ang SQLite database at lokal na backup, hiwalay sa naka-install na application binary.
- Awtomatikong gumagawa ang FloCafe ng timestamped backup bago magpatakbo ng schema migration.
- Nakikipag-ugnayan lamang ang opsyonal na network feature kapag tahasang na-configure at na-enable ng may-ari ng negosyo.

## Mga wika at regional support

May UI translation ang FloCafe para sa English, Spanish, Brazilian Portuguese, Persian (Farsi), Filipino, Turkish, at German. Filipino ay left-to-right at hindi nangangailangan ng RTL layout. Hiwalay ang UI language sa country at regional setting ng store, at hiwalay din ang tax calculation rules.

May profile ang FloCafe para sa 131 bansa at 109 currency. Tinutukoy ng bawat profile ang default currency, locale, at timezone; maaaring baguhin ng may-ari ang timezone sa setup o sa Settings.

## Tax support

May generic calculation engine at signed, versioned regional tax pack ang FloCafe. Maaari ring mag-configure ng manual tax rule at rate nang lokal.

> **Paalala:** Software ang FloCafe, hindi legal o tax advice. Hindi awtomatikong nagpapatunay ng pagsunod sa lokal na regulasyon ang tax pack at configuration tool.

## Development

Kailangan ang Node.js 22 o mas bago para sa development:

```sh
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe
npm install
npm run dev
```

Binubuo ng `npm run dev` ang frontend at backend, pagkatapos ay sinisimulan ang Electron.

Tingnan ang [CONTRIBUTING.md](CONTRIBUTING.md) para sa development workflow, coding standard, at testing procedure.

## Tulong at dokumentasyon

- [Documentation index](docs/README.md)
- [Printer guide](docs/printers.md)
- [Linux setup and support](docs/linux.md)
- [Internationalization and translations](docs/i18n.md)
- [Google Drive backup setup](docs/google-drive-setup.md)
- [GitHub Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues)
- [GitHub Discussions](https://github.com/FreeOpenSourcePOS/FloCafe/discussions)

## Lisensya

Ang FloCafe ay open-source software sa ilalim ng [MIT License](LICENSE).
