# FloCafe

**面向咖啡馆、餐厅和小型厨房的免费、开源、离线优先销售点系统。**

[English](README.md) | [Español](README.es.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Türkçe](README.tr.md) | [Filipino](README.fil.md) | [Deutsch](README.de.md) | **简体中文**

FloCafe 直接运行在商家的电脑上。订单、客户、收据和备份保存在本地 SQLite 数据库中，因此即使没有互联网连接，柜台服务和厨房显示屏也可以继续运行。核心 POS 操作不需要托管账户或云账户。Google Drive 备份、通过 WhatsApp 发送账单以及云端报表等可选集成可以按需启用。

## 获取 FloCafe

从 [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases) 下载最新安装程序，或通过平台的应用商店安装。也可以使用 [Mac App Store](https://apps.apple.com/in/app/flo-cafe/id6763136018)、[Microsoft Store](https://apps.microsoft.com/detail/9n1md6585p4q) 或 [Snap Store](https://snapcraft.io/flocafe)。

发行版本包含 Windows 安装程序、macOS DMG，以及 Linux 的 AppImage、`.deb`、`.rpm` 和 Snap 软件包。有关 Linux 软件包、更新、FUSE、打印权限和系统托盘行为的信息，请参阅 [Linux 安装与支持指南](docs/linux.md)。

### 系统要求

| 要求 | 最低配置 |
| --- | --- |
| 操作系统 | Windows 10+、macOS 12+，或当前受支持的 Linux 发行版 |
| 内存 | 4 GB RAM |
| 存储空间 | 500 MB 可用空间，另需为本地备份预留空间 |

Node.js 仅用于开发 FloCafe，运行打包版本不需要 Node.js。

<details>
<summary>卸载直接下载的版本</summary>

通过 App Store 和 Microsoft Store 安装的版本，应通过对应商店或操作系统移除。

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

两个脚本都会询问是否保留应用数据。除非你确实要删除本地数据库和备份，否则不要选择清除数据的选项。

</details>

## 主要功能

- **订单流程：** 支持柜台、堂食、外带和配送订单，并提供桌台管理和挂起订单。
- **商品选项与定价：** 支持商品选项、加料组、折扣和客户忠诚度积分。
- **收据打印：** 支持通过 USB、本地网络（TCP）和操作系统打印队列进行 ESC/POS 热敏打印，并在兼容浏览器中支持 WebUSB 以及 58 mm 和 80 mm 纸张。
- **厨房运营：** 提供独立的厨房显示系统（KDS）服务器和按分类路由到厨房工作站的功能。
- **商品目录管理：** 支持商品图片、条形码扫描以及菜单 CSV 导入/导出。
- **管理功能：** 支持基于角色的员工账户（所有者、经理、收银员、服务员和厨师）、销售分析和审计日志。
- **数据保护：** 使用本地 SQLite 数据库，迁移前自动备份，提供手动恢复工具，并支持可选的 Google Drive 备份。

## 项目状态

FloCafe 正在积极开发中，并已用于实际部署。项目通过明确的数据库迁移和恢复机制，谨慎保护客户数据和升级安全。部分内部架构和面向扩展的架构仍在演进，具体实现和内部契约可能会变化。

## 离线优先设计

核心 POS 操作和本地数据支持离线运行。录入订单、结算、KDS 协调和收据打印不依赖互联网或外部云服务。

- SQLite 数据库和本地备份位于操作系统用户数据目录中，与已安装的应用程序文件分开。常规应用更新不会删除这些数据；在重新安装、更换电脑或更换分发渠道前，建议先手动备份。
- FloCafe 在执行数据库架构迁移前会自动创建带时间戳的备份。
- Google Drive 备份、WhatsApp 账单发送和云端报表等服务，只有在商家明确配置并启用后才会通过网络通信。

## 语言和区域支持

FloCafe 提供英语、西班牙语、法语、巴西葡萄牙语、菲律宾语、土耳其语、波斯语（支持 RTL）、德语、意大利语、日语、简体中文、韩语和印度尼西亚语界面。界面语言独立于商店所在国家和区域设置，税费计算规则则属于独立领域。有关贡献翻译或添加语言的信息，请参阅[国际化与翻译指南](docs/architecture/internationalization.md)。

FloCafe 包含 131 个国家/地区配置和 109 种货币。每个配置提供默认货币、区域设置和时区；商家可以在初始化时或之后的设置中修改时区。

## 税务支持

FloCafe 提供通用计算引擎，以及针对区域规则、税务类别和舍入策略的签名、版本化区域税务包。国家/地区覆盖范围会通过目录扩展，具体可用性可能不同。运营者也可以在本地配置手动税务规则和税率。

> **提示：** FloCafe 是软件，不构成法律或税务建议。税务包和配置工具本身不代表符合当地法规；运营者仍需核实适用于其业务的要求。

有关税务包编写、验证和架构的详细信息，请参阅[税务包开发指南](docs/reference/tax-packs.md)。

## 开发

开发 FloCafe 需要 Node.js 22 或更高版本：

```sh
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe
npm install
npm run dev
```

`npm run dev` 会构建前端和后端，然后启动 Electron。

### 架构

```text
Electron 主进程
├── Express API 和 WebSocket 服务器       :3001
├── 独立厨房显示服务器                    :3002
├── 服务员应用服务器                      :3003
└── SQLite 数据库、迁移和打印
                 ↕ HTTP 和 WebSocket
Next.js 渲染器
└── React 界面和 Zustand 客户端状态
```

有关开发流程、代码规范和测试流程，请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 参与贡献

欢迎贡献代码。开始之前请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)：

- **小型 bug 修复、文档改进和有针对性的测试**可以直接开始。
- **新功能、数据库架构变更和架构重构**在实现前需要与维护者讨论并获得批准。

如果 FloCafe 对你有帮助，欢迎为仓库点亮 Star。

## 帮助与文档

- [文档索引](docs/README.md)
- [打印机指南](docs/printers.md)
- [Linux 设置与支持](docs/linux.md)
- [国际化与翻译](docs/architecture/internationalization.md)
- [税务包开发指南](docs/reference/tax-packs.md)
- [Google Drive 备份设置](docs/google-drive-setup.md)
- [GitHub Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues)
- [GitHub Discussions](https://github.com/FreeOpenSourcePOS/FloCafe/discussions)

## 许可证

FloCafe 是采用 [MIT 许可证](LICENSE) 发布的开源软件。
