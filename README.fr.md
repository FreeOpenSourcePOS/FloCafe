# FloCafe

**Point de vente gratuit, open source et conçu pour fonctionner hors ligne pour les cafés, restaurants et petites cuisines.**

[English](README.md) | [Español](README.es.md) | [Português](README.pt.md) | **Français**

FloCafe fonctionne directement sur l’ordinateur de l’établissement. Les commandes, les clients, les reçus et les sauvegardes sont stockés dans une base de données SQLite locale. Le service au comptoir et les écrans de cuisine peuvent donc continuer à fonctionner sans connexion Internet. Aucun compte hébergé ou cloud n’est nécessaire pour l’utilisation principale du point de vente. Des intégrations optionnelles, comme les sauvegardes Google Drive, l’envoi de factures par WhatsApp et les rapports connectés au cloud, peuvent être activées si nécessaire.

## Obtenir FloCafe

Téléchargez le dernier installateur depuis [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases), ou installez FloCafe depuis la boutique d’applications de votre plateforme.

Les versions comprennent des installateurs Windows, des DMG macOS ainsi que des paquets AppImage, `.deb`, `.rpm` et Snap pour Linux. Consultez le [guide d’installation et d’assistance Linux](docs/linux.md) pour les informations concernant les paquets, les mises à jour, FUSE, les permissions d’impression et la barre d’état système.

### Configuration requise

| Exigence | Minimum |
| --- | --- |
| Système d’exploitation | Windows 10+, macOS 12+ ou une distribution Linux actuelle prise en charge |
| Mémoire | 4 Go de RAM |
| Stockage | 500 Mo libres, plus l’espace nécessaire aux sauvegardes locales |

Node.js est uniquement nécessaire pour développer FloCafe, pas pour exécuter une version empaquetée.

## Points forts

- **Flux de commandes :** commandes au comptoir, sur place, à emporter et en livraison, avec gestion des tables et des commandes mises en attente.
- **Modificateurs et tarifs :** modificateurs d’articles, groupes d’options, remises et points de fidélité.
- **Impression des reçus :** impression thermique ESC/POS par USB, réseau local TCP et files d’impression du système, avec WebUSB dans les navigateurs compatibles.
- **Opérations en cuisine :** serveur autonome d’écran de cuisine (KDS) et routage des stations par catégorie.
- **Gestion du catalogue :** images des produits, lecture des codes-barres et import/export CSV du menu.
- **Administration :** comptes du personnel avec rôles, analyses des ventes et journaux d’audit.
- **Protection des données :** base SQLite locale, sauvegardes automatiques avant migration, outils de restauration manuelle et sauvegarde Google Drive optionnelle.

## État du projet

FloCafe est activement développé et déjà utilisé dans des déploiements réels. Les données clients et la sécurité des mises à niveau sont protégées avec des migrations explicites et des mécanismes de récupération.

## Conçu pour fonctionner hors ligne

Les fonctions principales du point de vente et les données locales fonctionnent hors ligne. La saisie des commandes, la facturation, la coordination KDS et l’impression des reçus ne dépendent pas d’Internet ni de services cloud externes.

- La base SQLite et les sauvegardes locales se trouvent dans le répertoire de données de l’utilisateur, séparé des binaires installés.
- FloCafe crée automatiquement une sauvegarde horodatée avant d’exécuter les migrations du schéma.
- Les fonctions réseau optionnelles ne communiquent que lorsqu’elles sont explicitement configurées et activées par le propriétaire de l’établissement.

## Langues et support régional

FloCafe propose des traductions de l’interface en anglais, espagnol, portugais brésilien et persan (farsi), avec prise en charge RTL. La langue de l’interface est indépendante du pays et des paramètres régionaux du magasin. Les règles de calcul des taxes constituent un domaine séparé.

FloCafe inclut des profils pour 131 pays et 109 devises. Chaque profil définit une devise, une région et un fuseau horaire par défaut ; le propriétaire peut modifier le fuseau horaire lors de la configuration ou plus tard dans les paramètres.

## Gestion des taxes

FloCafe comprend un moteur de calcul générique ainsi que des packs fiscaux régionaux signés et versionnés. Il permet également de configurer localement des règles et taux de taxe manuels.

> **Avertissement :** FloCafe est un logiciel, et non un conseil juridique ou fiscal. Les packs fiscaux et les outils de configuration ne certifient pas à eux seuls la conformité aux réglementations locales.

## Développement

Le développement de FloCafe nécessite Node.js 22 ou une version ultérieure :

```sh
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe
npm install
npm run dev
```

`npm run dev` compile le frontend et le backend, puis lance Electron.

Consultez [CONTRIBUTING.md](CONTRIBUTING.md) pour les procédures de développement, les conventions de code et les tests.

## Aide et documentation

- [Index de la documentation](docs/README.md)
- [Guide des imprimantes](docs/printers.md)
- [Configuration et assistance Linux](docs/linux.md)
- [Internationalisation et traductions](docs/i18n.md)
- [Configuration des sauvegardes Google Drive](docs/google-drive-setup.md)
- [GitHub Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues)
- [GitHub Discussions](https://github.com/FreeOpenSourcePOS/FloCafe/discussions)

## Licence

FloCafe est un logiciel open source distribué sous [licence MIT](LICENSE).
