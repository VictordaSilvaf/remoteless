# 8. Fase 2 — cadastro, importação e proxies

Esta entrega conecta o cadastro real ao PostgreSQL e à interface Electron. O cliente escolhe o site pelo formulário; não existe domínio de jogo fixado no cadastro. A fundação da fase 1 continua sendo usada: TLS mútuo, pareamento, RLS, cofre e bridge restrita.

## 8.1 Iniciar e usar

No servidor de desenvolvimento:

```bash
npm ci
npm run setup
npm run doctor
npm run server:up
npm run server:check
```

`server:up` aplica a migration adicional `002_workspace.sql`, sem editar o histórico da migration 001. O schema passa à versão 2. Banco e Redis continuam sem portas publicadas; a API permanece em TLS no loopback.

No Electron, conecte a instalação, desbloqueie o cofre e escolha **Abrir cadastro**. Cadastre um grupo e um site antes das contas. A interface oferece Contas, Grupos, Sites, Proxies e Importações, além de busca, filtros e páginas de 50 contas.

Para testar no servidor sem abrir uma janela física:

```bash
npm run phase2:verify
```

O comando executa a fundação e o cadastro em uma instalação temporária, incluindo o Electron real com Xvfb. Nenhuma senha de teste inicializa o cofre da instalação persistente. Containers, volumes e credenciais temporárias são removidos ao terminar; relatórios e screenshots ficam em `.runtime/artifacts/msm-phase2-check-<id>/`, com resultado mais recente em `.runtime/artifacts/phase2-latest.json`.

Em Linux, o instalador oficial prepara o binário Electron do host e o monta somente para leitura no runner. A imagem pesada dedicada ao teste não é necessária nesse caminho; o sandbox e as bibliotecas nativas continuam sendo verificados no container.

## 8.2 Comportamentos do cadastro

| Área | Comportamento |
| --- | --- |
| Grupos | Criar, renomear, habilitar/desabilitar e remover grupo vazio; política de janela, ações/hora e concorrência registrada por versões imutáveis |
| Sites | Nome, URL inicial e origens permitidas; modo genérico explícito; URLs privadas/reservadas, credenciais na URL e protocolos não HTTP(S) são recusados |
| Contas | Criar, editar, desabilitar e remover; apelido, grupo, site, credenciais opcionais, observações, status informado e proxy |
| Proxies | HTTP, HTTPS e SOCKS5; autenticação opcional cifrada, grupo proprietário, capacidade, habilitação, último diagnóstico e IP observado |
| Atribuição | Manual por conta, distribuição automática para contas sem proxy e troca transacional de rota dentro do mesmo grupo |
| Concorrência | Atualizações exigem ID e versão. Referências de outro tenant são invisíveis; proxy de outro grupo é recusado |

Uma alteração usa transação com contexto de tenant e coordenação por tenant. Duas importações ou atribuições concorrentes não ultrapassam o limite de contas nem a capacidade do proxy. Falta de capacidade cancela toda a atribuição daquela operação, preservando as rotas anteriores.

Contas em estado operacional diferente de `DORMANT` recusam edição, exclusão, reabilitação ou troca de rota. A ação específica **Desabilitar** continua disponível para fechar a admissão sem alterar credenciais/rota nem interromper efeitos em voo; desabilitar não libera a quota de cadastro ou de proxy. Isso prepara a integração com a posse de sessão das próximas fases: uma operação mutável em andamento não pode ser contornada alterando seu cadastro. O status de autenticação permanece **não verificado**; falhar ao conectar um proxy não marca a conta como banida.

A exclusão é lógica para conservar as referências de auditoria. Na conta, remove as credenciais armazenadas e a atribuição de proxy e libera o limite de cadastro. Grupos, sites e proxies com associações atuais não são removidos silenciosamente. Ao mudar um site já utilizado, a URL/origens ficam protegidas; crie outro perfil e transfira as contas de forma explícita. Trocar o site de uma conta ou o endpoint de um proxy autenticado exige reentrada explícita das credenciais ou sua remoção; um segredo armazenado não é reaproveitado silenciosamente em outro destino. Mudar o grupo recifra as credenciais com o novo contexto autenticado e exige uma rota compatível ou a escolha sem proxy.

