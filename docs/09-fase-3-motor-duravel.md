# Fase 3 — campanhas e motor durável

Esta entrega implementa planejamento, confirmação, ledger PostgreSQL, transporte BullMQ/Redis, ordem por conta, quotas, leases, recuperação, reconciliação e cancelamento. O Electron oferece uma área **Abrir campanhas** para criar receitas, selecionar contas, revisar a simulação e acompanhar o histórico.

O servidor atual continua sendo o ambiente de desenvolvimento e validação com tela virtual. A arquitetura de produto executa este backend e as futuras sessões no computador do cliente.

## Escopo executável

Os adaptadores disponíveis nesta fase são:

| Passo | Comportamento | Evidência de sucesso |
| --- | --- | --- |
| Conferir cadastro | Consulta a conta cadastrada, sem visitar o site | Registro presente e habilitado |
| Diagnosticar proxy | Testa a rota HTTP/HTTPS CONNECT ou SOCKS5 com o diagnóstico configurado na instalação | IP de saída validado pelo probe |

Nenhum desses passos comprova login, banimento ou saúde de uma sessão. A fase 4 conectará o motor aos runners e às sessões de produção. O laboratório da fase 0 continua separado; suas receitas não são executadas silenciosamente sobre contas reais.

Receitas são declarativas, com até 20 passos e revisões imutáveis. O cliente não fornece JavaScript, SQL, comandos de shell, endpoints de probe ou credenciais em uma receita. Adaptadores adicionais precisam ser implementados e homologados no backend.

## Planejamento e confirmação

1. Materializar até 500 IDs de contas e a versão da receita.
2. Excluir contas desabilitadas, removidas, restritas, ocupadas, com cadeia bloqueada ou rota incompatível. Mostrar o motivo de cada exclusão.
3. Congelar versões de conta, grupo, site, proxy, época de execução, políticas e adaptadores.
4. Simular horários estratificados com seed aleatória persistida, dependências, limites de concorrência e quotas móveis. Reservar 30% de margem nas estimativas de duração. Rejeitar janela inviável.
5. Gravar o snapshot e seu SHA-256 canônico. Entregar token aleatório de confirmação; somente seu hash fica no banco. A confirmação é vinculada à instalação, ao tenant, ao hash e ao modo e expira em cinco minutos.
6. Na confirmação, revalidar snapshot, receita, adaptadores, quotas e limite de backlog na mesma transação que cria a campanha, as ações, dependências e auditoria e consome o token.

Os horários da simulação são **relativos à confirmação**; a campanha começa dois segundos após o commit. Essa escolha evita transformar o tempo gasto na revisão em trabalho atrasado. Os deslocamentos e a janela revisados permanecem os mesmos. Não há navegação, login nem teste de proxy durante a simulação.

O modo distribuído é o padrão. “Assim que houver capacidade” exige aceite específico antes da simulação e continua sujeito a quotas e concorrência. A interface volta ao modo distribuído depois de confirmar. Repetir a confirmação com o mesmo token/hash/chave de idempotência retorna a campanha original; outra chave não cria uma cópia.

## Consistência e transporte

As tabelas da migração `003_engine.sql` usam RLS forçada, chaves compostas por tenant e histórico de transições e receitas sem permissão de alteração para o papel normal. Uma transação obtém o mesmo lock de tenant usado pelo cadastro, impedindo que confirmação/admissão corra com troca de rota ou política.

O PostgreSQL é a fonte da verdade. O dispatcher escreve a outbox junto à transição para `READY`; publica tickets `{version,eventId,actionId}` com `jobId` igual ao UUID da outbox e só depois registra a publicação. Um crash nesse intervalo pode entregar o ticket novamente, mas não autoriza repetir um efeito. Tickets repetidos, antigos ou de outro tenant falham nas guardas do ledger.

