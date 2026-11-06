# 4. Critérios de aceite e rastreabilidade

## 4.1 Como comprovar a implementação

Cada gate deve produzir evidências reproduzíveis: versão do aplicativo/adaptador, SO, CPU/RAM, versão e orçamento do runtime, cenário, seed, métricas, logs redigidos e resultado. A matriz abaixo descreve o produto completo. A evidência já produzida pela fundação está no [guia da fase 1](06-fase-1-execucao.md); a prova de sessões com fixtures e suas limitações estão no [laboratório da fase 0](07-fase-0-laboratorio.md). Os demais cenários continuam sendo critérios para as próximas entregas.

Usar sites-fixture controlados que modelem login, cookies/IndexedDB, expiração, loja, cura, atraso, respostas 429/5xx, challenge, ban explícito e efeitos não idempotentes. Eles mantêm um ledger externo de efeitos recebidos, para verificar duplicação sem depender da interpretação do próprio aplicativo. A base é desenvolvida sem exigir o site futuro do cliente; cada integração específica, quando existir, é homologada separadamente com contas de teste.

## 4.2 Invariantes verificáveis

| ID | Invariante | Evidência esperada |
| --- | --- | --- |
| I01 | Nenhum tenant acessa dados ou segredos de outro | Testes de leitura, escrita, referência por ID, WS, exportação e restore cruzados |
| I02 | Uma conta não recebe dois efeitos mutáveis concorrentes | Ledger da fixture + histórico de leases/épocas em testes com consumidores concorrentes |
| I03 | A próxima ação só começa após sucesso confirmado dos predecessores da receita e da execução global | Testes de sequência com falha, cancelamento, expiração e resultado incerto |
| I04 | Nenhum efeito em massa ocorre sem plano confirmado | Verificar chamadas externas zero antes do commit de confirmação |
| I05 | O que foi confirmado é o que será executado | Hash, IDs, versões, parâmetros, janela e modo imutáveis; mudança material gera conflito |
| I06 | Queda de proxy não usa conexão direta | Captura de rede IPv4/IPv6/DNS e teste de destino externo controlado |
| I07 | Grupos não compartilham contexto, browser, container ou storage ativo | Inspeção de runtime e tentativa de acesso entre grupos |
| I08 | Contas dormentes não mantêm navegador carregado | Medidas de contextos, processos e memória com 500 contas importadas |
| I09 | Retry não repete cegamente efeito não idempotente | Matar worker depois de efeito e antes do commit; estado reconciliação/UNKNOWN |
| I10 | Perda de Redis não perde o estado de negócio | Recriar Redis e reconstruir tickets a partir do PostgreSQL |
| I11 | Logs, exports e telemetria não contêm segredos | Segredos-canário e varredura de todos os artefatos produzidos |
| I12 | UI não afirma sucesso antes da pós-condição | Fixture retorna HTTP 200 com rejeição de negócio; ação não vira SUCCEEDED |
| I13 | Owner antigo não avança a conta após failover | Comando e resultado atrasados da época anterior rejeitados; runtime antigo cercado |
| I14 | Restore não reexecuta trabalho antigo | Backup com campanha parcial restaurado fica pausado, sem efeitos externos |
| I15 | Modo imediato respeita quotas e confirmações | Carga e ordem idênticas às políticas; só muda o espalhamento de início |

## 4.3 Cenários funcionais

### Contas, grupos e proxies

0. Configurar dois perfis de site, um sem integração dedicada; navegar e entrar manualmente em ambos, manter sessões separadas e mostrar capacidades limitadas no modo genérico. Recusar receita/sala entre perfis incompatíveis e URL que alcance destino interno. Um perfil genérico não recebe status de ban por heurística de HTTP.

1. Importar CSV de 500 contas com aspas, caracteres acentuados, linhas inválidas e duplicatas; preview indica cada erro sem abrir browser ou testar site. Commit respeita quota mesmo com dois imports concorrentes.
2. Colar lista e adicionar conta individual produzem as mesmas validações e formato cifrado. Nenhuma senha aparece na resposta de listagem.
3. Editar conta com versão antiga retorna conflito e preserva a edição atual. Desabilitar fecha admissão, preservando a resolução de efeito em voo.
4. Atribuir contas concorrentemente ao mesmo proxy não ultrapassa `max_accounts`. Proxy de outro grupo/tenant é recusado.
5. Testar HTTP/CONNECT e SOCKS5, com/sem autenticação, IPv4/IPv6 e DNS remoto; combinações não suportadas falham explicitamente.
6. Derrubar proxy e observar que conta fica com problema de rota, não marcada como banida. Revalidar egress antes de retomar.
7. Mudar grupo ou proxy durante ação mantém o fluxo antigo até fronteira segura; não há reutilização indevida de perfil/storage.

### Ao vivo