## 8.3 Importação com prévia e confirmação

Contas aceitam CSV com cabeçalho:

```csv
alias,login,password,notes,enabled
Conta exemplo,usuario-exemplo,senha-exemplo,"Observação, com vírgula",true
```

Também aceita uma lista `login:senha`, preservando os dois-pontos adicionais na senha. Para login manual, o CSV pode conter apenas apelidos e observações. Cabeçalhos em português comuns são reconhecidos: `nome`, `apelido`, `usuario`, `senha`, `observacoes`, `ativo`. O grupo e o site são escolhidos na interface e não são controlados por colunas ocultas do arquivo.

Proxies aceitam CSV:

```csv
scheme,host,port,username,password,max_accounts
http,host-publico-do-provedor,8080,usuario-exemplo,senha-exemplo,2
```

Ou uma URL `http://`, `https://` ou `socks5://` por linha, com usuário/senha percent-encoded quando necessário. Endereços IPv6 em URLs usam colchetes. Caminho, query e fragmento não fazem parte de uma URL de proxy aceita.

O leitor aceita UTF-8/BOM, vírgula, ponto e vírgula ou tabulação, aspas duplicadas e campos com quebra de linha. O arquivo tem limite de 512 KB e 500 registros. Cabeçalhos desconhecidos, quantidade incorreta de campos, duplicatas e campos inválidos são indicados por linha, com mensagens sem senhas.

O preview de contas não abre navegador nem testa o site. O staging mantém somente linhas normalizadas cifradas; a resposta contém rótulos e resultados de validação. Após gerar a prévia, a fonte com credenciais é limpa da tela. Editar/recarregar a fonte invalida a prévia anterior. A confirmação inclui ID/hash da prévia e exige autorização explícita para ignorar linhas inválidas. O hash é calculado sobre o envelope cifrado, não sobre senhas abertas. O commit é atômico e idempotente; repetir a confirmação retorna os IDs já criados.

Prévia expira em 30 minutos e é invalidada quando grupo/site mudam de versão. Há no máximo 20 prévias pendentes por tenant. Após o commit, o conteúdo cifrado temporário é removido. Prévias vencidas são limpas ao gerar uma nova prévia. Prévia de proxies valida destinos por DNS com concorrência limitada e cache por operação, evitando resolver o mesmo provedor centenas de vezes; DNS é revalidado no commit. Falhas ou orçamento de DNS excedido aparecem como erros de linha, sem conectar diretamente ao destino.

Login é normalizado com trim e Unicode NFKC, preservando maiúsculas/minúsculas no modo genérico. A deduplicação usa HMAC derivado da chave do cofre, tenant e site, sem índice de login aberto. Não se presume que todo website tenha a mesma regra de caixa. Login, senha e autenticação de proxy não retornam nas listagens ou formulários de edição: campos vazios preservam o segredo anterior; remoção precisa ser explícita.

## 8.4 Diagnóstico e segurança de proxies

**Testar** abre uma conexão ao proxy configurado e solicita uma consulta de IP através dele. HTTP/HTTPS usa CONNECT; SOCKS5 implementa negociação, autenticação e envio do hostname para resolução no proxy. Há timeout total, limites de cabeçalhos/resposta e validação TLS tanto do proxy HTTPS quanto do destino HTTPS. Certificado inválido, autenticação recusada e proxy indisponível são falhas; não existe tentativa direta como alternativa.

