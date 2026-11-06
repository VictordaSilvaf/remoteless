import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import type {Page} from 'playwright';
import type {LocalClient} from '../../apps/desktop/src/main/client.js';

export async function verifyWorkspace(page:Page,client:LocalClient){
  const cases:string[]=[];
  const snapshot=async()=>(await client.workspace({kind:'get',limit:100})).snapshot!;
  const tab=(name:string)=>page.getByRole('button',{name,exact:true}).click();
  const dialog=()=>page.getByRole('dialog');
  async function save(){await dialog().getByRole('button',{name:'Salvar',exact:true}).click();await dialog().waitFor({state:'hidden'});}
  async function confirm(){await dialog().getByRole('button',{name:'Confirmar operação',exact:true}).click();await dialog().waitFor({state:'hidden'});}
  async function until(check:()=>Promise<boolean>){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await new Promise(done=>setTimeout(done,100));}throw Error('WORKSPACE_UI_CONDITION_TIMEOUT');}
  try {
    await page.getByRole('button',{name:'Abrir cadastro',exact:true}).click();
    await page.getByText('Contas e conexões',{exact:true}).waitFor();
    await until(async()=>!(await snapshot()).groups.length);
    await tab('Grupos');await page.getByRole('button',{name:'Adicionar grupo',exact:true}).click();
    await dialog().getByLabel('Nome do grupo',{exact:true}).fill('Grupo interface');await save();
    await page.getByRole('button',{name:'Editar Grupo interface',exact:true}).click();
    await dialog().getByLabel('Ações por hora',{exact:true}).fill('12');await save();
    assert.equal((await snapshot()).groups[0]!.version,2);cases.push('group-create-and-versioned-policy-edit');
    await tab('Sites');await page.getByRole('button',{name:'Adicionar site',exact:true}).click();
    await dialog().getByLabel('Nome do site',{exact:true}).fill('Site interface');
    await dialog().getByLabel('Endereço inicial',{exact:true}).fill('http://127.0.0.1/');
    await dialog().getByRole('button',{name:'Salvar',exact:true}).click();
    await dialog().getByRole('alert').filter({hasText:'reservados não são permitidos'}).waitFor();assert.equal((await snapshot()).sites.length,0);
    await dialog().getByLabel('Endereço inicial',{exact:true}).fill('https://8.8.4.4/');await save();cases.push('customer-site-selection-and-private-url-rejection');
    await tab('Contas');await page.getByRole('button',{name:'Adicionar conta',exact:true}).click();
    await dialog().getByLabel('Apelido da conta',{exact:true}).fill('Conta interface');
    await dialog().getByLabel('Login da conta',{exact:true}).fill('native-login-canary');
    await dialog().getByLabel('Senha da conta',{exact:true}).fill('native-password-canary');await save();
    await page.getByRole('button',{name:'Editar Conta interface',exact:true}).waitFor();
    assert.equal(JSON.stringify(await snapshot()).includes('native-password-canary'),false);cases.push('manual-account-create-with-hidden-encrypted-credentials');
    await page.getByRole('button',{name:'Editar Conta interface',exact:true}).click();
    const account=(await snapshot()).accounts[0]!;
    await client.workspace({kind:'account.save',id:account.id,version:account.version,alias:account.alias,groupId:account.groupId,siteId:account.siteId,notes:'Changed by another operator'});
    await dialog().getByLabel('Apelido da conta',{exact:true}).fill('Stale edit');
    await dialog().getByRole('button',{name:'Salvar',exact:true}).click();await dialog().getByRole('alert').filter({hasText:'foi alterado'}).waitFor();
    await dialog().getByRole('button',{name:'Fechar formulário',exact:true}).click();await page.getByRole('button',{name:'Atualizar cadastro',exact:true}).click();
    await until(async()=>((await snapshot()).accounts[0]!.version===2));cases.push('stale-form-is-rejected-without-overwriting-data');
    await page.getByRole('row').filter({has:page.getByText('Conta interface',{exact:true})}).getByRole('button',{name:'Desabilitar',exact:true}).click();
    await until(async()=>!(await snapshot()).accounts[0]!.enabled);
    await page.getByRole('row').filter({has:page.getByText('Conta interface',{exact:true})}).getByRole('button',{name:'Habilitar',exact:true}).click();
    await until(async()=>(await snapshot()).accounts[0]!.enabled);cases.push('account-enable-disable-without-reading-credentials');
    await tab('Importações');
    const csv='alias,login,password\nImportada 1,native-import-1,native-import-password\nImportada 2,native-import-2,native-import-password\nInválida,,native-import-password';
    await page.getByLabel('Arquivo CSV ou TXT',{exact:true}).setInputFiles({name:'contas.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
    await page.getByTestId('import-preview').click();await page.getByTestId('import-preview-result').getByText('2 válidos · 1 com erro · 3 registros',{exact:true}).waitFor();
    assert.equal(await page.getByTestId('import-source').inputValue(),'');
    assert.equal((await snapshot()).quota.used,1);
    assert.equal(await page.getByTestId('import-commit').isDisabled(),true);
    await page.getByLabel('Importar apenas os registros válidos e ignorar os erros',{exact:true}).check();
    await page.getByTestId('import-commit').click();await dialog().getByRole('button',{name:'Cancelar',exact:true}).click();assert.equal((await snapshot()).quota.used,1);
    await page.getByTestId('import-commit').click();await confirm();await until(async()=>(await snapshot()).quota.used===3);
    await page.getByTestId('import-preview-result').getByText('Importação concluída',{exact:true}).waitFor();cases.push('file-upload-preview-partial-confirmation-and-cancel');
    async function addProxy(host:string,port:number,capacity:number,scheme='http'){
      await tab('Proxies');await page.getByRole('button',{name:'Adicionar proxy',exact:true}).click();
      await dialog().getByLabel('Host do proxy',{exact:true}).fill(host);await dialog().getByLabel('Porta do proxy',{exact:true}).fill(String(port));
      await dialog().getByLabel('Protocolo do proxy',{exact:true}).selectOption(scheme);await dialog().getByLabel('Limite de contas no proxy',{exact:true}).fill(String(capacity));await save();
    }
    await addProxy('8.8.8.8',9900,1);await addProxy('8.8.4.4',9901,2);
    await tab('Contas');await page.getByRole('button',{name:'Editar Conta interface',exact:true}).click();
    const first=(await snapshot()).proxies.find(proxy=>proxy.port===9900)!;
    await dialog().getByLabel('Proxy da conta',{exact:true}).selectOption(first.id);await save();
    await page.getByLabel('Filtrar por grupo',{exact:true}).selectOption({label:'Grupo interface'});
    await page.getByLabel('Selecionar Importada 1',{exact:true}).check();await page.getByLabel('Selecionar Importada 2',{exact:true}).check();
    await page.getByRole('button',{name:'Distribuir proxies (2)',exact:true}).click();await confirm();
    await until(async()=>(await snapshot()).proxies.find(proxy=>proxy.port===9901)!.assigned===2);cases.push('manual-proxy-binding-and-automatic-capacity-distribution');
    await addProxy('1.1.1.1',1080,1,'socks5');
    await page.getByRole('row').filter({hasText:'8.8.8.8:9900'}).getByRole('button',{name:'Trocar rota',exact:true}).click();await confirm();
    await until(async()=>(await snapshot()).proxies.find(proxy=>proxy.port===1080)!.assigned===1);cases.push('proxy-rotation-between-compatible-group-routes');
    await tab('Contas');
    const row=page.getByRole('row').filter({has:page.getByText('Importada 2',{exact:true})});await row.getByRole('button',{name:'Remover',exact:true}).click();await confirm();
    await until(async()=>(await snapshot()).quota.used===2);cases.push('account-deletion-releases-the-registration-quota');
    await page.screenshot({path:'/artifacts/workspace.png',fullPage:true});
    await writeFile('/artifacts/workspace.json',JSON.stringify({passed:true,cases,renderer:'real Electron',tls:'mutual',secretsVisibleInLists:false,externalSitesContacted:false},null,2));
    for(const name of cases)console.log(`PASS workspace-ui-${name}`);
    await page.getByRole('button',{name:'Voltar ao ambiente',exact:true}).click();
  }catch(error){await page.screenshot({path:'/artifacts/workspace-failure.png',fullPage:true}).catch(()=>{});await writeFile('/artifacts/workspace.json',JSON.stringify({passed:false,cases,error:error instanceof Error?error.message:'WORKSPACE_UI_FAILED'},null,2));throw error;}
}
