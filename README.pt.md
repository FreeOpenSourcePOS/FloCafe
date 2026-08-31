# FloCafe

**Ponto de venda gratuito, de código aberto e desenvolvido para funcionar offline em cafés, restaurantes e pequenas cozinhas.**

[English](README.md) | [Español](README.es.md) | **Português** | [Français](README.fr.md)

O FloCafe funciona diretamente no computador do estabelecimento. Pedidos, clientes, recibos e backups são armazenados em um banco de dados SQLite local, permitindo que o atendimento no balcão e as telas da cozinha continuem funcionando sem conexão com a Internet. Nenhuma conta hospedada ou na nuvem é necessária para a operação principal do PDV. Integrações opcionais, como backup no Google Drive, envio de contas pelo WhatsApp e relatórios conectados à nuvem, podem ser ativadas quando necessário.

## Obter o FloCafe

Baixe o instalador mais recente em [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases) ou instale-o pela loja de aplicativos da sua plataforma.

As versões incluem instaladores para Windows, DMGs para macOS e pacotes AppImage, `.deb`, `.rpm` e Snap para Linux. Consulte o [guia de instalação e suporte do Linux](docs/linux.md) para informações sobre pacotes, atualizações, FUSE, permissões de impressão e comportamento da bandeja do sistema.

### Requisitos do sistema

| Requisito | Mínimo |
| --- | --- |
| Sistema operacional | Windows 10+, macOS 12+ ou uma distribuição Linux atual compatível |
| Memória | 4 GB de RAM |
| Armazenamento | 500 MB livres, além do espaço para backups locais |

Node.js é necessário apenas para desenvolver o FloCafe, não para executar uma versão empacotada.

## Destaques

- **Fluxos de pedidos:** pedidos no balcão, no salão, para viagem e entrega, com gerenciamento de mesas e pedidos suspensos.
- **Modificadores e preços:** modificadores de itens, grupos de adicionais, descontos e pontos de fidelidade.
- **Impressão de recibos:** impressão térmica ESC/POS por USB, rede local TCP e filas de impressão do sistema operacional, com WebUSB em navegadores compatíveis.
- **Operações de cozinha:** servidor independente de tela de cozinha (KDS) e roteamento de estações por categoria.
- **Gerenciamento do catálogo:** imagens de produtos, leitura de códigos de barras e importação/exportação CSV do cardápio.
- **Administração:** contas de funcionários com funções, análise de vendas e registros de auditoria.
- **Proteção de dados:** banco de dados SQLite local, backups automáticos antes das migrações, restauração manual e backup opcional no Google Drive.

## Status do projeto

O FloCafe está em desenvolvimento ativo e já é usado em instalações reais. Os dados dos clientes e a segurança das atualizações são tratados com cuidado por meio de migrações explícitas e mecanismos de recuperação.

## Offline por design

A operação principal do PDV e os dados locais funcionam offline. A criação de pedidos, o faturamento, a coordenação com o KDS e a impressão de recibos não dependem da Internet nem de serviços externos na nuvem.

- O banco SQLite e os backups locais ficam no diretório de dados do usuário, separado dos binários instalados.
- O FloCafe cria automaticamente um backup com data e hora antes de executar migrações do esquema.
- Recursos opcionais de rede só se comunicam quando configurados e ativados explicitamente pelo proprietário do estabelecimento.

## Idiomas e suporte regional

O FloCafe inclui traduções da interface em inglês, espanhol, português brasileiro e persa (farsi), incluindo suporte RTL. O idioma da interface é independente do país e das configurações regionais da loja. As regras de cálculo de impostos são uma área separada.

O FloCafe inclui perfis para 131 países e 109 moedas. Cada perfil define moeda, localidade e fuso horário padrão; o proprietário pode alterar o fuso durante a configuração ou depois em Configurações.

## Suporte fiscal

O FloCafe inclui um mecanismo genérico de cálculo e pacotes fiscais regionais assinados e versionados. Também permite configurar regras e alíquotas fiscais manualmente de forma local.

> **Aviso:** FloCafe é software, não aconselhamento jurídico ou fiscal. Pacotes fiscais e ferramentas de configuração não certificam, por si só, conformidade com as normas locais.

## Desenvolvimento

Para desenvolver o FloCafe, é necessário Node.js 22 ou posterior:

```sh
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe
npm install
npm run dev
```

`npm run dev` compila o frontend e o backend e depois inicia o Electron.

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para os fluxos de desenvolvimento, padrões de código e procedimentos de testes.

## Ajuda e documentação

- [Índice da documentação](docs/README.md)
- [Guia de impressoras](docs/printers.md)
- [Configuração e suporte do Linux](docs/linux.md)
- [Internacionalização e traduções](docs/i18n.md)
- [Configuração de backup no Google Drive](docs/google-drive-setup.md)
- [GitHub Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues)
- [GitHub Discussions](https://github.com/FreeOpenSourcePOS/FloCafe/discussions)

## Licença

FloCafe é um software de código aberto sob a [licença MIT](LICENSE).
