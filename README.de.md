# FloCafe

**Kostenloses, quelloffenes und offline-orientiertes Kassensystem für Cafés, Restaurants und kleine Küchen.**

[English](README.md) | [Español](README.es.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Türkçe](README.tr.md) | [Filipino](README.fil.md) | **Deutsch** | [简体中文](README.zh-CN.md)

FloCafe läuft direkt auf dem Computer des Betriebs. Bestellungen, Kunden, Belege und Sicherungen werden in einer lokalen SQLite-Datenbank gespeichert. Dadurch können Kassenbetrieb und Küchenanzeigen auch ohne Internetverbindung weiterarbeiten. Für den grundlegenden Kassenbetrieb ist kein gehostetes oder cloudbasiertes Konto erforderlich. Optionale Integrationen wie Google-Drive-Sicherungen, der Versand von Belegen über WhatsApp und cloudbasierte Berichte können bei Bedarf aktiviert werden.

## FloCafe herunterladen

Laden Sie das neueste Installationsprogramm von [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases) herunter oder installieren Sie FloCafe über den App-Store Ihrer Plattform. Sie können auch den [Mac App Store](https://apps.apple.com/in/app/flo-cafe/id6763136018), den [Microsoft Store](https://apps.microsoft.com/detail/9n1md6585p4q) oder den [Snap Store](https://snapcraft.io/flocafe) verwenden.

Die Releases enthalten Windows-Installationsprogramme, macOS-DMGs sowie AppImage-, `.deb`-, `.rpm`- und Snap-Pakete für Linux. Informationen zu Linux-Paketen, Updates, FUSE, Druckberechtigungen und dem Verhalten der Systemleiste finden Sie im [Linux-Installations- und Supportleitfaden](docs/linux.md).

### Systemanforderungen

| Anforderung | Minimum |
| --- | --- |
| Betriebssystem | Windows 10+, macOS 12+ oder eine aktuelle unterstützte Linux-Distribution |
| Arbeitsspeicher | 4 GB RAM |
| Speicherplatz | 500 MB frei, zusätzlich Platz für lokale Sicherungen |

Node.js wird nur zur Entwicklung von FloCafe benötigt, nicht zum Ausführen einer paketierten Version.

<details>
<summary>Direkt heruntergeladene Version deinstallieren</summary>

Installationen aus dem App Store und Microsoft Store sollten über den jeweiligen Store oder das Betriebssystem entfernt werden.

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

Beide Skripte fragen, ob die Anwendungsdaten behalten werden sollen. Wählen Sie die Optionen zum Löschen der Daten nur, wenn Sie die lokale Datenbank und Sicherungen entfernen möchten.

</details>

## Highlights

- **Bestellabläufe:** Bestellungen an der Kasse, im Restaurant, zum Mitnehmen und zur Lieferung mit Tischverwaltung und zurückgehaltenen Bestellungen.
- **Optionen und Preise:** Artikeloptionen, Zusatzgruppen, Rabatte und Kunden-Treuepunkte.
- **Belegdruck:** ESC/POS-Thermodruck über USB, lokales TCP-Netzwerk und Druckwarteschlangen des Betriebssystems, mit WebUSB in kompatiblen Browsern und Unterstützung für 58-mm- und 80-mm-Papier.
- **Küchenbetrieb:** Eigenständiger Küchenbildschirm-Server (KDS) und kategoriebasierte Weiterleitung an Küchenstationen.
- **Katalogverwaltung:** Produktbilder, Barcode-Scan sowie CSV-Import und -Export von Menüs.
- **Verwaltung:** Mitarbeiterkonten mit Rollen (Eigentümer, Manager, Kassierer, Server und Koch), Verkaufsanalysen und Prüfprotokolle.
- **Datenschutz:** Lokale SQLite-Datenbank, automatische Sicherungen vor Migrationen, manuelle Wiederherstellung und optionale Google-Drive-Sicherung.

## Projektstatus

FloCafe wird aktiv entwickelt und bereits in realen Installationen eingesetzt. Kundendaten und die Sicherheit von Aktualisierungen werden durch explizite Datenbankmigrationen und Wiederherstellungsmechanismen sorgfältig geschützt. Teile der internen und erweiterungsorientierten Architektur entwickeln sich noch weiter; Implementierungsdetails und interne Verträge können sich daher ändern.

## Offline-orientiertes Design

Der grundlegende Kassenbetrieb und lokale Daten funktionieren offline. Auftragserfassung, Abrechnung, KDS-Koordination und Belegdruck sind nicht von Internet oder externen Cloud-Diensten abhängig.

- Die SQLite-Datenbank und lokale Sicherungen liegen im Benutzerdatenverzeichnis, getrennt von den installierten Programmbinärdateien. Normale Aktualisierungen entfernen sie nicht; vor einer Neuinstallation, einem Computerwechsel oder einem Wechsel des Vertriebswegs sollte eine manuelle Sicherung erstellt werden.
- FloCafe erstellt vor Schema-Migrationen automatisch eine Sicherung mit Zeitstempel.
- Dienste wie Google-Drive-Sicherungen, der Belegversand über WhatsApp und cloudbasierte Berichte kommunizieren nur dann über das Netzwerk, wenn sie vom Betriebsinhaber ausdrücklich konfiguriert und aktiviert wurden.

## Sprachen und regionale Unterstützung

FloCafe bietet Benutzeroberflächen auf Englisch, Spanisch, Französisch, brasilianischem Portugiesisch, Filipino, Türkisch, Persisch (Farsi) mit RTL-Unterstützung, Deutsch, Italienisch, Japanisch, vereinfachtem Chinesisch, Koreanisch und Bahasa Indonesia. Die UI-Sprache ist unabhängig von Land und regionalen Einstellungen des Geschäfts. Steuerberechnungsregeln sind ein getrenntes Thema. Informationen zum Mitwirken an Übersetzungen oder zum Hinzufügen von Sprachen finden Sie im [Leitfaden für Internationalisierung und Übersetzungen](docs/architecture/internationalization.md).

FloCafe enthält Profile für 131 Länder und 109 Währungen. Jedes Profil legt Währung, Region und Standardzeitzone fest; der Betriebsinhaber kann die Zeitzone während der Einrichtung oder später in den Einstellungen ändern.

## Steuerunterstützung

FloCafe enthält eine allgemeine Berechnungs-Engine sowie signierte und versionierte regionale Steuerpakete für regionale Regeln, Steuerkategorien und Rundungsrichtlinien. Die Länderabdeckung wird über den Katalog erweitert und die Verfügbarkeit variiert. Manuelle Steuerregeln und Steuersätze können ebenfalls lokal konfiguriert werden.

> **Hinweis:** FloCafe ist Software und keine Rechts- oder Steuerberatung. Steuerpakete und Konfigurationswerkzeuge bescheinigen allein keine Einhaltung lokaler Vorschriften; der Betreiber muss die für seinen Betrieb geltenden Anforderungen prüfen.

Informationen zur Erstellung, Validierung und zum Schema der Pakete finden Sie im [Entwicklerleitfaden für Steuerpakete](docs/reference/tax-packs.md).

## Entwicklung

Für die Entwicklung von FloCafe benötigen Sie Node.js 22 oder höher:

```sh
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe
npm install
npm run dev
```

`npm run dev` erstellt Frontend und Backend und startet anschließend Electron.

### Architektur

```text
Electron-Hauptprozess
├── Express-API und WebSocket-Server        :3001
├── Eigenständiger Küchenserver              :3002
├── Server für Anwendung / Bedienpersonal    :3003
└── SQLite-Datenbank, Migrationen und Druck
                 ↕ HTTP und WebSocket
Next.js-Renderer
└── React-Oberfläche und Zustand-Clientstatus
```

Weitere Informationen zu Entwicklungsabläufen, Programmierrichtlinien und Tests finden Sie in [CONTRIBUTING.md](CONTRIBUTING.md).

## Mitwirken

Beiträge sind willkommen. Bitte lesen Sie [CONTRIBUTING.md](CONTRIBUTING.md), bevor Sie beginnen:

- **Kleine Fehlerbehebungen, Dokumentationsverbesserungen und fokussierte Tests** können frei begonnen werden.
- **Neue Funktionen, Änderungen am Datenbankschema und architektonische Refactorings** erfordern vor der Umsetzung eine Diskussion und Genehmigung durch die Maintainer.

Wenn FloCafe für Sie nützlich ist, können Sie das Repository mit einem Stern markieren.

## Hilfe und Dokumentation

- [Dokumentationsindex](docs/README.md)
- [Druckerleitfaden](docs/printers.md)
- [Linux-Einrichtung und Support](docs/linux.md)
- [Internationalisierung und Übersetzungen](docs/architecture/internationalization.md)
- [Entwicklerleitfaden für Steuerpakete](docs/reference/tax-packs.md)
- [Einrichtung der Google-Drive-Sicherung](docs/google-drive-setup.md)
- [GitHub Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues)
- [GitHub Discussions](https://github.com/FreeOpenSourcePOS/FloCafe/discussions)

## Lizenz

FloCafe ist Open-Source-Software unter der [MIT-Lizenz](LICENSE).
