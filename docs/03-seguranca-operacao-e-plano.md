# 3. Segurança, operação e plano de implementação

## 3.1 Modelo de ameaça

Proteger credenciais de sites, cookies, dados de contas, comandos, licença, integridade do instalador e privacidade dos tenants. Considerar site/página comprometida, renderer com XSS, processo local tentando chamar a API, proxy malicioso, arquivo CSV/backup adulterado, usuário de outro tenant, webhook falso e dependência comprometida.

O administrador/root do computador controla o runtime, memória e filesystem. Containers locais, RLS e cofre do SO não tornam os segredos invulneráveis a esse administrador enquanto o aplicativo os utiliza. Licenciamento local também pode ser adulterado por quem controla o binário. Para clientes que exigem fronteira contra o próprio operador do host, oferecer execução remota em infraestrutura controlada, sem prometer que criptografia em repouso resolva essa ameaça.

## 3.2 Electron e acesso ao backend

Checklist de implementação:

- [ ] UI carregada de recursos locais empacotados por protocolo próprio; CSP restritiva, sem `eval` ou scripts remotos.
- [ ] `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true` e sem conteúdo misto.
- [ ] `preload` expõe métodos de domínio específicos, como `simulatePlan` e `subscribeEvents`; não expõe `ipcRenderer`, filesystem, shell, rede genérica ou execução de código.
- [ ] Cada handler valida origem/frame do emissor, schema, tamanho, permissão e estado; descartar mensagens de frames inesperados.
- [ ] Bloquear navegação da UI e abertura arbitrária de novas janelas. Links externos passam por allowlist de esquema/destino e abertura deliberada.
- [ ] Permissões de câmera, microfone, clipboard e downloads negadas por padrão; habilitações específicas e visíveis.
- [ ] Frames do site são dados de imagem, decodificados com limites; texto remoto é escapado, sem inserir HTML do site na UI.
- [ ] Tokens de backend, chaves, cookies e senhas não ficam em Redux, localStorage, logs, analytics ou URLs.
- [ ] DevTools e superfícies de depuração não ficam expostas em builds de produção; isso complementa, sem substituir, isolamento e autorização.
- [ ] Electron e Chromium recebem atualizações de segurança por política de releases.

