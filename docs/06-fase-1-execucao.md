# 6. Fundação implementada e execução da fase 1

**Estado em 04/11/2026:** fundação concluída e gate completo aprovado em Linux arm64. O escopo desta fase é a infraestrutura local e sua segurança; homologação dos outros sistemas operacionais, instaladores e recursos comerciais pertencem às fases seguintes.

## 6.1 Escopo desta entrega

Esta é a primeira entrega executável da fundação. O servidor de desenvolvimento roda containers e testes headless. No produto final, a proposta é executar sessões e automações no computador do cliente; um plano remoto separado cuida de login, assinatura, administração e atualizações.

| Componente | Implementado nesta entrega |
| --- | --- |
| Monorepo | npm workspaces, TypeScript estrito, lockfile, build backend/desktop e runner |
| Contratos | Schemas Zod fechados, versão de protocolo, estados de dependências e IPC tipado |
| Banco | Migration transacional com checksum/lock, papel `msm_app` sem bypass de RLS, FKs compostas e contexto de tenant por transação |
| Transporte | TLS mútuo com CA local, cliente fixado por fingerprint e acesso em loopback |
| Pareamento | Token curto e único, tenant escolhido no servidor, registro/auditoria na mesma transação |
| Cofre | Envelope encryption XChaCha20-Poly1305, DEK aleatória por segredo, AAD vinculado ao escopo, bloqueio por inatividade e prova persistida da chave |
| Chave no desktop | `safeStorage` assíncrono em backend de SO reconhecido ou arquivo protegido por senha com Argon2id |
| Electron | Tela de diagnóstico em português, renderer sandboxed, CSP e bridge restrita à janela/frame/origem esperados |
| Containers | Imagens por digest, segredos fora das imagens, limites de recursos e dependências com health checks |
| Runner diagnóstico | Chromium sandboxed, contextos isolados, restauração de cookies e tráfego apenas por canal de proxy dedicado |

O cofre está no processo da API nesta primeira entrega; as primitivas ficam em pacote separado. Runners não recebem chave mestra, credenciais de banco ou Redis. A extração do cofre para serviço próprio e capacidades de execução entram quando o motor de sessões for implementado. O Main conecta ao backend iniciado pelo operador; o supervisor automático/instalador completo ainda é trabalho posterior.

A identidade local pareada representa **uma instalação de desenvolvimento**, não o login comercial de usuários nem um serviço remoto compartilhado pronto para produção. As tabelas de grupos/sites/contas são a base de persistência; seus endpoints de produto chegam na fase 2. A outbox existe no schema, mas dispatcher, BullMQ e execução de campanhas chegam na fase 3.

## 6.2 Iniciar e verificar o backend no servidor

```bash
npm ci
npm run setup
npm run doctor
npm run server:up
npm run server:check
npm run server:status
```

`setup` gera `.runtime/` com permissão restrita, senhas aleatórias, CA, certificados e identidade local. Pode ser repetido sem trocar as senhas ou recriar a identidade. O material fica fora do controle de versão e do contexto Docker. A chave privada da CA não é montada na API ou runner; o papel administrativo do banco é montado somente na migração.

`doctor` verifica identidade compartilhada, CA, validade/finalidade dos certificados, correspondência entre certificados e chaves, pin do cliente, permissões de diretórios/segredos e consistência do token quando ainda existe. Nenhuma chave é exibida. `server:up` executa esse diagnóstico antes de iniciar os serviços. No Linux, arquivos privados acessíveis ao grupo/outros ou substituídos por symlink são recusados.

A migração cria o papel operacional, aplica versões sob advisory lock, verifica checksums e inicializa o tenant local. Alterar uma migration já aplicada é erro; alterações futuras devem entrar em outro arquivo. A API só inicia após banco/Redis saudáveis e migração concluída.

`server:check` usa o mesmo cliente HTTPS do Electron, valida a CA e apresenta estados reais do banco, Redis e cofre. No primeiro uso, pareia a instalação com token de validade de 30 minutos e remove a cópia consumida do lado do cliente. A unicidade no banco impede replay mesmo que outra cópia do token exista.

`/status` é liveness autenticada por certificado da instalação/health probe. `/ready` exige também pareamento, banco/fila disponíveis e cofre desbloqueado; retorna 503 enquanto a execução não estiver pronta. A saúde do container usa liveness para permitir iniciar o desktop e desbloquear o cofre, sem confundir isso com permissão para executar automações.

Se o pareamento inicial expirar antes do consumo:

```bash
npm run setup -- --renew-pairing-token
docker compose -p msm-phase1 -f infra/compose/compose.yaml up -d --force-recreate api
npm run server:check
```

Renovar o token não desfaz um pareamento existente. Certificados desta entrega de desenvolvimento duram 90 dias; renovação automática e revogação administrada de dispositivos ainda precisam ser implementadas antes da distribuição comercial. Não copiar `.runtime/authority` ou `.runtime/server` para clientes.