1. Abrir layouts 1, 2, 3 e 4; principal e seguidoras têm cookies diferentes e o contexto exibido é o mesmo que recebe automação.
2. Executar cura, navegação e ação de formulário suportada; conferir pós-condições por conta e sequência no ledger.
3. Alterar DOM/layout de uma seguidora e garantir resolução semântica correta ou falha explícita; nenhum clique cego no alvo errado.
4. Atrasar uma seguidora; o limite de pendências pausa a réplica com feedback, sem consumir memória indefinidamente.
5. Forçar erro em uma seguidora e testar as políticas “pausar esta conta” e “pausar todas”.
6. Reenviar o mesmo `command_id`, reconectar WS e trocar o líder com comando em voo; nenhuma duplicação ou loop.
7. Digitar senha/2FA na principal; valores não são replicados, gravados na receita ou enviados a logs.
8. Fechar painel enquanto efeito está em voo; captura encerra, estado continua sendo resolvido e nenhum job disputa a sessão.
9. Gravar receita e aplicar às contas restantes; participantes já executados ficam excluídos e a campanha exige novo dry-run.
10. Testar IME, escala/DPI, foco, clipboard, modais, popup, iframe e canvas conforme matriz do site; declarar limitações antes da entrega comercial.

### Campanhas e saúde

1. Dry-run de 500 contas × 3 passos não toca rede externa; informa excluídas, motivos, horários, dependências e capacidade.
2. Confirmar plano e repetir a mesma requisição; retorna a mesma campanha. Usar o token com outro hash/usuário ou após expiração é recusado.
3. Alterar política/proxy/conta entre simulação e confirmação; plano fica obsoleto, sem efeito parcial.
4. Plano que não cabe na janela é rejeitado com alternativas; não reduz duração estimada para fingir viabilidade.
5. Distribuição respeita seed, deadlines, quotas e ordem. Modo imediato continua limitado; nova campanha retorna a distribuído.
6. Falha no primeiro passo impede o segundo em todos os canais. Abandono da cadeia exige novo baseline validado e auditoria.
7. Cancelar antes do início não envia efeitos. Cancelar após envio exibe o resultado efetivo ou incerteza, sem declarar rollback.
8. Health check suportado usa HTTP sem criar processo Chromium; ban explícito pausa, 403 genérico não vira ban e timeout do proxy não altera identidade da conta.
9. Endpoint de health que rotaciona cookie é serializado; mudança de versão não sobrescreve checkpoint novo. Sem endpoint seguro, retornar não verificável.
10. Host retorna de suspensão depois da janela: trabalho vencido expira, UI mostra remanescentes e nenhum catch-up em rajada acontece.

## 4.4 Matriz de injeção de falhas

| Ponto de interrupção | Resultado obrigatório |
| --- | --- |
| Antes do commit da campanha | Nenhuma campanha ou efeito parcial |
| Depois do commit, antes de publicar outbox | Dispatcher publica posteriormente |
| Depois de publicar, antes de marcar publicação | Ticket repetido não cria segundo efeito lógico |
| Após lease, antes de qualquer envio possível | Retry somente com evidência de segurança |
| Após enviar efeito, antes da resposta | Reconciliar; nunca assumir falha sem efeito |
| Após sucesso externo, antes do commit local | Reconciliação comprova resultado ou UNKNOWN |
| Durante captura/transmissão de frames | Imagem pode atrasar; comandos e resultados permanecem consistentes |
| Durante escrita de snapshot | Versão anterior permanece íntegra; owner antigo não sobrescreve a nova |
| Durante cancelamento | Intenção durável prevalece sobre tickets ainda no Redis |
| Durante rotação de proxy | Sem troca de rota dentro de operação em voo |
| Durante backup | Artefato incompleto não é marcado como válido |
| Durante restore | Dados originais preservados ou restore point utilizável; nenhum job retomado |
| Durante update/migration | Release não declara pronto com schema incompatível; plano de recuperação executável |
| Supervisor indisponível e runner zumbi | Conta bloqueada até fencing comprovado, sem owner substituto concorrente |

Repetir as falhas com múltiplos consumidores, atraso de mensagens, reconexões e pequenas alterações de relógio. Medir também condições em que o sistema escolhe parar: bloquear com motivo claro é preferível a declarar conclusão sem prova.

## 4.5 Segurança e recuperação

- Testes negativos de autorização em toda rota, canal de evento e artefato; roles normais não conseguem desativar RLS ou escolher tenant alheio.
- CSV com fórmula, arquivo muito grande, escapes, URL de proxy malformada, redirect para rede privada e backup com path traversal são recusados/neutralizados.
- Bootstrap local rejeita processo não pareado; renderer comprometido não encontra método IPC genérico para shell/FS/CDP.
- Cofre indisponível ou backend sem proteção efetiva provoca fluxo de desbloqueio seguro; não grava dados sob fallback fraco.
- Alterar nonce, ciphertext, AAD, ordem ou truncamento de backup provoca falha de integridade. KDF com parâmetros abusivos é recusado antes de esgotar recursos.
- Restore em instalação limpa e tenant correto reenvolve chaves, restaura contas/configurações e solicita revalidação de sessões.
- Webhook com assinatura inválida, repetido ou fora de ordem não cria concessões indevidas. Limite de plano vale também fora da UI.
- Atualização com assinatura/digest inválido é rejeitada; falha de migration não inicia execução com contrato incompatível.
- Módulo de adaptação de ambiente aplica somente a versão homologada, comprova os valores observados em diagnóstico e faz rollback seguro sem alterar sandbox/TLS. Resultado do canário é evidência de compatibilidade, sem declaração de indetectabilidade.
- Auditoria registra login administrativo, alteração de plano, exportação, restauração, rotação de proxy, reset de cadeia e execução imediata, com ator e motivo.

