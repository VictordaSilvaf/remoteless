# MultiSession Manager

**Aplicação:** 0.1.0 · **Especificação:** 1.1 · **Estado:** fases 0, 1 e 2 implementadas nos escopos de laboratório, fundação e cadastro/proxies, validadas em Linux arm64.

Especificação de um aplicativo Electron por assinatura para administrar até 500 contas em sites selecionados pelo cliente, visualizar de uma a quatro contas e executar rotinas com isolamento, confirmação e recuperação de falhas. O núcleo oferece navegação e sessões genéricas; automações e diagnósticos avançados dependem das capacidades configuradas para cada site.

O repositório contém a especificação, a fundação, o cadastro e um laboratório funcional: API com TLS mútuo, PostgreSQL com RLS, Redis, cofre, Electron, CRUD de contas/grupos/sites/proxies, importação com revisão e prova de quatro sessões com streaming, espelhamento e receitas em contas fictícias. Posse de sessões de produção, filas duráveis, visualização integrada dessas contas e integrações de automação pertencem às próximas fases. Metas da especificação não devem ser confundidas com os resultados medidos nas fixtures.

## Executar no servidor, sem interface gráfica

Requer Node.js 22.16+, OpenSSL e Docker com Compose. As imagens e bibliotecas estão fixadas no lockfile e nos Dockerfiles.

```bash
npm ci
npm run setup
npm run doctor
npm run server:up
npm run server:check
```

`npm start` e `npm run dev` também iniciam o backend em Docker. A API usa TLS mútuo e fica publicada somente em `127.0.0.1:17643`; banco e Redis ficam na rede interna. O primeiro `server:check` consome o token de pareamento e verifica a instalação real. Cofre bloqueado inicialmente é esperado.

O servidor atual é usado para desenvolvimento e testes headless. A arquitetura de produto mantém sessões/automações no computador do cliente e reserva o servidor central para identidade, assinatura, administração e atualizações; esse plano remoto será implementado na fase 6.

Para abrir a interface **em um computador com ambiente gráfico**, use `npm run desktop:dev`. Esse comando instala o binário oficial do Electron quando necessário. O renderer nunca recebe os certificados privados nem a chave raiz do cofre.

Veja [execução e validação da fase 1](docs/06-fase-1-execucao.md) para os testes, limitações e estrutura efetivamente implementada.

Para repetir o gate completo da fundação, execute `npm run phase1:verify`. Ele cria uma instalação temporária, testa banco, TLS, sandbox e cofre no Electron real com Xvfb, reinicia a API e remove seus próprios containers/volumes. Não publica portas de teste nem inicializa o cofre da instalação atual. O resultado fica em `.runtime/artifacts/phase1-latest.json`.

Para validar também o cadastro, execute `npm run phase2:verify`. Inclui importação de 500 linhas, concorrência de limites, protocolos de proxy reais em fixtures locais e nove fluxos da interface Electron. No aplicativo, conecte/desbloqueie o cofre e escolha **Abrir cadastro**. Consulte o [guia da fase 2](docs/08-fase-2-cadastro-e-proxies.md).

## Laboratório da fase 0

```bash
npm run phase0:up
npm run server:up
npm run phase0:verify
```

São testados login, storages, quatro painéis, espelhamento, canvas, receitas em dez contas e restauração após reinício. Relatórios e imagens ficam em `.runtime/artifacts/`. O servidor também pode testar o Electron real com Xvfb usando `npm run phase0:electron:verify`. Consulte o [guia do laboratório](docs/07-fase-0-laboratorio.md) para o escopo e as fronteiras das medições.

## Documentos

1. [Arquitetura, decisões e fluxos](docs/01-arquitetura-e-fluxos.md) — componentes, espelhamento, processamento em massa, filas, sessões, proxies e health checks.
2. [Modelo de dados e contratos](docs/02-dados-e-contratos.md) — entidades, relações, restrições, transações, APIs, eventos e interface dos adaptadores.
3. [Segurança, operação e implementação](docs/03-seguranca-operacao-e-plano.md) — autenticação, planos, criptografia, Docker, capacidade, UX, riscos, fases e estrutura de pastas.
4. [Critérios de aceite e rastreabilidade](docs/04-aceite-e-rastreabilidade.md) — cenários verificáveis, matriz de requisitos e decisões que precisam de homologação.
5. [Sites escolhidos pelo cliente e otimização](docs/05-sites-configuraveis-e-otimizacao.md) — atualização de escopo, prioridades de desempenho, receitas genéricas, limites de compatibilidade e comparação de runtimes.
6. [Execução da fase 1](docs/06-fase-1-execucao.md) — código implementado, comandos para servidor/cliente, validação, certificados e limitações desta entrega.
7. [Laboratório da fase 0](docs/07-fase-0-laboratorio.md) — login, quatro painéis, streaming, receitas, benchmark e testes headless.
8. [Cadastro e proxies da fase 2](docs/08-fase-2-cadastro-e-proxies.md) — contas/grupos/sites, importação com revisão, limites transacionais e diagnóstico de proxies reais.

## Decisões que orientam o projeto

- PostgreSQL mantém os fatos duráveis; Redis/BullMQ transportam trabalho e podem ser reconstruídos a partir desses fatos.
- Uma conta tem um único responsável pela sessão e uma sequência persistida de ações. Visualização, espelhamento, automação e health check obedecem à mesma coordenação.
- Cada conta usa seu próprio `BrowserContext`; grupos distintos usam processos Chromium e containers distintos enquanto ativos. O número de contas cadastradas não determina quantos navegadores são abertos.
- A interface Electron recebe imagens das sessões executadas nos workers. Assim, a conta exibida e a conta automatizada utilizam o mesmo contexto.
- Ações em massa exigem simulação sem efeitos externos e confirmação de um plano imutável. O modo imediato também respeita os limites de segurança e concorrência.
- A entrega de trabalho admite repetição. Quando um efeito externo não pode ser confirmado, a ação fica com resultado incerto e bloqueia as sucessoras até reconciliação.
- Licenciamento e administração global ficam em um serviço remoto separado. Credenciais dos sites e sessões permanecem na instalação local.

Isolamento de storage, proxy e processo não garante identidade de máquina distinta nem indetectabilidade. A especificação explicita essa limitação, o escopo de perfis de ambiente e a opção de VMs para requisitos mais fortes.

## Como revisar

Comece pela atualização de escopo do documento 5, pelas premissas do documento 1 e pelo contrato de consistência do documento 2. A fase 0 usa sites de teste controlados para validar persistência de autenticação, proxy e visualização de quatro contas; o produto permite configurar sites depois. Cada integração avançada possui homologação própria. Use o documento 4 para aprovar cada fase com evidências.

As referências oficiais estão vinculadas junto das afirmações técnicas em cada documento. Elas fundamentam capacidades das ferramentas; as decisões de desenho e metas propostas são específicas deste projeto.