O destino de diagnóstico padrão é o endpoint JSON IPv4/IPv6 do [ipify](https://www.ipify.org/), `https://api64.ipify.org?format=json`. Somente o teste solicitado pelo usuário consulta esse serviço, através do proxy. Registrar/importar um proxy pode consultar DNS para validar seu host, mas não testa a rota automaticamente. O hostname do destino de diagnóstico segue pelo proxy; o host do próprio proxy é resolvido, validado e fixado no endereço usado para conectar.

`MSM_PROXY_PROBE_URL` permite ao operador configurar outro endpoint HTTPS que retorne `{"ip":"..."}`. Essa configuração pertence ao processo da API e não pode ser enviada pelo renderer. Redirects e respostas não compatíveis são recusados. A exceção para destinos privados/CA de teste existe somente como dependência dos fixtures em memória; não é uma opção da API pública.

A política de endereço usa CIDRs e [BlockList do Node](https://nodejs.org/api/net.html#class-netblocklist). Recusa loopback, redes privadas, link-local/metadata, multicast, documentação, representações mapeadas e respostas DNS que misturem IP público e privado. Para IPv6, aceita unicast global fora das faixas especiais bloqueadas; a referência de faixas é o [registro da IANA](https://www.iana.org/assignments/iana-ipv6-special-registry). Essa é uma política conservadora de destinos, não uma promessa de acesso a toda rede especial roteável.

O limite de cadastro padrão é 500, incluindo contas desabilitadas. O operador pode reduzi-lo de 1 a 500 com `MSM_MAX_ACCOUNTS` antes de `server:up`; o cliente não recebe comando para alterá-lo. Isso é configuração local da fundação. Licenças comerciais assinadas e limites de assinatura pertencem à fase 6.

## 8.5 API e validação

O preload expõe `workspace.run(command)`. Main e API validam o comando com schemas fechados; não existe método para escolher URL de API, tenant, SQL, filesystem ou JavaScript arbitrário. O transporte HTTPS usa `/v1/workspace/command`, com limite próprio para o CSV; as outras rotas mantêm seus limites menores.

Comandos disponíveis: `get`, `group.save/delete`, `site.save/delete`, `account.save/delete/enabled`, `proxy.save/delete/test/distribute/rotate`, `import.preview/get/commit`. `get` retorna páginas de contas e metadados explícitos; nunca inclui envelopes cifrados ou campos de segredo. Cada mutação/diagnóstico é auditado com entidade, ator pareado, operação e ID da requisição.

O gate cobre:

- Testes unitários de parser, contratos, política de IP/DNS e HMAC, além da fundação.
- Servidores locais reais de HTTP/HTTPS CONNECT e SOCKS5, com/sem autenticação, IPv6, DNS remoto, certificados inválidos e ausência de fallback direto.
- PostgreSQL real: CRUD, RLS, versões, recifragem após troca de grupo, importação de 500 linhas, duplicatas, staging cifrado, confirmação repetida e concorrência de quota/capacidade.
- API de diagnóstico atualizando IP/estado do proxy e preservando o estado da conta quando a rota cai.
- Electron real: cadastro e edição de grupo/site/conta, URL privada recusada, conflito de versão, upload de CSV, revisão/cancelamento/confirmação parcial, atribuição/distribuição/rotação de proxy e remoção de conta.

Esta fase cadastral não executa campanhas, não verifica banimento de sites genéricos e não substitui o motor durável/posse de sessões das fases 3–5. O laboratório da fase 0 continua limitado às suas fixtures. Abrir as sessões de produção na visualização e automatizá-las exige essas integrações seguintes. Windows/macOS, cofres nativos e instaladores continuam exigindo homologação própria.

## 8.6 Evidências

Gate integrado `msm-phase2-check-7e1eb9d4`, aprovado em 05/11/2026 no servidor Linux arm64: 15 testes unitários, 19 de integração, nove fluxos do cadastro no Electron e as verificações de TLS, sandbox, cofre e reinício da API. A conferência inclui rejeição do reaproveitamento de credenciais ao trocar o site ou endpoint de proxy. Todos os recursos/segredos temporários desse gate foram removidos, mantendo seus relatórios e screenshots.

Revalidado em 06/11/2026 pelo gate `msm-phase2-check-aa245da2`: novamente 15 testes unitários, 19 de integração e nove fluxos no Electron aprovados. A instalação persistente foi conferida separadamente por TLS mútuo, com PostgreSQL/Redis saudáveis, schema 2 e cofre bloqueado. Os dados de teste permaneceram na instalação temporária, removida ao terminar. A implementação existente foi preservada; esta rodada atualiza sua evidência de funcionamento no servidor.
