# FloCafe

**Punto de venta gratuito, de código abierto y diseñado para funcionar sin conexión para cafeterías, restaurantes y pequeñas cocinas.**

[English](README.md) | **Español** | [Português](README.pt.md) | [Français](README.fr.md) | [Türkçe](README.tr.md) | [Filipino](README.fil.md) | [Deutsch](README.de.md) | [简体中文](README.zh-CN.md)

FloCafe funciona directamente en el ordenador del negocio. Los pedidos, clientes, recibos y copias de seguridad se guardan en una base de datos SQLite local, por lo que el servicio de mostrador y las pantallas de cocina pueden seguir funcionando sin conexión a Internet. No se necesita una cuenta alojada ni en la nube para las funciones principales del TPV. Las integraciones opcionales, como las copias de seguridad en Google Drive, el envío de facturas por WhatsApp y los informes conectados a la nube, pueden activarse cuando sea necesario.

## Obtener FloCafe

Descarga el instalador más reciente desde [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases), o instala FloCafe desde la tienda de aplicaciones de tu plataforma. También puedes usar la [Mac App Store](https://apps.apple.com/in/app/flo-cafe/id6763136018), [Microsoft Store](https://apps.microsoft.com/detail/9n1md6585p4q) o [Snap Store](https://snapcraft.io/flocafe).

Las versiones incluyen instaladores para Windows, DMG para macOS y paquetes AppImage, `.deb`, `.rpm` y Snap para Linux. Consulta la [guía de instalación y soporte de Linux](docs/linux.md) para obtener información específica sobre paquetes, actualizaciones, FUSE, permisos de impresión y la bandeja del sistema.

### Requisitos del sistema

| Requisito | Mínimo |
| --- | --- |
| Sistema operativo | Windows 10+, macOS 12+ o una distribución Linux compatible actual |
| Memoria | 4 GB de RAM |
| Almacenamiento | 500 MB libres, además del espacio para copias de seguridad locales |

Node.js solo es necesario para desarrollar FloCafe, no para ejecutar una versión empaquetada.

<details>
<summary>Desinstalar una versión descargada directamente</summary>

Las instalaciones desde App Store y Microsoft Store deben eliminarse desde la tienda correspondiente o desde el sistema operativo.

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

Ambos scripts preguntan si quieres conservar los datos de la aplicación. No elijas las opciones para eliminar datos a menos que quieras borrar la base de datos local y las copias de seguridad.

</details>

## Funciones principales

- **Flujos de pedidos:** pedidos de mostrador, mesa, para llevar y entrega, con gestión de mesas y pedidos retenidos.
- **Modificadores y precios:** modificadores de artículos, grupos de complementos, descuentos y puntos de fidelidad.
- **Impresión de recibos:** impresión térmica ESC/POS por USB, red local (TCP) y colas de impresión del sistema operativo, con WebUSB en navegadores compatibles y papel de 58 mm y 80 mm.
- **Operaciones de cocina:** servidor independiente de pantalla de cocina (KDS) y asignación de estaciones por categoría.
- **Gestión del catálogo:** imágenes de productos, lectura de códigos de barras e importación/exportación CSV del menú.
- **Administración:** cuentas de personal con roles (propietario, gerente, cajero, camarero y chef), análisis de ventas y registros de auditoría.
- **Protección de datos:** base de datos SQLite local, copias automáticas antes de migraciones, restauración manual y copias opcionales en Google Drive.

## Estado del proyecto

FloCafe está en desarrollo activo y ya se utiliza en instalaciones reales. La seguridad de los datos de clientes y las actualizaciones se trata con cuidado mediante migraciones explícitas y mecanismos de recuperación. Parte de la arquitectura interna y orientada a extensiones todavía está evolucionando, por lo que los detalles de implementación y los contratos internos pueden cambiar.

## Diseñado para funcionar sin conexión

Las funciones principales del TPV y los datos locales funcionan sin conexión. La creación de pedidos, la facturación, la coordinación con KDS y la impresión de recibos no dependen de Internet ni de servicios externos en la nube.

- La base de datos SQLite y las copias locales se guardan en el directorio de datos del usuario, separado de los binarios instalados. Las actualizaciones normales no los eliminan; se recomienda crear una copia manual antes de reinstalar, cambiar de equipo o cambiar de canal de distribución.
- FloCafe crea automáticamente una copia de seguridad con fecha y hora antes de ejecutar migraciones del esquema.
- Servicios como las copias de seguridad en Google Drive, el envío de facturas por WhatsApp y los informes en la nube solo se comunican por la red cuando el propietario del negocio los configura y activa explícitamente.

## Idiomas y soporte regional

FloCafe incluye traducciones de la interfaz en inglés, español, francés, portugués brasileño, filipino, turco, persa (farsi) con soporte RTL, alemán, italiano, japonés, chino simplificado, coreano y bahasa indonesio. El idioma de la interfaz es independiente del país de la tienda y de la configuración regional. Las reglas de cálculo de impuestos son un aspecto separado. Para contribuir traducciones o añadir idiomas, consulta la [guía de internacionalización y traducciones](docs/architecture/internationalization.md).

FloCafe incluye perfiles para 131 países y 109 monedas. Cada perfil establece una moneda, configuración regional y zona horaria predeterminadas; el propietario puede cambiar la zona horaria durante la configuración o más adelante en Ajustes.

## Soporte fiscal

FloCafe incluye un motor de cálculo genérico y paquetes fiscales regionales firmados y versionados para reglas regionales, categorías fiscales y políticas de redondeo. La cobertura de países se amplía mediante el catálogo y la disponibilidad varía. También permite configurar reglas y tipos impositivos manuales localmente.

> **Aviso:** FloCafe es software, no asesoramiento legal ni fiscal. Los paquetes fiscales y las herramientas de configuración no certifican por sí mismos el cumplimiento de las normativas locales; cada operador debe verificar los requisitos aplicables a su negocio.

Para obtener información sobre la creación, validación y el esquema de los paquetes, consulta la [guía para desarrolladores de paquetes fiscales](docs/reference/tax-packs.md).

## Desarrollo

Para desarrollar FloCafe necesitas Node.js 22 o posterior:

```sh
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe
npm install
npm run dev
```

`npm run dev` compila el frontend y el backend y después inicia Electron.

### Arquitectura

```text
Proceso principal de Electron
├── API Express y servidor WebSocket       :3001
├── Servidor independiente de cocina       :3002
├── Servidor de aplicación / camareros     :3003
└── Base SQLite, migraciones e impresión
                 ↕ HTTP y WebSocket
Renderizador Next.js
└── Interfaz React y estado cliente Zustand
```

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para conocer los flujos de desarrollo, las normas de código y los procedimientos de pruebas.

## Contribuir

Las contribuciones son bienvenidas. Consulta [CONTRIBUTING.md](CONTRIBUTING.md) antes de empezar:

- **Las correcciones pequeñas, mejoras de documentación y pruebas específicas** pueden iniciarse libremente.
- **Las funciones nuevas, cambios de esquema de base de datos y refactorizaciones arquitectónicas** requieren conversación y aprobación de los mantenedores antes de implementarse.

Si FloCafe te resulta útil, considera marcar el repositorio con una estrella.

## Ayuda y documentación

- [Índice de documentación](docs/README.md)
- [Guía de impresoras](docs/printers.md)
- [Configuración y soporte de Linux](docs/linux.md)
- [Internacionalización y traducciones](docs/architecture/internationalization.md)
- [Guía para desarrolladores de paquetes fiscales](docs/reference/tax-packs.md)
- [Configuración de copias en Google Drive](docs/google-drive-setup.md)
- [GitHub Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues)
- [GitHub Discussions](https://github.com/FreeOpenSourcePOS/FloCafe/discussions)

## Licencia

FloCafe es software de código abierto bajo la [licencia MIT](LICENSE).
