# 7. Fase 0 — laboratório de viabilidade

Esta entrega implementa a prova de conceito do runtime escolhido: Chromium em container, sessões por contexto e imagens/interação compartilhadas com a interface Electron. O servidor executa testes headless; a arquitetura comercial continua com sessões no computador do cliente e serviços comerciais no servidor.

## 7.1 O que existe

- Dois endereços de teste, `http://fixture.test/` e `http://canvas.test/`, servidos por uma fixture controlada: formulário de login, SPA autenticada, contadores de efeitos, observação Unicode e canvas animado com carga configurável.
- Perfis configuráveis por URL dentro dessas origens, até 12 perfis de demonstração, quatro contextos visíveis e duas tarefas de fundo. Os limites são do laboratório, não do plano comercial.
- Login pelo formulário e pelo canal de entrada remoto, sem replicar senha, usuário do formulário de login ou submit de autenticação para outras contas.
- Checkpoint cifrado de cookies, localStorage, IndexedDB e sessionStorage, vinculado a tenant/grupo/perfil. A restauração é testada depois de reiniciar o processo/container do laboratório.
- Captura via CDP, JPEG 720×480 e cache apenas do frame mais recente por conta. A captura aceita cada mudança visual (`everyNthFrame=1`) e retarda os acknowledgements por 250 ms para aplicar pressão no produtor, preservando também a imagem de páginas estáticas. O protótipo busca os frames em intervalos de aproximadamente 180 ms; WebSocket binário é evolução da fase 4.
- Componente React compartilhado entre Electron e o verificador: layouts 1–4, indicação de líder, espelhamento, texto para o campo em foco, rolagem, gravação e edição de receitas e confirmação do dry-run.
- Receita declarativa limitada a navegar, clicar, preencher e verificar. Execução de prova com dez contas, dois workers lógicos e nenhuma chamada arbitrária a JavaScript fornecido pelo usuário.
- Relatório JSON, amostras reais de CPU/memória e imagem da interface operando as sessões.