## 4.6 Ensaios de capacidade

Para cada perfil 100/300/500, registrar sites-fixture e, quando houver integração específica, o site homologado correspondente, distribuição de grupos/proxies, duração de ações, quantidade de painéis, tamanho dos frames e taxa de atualização. Testar dois extremos: muitas contas em poucos grupos e cada conta ativa em grupo distinto.

1. **Ocioso por 1 h:** todas cadastradas, sem painel, sem campanha; zero Chromium para contas dormentes, health leve dentro do orçamento.
2. **Interativo por 2 h:** quatro painéis com campanha de fundo; medir latência, drops, CPU, memória e responsividade da UI.
3. **Carga planejada:** receitas de 1 e 3 passos, duração variável, quotas diferentes e recursos disputados; conferir factibilidade prevista versus medida.
4. **Soak de 24 h antes do beta e 72 h antes do release:** ciclos de abrir/fechar sessões, health, falhas e reconexões; procurar crescimento de memória, contextos órfãos e atrasos.
5. **Pressão:** reduzir memória/CPU/rede, aproximar disco do limite e simular proxy lento; controlador reduz admissão e não viola consistência.
6. **Recuperação:** reiniciar API, Redis e runner em pontos distintos; medir RTO e comprovar que ações incertas não se transformam em efeitos repetidos.

Não aceitar benchmark somente com 500 contas cadastradas e nenhuma operação. Também não exigir 500 browsers para demonstrar capacidade: a evidência relevante é throughput sustentado dentro dos limites e correção após falha.

## 4.7 Rastreabilidade dos 12 entregáveis

| Entregável do pedido | Local da especificação |
| --- | --- |
| 1. Arquitetura e diagrama | Documento 1, §§ 1.1–1.4 |
| 2. Tabelas e relações | Documento 2, §§ 2.1–2.8 |
| 3. Espelhamento ao vivo | Documento 1, § 1.5; documento 2, §§ 2.5 e 2.11 |
| 4. Ação em massa com dry-run | Documento 1, § 1.6; documento 2, §§ 2.9–2.10 |
| 5. Sessões e proxies | Documento 1, § 1.8; documento 3, §§ 3.3 e 3.5–3.6 |
| 6. Health check leve | Documento 1, § 1.9 |
| 7. Filas e máquina de estados | Documento 1, § 1.7; documento 2, §§ 2.5 e 2.9 |
| 8. Segurança/checklist | Documento 3, §§ 3.1–3.5 e 3.11 |
| 9. Escala 100 → 300 → 500 | Documento 3, § 3.8; documento 4, § 4.6 |
| 10. UX e confiabilidade | Documento 3, §§ 3.7 e 3.9 |
| 11. Riscos e mitigação | Documento 3, § 3.12; documento 4, § 4.4 |
| 12. Estrutura inicial | Documento 3, § 3.14 |

## 4.8 Decisões de produto antes do compromisso de implementação

Estas decisões não impedem usar a especificação, mas devem ser fechadas na fase 0:

1. Quais padrões de site/fluxo serão cobertos pelos fixtures iniciais e quais capacidades ficam disponíveis no modo genérico? O cliente define o site depois; não é uma dependência para iniciar a base.
2. “Simultâneas” significa estados autenticados recuperáveis ou presença online contínua? Este projeto assume a primeira opção.
3. Quais SOs e arquiteturas entram no primeiro release, com qual orçamento de hardware?
4. Como a UI informa a ausência de endpoint seguro de health e de pós-condição verificável em um perfil genérico? Integrações posteriores devem comprovar essas capacidades.
5. O espelhamento semântico das ações homologadas atende ao produto, considerando limitações de canvas, autenticação e entrada remota?
6. Isolamento de conta + processo/container por grupo atende, ou o contrato exige VM/host dedicado e custo correspondente?
7. Quais sinais de detecção aparecem no site e quais adaptações de ambiente serão homologadas na primeira versão? Fixar o escopo testável dessa camada e os limites, sem promessa de indetectabilidade.
8. Como VIP permanente será concedido/vendido, qual provedor de pagamento será usado e qual política offline será comercializada?
9. Qual é a taxa real de ações por conta, a distribuição de grupos/proxies e a retenção desejada?
10. Ao atingir deadline, vale a política proposta de expirar trabalho não iniciado? Qual ação exige confirmação de gasto?

Após esses pontos, registrar ADRs para runtime de visualização, persistência de sessão, isolamento, consistência, egress, cofre e licenciamento. Mudança de premissa deve atualizar os contratos e critérios de aceite, não apenas o texto comercial.
