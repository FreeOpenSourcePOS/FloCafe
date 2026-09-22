# FloCafe

**Libre, open-source, at offline-first na point of sale para sa mga café, restaurant, at maliliit na kusina.**

[English](README.md) | [Español](README.es.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Türkçe](README.tr.md) | **Filipino** | [Deutsch](README.de.md) | [简体中文](README.zh-CN.md)

Direktang tumatakbo ang FloCafe sa computer ng negosyo. Naka-save ang mga order, customer, resibo, at backup sa lokal na SQLite database, kaya patuloy na gagana ang counter service at kitchen display kahit walang koneksyon sa Internet. Hindi kailangan ng hosted o cloud account para sa pangunahing operasyon ng POS. Maaaring paganahin kapag kailangan ang mga opsyonal na integration gaya ng Google Drive backup, pagpapadala ng bill sa WhatsApp, at cloud-connected reporting.

## Kunin ang FloCafe

I-download ang pinakabagong installer mula sa [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases), o i-install ito mula sa app store ng iyong platform. Maaari ring gamitin ang [Mac App Store](https://apps.apple.com/in/app/flo-cafe/id6763136018), [Microsoft Store](https://apps.microsoft.com/detail/9n1md6585p4q), o [Snap Store](https://snapcraft.io/flocafe).

May Windows installer, macOS DMG, at AppImage, `.deb`, `.rpm`, at Snap package para sa Linux ang mga release. Para sa mga detalye tungkol sa Linux package, update, FUSE, printing permission, at system tray, tingnan ang [Linux installation and support guide](docs/linux.md).

### Mga kinakailangan ng system

| Kinakailangan | Minimum |
| --- | --- |
| Operating system | Windows 10+, macOS 12+, o kasalukuyang suportadong Linux distribution |
| Memory | 4 GB RAM |
| Storage | 500 MB na libre, dagdag pa para sa lokal na backup |

Kailangan lamang ang Node.js para sa pag-develop ng FloCafe, hindi para patakbuhin ang naka-package na bersyon.

<details>
<summary>I-uninstall ang direktang na-download na build</summary>

Ang mga install mula sa App Store at Microsoft Store ay dapat alisin sa kaukulang store o sa operating system.

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

Itatanong ng dalawang script kung pananatilihin ang application data. Huwag piliin ang data-purge option maliban kung nais mong alisin ang lokal na database at mga backup.

</details>

## Mga tampok

- **Mga workflow ng order:** Counter, dine-in, takeaway, at delivery order na may table management at held orders.
- **Mga modifier at presyo:** Item modifier, addon group, discount, at customer loyalty point.
- **Pagpi-print ng resibo:** ESC/POS thermal printing sa USB, lokal na TCP network, at operating-system print queue, kasama ang WebUSB sa mga suportadong browser at 58 mm at 80 mm na papel.
- **Mga operasyon sa kusina:** Standalone Kitchen Display System (KDS) server at category-based kitchen station routing.
- **Pamamahala ng catalog:** Product image, barcode scanning, at CSV menu import/export.
- **Administration:** Staff account na may mga role (owner, manager, cashier, server, at chef), sales analytics, at audit log.
- **Proteksyon ng data:** Lokal na SQLite database, awtomatikong backup bago ang migration, manual restore, at opsyonal na Google Drive backup.

## Status ng proyekto

Aktibong dine-develop ang FloCafe at ginagamit na sa mga aktuwal na deployment. Pinangangalagaan ang customer data at upgrade safety sa pamamagitan ng malinaw na database migration at recovery mechanism. Patuloy pang umuunlad ang ilang bahagi ng internal at extension-facing architecture, kaya maaaring magbago ang implementation details at internal contract.

## Offline-first

Gumagana offline ang pangunahing POS operation at lokal na data. Hindi nakadepende sa Internet o external cloud service ang order entry, billing, KDS coordination, at receipt printing.

- Nasa user-data directory ang SQLite database at lokal na backup, hiwalay sa naka-install na application binary. Hindi inaalis ng karaniwang update ang mga ito; pinakamainam na gumawa ng manual backup bago mag-reinstall, lumipat ng computer, o magpalit ng distribution channel.
- Awtomatikong gumagawa ang FloCafe ng timestamped backup bago magpatakbo ng schema migration.
- Ang Google Drive backup, pagpapadala ng bill sa WhatsApp, at cloud reporting ay nakikipag-ugnayan lamang sa network kapag tahasang na-configure at na-enable ng may-ari ng negosyo.

## Mga wika at regional support

May UI translation ang FloCafe para sa English, Spanish, French, Brazilian Portuguese, Filipino, Turkish, Persian (Farsi) na may RTL support, German, Italian, Japanese, Simplified Chinese, Korean, at Bahasa Indonesia. Hiwalay ang UI language sa country at regional setting ng store, at hiwalay din ang tax calculation rules. Para sa pag-aambag ng translation o pagdaragdag ng wika, tingnan ang [Internationalization and translation guide](docs/i18n.md).

May profile ang FloCafe para sa 131 bansa at 109 currency. Tinutukoy ng bawat profile ang default currency, locale, at timezone; maaaring baguhin ng may-ari ang timezone sa setup o sa Settings.

## Tax support

May generic calculation engine at signed, versioned regional tax pack ang FloCafe para sa regional rules, tax category, at rounding policy. Lumalawak ang country coverage sa pamamagitan ng catalog at nag-iiba ang availability. Maaari ring mag-configure ng manual tax rule at rate nang lokal.

> **Paalala:** Software ang FloCafe, hindi legal o tax advice. Hindi awtomatikong nagpapatunay ng pagsunod sa lokal na regulasyon ang tax pack at configuration tool; responsibilidad ng operator na beripikahin ang mga requirement para sa negosyo nito.

Para sa detalye tungkol sa pag-author, validation, at schema ng pack, tingnan ang [tax pack developer guide](docs/tax-packs.md).

## Development

Kailangan ang Node.js 22 o mas bago para sa development:

```sh
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe
npm install
npm run dev
```

Binubuo ng `npm run dev` ang frontend at backend, pagkatapos ay sinisimulan ang Electron.

### Architecture

```text
Electron main process
├── Express API at WebSocket server        :3001
├── Standalone kitchen-display server      :3002
├── Server / waiter app server              :3003
└── SQLite database, migration, at printing
                 ↕ HTTP at WebSocket
Next.js renderer
└── React UI at Zustand client state
```

Tingnan ang [CONTRIBUTING.md](CONTRIBUTING.md) para sa development workflow, coding standard, at testing procedure.

## Pag-aambag

Malugod na tinatanggap ang mga contribution. Tingnan ang [CONTRIBUTING.md](CONTRIBUTING.md) bago magsimula:

- **Ang maliliit na bug fix, documentation improvement, at focused test** ay maaaring simulan nang malaya.
- **Ang bagong feature, database schema change, at architectural refactor** ay nangangailangan ng talakayan at pag-apruba ng maintainer bago ipatupad.

Kung kapaki-pakinabang sa iyo ang FloCafe, pag-isipang i-star ang repository.

## Tulong at dokumentasyon

- [Documentation index](docs/README.md)
- [Printer guide](docs/printers.md)
- [Linux setup and support](docs/linux.md)
- [Internationalization and translations](docs/i18n.md)
- [Tax pack developer guide](docs/tax-packs.md)
- [Google Drive backup setup](docs/google-drive-setup.md)
- [GitHub Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues)
- [GitHub Discussions](https://github.com/FreeOpenSourcePOS/FloCafe/discussions)

## Lisensya

Ang FloCafe ay open-source software sa ilalim ng [MIT License](LICENSE).