A captura e a persistência usam as APIs documentadas de [CDPSession](https://playwright.dev/docs/api/class-cdpsession) e [storageState](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state). A separação de sessionStorage é implementada explicitamente por origem; um snapshot não representa um perfil completo de qualquer website.

## 7.2 Executar no servidor

Pré-requisitos: os mesmos da fase 1 — Node.js, OpenSSL e Docker/Compose.

```bash
npm ci
npm run phase0:up
npm run server:up
npm run server:check
```

`phase0:up` inicia somente fixture, gateway e laboratório. Nenhuma porta do laboratório é publicada no host. O gateway aceita apenas as duas origens de teste; outros destinos e CONNECT são recusados. O runtime de sessões permanece com `network_mode: none`, usando um socket Unix exclusivo para alcançar esse gateway.

A API existente recebe `/v1/lab/status`, `/v1/lab/command` e `/v1/lab/frame/:accountId`. Todas as rotas passam pelo pareamento/TLS mútuo e pelo tenant configurado na instalação. O canal API→laboratório requer outra capacidade privada, e os DTOs são validados novamente no runtime. O renderer recebe apenas os métodos tipados pela bridge do preload; não acessa socket, CDP, chave ou filesystem.

O laboratório é um ambiente de demonstração com chave própria em `.runtime/lab/root-key`, protegida por permissões e montada separadamente do volume de snapshots. Ele usa exclusivamente contas fictícias. Essa provisão de chave para testes não substitui a proteção por cofre do SO/senha já implementada para o cliente, nem habilita automação de sites reais com o cofre bloqueado.

Em máquina com ambiente gráfico, depois de iniciar os serviços locais:

```bash
npm run desktop:dev
```

Conecte a instalação e escolha **Abrir laboratório**. Para entrar na fixture, use um usuário como `demo-minha-conta` e a senha de demonstração `phase0-demo`. Clique no campo dentro da imagem, selecione a conta em foco e envie o texto pelo controle abaixo dos painéis. Os botões de seta rolam a página remota. Ative o espelhamento depois de autenticar cada conta individualmente.

O seletor de URL está pronto para testar perfis sem integração específica, mas esta prova aceita apenas as origens de fixture. Proxies comerciais, destinos públicos e a configuração de compatibilidade de sites reais entram na fase 2; não há declaração de compatibilidade universal nesta entrega.

## 7.3 Verificação completa sem interface gráfica física

```bash
npm run phase0:verify
```

O comando cria um projeto Docker temporário com nome exclusivo, executa os testes, reinicia o runtime, valida a restauração e remove somente os containers/volumes desse teste. Os dados da fase 1 e do laboratório persistente não são removidos. Evidências ficam em:

```text
.runtime/artifacts/msm-phase0-check-<id>/report.json
.runtime/artifacts/msm-phase0-check-<id>/workbench.png
.runtime/artifacts/phase0-latest.json
```

Casos executados:

1. Estado inicial vazio, ausência de saída IP direta e recusa de URL interna/não permitida.
2. Imagem inicial de login estático antes de qualquer entrada, login pelo formulário em quatro contas, isolamento e marcadores separados nos três storages.
3. Quatro streams CDP simultâneos e limite de painéis.
4. Captura de clique semântico, réplicas verificadas e parada quando a principal rejeita a ação.
5. Canvas, slider, clique e recusa de espelhamento entre origens diferentes.
6. Componente React real: layouts 1–4, input Unicode, gravação, simulação e confirmação pela interface.
7. Dry-run sem efeitos, hash adulterado rejeitado, confirmação idempotente e 30 passos em dez contas.
8. Quatro contas visíveis mais duas tarefas de fundo, respeitando seis contextos no total.
9. Falha no segundo passo bloqueando o terceiro, sem retry cego ou efeito extra.
10. Cancelamento e invalidação de plano após uma alteração de estado.
11. Restauração após reiniciar o container, preservando autenticação e storages, sem liberar conta com resultado incerto.

O verificador também usa HTTP somente leitura da fixture para inspecionar contas dormentes sem abrir Chromium. Essa é uma capacidade conhecida dessa fixture; não é um health check universal de sessão ou ban.

## 7.4 Electron real com display virtual

Com API e laboratório persistente iniciados, no servidor Linux:

```bash
npm run phase0:electron:verify
```

O verificador usa o binário Electron fixado e obtido pelo instalador oficial com verificação de checksum. Em Linux, monta o binário de `node_modules/electron/dist` somente para leitura no runner, evitando guardar outra cópia pesada em uma imagem de testes. Usa Xvfb dentro do container e abre o aplicativo real em um display virtual, sem janela no desktop físico do servidor. Verifica pareamento por TLS, Main→preload→React, quatro imagens reais e os indicadores de sandbox/context isolation do preload. O código da página não recebe `require`.

Artefatos:

```text
.runtime/artifacts/phase0-electron/electron-report.json
.runtime/artifacts/phase0-electron/electron-workbench.png
```

Essa execução é limitada a Linux e à arquitetura do servidor. Cofre nativo de Windows/macOS, IME físico, HiDPI, aceleração de GPU e instaladores precisam de validação nos computadores cliente. A entrada Unicode pelo componente HTML foi testada; isso não é evidência de todas as implementações de IME do sistema operacional.

Executado e aprovado em 04/11/2026 em Linux arm64: quatro painéis, TLS mútuo, caminho Main/preload/renderer, `sandboxed=true`, `contextIsolated=true` e ausência de `require` na página. Esse resultado está no relatório Electron separado; a suíte headless da seção anterior avalia o componente compartilhado sem iniciar o binário desktop.

## 7.5 Como interpretar desempenho

O relatório registra o ambiente, a quota de duas CPUs do worker, limite de 2 GiB, amostras por fase e os casos aprovados. `memory.current` é memória cobrada ao container, incluindo caches; a soma de RSS dos processos pode contar páginas compartilhadas várias vezes e não deve ser apresentada como RAM física exclusiva.

`meanCpuCores` usa a diferença de CPU do cgroup dividida pelo tempo observado dentro de cada fase. `framesPerSecond` conta frames mantidos pelo produtor, não garante que todos chegaram à tela. `mirrorDispatchP95Ms` mede somente admissão das seguidoras dentro do worker após a principal; `mirrorRoundTripP95Ms` inclui a chamada de controle, resolução do alvo e conclusão das réplicas na fixture. Não comparar essas duas medidas como se tivessem a mesma fronteira.

As medições do worker excluem o container do verificador/GUI, fixture, gateway e a infraestrutura da fase 1. São ensaios curtos com carga controlada; não constituem requisito mínimo de hardware, SLA ou benchmark de 500 contas. A decisão desta fase é manter o caminho Docker+streaming para o MVP, preservando o requisito de isolamento. Não foi demonstrado que ele supera um runtime alternativo com WebContentsView nativo.

Resultados observados em 04/11/2026, Linux arm64, worker limitado a duas CPUs e 2 GiB:

| Cenário | Pico de memória cobrada ao worker | CPU média observada, em núcleos | Contextos máximos |
| --- | --- | --- | --- |
| Ocioso inicial | 101,8 MiB | 0,10 | 0 |
| Uma conta | 297,1 MiB | 0,39 | 1 |
| Duas contas | 396,3 MiB | 0,77 | 2 |
| Quatro contas | 568,1 MiB | 1,13 | 4 |
| Canvas mais pesado | 597,2 MiB | 1,32 | 4 |
| Receita em dez contas dormentes | 460,3 MiB | 1,18 | 2 |
| Quatro visíveis + duas de fundo | 821,4 MiB | 1,04 | 6 |

Na execução `msm-phase0-check-3a7540`, o p95 de despacho para seguidoras foi 0,76 ms; o p95 da ida e volta do comando espelhado, incluindo conclusão na fixture, foi 1.391,5 ms. Os 11 cenários levaram cerca de 114 segundos, sem incluir construção das imagens e o teste Electron separado. A última execução inclui a verificação da tela de login estática antes de qualquer interação.

Com quatro contas, foram mantidos aproximadamente 40,7 frames/s no total; sob quatro visíveis mais duas tarefas de fundo, aproximadamente 16,0 frames/s no total, incluindo frames dos contextos de fundo. Essa queda e a latência de conclusão sob quota de duas CPUs precisam orientar a prioridade de UI/admissão da fase 4. O protótipo comprova o fluxo funcional; a meta de baixa latência do produto continua pendente. Estes números não são promessa de fluidez para qualquer jogo.

## 7.6 Segurança e limites da prova

Dados de sessão são cifrados com a biblioteca da fase 1 e nunca gravados em JSON aberto. A fila de escrita usa rename atômico e serialização; comandos da mesma conta são ordenados. Resultado incerto permanece bloqueado após reinício. Frames não entram nos arquivos de sessão nem nos tickets de trabalho.

O espelhamento resolve um locator próprio em cada conta; canvas não é convertido automaticamente em receita replicável. A fixture implementa pós-condições conhecidas para suas ações. Credenciais de login ficam fora das receitas e réplicas.

O estado de campanhas deste laboratório é um ledger de prova em arquivos. Um processo interrompido marca campanhas antigas como interrompidas e não as reexecuta. Outbox, BullMQ, leases distribuídos, reconciliação por recibos e administração de produção continuam pertencendo às fases seguintes.

Para parar o laboratório sem apagar seus snapshots:

```bash
npm run phase0:down
```

A suíte atual, ampliada pela fase 2, reúne 15 testes unitários e 19 de integração; a prova de sessões permanece em seu gate próprio. O gate `npm run phase1:verify` também verifica o cofre no Electron real, conforme o [guia da fase 1](06-fase-1-execucao.md).

O smoke test do Electron com quatro painéis foi executado novamente com sucesso em 05/11/2026 após a integração do cadastro da fase 2 e a atualização do comando para reutilizar o binário oficial do host em Linux.