O reconciliador republica ações `READY` a partir da outbox, inclusive após perda da fila Redis. Cada evento fixa a versão da ação; um ticket de versão antiga não admite uma tentativa nova. Jobs de transporte têm uma tentativa; as tentativas de negócio são autorizadas pelo banco. Uma entrega que falha antes da admissão é reagendada. Se essa escrita de recuperação também falhar, o dispatcher remove o ticket finalizado e o republica somente enquanto a versão correspondente permanecer `READY` no ledger. A remoção de jobs concluídos controla memória; a deduplicação durável permanece no PostgreSQL. Redis mantém AOF e `noeviction`. Essas escolhas seguem as orientações oficiais de [IDs e deduplicação](https://docs.bullmq.io/guide/jobs/job-ids) e [operação do BullMQ](https://docs.bullmq.io/guide/going-to-production).

Dispatcher e consumidor são módulos de background no processo da API local. Essa implantação reduz serviços ociosos nesta fase. Reiniciar a API também reinicia o coordenador; os leases e o ledger preservam a recuperação. Os futuros runners de browser não recebem PostgreSQL, Redis ou chave mestra.

O consumidor usa conexão bloqueante própria, sem herdar o timeout curto de comandos do produtor. O shutdown fecha admissão, interrompe operações de diagnóstico e drena o consumidor. Erros de transporte registram somente etapa e código saneado; nenhum payload ou erro bruto de driver é enviado ao log. Consultas de histórico têm limite próprio de 20 leituras/s, separado dos 120 comandos/min da instalação.

## Ordem, capacidade e posse

- Uma cabeça de execução por conta mantém época, sequência crescente, predecessor global, ação atual e bloqueio.
- O predecessor da receita e o predecessor global precisam ter sucesso confirmado. Campanhas da mesma conta obedecem FIFO; tickets são intercalados entre grupos.
- A admissão verifica novamente cadastro/rota/política, deadline, grupo, conta e proxy, dentro da transação.
- Há quatro slots globais, o limite configurado de cada grupo e um slot por proxy. Quotas de conta, grupo e proxy contam reservas na janela móvel de uma hora e usam `maxActionsHour` da política do grupo. Reservas de tentativas que comprovadamente não enviaram efeito são liberadas; uso incerto é contabilizado conservadoramente.
- A promoção para `READY` mantém no máximo duas vezes o número de slots em pré-admissão. Contas ocupadas e campanhas posteriores da mesma conta aguardam no banco, reduzindo tickets e ciclos de reentrega.
- Cada lease tem proprietário, token aleatório com hash persistido, geração crescente, heartbeat e validade de 30 segundos. O início e a intenção do efeito exigem lease e época vigentes. Um responsável antigo não pode concluir nem autorizar outro efeito depois de ser cercado.
- O tempo de produção é amostrado do PostgreSQL em cada transação e avança com relógio monotônico dentro do processo. Testes usam relógio controlado para simular vencimentos.

O motor conserva `earliest_start`, `latest_start` e deadline. Atrasos não geram rajadas após a janela: trabalho não iniciado expira. Trabalho já enviado chega a um resultado seguro ou fica bloqueado para reconciliação.

## Falhas e intervenções

Antes de uma operação externa, o adaptador deve persistir a intenção do efeito e as quotas comprometidas. Sucesso exige pós-condição ou recibo do adaptador; a UI não pode declarar um efeito concluído.

| Falha | Resultado |
| --- | --- |
| Processo interrompido antes da intenção do efeito | Retry seguro, com geração nova e mesmo ID lógico |
| Efeito enviado, resposta perdida | `RECONCILING`; consultar evidência sem repetir a mutação |
| Recibo confirma o efeito | `SUCCEEDED`, liberando a sucessora |
| Ausência comprovada e adaptador com replay seguro | Retry dentro do orçamento e prazo |
| Evidência insuficiente | `UNKNOWN`, bloqueando a conta |
| Falha definitiva | `FAILED`; sucessoras não executam |

O orçamento é de três tentativas no total, com backoff de cinco e vinte segundos e jitter, respeitando adiamento indicado pelo adaptador e o deadline. Nenhum retry automático do BullMQ substitui essas guardas.

Cancelar uma campanha fecha a admissão e cancela passos ainda não iniciados. Para ações em voo, a interface mostra “cancelamento solicitado”; um efeito já enviado ainda pode concluir com sucesso. Ações individuais também podem ser canceladas. O histórico diferencia sucesso, falha, expiração, cancelamento e resultado desconhecido.

“Reconciliar” consulta o adaptador novamente, sem aceitar um resultado digitado pelo usuário. “Nova cadeia” exige motivo e incrementa a época. Se houver efeito incerto, exige primeiro que um adaptador confiável comprove o cercamento do responsável antigo e inspecione um baseline seguro; sem essa prova, a operação é recusada. O histórico incerto é preservado como `ABANDONED`, e as sucessoras antigas são canceladas. Não existe um atalho para marcar falha como sucesso.

## Executar e verificar

```bash
npm run server:up
npm run server:check
npm run phase3:verify
```

No computador com interface gráfica: conectar a instalação → cadastrar contas → **Abrir campanhas** → salvar receita → selecionar contas → simular → revisar e confirmar. Diagnóstico de proxy requer o cofre desbloqueado para recuperar a autenticação cifrada; conferência de cadastro não lê credenciais.

O gate usa uma instalação temporária, volumes próprios, rede interna sem portas de teste publicadas, PostgreSQL/Redis reais e Electron com Xvfb. Ele mantém os testes das fases anteriores, acrescenta testes do planejador, do ledger, do transporte e dos fluxos da interface e elimina apenas seus próprios containers/volumes. Relatórios ficam em `.runtime/artifacts/phase3-latest.json` e na pasta identificada no resultado.

O gate não certifica Windows/macOS, sites arbitrários, 500 browsers ativos, automação de produção ou capacidade sustentada de 500 contas. Essas homologações continuam nas fases de sessões, operação e release.

A interface lista as 50 campanhas mais recentes, pagina ações em blocos de 50 e mostra as últimas 100 transições do filtro atual. O ledger conserva o histórico anterior. Busca histórica ampliada, exportação, retenção e alertas operacionais entram na fase 5.

## Evidência de validação em 06/11/2026

O gate `msm-phase3-check-aab5c0ae` concluiu as 16 etapas em Linux arm64. Relatório: `.runtime/artifacts/msm-phase3-check-aab5c0ae/report.json`; resultado mais recente: `.runtime/artifacts/phase3-latest.json`.

- **18 testes unitários**, incluindo cronograma determinístico para 500 contas, concorrência, quotas móveis e rejeição de comandos não declarativos.
- **35 testes de integração**, dos quais 16 cobrem o motor: confirmação concorrente/idempotente, snapshots vencidos, predecessores, FIFO, leases, falhas, cancelamento, deadlines, quotas, proxy compartilhado, RLS, reconstrução da fila, consumidor ocioso e falha simultânea de entrega/recuperação.
- **15 fluxos de interface**, sendo nove de cadastro e seis de campanhas: edição versionada de receita, aceite do modo imediato, simulação sem efeitos, execução em ordem pela fila real, cancelamento com revisão e histórico após reabrir a área.
- Electron real com sandbox/context isolation e Xvfb; cofre cifrado restaurado depois de reiniciar a API e o aplicativo; serviços temporários removidos ao final.

Os ensaios de crash interrompem um subprocesso real com `SIGKILL` antes da intenção do efeito e depois de um POST em fixture HTTP local. O segundo caso comprova reconciliação por recibo sem repetir a mutação. A perda do Redis é simulada removendo somente a fila do tenant de teste, conservando o ledger. Nenhuma fixture acessa os sites dos clientes.

O backend desta instalação foi atualizado e conferido por TLS mútuo em **06/11/2026 às 18:14 UTC**: schema 3, PostgreSQL/Redis saudáveis, motor disponível, quatro slots, fila saudável e nenhum erro registrado. O cofre permaneceu bloqueado, e a conferência não criou receitas, campanhas ou contas no cadastro real. Evidência: `.runtime/artifacts/phase3-installation.json`. Os volumes existentes foram preservados, e nenhum container temporário do gate permaneceu ativo.