Essas escolhas seguem as recomendações de isolamento, sandbox e IPC da [documentação de segurança do Electron](https://www.electronjs.org/docs/latest/tutorial/security/).

A porta publicada pelo Compose fica somente em `127.0.0.1`, nunca em `0.0.0.0` no host. Se IPv6 for necessário, publicar separadamente em `::1`. Dentro do container o listener pode usar a interface interna, mas a publicação no host continua restrita. Banco, Redis, runners, CDP e métricas não têm portas públicas.

Loopback não é autenticação. O Main cria identidade de instalação e pareia com a API via TLS local com certificado fixado e autenticação de cliente/capacidade de bootstrap de uso único. O certificado do serviço é gerado/fornecido pelo supervisor confiável, não aceito com validação TLS desligada. Material de bootstrap é entregue por arquivos temporários restritos, não por argumentos de processo, URL ou log. Limpar após pareamento.

O Main mantém a conexão e repassa apenas métodos/eventos tipados ao renderer. CORS é negado por padrão e o `Host` é validado; nenhuma página de internet deve conseguir operar a API por CSRF ou DNS rebinding. WebSockets também autenticam o upgrade e validam origem e capacidades. Arquivos de configuração e sockets têm permissões por usuário do SO.

## 3.3 Criptografia e cofre

### Separar senhas do software e senhas dos sites

Senha de login do MultiSession Manager recebe hash lento Argon2id no plano remoto, salt aleatório e parâmetros versionados. Ela não precisa ser recuperada. Senha do site, cookie e token de sessão precisam ser recuperados para uso autorizado e, por isso, recebem cifra autenticada.

Proposta de envelope encryption:

```text
Chave raiz aleatória da instalação (256 bits)
  ├─ protegida pelo cofre do SO no caminho padrão
  └─ opcionalmente envolvida por KEK derivada de senha de cofre
       └─ Argon2id + salt aleatório + parâmetros persistidos

Raiz → envolve DEK aleatória de tenant/grupo
DEK → XChaCha20-Poly1305 em credenciais e snapshots
AAD → tenant + grupo + entidade + finalidade + versão do schema
```

Usar nonce aleatório de 24 bytes por mensagem com XChaCha20-Poly1305 e nunca reutilizar o par chave/nonce. Manter identificador de chave e algoritmo junto do ciphertext. O AAD impede transplantar ciphertext de uma conta para outra sem falha de autenticação. As primitivas e a derivação são descritas em [XChaCha20-Poly1305](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction) e na [API de password hashing/derivação do libsodium](https://doc.libsodium.org/password_hashing/default_phf).

Parâmetros Argon2id são calibrados no dispositivo, por exemplo para desbloqueio entre 250–750 ms, com piso de memória/recurso definido em revisão de segurança e limite superior contra DoS na leitura de backups. Não fixar um número de iterações sem medir a biblioteca e o hardware. Persistir parâmetros e permitir rehash/rewrap progressivo.

No host, usar `safeStorage` ou integração equivalente com o cofre do SO, preferindo API assíncrona quando disponível na versão homologada. Em Linux, detectar backend sem proteção efetiva e exigir senha de cofre em vez de aceitar fallback silencioso. [A documentação do safeStorage descreve as diferenças entre SOs e o backend `basic_text`](https://www.electronjs.org/docs/latest/api/safe-storage).

O serviço local de cofre recebe a raiz durante desbloqueio por canal autenticado e a mantém apenas em memória. Ele não entrega todas as DEKs aos workers. Um runner obtém apenas o segredo necessário à conta e à ação, com lease curto, por canal interno autenticado. Segredos temporários em arquivo, quando inevitáveis, usam tmpfs e permissões mínimas. Tokens são removidos dos traces e capturas de diagnóstico.

Rotação: criar nova versão de raiz/DEK, reenvolver ou recifrar em lotes, manter leitura das versões anteriores durante migração e eliminar versões antigas somente após backup validado. Não colocar chave mestra no `.env`, no banco, na imagem ou junto de um dump aberto.

Recuperação de senha do software não recupera automaticamente um cofre local protegido por outra senha. Fornecer chave de recuperação opcional, entregue uma vez e guardada pelo usuário. Perda de todas as chaves torna os dados cifrados irrecuperáveis; explicar isso no onboarding. Auto-lock impede novos efeitos que precisem de segredo; o comportamento de jobs já ativos é configurável e sempre visível.

## 3.4 Autenticação, planos e administração

- Login remoto com email validado, senha forte, rate limit por conta e origem, proteção contra enumeração e recuperação com tokens curtos de uso único.
- TOTP opcional para usuário comum e obrigatório para administrador global; códigos de recuperação individuais em hash. WebAuthn/passkeys podem ser evolução.
- Access tokens de curta duração e refresh token rotativo protegido pelo cofre. Reutilização de refresh revoga a família. Revogar dispositivo invalida futuras renovações.
- Contexto de tenant deriva da sessão e membership verificada; `viewer` lê, `operator` opera, `owner` administra membros/configurações. Papel global de admin não concede leitura das senhas locais.
- Admin lista usuários, planos, limites, dispositivos e métricas permitidas; suspende uso e registra motivo, ator e duração. Não recebe acesso silencioso às contas do site.
- Suspensão interrompe admissão de novos efeitos; a ação em voo é verificada/reconciliada antes de encerrar. Exportação de dados e recuperação permanecem disponíveis conforme política de produto.

O plano remoto entrega entitlement assinado com `tenant`, `device`, `revision`, limites, features, data de emissão e expiração. A chave privada de assinatura nunca vai para o cliente. A API local verifica assinatura e versão; o renderer não decide quotas. Limites de contas são aplicados também a importações concorrentes em transação.

Política comercial proposta para resolver “assinatura mensal” e “VIP permanente”:

| Tipo de direito | Pagamento | Limites e revogação |
| --- | --- | --- |
| Assinatura | Mensal | Limites do plano e prazo do período/entitlement |
| VIP permanente | Concessão permanente explícita | Dispensa cobrança recorrente; mantém limites e regras de suspensão |
| Admin | Papel, não plano | Acesso administrativo com 2FA; direito de uso operacional definido separadamente |

A política precisa definir se VIP é vendável ou apenas concedido; a arquitetura suporta ambos. Não expor “VIP” como booleano que automaticamente remove todos os limites.

Offline: entitlement técnico válido por até 72 h desde a última renovação, sem ultrapassar o período pago mais uma tolerância comercial explicitamente concedida. Renovar em segundo plano. Após expirar, modo de consulta/exportação e nenhuma nova ação mutável; efeitos em voo chegam a estado seguro. VIP permanente também renova prova técnica para que revogações sejam conhecidas. Essas durações são configuração de produto, não garantia contra alteração de relógio: usar tempo remoto assinado, detecção de regressão e relógio monotônico durante o processo; controle forte exige comunicação com servidor.

Webhooks de cobrança verificam assinatura sobre corpo original, tolerância temporal e ID único; consultar o provedor para resolver eventos fora de ordem. Nunca liberar licença apenas porque o cliente visitou uma página de sucesso.

## 3.5 Isolamento de rede e runners

Checklist de release:

- [ ] Runner roda como usuário sem privilégios, com sandbox Chromium explicitamente habilitado e verificado; em Playwright, configurar `chromiumSandbox: true` na inicialização homologada.
- [ ] Perfil seccomp compatível com namespaces de usuário; `no-new-privileges`, capabilities mínimas e sem `privileged`, `SYS_ADMIN` ou `--no-sandbox` como correção automática.
- [ ] PID namespace, IPC privado, `init`, filesystem raiz somente leitura e tmpfs por runner para perfil temporário.
- [ ] `/dev/shm` com orçamento próprio suficiente, inicialmente 256–512 MiB por runner a validar; considerar essa memória no total. Evitar `ipc: host` para preservar separação entre grupos.
- [ ] Limites de CPU, memória, PIDs, disco e conexões; sem mounts do diretório do usuário, Docker socket ou credenciais de infraestrutura.
- [ ] Imagem endurecida para produção, scan de dependências e navegador fixado à versão Playwright correspondente. Não tratar uma imagem padrão de testes como garantia de proteção contra site não confiável.
- [ ] Rede de runner não alcança grupos vizinhos, banco, Redis, API do host ou internet direta; gateway interno oferece somente capacidades necessárias.
- [ ] Egress passa por gateway/proxy do grupo. Destinos HTTP/HTTPS são verificados por origem/porta e política do adaptador, inclusive redirects, DNS e IPv6.
- [ ] Bloquear loopback, redes privadas não autorizadas, link-local, metadata e nomes internos como destinos do site. Endpoints de proxy corporativo privado precisam de exceção administrativa específica e não abrem os destinos navegáveis.
- [ ] Testar DNS rebinding, redirect para rede interna, WebRTC, QUIC e falha do proxy; nenhum caminho pode cair para internet direta.

A documentação do Playwright alerta para o uso de root sem sandbox e para o escopo das imagens de testes. A escolha de imagem e sandbox precisa de validação específica de produção: [Playwright em Docker](https://playwright.dev/docs/docker). A proteção de destinos deve considerar DNS e redirects, conforme [orientações de SSRF da OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

`read_only`, TLS, seccomp e containers são camadas complementares. Não declarar “isolamento empresarial” somente porque existem containers ou proxies. Teste de separação e documentação do risco residual são parte da entrega.

## 3.6 Topologia Docker e ciclo de vida

Serviços base: `postgres`, `redis`, `api`, `dispatcher`, `coordinator` e `vault`. Runners e seus gateways de egress são criados sob demanda pelo supervisor a partir de template fixo; serviços de métricas entram por profile opcional. O plano remoto usa implantação e banco próprios, também containerizados quando sob controle do produto.

Redes previstas:

| Rede | Participantes | Saída |
| --- | --- | --- |
| `data-internal` | API, dispatcher, coordenador, PostgreSQL e Redis | Sem saída externa direta |
| `control-internal` | Gateway de capacidades e runtimes autorizados | Somente controle interno autenticado |
| `group-<id>` | Runner e gateway daquele grupo | Runner alcança apenas gateway/serviços explicitamente necessários |
| `egress` | Gateways de grupo e cliente de licenciamento autorizado | Gateways só conectam ao upstream configurado; políticas de firewall verificadas |

Uma rede Docker `internal` não implementa sozinha todas as allowlists. A fase 1 deve materializar as regras de egress de forma portátil no runtime escolhido e testar o tráfego real. Se o host não fornecer enforcement verificável, a instalação não pode habilitar o modo de isolamento estrito silenciosamente.

Configuração mínima de produção:

- PostgreSQL e Redis com volumes persistentes próprios, sem publicação de portas; usuários/senhas distintas por serviço e arquivos de segredo com acesso mínimo.
- Redis com AOF conforme tolerância de perda escolhida, memória limitada e `maxmemory-policy noeviction`. Se memória acabar, reduzir admissão e alertar, em vez de perder chaves da fila. [A orientação de produção do BullMQ exige política sem eviction](https://docs.bullmq.io/guide/going-to-production).
- PostgreSQL com backup, WAL e política de disco. Redis é reconstruível, mas essa reconstrução precisa ser implementada e testada.
- `healthcheck`, `depends_on: condition: service_healthy` e tarefa de migração que termina com sucesso antes da prontidão da API. `depends_on` simples não assegura prontidão. Referência: [ordem e readiness no Compose](https://docs.docker.com/compose/how-tos/startup-order/).
- Reinício limitado com backoff no supervisor, drain em shutdown e ausência de loops infinitos ocultos. Disco cheio e banco corrompido não devem produzir reinício incessante com efeitos repetidos.
- Resource limits efetivos no runtime local, não apenas reservas declarativas sem efeito. Verificar via inspeção do container e teste de pressão. [Docker não impõe limites de recursos por padrão](https://docs.docker.com/engine/containers/resource_constraints/).

Bootstrap: verificar runtime/arquitetura/disco → validar pacote e digests → criar segredos → iniciar dados → aplicar migrations → iniciar controle/cofre → parear Main/API → autenticar usuário → desbloquear cofre → verificar licença → declarar pronto. Baixar imagens mostra progresso e pode ser retomado.

Shutdown: fechar admissão → parar captura → cancelar waits seguros → verificar/reconciliar efeitos em voo → salvar checkpoints → liberar sessões → encerrar runners → encerrar serviços. `docker compose down -v` não faz parte de manutenção comum; remover volumes é uma operação destrutiva separada.

O instalador precisa de builds e homologação por Windows x64, macOS arm64/x64 e Linux x64 conforme a matriz comercial aprovada. O MVP pode priorizar Windows x64; isso não valida automaticamente rede, cofre, sandbox ou updates nos demais. Runtime Docker pode exigir configuração, virtualização, permissões e termos próprios; a UX não deve prometer instalação completamente autônoma em toda máquina.

## 3.7 Observabilidade e resposta a falhas

Logs JSON estruturados com `request_id`, `tenant_ref` pseudonimizado, `campaign_id`, `action_id`, `attempt`, `worker_id`, `group_id`, `lease_epoch`, duração, resultado e código de erro. Nunca senha, token, cookie, headers de autenticação, URL completa sensível ou body integral do site. Screenshots e traces são opt-in, cifrados, com retenção curta e acesso auditado.

Métricas propostas:

- Contas por estado e idade da última verificação; sessões persistidas versus contextos ativos.
- Jobs planejados, elegíveis, em fila e em execução; idade do job elegível mais antigo, atraso de início e percentual expirado.
- Duração p50/p95/p99 por tipo de ação, retries seguros, falhas de login, resultados incertos e reconciliações.
- CPU, memória total dos containers e árvores Chromium, contextos, browsers, reinícios, PIDs, event-loop lag e espaço em disco.
- Saúde de proxy, latência, conexões e taxa de requisições por rota.
- Latência de frames, drops, tempo de input→principal, despacho de réplica e conclusão por painel.
- Latência/erros do banco, espera de locks, conexões, atraso de outbox e reconstruções de Redis.

Evitar labels de alta cardinalidade como login ou `action_id` em séries temporais; esses IDs ficam em logs/traces. Instrumentar operações com OpenTelemetry e logs com Pino; exportação externa é opcional e consentida.

Alarmes iniciais, ajustáveis após benchmark: heartbeat ausente por 15 s; outbox elegível atrasada mais de 30 s; memória acima de 85% do orçamento por 60 s; disco abaixo de 15%; crescimento persistente de atraso de jobs; taxa de resultado incerto acima da linha de base. Notificar apenas mudanças relevantes, com deduplicação e recuperação, em vez de um toast por conta afetada.

Runbooks mínimos:

| Falha | Comportamento e recuperação |
| --- | --- |
| API caiu | Main mostra reconectando; workers só continuam se conseguem renovar autorização; UI consulta estado persistido |
| Banco indisponível | Parar novas autorizações de efeito; comandos já autorizados/aceitos podem estar em voo e exigem evidência/reconciliação após retorno |
| Redis perdido | Suspender despacho, reconstruir tickets do PostgreSQL e deduplicar antes de retomar |
| Runner sem heartbeat | Revogar capacidade, cercar/destruir runtime, reconciliar ação em voo, transferir posse apenas depois |
| Supervisor não consegue destruir owner antigo | Conta permanece bloqueada; não lançar owner concorrente |
| Proxy caiu | Circuit breaker da rota, pausar contas, oferecer teste/rotação em fronteira segura |
| CPU/memória elevadas | Reduzir slots de fundo e FPS antes de perder UI; não encerrar ação mutável sem reconciliar |
| Sleep/hibernação | Detectar salto temporal, revogar leases expirados, revalidar sessões e prazos; não disparar backlog em rajada |
| Disco cheio | Fechar admissão, preservar integridade e oferecer limpeza de artefatos expirados; não apagar histórico arbitrariamente |
| Adapter mudou/site mudou | Pausar ações afetadas e apresentar incompatibilidade; não continuar clicando por coordenadas antigas |

Lease sugerido de 30 s com heartbeat a cada 5 s, ambos por tempo do banco/controle. Suspeita operacional após 15 s permite parar admissão, mas failover só ocorre com perda de posse resolvida e fencing do runtime; vencer TTL não prova ausência de efeitos no site.

## 3.8 Escalabilidade de 100 → 300 → 500 contas

As faixas abaixo são **orçamentos iniciais de homologação**, não medições nem requisitos mínimos garantidos. O custo real depende do jogo, WebGL, quantidade de grupos ativos, duração de ações e overhead da VM do Docker no SO.

| Perfil | Contas | Visíveis | Slots de fundo | Contextos máximos | Browsers máximos se todos de grupos distintos | Budget inicial do runtime completo | Host para ensaio |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Econômico | 100 | Até 4 | 2 | 6 | 6 | 6 GiB | 16 GiB RAM, 4–8 threads |
| Padrão | 300 | Até 4 | 4 | 8 | 8 | 10 GiB | 24–32 GiB RAM, 8 threads |
| Ampliado | 500 | Até 4 | 6 | 10 | 10 | 16 GiB | 32–64 GiB RAM, 8–16 threads |

500 contas podem funcionar com orçamento menor se a maioria estiver dormente; jogos pesados podem exigir mais memória mesmo com dez páginas. Manter margem de pelo menos 25% para SO e picos. O controlador reduz automaticamente slots quando o orçamento é ameaçado e mostra novo ETA. Se reduzir concorrência tornar a janela inviável, expirar/pausar conforme política e pedir nova simulação.

Escalar cadastro não significa escalar browsers proporcionalmente. Primeiro medir duração e otimizar restauração/reuso seguro de sessão; depois aumentar slots dentro do orçamento. Instâncias adicionais de workers só ajudam quando existe CPU/memória/rede e não há limite do site/proxy. Para múltiplos hosts, adicionar supervisor remoto, registro autenticado e transferência cifrada de estado; o mesmo ledger central deve coordenar a conta. Isso é fase posterior, não `docker compose --scale` sem controle de posse.

Metas de engenharia para release, com fixture/site e hardware registrados:

| Medida | Meta inicial |
| --- | --- |
| Busca/paginação de contas | p95 ≤ 200 ms no backend para 500 registros e histórico representativo |
| Simular 500 contas × 3 passos | p95 ≤ 2 s, sem IO externo |
| Despacho de réplica após principal confirmada | p95 ≤ 250 ms em runtime local saudável |
| Renderização de UI | Sem tarefas longas recorrentes > 100 ms durante execução normal |
| Contextos de contas dormentes | Zero |
| Concorrência mutável por conta | Nunca maior que 1 nos cenários de falha testados |
| Admissão após falha de dependência | Zero novos efeitos sem autorização/estado consistente |
| Recuperação de ticket perdido | Até 60 s após Redis/banco saudáveis, sem replay mutável inseguro |
| Memória em ensaio prolongado | Sem crescimento monotônico após aquecimento; teto do perfil respeitado |

Essas metas são critérios de teste e podem reprovar uma combinação de site/hardware. Não são SLA comercial. RTO operacional proposto ≤ 5 min após runtime íntegro e banco saudável; ações incertas podem exigir intervenção além desse tempo. RPO zero só é pretendido para fatos já confirmados em banco durável sobrevivente; perda de disco depende de backups/WAL e não recebe a mesma garantia.

## 3.9 UX e confiabilidade percebida

Navegação: Visão geral, Contas, Ao vivo, Ações, Grupos, Proxies, Histórico e Configurações. Administração global aparece somente para administradores e usa o plano remoto.

Dashboard mostra separadamente total cadastrado, sessões válidas recentemente, problemas, contextos ativos, ações elegíveis/em execução e uso de recursos. “Ativa” vem com horário da última verificação. Um banner de dependência explica quando Docker, banco, licença ou cofre impedem operação.

Fluxos prioritários:

- **Onboarding:** verificar máquina/runtime → login → proteger cofre → criar grupo/proxy → importar contas → diagnóstico opcional → primeira visualização → primeira simulação.
- **Importação:** modelo CSV com encoding definido, detecção de cabeçalho/separador, colar lista, preview, duplicatas por linha, associação de grupo e relatório de erros. Nunca importar silenciosamente acima da quota. O parser suporta delimitadores escapados e limita tamanho, linhas e campos.
- **Contas:** tabela virtualizada se necessário, busca rápida, filtros persistidos, seleção clara entre “esta página” e “todos os resultados”, edição em lote com revisão, aliases e senha sempre mascarada.
- **Ao vivo:** layouts 1, 2, 3 e 4; líder com borda e rótulo; status individual; botão de espelhamento visível; pausar réplica e encerrar controle separados. Nenhuma operação silenciosa em conta fora da sala.
- **Campanhas:** revisão exata, confirmação com contagem e custo, barra com estados reais, linha do tempo, motivo de espera e cancelamento individual ou em lote.
- **Recuperação:** mensagem orientada à ação (“Proxy indisponível; 32 contas pausadas”) e não stack trace. Resultado incerto explica que repetir pode duplicar o efeito e oferece verificar/reconciliar.
- **Proxies:** exibir capacidade e IP de saída observado; distinguir “não testado”, “saudável”, “degradado” e “indisponível”. A rotação mostra quais contas serão revalidadas.
- **Backup:** indicador de última cópia verificada e assistente de restauração com preview e resolução de conflitos.

Tema claro/escuro, contraste, foco visível, navegação por teclado, estados além de cor, redução de animações e atalhos documentados. Exemplos: `Ctrl/Cmd+K` busca/comandos, `Ctrl/Cmd+1..4` foco de painel e `Esc` desarma espelhamento **quando o foco está no chrome da aplicação**. Dentro da sessão remota, teclas podem pertencer ao site; a UI precisa de controle de pausa sempre acessível e sem atalhos globais inesperados.

Confirmações são proporcionais: editar observação não requer modal; remover conta, mudar proxy de sessão ativa, ligar modo imediato e executar compras exigem revisão. Exclusão lógica pode permitir desfazer antes da purga; cliques externos e compras não recebem promessa de desfazer. Notificações importantes são agrupadas por incidente, com centro de eventos e opção de som discreto.

## 3.10 Exportação, backup e restauração

Exportar CSV UTF-8 com colunas explícitas, timestamps com fuso, filtros materializados e proteção contra fórmulas iniciadas por `=`, `+`, `-`, `@`, tabulação ou retorno de carro. Exportações de status e ações nunca incluem senha, token ou segredo de proxy. Arquivos são produzidos em stream, com permissões mínimas e exclusão de temporários após salvar.

Backup completo inclui contas, grupos, políticas, proxies/segredos cifrados, snapshots, receitas, histórico escolhido e manifest com versão do formato/schema. Não inclui processos, leases válidos ou autorização para continuar jobs automaticamente.

Fluxo portátil:

1. Pausar admissão e alcançar barreira segura para checkpoints de sessões; ações não resolvidas permanecem registradas como tais.
2. Capturar snapshot consistente do PostgreSQL e fixar as revisões dos blobs externos. Se tudo estiver no banco, aproveitar um único snapshot de leitura.
3. Gerar chave aleatória para o arquivo; envolver DEKs necessárias com essa chave, sem exportar a raiz do SO em aberto.
4. Derivar KEK de passphrase de backup com Argon2id e salt próprio; envolver chave do arquivo e cifrar chunks com stream autenticado do libsodium ou AEAD corretamente sequenciado.
5. Autenticar manifest, ordem e total de chunks e encerramento para detectar truncamento, troca e corrupção. Não guardar a passphrase junto do arquivo.
6. Fazer verificação de leitura/integridade antes de marcar como backup concluído. Uma cópia que só funciona na instalação original não atende portabilidade.

Restauração valida limites de tamanho/KDF, assinatura de integridade, formato, schema e identidade do tenant. Descompactar em staging com proteção contra path traversal e arquivos inesperados. Mostrar contas novas/duplicadas, proxies, políticas e tratamento do histórico. Reenvolver chaves com o cofre da nova instalação. Criar restore point antes da aplicação final.

Por padrão, restauração de um tenant usa o mesmo tenant autenticado; migração entre tenants é um fluxo separado autorizado. Importar backup não eleva plano, permissões ou licença. Todas as concessões e leases antigas são invalidadas, sessões são revalidadas e campanhas ficam pausadas. Remanescentes exigem nova simulação, impedindo replay de operações já executadas.

Backup diário cifrado e até sete versões locais são defaults propostos; só backup no mesmo disco não protege contra perda do host. Oferecer destino externo controlado pelo usuário e teste periódico de restauração, sem upload silencioso de credenciais.

## 3.11 Atualizações e distribuição

Assinar instaladores Windows e macOS, notarizar macOS e publicar hashes/manifest autenticado. Separar chaves de build, assinatura de licença e cofre. Usar CI com privilégios mínimos, revisão de dependências, SBOM e digests fixados de imagens.

Atualização deve validar origem e assinatura, verificar compatibilidade de schema/contratos/adaptadores, pausar admissão, drenar ações e gerar restore point antes de migration irreversível. UI oferece progresso e relatório de falha. Rollback do binário só é permitido se o schema continuar compatível; se não, restaurar explicitamente o backup anterior, sem executar trabalho antigo automaticamente.

O mecanismo de update depende do SO e da ferramenta de empacotamento homologada. Adotar Electron Forge como ponto inicial, com adaptador de atualização por plataforma; não assumir que `autoUpdater` se comporte igualmente no Linux. Referências: [assinatura no Electron](https://www.electronjs.org/docs/latest/tutorial/code-signing) e [atualização de aplicações Electron](https://www.electronjs.org/docs/latest/tutorial/updates).

## 3.12 Riscos técnicos e mitigação

| Risco | Impacto | Mitigação e condição de aceite |
| --- | --- | --- |
| Site muda DOM/API | Cliques errados ou falha em massa | Adaptador versionado, pré/pós-condições, canário e pausa automática |
| Canvas/WebGL inacessível semanticamente | Espelhamento incompleto | Prova de conceito no site antes do escopo comercial; bloquear operação sem mapeamento confiável |
| Latência/custo de quatro streams | UX ruim e CPU alta | Medir fase 0, compressão/FPS adaptativos, descarte de frames e transporte separado |
| Snapshot não conserva autenticação | Logins repetidos | Testar cookies/IndexedDB/sessionStorage; fallback de perfil dedicado com novo orçamento |
| Sessão expira no servidor | Conta “conectada” visualmente incorreta | Validade e horário de verificação; health check e login assistido |
| Efeito externo duplicado após crash | Perda de recursos/consistência | Ledger, idempotência, fencing e reconciliação; estado UNKNOWN quando necessário |
| Runner zumbi após lease vencer | Dois efeitos concorrentes | Destruição confirmada do runtime antes do failover; se impossível, bloquear conta |
| Proxy cai ou usa IP compartilhado | Vazamento/associação de identidade | Egress fail-closed, diagnóstico, afinidade e IP observado |
| Promessa irreal de fingerprint | Expectativa comercial falsa | Perfil coerente, limites explícitos e VM/host dedicado quando exigido |
| Ação individual viola limite do site | Bloqueios e instabilidade | Budget de requisições, rate limits efetivos, respeito a 429 e circuit breakers |
| Recursos insuficientes | OOM, travamento, deadline perdido | Admissão por orçamento, redução de slots/FPS, planos inviáveis rejeitados |
| Docker/sandbox varia entre SOs | Instalação insegura ou quebrada | Matriz por SO, pré-flight e modo estrito disponível só quando enforcement comprovado |
| Multi-tenant vaza por ID/consulta | Exposição de dados | Autorização + RLS + FKs compostas + capacidades e testes negativos |
| Roubo do host em uso | Segredos em memória | Cofre/auto-lock, mínimos privilégios e opção de execução remota; limite residual declarado |
| Licença local adulterada/offline | Receita/limites burlados | Entitlements assinados, servidor de controle e política offline; não prometer DRM inviolável |
| Perda de chave/backup inválido | Perda definitiva de contas/configuração | Chave de recuperação e restauração ensaiada em instalação limpa |
| Relógio muda ou host suspende | Execução fora da janela | Tempo do banco, detecção de sleep, revalidação de prazos e sem rajada de recuperação |

## 3.13 Plano de implementação com gates

Estimativa de referência: equipe com duas pessoas em backend/automação, uma em Electron/UX e QA/infra compartilhados; cerca de 12–18 semanas de calendário **se a fase 0 confirmar viabilidade**. Não é orçamento fechado. Matriz de capacidades genéricas, plataformas de lançamento, integração de pagamentos e licença do runtime precisam ser definidas antes de compromisso de prazo. Integrações específicas posteriores têm estimativa própria; o site escolhido pelo cliente não é dependência para iniciar o núcleo. Segurança e testes entram em cada fase.

| Fase | Entregas concretas | Gate para avançar | Faixa indicativa |
| --- | --- | --- | --- |
| 0 — Viabilidade | Sites de teste controlados, perfis configuráveis, núcleo genérico, login manual/snapshot, proxy e quatro streams | Restaurar autenticação; navegar/clicar/preencher/verificar; avaliar canvas/IME/4 painéis e egress real; limites medidos | 1–2 semanas |
| 1 — Fundação | Monorepo, contratos, Compose, migrações, RLS, cofre, pareamento Main/API, runner endurecido | Bootstrap repetível; zero acesso cruzado em testes; proxy fail-closed e sandbox comprovados | 2–3 semanas |
| 2 — Contas e grupos | CRUD, site profiles, importação preview/commit, políticas versionadas, proxies, quotas, status e UX de erros | Importar 500 registros sem abrir 500 browsers; concorrência de quotas correta; nenhum segredo em logs | 1–2 semanas |
| 3 — Motor durável | Planner, confirmação, ledger, outbox, dependências, leases, quotas, retry/reconciliação/cancelamento | Testes de crash e Redis perdido; nenhum retry mutável inseguro; predecessor obrigatório | 2–3 semanas |
| 4 — Ao vivo | Sala 1–4, captura/input, espelhamento semântico, pressão, fan-out individual e gravação de receita | Erros e divergência visíveis; sem loop; mesma sessão da automação; medir latências | 2 semanas |
| 5 — Saúde e operação | Health checks, breakers, métricas, alertas, histórico e CSV | Sem browser no check suportado; sem falso ban por proxy; soak com 300 contas | 1–2 semanas |
| 6 — Comercial e recuperação | Login/2FA, licenciamento remoto, admin, cobrança em sandbox, backups/restores e updates | Webhook/replay validados; limites reais; restauração limpa; assinatura de release | 2 semanas |
| 7 — Homologação | Perfis 100/300/500, ensaios de falha, revisão de segurança, instaladores e suporte | Matriz de aceite aprovada com evidências em cada SO de lançamento | 1–2 semanas |

Algumas entregas podem ocorrer em paralelo por responsáveis humanos, sem antecipar os gates de consistência ou isolamento. A soma das faixas depende desse paralelismo e da homologação. Um protótipo visual não equivale à conclusão da fase 4, e cadastrar 500 linhas não comprova capacidade de automação de 500 contas.

## 3.14 Estrutura de pastas recomendada

Estrutura futura; os diretórios abaixo representam a implementação planejada, não código já existente:

```text
multisession-manager/
  apps/
    desktop/
      src/main/             # lifecycle, cofre SO, supervisor, transporte
      src/preload/          # bridge mínima e validada
      src/renderer/
        features/           # accounts, live, campaigns, proxies, settings
        components/         # design system e acessibilidade
        state/              # cache/estado de UI, sem segredos
      forge.config.ts
    local-api/
      src/modules/          # accounts, groups, plans, sessions, exports
      src/plugins/          # auth, tenant, DB, schemas, websocket
      src/server.ts
    dispatcher/src/         # outbox, admissão, reconciliação
    coordinator/src/        # slots, concessões e capacidades
    group-runner/src/       # um grupo por processo/container
    egress-gateway/src/     # rota obrigatória, DNS e upstream
    vault/src/              # envelope encryption e acesso temporário
    control-plane/
      src/modules/          # identity, MFA, billing, licenses, admin
  packages/
    domain/                 # invariantes, planner e máquina de estados
    contracts/              # schemas, DTOs, eventos e OpenAPI
    database/               # repositories, migrations e RLS
    queue/                  # envelopes e adaptação BullMQ
    crypto/                 # wrappers de primitivas e versões de envelope
    environment-adapters/   # perfis, adaptações homologadas e diagnósticos
    site-adapters/
      core/                 # contrato, evidências, capacidades
      generic/              # navegação, interação e receitas declarativas
      integrations/         # opcionais: ações e autenticação por site
    observability/          # logs, métricas e tracing com redação
    test-fixtures/          # site controlado, falhas e respostas
    ui/                     # componentes reutilizáveis
  infra/
    compose/                # base e profiles por plataforma
    runners/                # templates fixos de grupo/egress
    docker/                 # imagens e seccomp
    monitoring/             # dashboards e regras
    release/                # assinatura e manifest de atualização
  tests/
    domain/                 # planner, estados e regras
    integration/            # PostgreSQL/Redis reais e autorização
    desktop/                # IPC, onboarding e fluxos críticos
    fault-injection/        # crash, perda de rede e estado incerto
    capacity/               # 100, 300, 500 e quatro streams
    security/               # egress, tenant, cofre e arquivos maliciosos
  docs/
    adr/                    # decisões de arquitetura e tradeoffs
    runbooks/               # operação e recuperação
    api/                    # contratos gerados e exemplos
  scripts/                  # bootstrap, diagnóstico e verificação
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  tsconfig.base.json
```

Fronteiras de dependência: renderer importa contratos e UI; domínio não importa Electron, Fastify, Playwright ou Redis; adapters implementam interfaces do domínio; persistência e infraestrutura ficam nas bordas. Não criar um pacote `utils` que misture criptografia, browser, autorização e componentes.

A fase 1 fixa versões suportadas e compatíveis de Node LTS, Electron, Playwright/Chromium, PostgreSQL, Redis e libsodium no lockfile e nas imagens por digest. Atualizar em fluxo controlado com testes de contratos e compatibilidade, sem usar tags `latest` em produção.
