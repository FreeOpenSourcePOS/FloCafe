# FloCafe

**Kostenloses, quelloffenes und offline-orientiertes Kassensystem für Cafés, Restaurants und kleine Küchen.**

[English](README.md) | [Español](README.es.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Türkçe](README.tr.md) | [Filipino](README.fil.md) | **Deutsch**

FloCafe läuft direkt auf dem Computer des Betriebs. Bestellungen, Kunden, Belege und Sicherungen werden in einer lokalen SQLite-Datenbank gespeichert. Dadurch können Kassenbetrieb und Küchenanzeigen auch ohne Internetverbindung weiterarbeiten. Für den grundlegenden Kassenbetrieb ist kein gehostetes oder cloudbasiertes Konto erforderlich. Optionale Integrationen wie Google-Drive-Sicherungen, der Versand von Belegen über WhatsApp und cloudbasierte Berichte können bei Bedarf aktiviert werden.

## FloCafe herunterladen

Laden Sie das neueste Installationsprogramm von [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases) herunter oder installieren Sie FloCafe über den App-Store Ihrer Plattform.

Die Releases enthalten Windows-Installationsprogramme, macOS-DMGs sowie AppImage-, `.deb`-, `.rpm`- und Snap-Pakete für Linux. Informationen zu Linux-Paketen, Updates, FUSE, Druckberechtigungen und dem Verhalten der Systemleiste finden Sie im [Linux-Installations- und Supportleitfaden](docs/linux.md).

### Systemanforderungen

| Anforderung | Minimum |
| --- | --- |
| Betriebssystem | Windows 10+, macOS 12+ oder eine aktuelle unterstützte Linux-Distribution |
| Arbeitsspeicher | 4 GB RAM |
| Speicherplatz | 500 MB frei, zusätzlich Platz für lokale Sicherungen |

Node.js wird nur zur Entwicklung von FloCafe benötigt, nicht zum Ausführen einer paketierten Version.

## Highlights

- **Bestellabläufe:** Bestellungen an der Kasse, im Restaurant, zum Mitnehmen und zur Lieferung mit Tischverwaltung und zurückgehaltenen Bestellungen.
- **Optionen und Preise:** Artikeloptionen, Zusatzgruppen, Rabatte und Kunden-Treuepunkte.
- **Belegdruck:** ESC/POS-Thermodruck über USB, lokales TCP-Netzwerk und Druckwarteschlangen des Betriebssystems, mit WebUSB in kompatiblen Browsern.
- **Küchenbetrieb:** Eigenständiger Küchenbildschirm-Server (KDS) und kategoriebasierte Weiterleitung an Küchenstationen.
- **Katalogverwaltung:** Produktbilder, Barcode-Scan sowie CSV-Import und -Export von Menüs.
- **Verwaltung:** Mitarbeiterkonten mit Rollen, Verkaufsanalysen und Prüfprotokolle.
- **Datenschutz:** Lokale SQLite-Datenbank, automatische Sicherungen vor Migrationen, manuelle Wiederherstellung und optionale Google-Drive-Sicherung.

## Offline-orientiertes Design

Der grundlegende Kassenbetrieb und lokale Daten funktionieren offline. Auftragserfassung, Abrechnung, KDS-Koordination und Belegdruck sind nicht von Internet oder externen Cloud-Diensten abhängig.

- Die SQLite-Datenbank und lokale Sicherungen liegen im Benutzerdatenverzeichnis, getrennt von den installierten Programmbinärdateien.
- FloCafe erstellt vor Schema-Migrationen automatisch eine Sicherung mit Zeitstempel.
- Optionale Netzwerkfunktionen kommunizieren nur, wenn sie vom Betriebsinhaber ausdrücklich konfiguriert und aktiviert wurden.

## Sprachen und regionale Unterstützung

FloCafe bietet Benutzeroberflächen auf Englisch, Spanisch, brasilianischem Portugiesisch, Persisch (Farsi), Türkisch, Filipino und Deutsch. Persisch unterstützt RTL; Türkisch, Filipino und Deutsch werden von links nach rechts geschrieben. Die UI-Sprache ist unabhängig von Land und regionalen Einstellungen des Geschäfts. Steuerberechnungsregeln sind ein getrenntes Thema.

FloCafe enthält Profile für 131 Länder und 109 Währungen. Jedes Profil legt Währung, Region und Standardzeitzone fest; der Betriebsinhaber kann die Zeitzone während der Einrichtung oder später in den Einstellungen ändern.

## Steuerunterstützung

FloCafe enthält eine allgemeine Berechnungs-Engine sowie signierte und versionierte regionale Steuerpakete. Manuelle Steuerregeln und Steuersätze können ebenfalls lokal konfiguriert werden.

> **Hinweis:** FloCafe ist Software und keine Rechts- oder Steuerberatung. Steuerpakete und Konfigurationswerkzeuge bescheinigen allein keine Einhaltung lokaler Vorschriften.

## Entwicklung

Für die Entwicklung von FloCafe benötigen Sie Node.js 22 oder höher:

```sh
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe
npm install
npm run dev
```

`npm run dev` erstellt Frontend und Backend und startet anschließend Electron.

Weitere Informationen zu Entwicklungsabläufen, Programmierrichtlinien und Tests finden Sie in [CONTRIBUTING.md](CONTRIBUTING.md).

## Hilfe und Dokumentation

- [Dokumentationsindex](docs/README.md)
- [Druckerleitfaden](docs/printers.md)
- [Linux-Einrichtung und Support](docs/linux.md)
- [Internationalisierung und Übersetzungen](docs/i18n.md)
- [Einrichtung der Google-Drive-Sicherung](docs/google-drive-setup.md)
- [GitHub Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues)
- [GitHub Discussions](https://github.com/FreeOpenSourcePOS/FloCafe/discussions)

## Lizenz

FloCafe ist Open-Source-Software unter der [MIT-Lizenz](LICENSE).