Para parar sem remover volumes:

```bash
npm run server:down
```

Dados permanecem nos volumes `msm-phase1_postgres-data` e `msm-phase1_redis-data`. Nenhum comando normal remove esses volumes ou interfere em outros projetos Docker.

## 6.3 Execução do desktop no cliente

Em um computador com ambiente gráfico e o backend local configurado:

```bash
npm ci
npm run setup
npm run server:up
npm run desktop:dev
```

`desktop:dev` instala o binário Electron com os checksums do pacote, compila e abre a interface. O build por si só não exige esse download; os containers do backend não instalam o binário desktop. `npm start`/`npm run dev` no servidor não abrem janela.

O desktop usa certificados de `.runtime/client` e a URL de loopback configurada. O arquivo do cofre fica no diretório de dados do aplicativo do usuário. No Linux, se não houver backend de cofre reconhecido, a interface solicita senha de no mínimo 12 caracteres e não usa `basic_text` ou backend desconhecido silenciosamente. Perder a senha sem recuperação torna a chave indisponível; a implementação desta fase ainda não oferece assistente de recuperação.

O servidor de desenvolvimento também pode ser acessado por um cliente de diagnóstico através de túnel SSH autorizado:

```bash
ssh -N -L 17643:127.0.0.1:17643 usuario@servidor
```

Isso é uma ferramenta de desenvolvimento: o cliente de diagnóstico precisa do material de `.runtime/client` correspondente por canal seguro. TLS mútuo continua sendo verificado dentro do túnel. Essa opção não transforma o backend local em hospedagem central para todos os usuários e não é o fluxo de instalação do produto final.

## 6.4 Testes automatizados

O gate completo pode ser repetido com um comando, inclusive no servidor sem tela física. Requer Node.js, OpenSSL e Docker Compose 2.24.4 ou posterior:

```bash
npm run phase1:verify
```

