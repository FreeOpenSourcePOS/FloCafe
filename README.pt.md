# FloCafe

**Ponto de venda gratuito, de código aberto e desenvolvido para funcionar offline em cafés, restaurantes e pequenas cozinhas.**

[English](README.md) | [Español](README.es.md) | **Português** | [Français](README.fr.md) | [Türkçe](README.tr.md) | [Filipino](README.fil.md) | [Deutsch](README.de.md) | [简体中文](README.zh-CN.md)

O FloCafe funciona diretamente no computador do estabelecimento. Pedidos, clientes, recibos e backups são armazenados em um banco de dados SQLite local, permitindo que o atendimento no balcão e as telas da cozinha continuem funcionando sem conexão com a Internet. Nenhuma conta hospedada ou na nuvem é necessária para a operação principal do PDV. Integrações opcionais, como backup no Google Drive, envio de contas pelo WhatsApp e relatórios conectados à nuvem, podem ser ativadas quando necessário.

## Obter o FloCafe

Baixe o instalador mais recente em [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases) ou instale-o pela loja de aplicativos da sua plataforma. Você também pode usar a [Mac App Store](https://apps.apple.com/in/app/flo-cafe/id6763136018), a [Microsoft Store](https://apps.microsoft.com/detail/9n1md6585p4q) ou a [Snap Store](https://snapcraft.io/flocafe).

As versões incluem instaladores para Windows, DMGs para macOS e pacotes AppImage, `.deb`, `.rpm` e Snap para Linux. Consulte o [guia de instalação e suporte do Linux](docs/linux.md) para informações sobre pacotes, atualizações, FUSE, permissões de impressão e comportamento da bandeja do sistema.

### Requisitos do sistema

| Requisito | Mínimo |
| --- | --- |
| Sistema operacional | Windows 10+, macOS 12+ ou uma distribuição Linux atual compatível |
| Memória | 4 GB de RAM |
| Armazenamento | 500 MB livres, além do espaço para backups locais |

Node.js é necessário apenas para desenvolver o FloCafe, não para executar uma versão empacotada.

<details>
<summary>Desinstalar uma versão baixada diretamente</summary>

Instalações da App Store e da Microsoft Store devem ser removidas pela loja correspondente ou pelo sistema operacional.

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

Os dois scripts perguntam se você deseja manter os dados do aplicativo. Não escolha as opções de exclusão de dados a menos que pretenda remover o banco de dados local e os backups.

</details>

## Destaques

- **Fluxos de pedidos:** pedidos no balcão, no salão, para viagem e entrega, com gerenciamento de mesas e pedidos suspensos.
- **Modificadores e preços:** modificadores de itens, grupos de adicionais, descontos e pontos de fidelidade.
- **Impressão de recibos:** impressão térmica ESC/POS por USB, rede local (TCP) e filas de impressão do sistema operacional, com WebUSB em navegadores compatíveis e suporte para papel de 58 mm e 80 mm.
- **Operações de cozinha:** servidor independente de tela de cozinha (KDS) e roteamento de estações por categoria.
- **Gerenciamento do catálogo:** imagens de produtos, leitura de códigos de barras e importação/exportação CSV do cardápio.
- **Administração:** contas de funcionários com funções (proprietário, gerente, caixa, atendente e chef), análise de vendas e registros de auditoria.
- **Proteção de dados:** banco de dados SQLite local, backups automáticos antes das migrações, restauração manual e backup opcional no Google Drive.

## Status do projeto

O FloCafe está em desenvolvimento ativo e já é usado em instalações reais. Os dados dos clientes e a segurança das atualizações são tratados com cuidado por meio de migrações explícitas e mecanismos de recuperação. Parte da arquitetura interna e voltada a extensões ainda está evoluindo, portanto os detalhes de implementação e os contratos internos podem mudar.

## Offline por design

A operação principal do PDV e os dados locais funcionam offline. A criação de pedidos, o faturamento, a coordenação com o KDS e a impressão de recibos não dependem da Internet nem de serviços externos na nuvem.

- O banco SQLite e os backups locais ficam no diretório de dados do usuário, separado dos binários instalados. Atualizações normais não os removem; recomenda-se criar um backup manual antes de reinstalar, trocar de computador ou mudar de canal de distribuição.
- O FloCafe cria automaticamente um backup com data e hora antes de executar migrações do esquema.
- Serviços como backups do Google Drive, envio de contas pelo WhatsApp e relatórios na nuvem só se comunicam pela rede quando configurados e ativados explicitamente pelo proprietário do estabelecimento.

## Idiomas e suporte regional

O FloCafe inclui traduções da interface em inglês, espanhol, francês, português brasileiro, filipino, turco, persa (farsi) com suporte RTL, alemão, italiano, japonês, chinês simplificado, coreano e bahasa indonésio. O idioma da interface é independente do país e das configurações regionais da loja. As regras de cálculo de impostos são uma área separada. Para contribuir com traduções ou adicionar idiomas, consulte o [guia de internacionalização e traduções](docs/i18n.md).

O FloCafe inclui perfis para 131 países e 109 moedas. Cada perfil define moeda, localidade e fuso horário padrão; o proprietário pode alterar o fuso durante a configuração ou depois em Configurações.

## Suporte fiscal

O FloCafe inclui um mecanismo genérico de cálculo e pacotes fiscais regionais assinados e versionados para regras regionais, categorias fiscais e políticas de arredondamento. A cobertura de países é ampliada pelo catálogo e a disponibilidade varia. Também permite configurar regras e alíquotas fiscais manualmente de forma local.

> **Aviso:** FloCafe é software, não aconselhamento jurídico ou fiscal. Pacotes fiscais e ferramentas de configuração não certificam, por si só, conformidade com as normas locais; cada operador é responsável por verificar os requisitos aplicáveis ao seu negócio.

Para detalhes sobre autoria, validação e esquema dos pacotes, consulte o [guia de desenvolvimento de pacotes fiscais](docs/tax-packs.md).

## Desenvolvimento

Para desenvolver o FloCafe, é necessário Node.js 22 ou posterior:

```sh
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe
npm install
npm run dev
```

`npm run dev` compila o frontend e o backend e depois inicia o Electron.

### Arquitetura

```text
Processo principal do Electron
├── API Express e servidor WebSocket       :3001
├── Servidor independente de cozinha       :3002
├── Servidor de aplicativo / atendentes    :3003
└── Banco SQLite, migrações e impressão
                 ↕ HTTP e WebSocket
Renderizador Next.js
└── Interface React e estado do cliente Zustand
```

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para os fluxos de desenvolvimento, padrões de código e procedimentos de testes.

## Contribuir

Contribuições são bem-vindas. Consulte [CONTRIBUTING.md](CONTRIBUTING.md) antes de começar:

- **Pequenas correções de bugs, melhorias na documentação e testes focados** podem ser iniciados livremente.
- **Novos recursos, alterações no esquema do banco de dados e refatorações arquitetônicas** exigem discussão e aprovação dos mantenedores antes da implementação.

Se o FloCafe for útil para você, considere deixar uma estrela no repositório.

## Ajuda e documentação

- [Índice da documentação](docs/README.md)
- [Guia de impressoras](docs/printers.md)
- [Configuração e suporte do Linux](docs/linux.md)
- [Internacionalização e traduções](docs/i18n.md)
- [Guia de desenvolvimento de pacotes fiscais](docs/tax-packs.md)
- [Configuração de backup no Google Drive](docs/google-drive-setup.md)
- [GitHub Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues)
- [GitHub Discussions](https://github.com/FreeOpenSourcePOS/FloCafe/discussions)

## Licença

FloCafe é um software de código aberto sob a [licença MIT](LICENSE).
