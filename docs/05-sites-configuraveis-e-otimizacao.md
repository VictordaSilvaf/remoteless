# 5. Sites configuráveis e otimização

**Atualização de escopo — 04/11/2026:** o cliente escolhe o site depois da instalação. O desenvolvimento inicial usa sites de teste controlados. Não exigir URL real do cliente para implementar o núcleo. Este documento complementa os anteriores e orienta a aplicação dos exemplos de domínio que eles contêm.

## 5.1 Produto genérico com capacidades explícitas

Separar três capacidades que têm níveis diferentes de compatibilidade:

| Camada | Entrega | Limites |
| --- | --- | --- |
| Núcleo genérico | URL escolhida pelo cliente, perfis/sessões isolados, login manual, proxies, 1–4 painéis e monitoramento de recursos | Site pode exigir recursos de browser, autenticação ou renderização ainda não suportados; sessão salva pode expirar |
| Receitas configuráveis | Gravar/editar navegação, clique, preenchimento por referência, espera e assertiva; preview e execução controlada em outras contas | Estrutura/estado precisam ser compatíveis; canvas, iframes e mudanças de DOM podem exigir configuração adicional |
| Integrações específicas | Login automatizado, ações semânticas de negócio, health HTTP e reconciliação conhecendo o site | Exigem desenvolvimento/homologação por site e versão |

“Aceitar uma URL” não significa saber se uma compra foi concluída, se uma conta foi banida ou qual endpoint permite checar sessão. No modo genérico, a interface distingue “interação enviada”, “condição visual confirmada” e “resultado de negócio confirmado por integração”. Timeout após um clique mutável pode gerar resultado incerto, nunca retry cego.

O primeiro MVP permite configurar um site e entrar manualmente nas contas. Automatizar credenciais de qualquer formulário não é requisito para disponibilizar navegação e persistência. Contas podem ser criadas inicialmente com alias, associadas a uma sessão, sem armazenar senha.