O verificador cria um projeto `msm-phase1-check-<id>` com CA, identidade, senhas e volumes próprios. Usa o [override do Compose](https://docs.docker.com/reference/compose-file/merge/) para remover as portas da API e manter o tráfego de teste na rede interna. A instalação persistente e seu cofre não são usados pelo teste.

O gate cobre bootstrap repetível, diagnóstico, a suíte unitária atual, TypeScript/build, replay da migração, integração com banco/TLS reais, runner sandboxed e Electron real com Xvfb. Depois do primeiro desbloqueio pelo Electron, reinicia o processo da API: o cofre deve voltar bloqueado, o pareamento deve persistir e a mesma chave protegida por senha deve ser aceita novamente. Senha incorreta e adulteração do arquivo cifrado devem manter o cofre bloqueado. O backend `basic_text` é recusado deliberadamente nesse teste; a proteção do SO continua seguindo as [capacidades do safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

Evidências ficam em `.runtime/artifacts/msm-phase1-check-<id>/`: `report.json`, logs por etapa, `integration.json`, `desktop-prepare.json`, `desktop-restore.json` e screenshots. `.runtime/artifacts/phase1-latest.json` aponta para o resultado mais recente, inclusive quando há falha. Ao terminar, o verificador remove somente seus containers, volumes e credenciais temporárias; preserva os relatórios. Ele não executa limpeza global do Docker.

Testes unitários, contratos e build:

```bash
npm test
npm run typecheck
npm run build
```

Os testes compilam fontes TypeScript com esbuild e executam cada arquivo usando `node:test`, exibindo os casos individuais. Verificam vínculo criptográfico de tenant/grupo/entidade/finalidade, adulteração, chave errada, bloqueio do cofre, Argon2id, origem de IPC, rejeição de tenant fornecido pelo cliente e bootstrap/permissões/pin do certificado. Uma falha ao limpar a transação de tenant descarta a conexão, preservando o erro original.

Integração usa **PostgreSQL e API reais**. O override de testes adiciona portas exclusivamente em loopback para banco e Redis:

```bash
npm run infra:test:up
npm run test:integration
```

A suíte cria tenants temporários e remove seus registros ao terminar. Confirma ausência de privilégios de owner/superuser/bypass, isolamento de leitura/escrita, ausência de vazamento pelo pool sob concorrência e rollback, FKs cruzadas, persistência cifrada, pareamento de uso único, binding da chave do cofre e conexão TLS real com/sem certificado. Também altera uma cópia de migration e injeta DDL incompleto: o checksum deve ser recusado e nenhum objeto parcial pode persistir. A execução manual pode parear a instalação de desenvolvimento, mas não inicializa a chave real do cofre do usuário.

Após os testes, remova as publicações adicionais recriando os serviços com o Compose base:

```bash
npm run server:up
```

O backend continua acessível só pela porta TLS de loopback; PostgreSQL e Redis voltam a ficar sem portas publicadas.

## 6.5 Runner e proxy: gate de isolamento

```bash
npm run runner:verify
```

Esse comando usa o profile `isolation` e um site-fixture local. O runner roda como UID 1000, sem capabilities, com `no-new-privileges`, filesystem somente leitura, limites de recursos e `network_mode: none`. O Chromium tem sandbox explicitamente habilitado; o diagnóstico verifica seccomp e namespaces no próprio browser.

Como o namespace não possui saída IP, o runner se comunica com um gateway de teste por um socket Unix exclusivo do grupo. Um bridge de loopback encaminha somente esse canal para o Chromium. O gateway aceita apenas a fixture e não alcança o banco/API. A prova não depende de bloquear requisições por JavaScript nem de prometer que uma configuração de proxy sempre impedirá fallback.

O gateway desta fase é **somente diagnóstico**: suporta a fixture HTTP declarada e recusa outros destinos/CONNECT. Importação, autenticação e conexão a proxies HTTP/HTTPS/SOCKS5 reais serão implementadas na fase 2. Não interpretar o teste como suporte já concluído a provedores comerciais de proxy ou a websites arbitrários.

Perfis seccomp:

- `seccomp.playwright.json`: cópia do [perfil oficial do Playwright 1.64.1](https://github.com/microsoft/playwright/blob/v1.64.1/utils/docker/seccomp_profile.json), SHA-256 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`.
- `seccomp.runner.json`: derivado que permite também a syscall `chroot`, necessária ao sandbox por namespaces quando todas as capabilities do container foram removidas. Essa permissão não concede `CAP_SYS_CHROOT` no namespace original e não adiciona `SYS_ADMIN`, modo privilegiado ou desativação do sandbox.

A configuração deve passar novamente em cada SO/runtime de lançamento. Se o host não suportar a combinação, o teste falha; não existe fallback automático para `--no-sandbox`.

## 6.6 Mudanças em relação à estrutura proposta

Foi adotado npm workspaces por já estar disponível no ambiente, preservando monorepo, versões fixadas e contratos compartilhados. O backend permanece Fastify/PostgreSQL/Redis, e a execução de sessões continua prevista em workers por grupo. O diagnóstico usa socket Unix com rede desativada como concretização mais restrita do egress por grupo.

A GUI foi compilada e o aplicativo Electron real passou pelos testes com Xvfb em Linux arm64: pareamento TLS, Main/preload/renderer, quatro painéis e sandbox/context isolation na fase 0; criação, bloqueio, reabertura e rejeição de adulteração do cofre na fase 1. Integração com cofres nativos de Windows/macOS, input físico e instaladores precisam ser validados em máquinas cliente. O servidor atual não exige ambiente gráfico físico para operar a fundação ou executar esses testes.

Antes da fase 2, os gates desta entrega são: bootstrap repetível, testes unitários/integrados aprovados, diagnóstico de sandbox/egress aprovado no runtime de destino e revisão das limitações acima. Ainda não há evidência de capacidade de 100/300/500 sessões; esses ensaios dependem do motor de sessões das fases seguintes.

## 6.7 Evidências desta entrega

Validação realizada em 04/11/2026 no servidor Linux arm64:

- `npm run setup` executado novamente sem recriar identidade ou segredos.
- Dez casos unitários aprovados e doze casos de integração aprovados, sem skips.
- TypeScript estrito e build backend/renderer/preload/runner aprovados.
- PostgreSQL, Redis e API reais iniciados com health checks e migrações concluídas.
- Runner retornou `directEgress=blocked`, `proxy=verified`, `contexts=isolated`, `restore=verified` e `sandbox=verified`.
- Electron real aprovado em display virtual Linux arm64, com isolamento do renderer e cofre protegido por senha; senha incorreta e arquivo adulterado recusados.
- API reiniciada entre duas execuções do desktop: cofre bloqueado na inicialização, pareamento preservado e chave cifrada reutilizada com sucesso.
- Gate `msm-phase1-check-efd94068` aprovado em todas as 15 etapas, incluindo remoção dos próprios recursos temporários. O cofre real da instalação de desenvolvimento não foi inicializado pelo teste.

As evidências adicionais da prova de sessões, seus relatórios e comandos estão no [guia da fase 0](07-fase-0-laboratorio.md). Não constituem homologação de sites reais, proxies comerciais, outros SOs ou capacidade de centenas de sessões ativas.

A fundação foi revalidada em 05/11/2026 pelo gate integrado da fase 2 (`msm-phase2-check-7e1eb9d4`), com 15 casos unitários, 19 de integração e nove fluxos do cadastro no Electron. Em Linux, os gates montam o binário Electron oficial do host somente para leitura no runner, evitando uma imagem extra pesada. Consulte o [guia da fase 2](08-fase-2-cadastro-e-proxies.md) para essas evidências adicionais.