Uma receita é uma lista declarativa limitada, não JavaScript fornecido pelo cliente. Locators gerados por inspeção visual possuem alternativas, verificação de unicidade e contexto de frame. Em cada conta, resolver novamente e verificar pré/pós-condições. O Playwright oferece [locators orientados à página e aos elementos](https://playwright.dev/docs/locators); isso ajuda a encontrar alvos, mas não comprova resultado de negócio.

Por padrão, espelhamento e campanha só atravessam contas do mesmo perfil de site e fluxo compatível. Não espelhar entre dois sites diferentes só porque os botões ocupam a mesma posição. Senhas, tokens e 2FA continuam individuais. Uma assertiva ausente ou ambígua limita a garantia e a possibilidade de execução autônoma, e isso precisa aparecer antes da confirmação.

## 5.2 Perfil de site e segurança de navegação

Cada `site_profile` possui ID, tenant, nome, URL inicial normalizada, origens de navegação permitidas, política de recursos externos, versão e capacidades. Conta/snapshot, sala, receita e plano referenciam esse perfil. URLs com protocolos inesperados, credenciais embutidas ou destinos internos são rejeitadas.

Para compatibilidade, recursos públicos de CDN e redirecionamentos de autenticação precisam de política própria. O cliente pode autorizar novas origens de navegação de forma explícita; não obrigar confirmação para cada imagem. Essa configuração nunca libera loopback, metadata, serviços internos ou saída direta fora do proxy. Revalidar destino efetivo após resolução DNS e redirects, inclusive IPv6.

Sites distintos não compartilham cookies, cache autenticado, snapshots ou credenciais de conta. Uma alteração de URL não mistura sessões já existentes. A política de egress aplica segurança de destino sem depender de interceptação JavaScript da página.

## 5.3 Prioridade 1: limitar páginas realmente carregadas

O principal eixo de otimização proposto é controlar o conjunto ativo. A hipótese é que execução/renderização das páginas terá custo maior que cadastrar 500 registros; essa hipótese será confirmada por métricas, sem presumir que todo site tenha o mesmo perfil.

Separar os estados operacionais:

- **Persistida/dormente:** estado cifrado, nenhum contexto/browser mantido para a conta.
- **Em restauração:** slot reservado, restaurando e verificando o mínimo necessário.
- **Pronta em espera curta:** contexto já carregado, sem ação em voo; ocupa memória e continua contando no teto.
- **Visível ou executando:** contexto fixado pelo painel ou pelo trabalho atual.

Começar os testes com até quatro contas visíveis e dois slots de fundo, independentemente de haver 100 ou 500 contas cadastradas. Aumentar para quatro/seis slots de fundo após medir. O limite de browsers por grupo continua valendo; não compartilhar grupos para economizar memória silenciosamente.

Um controlador de admissão considera memória total da árvore Chromium/containers, CPU sustentada, event-loop lag e atraso de ações. Reduz slots de fundo ao aproximar-se do teto. Só aumenta após período estável, até o máximo escolhido pelo usuário; usar histerese para evitar oscilações. Nunca encerrar contexto com efeito mutável em voo apenas para baixar memória.

Ocultar um painel ou parar frames não suspende automaticamente JavaScript, timers ou sockets do site. Uma conta dormente precisa de checkpoint e encerramento real do contexto. Congelar uma página depende das capacidades do runtime e pode quebrar a lógica do site; não tratar “aba oculta” como memória liberada.

## 5.4 Prioridade 2: amortizar restauração sem reter tudo

Reutilizar o contexto da mesma conta para uma receita curta reduz aberturas repetidas. Reusar browser dentro do mesmo grupo preserva a afinidade; cada conta mantém seu contexto exclusivo. O [Playwright documenta contextos independentes, sem cookies/cache compartilhados](https://playwright.dev/docs/api/class-browser#browser-new-context).

Após trabalho seguro, manter contexto por uma espera curta configurável, por exemplo 30–60 s **como hipótese de ensaio**, apenas se houver orçamento e expectativa de uso. Aplicar LRU aos contextos elegíveis para descarte; painéis visíveis, efeitos em voo e sessões sem checkpoint seguro não são candidatos. Contextos em espera contam no mesmo limite global.

Executar pequenos blocos da receita na mesma conta, evitando trocar de conta a cada gesto. Limitar tempo de ocupação por grupo e manter justiça para que uma receita longa não retenha todos os slots. Mensurar custo de login/restauração, ação, verificação e checkpoint separadamente; o planner usa medidas por perfil e tipo de ação, incluindo p95 e margem para variabilidade.

Persistir autenticação após mudanças relevantes e em fronteiras seguras, não por frame ou movimento de mouse. Snapshot não substitui cópia completa de um perfil em todos os sites. A alternativa de perfil persistente dedicado continua condicionada a compatibilidade, cifragem de disco e novo dimensionamento.

## 5.5 Prioridade 3: medir o custo da visualização

Manter inicialmente a arquitetura solicitada: backend e runners em Docker, com as mesmas sessões exibidas por streaming. Introduzir uma interface `SessionEngine` para reduzir acoplamento a esse transporte, sem implementar dois motores completos de produção agora.

Comparar dois protótipos limitados:

| Opção | Benefício esperado a medir | Custo/limitação |
| --- | --- | --- |
| Workers Docker + frames para Electron | Preserva isolamento e runtime único dos documentos anteriores | Codificação, transporte, decodificação e fidelidade de input |
| Runtime local com vistas nativas Electron | Elimina o caminho de codificação de imagens nessa visualização | Altera a localização do runtime de sessões; exige rever automação, isolamento por grupo e implantação |

O Electron fornece [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) e [sessões/partitions persistentes](https://www.electronjs.org/docs/latest/api/structures/web-preferences). Essas APIs não representam conexão direta com um `BrowserContext` remoto nem garantem um processo browser isolado por grupo. Não mover uma conta entre dois motores mantendo cópias concorrentes de sessão.

A opção nativa é uma alternativa arquitetural sujeita a decisão explícita; a seleção do site pelo cliente não revoga o requisito original de Docker. O benchmark deve incluir SPA, página pesada, canvas/WebGL, input/IME e quatro painéis. Comparar CPU total, memória, latência input→imagem, tempo de abertura e recuperação. Eliminar uma etapa de encode é uma diferença de desenho, não prova de que o produto completo será mais rápido.

No caminho de streaming: limitar resolução/FPS, parar captura de painéis invisíveis, descartar frames antigos e separar canal de controle. Reduzir quadros não altera a sequência dos comandos. Em vistas nativas, avaliar a política padrão de throttling antes de desabilitá-la: o [Electron documenta efeitos de `backgroundThrottling` sobre animações, timers e a janela](https://www.electronjs.org/docs/latest/api/structures/web-preferences).

## 5.6 Prioridade 4: preservar compatibilidade e cache

Evitar bloqueio global de imagens, fontes, scripts, service workers ou WebGL como “modo rápido”. Sites escolhidos pelo cliente podem depender desses recursos. Oferecer configurações por perfil, com diagnóstico e reversão; a economia só é aceita se o fluxo continuar correto.

Intercepção de todas as requisições também pode piorar o desempenho: a documentação do [routing do Playwright informa que habilitar routing desativa o cache HTTP](https://playwright.dev/docs/api/class-browsercontext#browser-context-route). Portanto, medir antes de instalar `context.route('**/*')` apenas para tentar acelerar páginas. Segurança de rede continua imposta no egress; retirar routing não retira validação de destino.

Não criar cache compartilhado de respostas autenticadas entre contas. Credenciais, cookies e conteúdo personalizado não podem atravessar fronteiras de isolamento para economizar tráfego. Caches de recursos públicos só entram com validação de privacidade e política explícita.

## 5.7 Prioridade 5: reduzir trabalho de coordenação e UI

- Fila contém referências a ações; snapshots e frames não são serializados nos tickets do Redis.
- Fazer atualização de UI por entidade, agrupando mudanças frequentes de status em pequenos intervalos, por exemplo 100–200 ms como valor inicial. Ack de comando, bloqueio e erro crítico continuam imediatos.
- Paginar histórico e buscar no backend; renderizar somente o necessário na tabela. Virtualização é uma decisão medida, não obrigação para cada lista.
- Health checks genéricos verificam infraestrutura e idade do snapshot. Somente perfis com capacidade específica executam verificação de sessão/ban; eliminar polling que não produz evidência útil.
- Compartilhar evidência já obtida pela ação ou painel, em vez de disparar outra verificação sobre a mesma conta.
- Medir custo de banco/fila antes de substituir componentes. A proposta atual mantém PostgreSQL e Redis; um perfil desktop mais leve com outra persistência exigiria ADR próprio, revisão dos requisitos de Docker e as mesmas garantias de recuperação.

## 5.8 Primeiro marco de implementação revisado

1. Criar dois sites-fixture: formulário/SPA com autenticação persistida e página com animação/canvas e consumo configurável.
2. Permitir que o usuário cadastre a URL e crie perfis de sessão sem integração dedicada.
3. Abrir duas contas isoladas, entrar manualmente, fechar/reabrir e restaurar o estado suportado.
4. Exibir até quatro sessões e medir custo; começar com no máximo dois slots de fundo.
5. Criar receita visual simples: navegar → clicar/preencher → aguardar → verificar condição.
6. Simular e confirmar a receita para dez perfis de teste, incluindo falha e resultado incerto.
7. Medir CPU/RAM/latência, ajustar limites e executar a progressão de carga dos documentos anteriores.

Esse marco dispensa escolher antecipadamente o site do cliente. Ele entrega a base genérica e evidencia o que requer configuração ou integração, preservando a consistência e o isolamento definidos nos documentos 1–4.
