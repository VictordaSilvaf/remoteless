import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import type {Page} from 'playwright';
import type {LocalClient} from '../../apps/desktop/src/main/client.js';

export async function verifyEngine(page:Page,client:LocalClient){
  const cases:string[]=[];
  const snapshot=async()=> (await client.engine({kind:'get',limit:100})).snapshot!;
  async function until(check:()=>Promise<boolean>){const end=Date.now()+20000;while(Date.now()<end){if(await check())return;await new Promise(done=>setTimeout(done,150));}throw Error('ENGINE_UI_CONDITION_TIMEOUT');}
  try {
    await page.getByRole('button',{name:'Abrir campanhas',exact:true}).click();await page.getByRole('heading',{name:'Campanhas e histórico',exact:true}).waitFor();
    await page.getByLabel('Nome da receita',{exact:true}).fill('Conferência interface');
    await page.getByRole('button',{name:'Salvar receita',exact:true}).click();
    await until(async()=> (await snapshot()).recipes.length===1);
    await page.getByRole('button',{name:'Editar Conferência interface',exact:true}).click();
    await page.getByRole('button',{name:'Adicionar passo',exact:true}).click();await page.getByRole('button',{name:'Salvar receita',exact:true}).click();
    await until(async()=> (await snapshot()).recipes[0]!.version===2);cases.push('create-and-version-declarative-recipe');
    await page.getByLabel('Incluir Conta interface',{exact:true}).check();
    await page.getByLabel('Modo da campanha',{exact:true}).selectOption('immediate');
    assert.equal(await page.getByRole('button',{name:'Simular campanha',exact:true}).isDisabled(),true);
    await page.getByLabel('Entendo que o modo imediato concentra os inícios e mantém quotas e concorrência',{exact:true}).check();cases.push('explicit-immediate-mode-acknowledgement');
    await page.getByRole('button',{name:'Simular campanha',exact:true}).click();await page.getByTestId('campaign-plan').getByText('1 contas elegíveis · 0 excluídas · 2 ações',{exact:true}).waitFor();
    assert.equal((await snapshot()).actions.length,0);assert.equal(await page.getByRole('button',{name:'Confirmar campanha',exact:true}).isDisabled(),true);cases.push('side-effect-free-preview-and-explicit-review');
    await page.getByLabel('Revisei as contas, as ações e a janela desta campanha',{exact:true}).check();
    await page.getByRole('button',{name:'Confirmar campanha',exact:true}).click();
    await until(async()=> (await snapshot()).campaigns[0]?.state==='SUCCEEDED');
    const successful=(await snapshot()).campaigns[0]!;assert.equal(successful.counts.SUCCEEDED,2);
    await page.getByRole('button',{name:'Atualizar campanhas',exact:true}).click();
    assert.equal(await page.getByLabel('Modo da campanha',{exact:true}).inputValue(),'distributed');cases.push('ordered-real-queue-execution-and-durable-results');
    await page.getByRole('button',{name:'Simular campanha',exact:true}).click();await page.getByTestId('campaign-plan').waitFor();
    await page.getByLabel('Revisei as contas, as ações e a janela desta campanha',{exact:true}).check();await page.getByRole('button',{name:'Confirmar campanha',exact:true}).click();
    await until(async()=> (await snapshot()).campaigns.length===2);
    const pending=(await snapshot()).campaigns.find(c=>c.id!==successful.id)!;
    await page.getByRole('button',{name:`Cancelar campanha ${pending.id.slice(0,8)}`,exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Voltar',exact:true}).click();assert.equal((await snapshot()).campaigns.find(c=>c.id===pending.id)!.cancelRequested,false);
    await page.getByRole('button',{name:`Cancelar campanha ${pending.id.slice(0,8)}`,exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Confirmar operação',exact:true}).click();
    await until(async()=> (await snapshot()).campaigns.find(c=>c.id===pending.id)!.state==='CANCELLED');cases.push('review-and-cancel-campaign-without-executing');
    await page.getByRole('button',{name:'Voltar ao ambiente',exact:true}).click();await page.getByRole('button',{name:'Abrir campanhas',exact:true}).click();
    await page.getByText('Cancelada',{exact:true}).first().waitFor();assert.equal((await snapshot()).campaigns.length,2);cases.push('persisted-history-after-reopening-the-workspace');
    await page.screenshot({path:'/artifacts/engine.png',fullPage:true});
    await writeFile('/artifacts/engine.json',JSON.stringify({passed:true,cases,renderer:'real Electron',queue:'real BullMQ/Redis',database:'real PostgreSQL',externalSitesContacted:false},null,2));
    for(const name of cases)console.log(`PASS engine-ui-${name}`);
    await page.getByRole('button',{name:'Voltar ao ambiente',exact:true}).click();
  }catch(error){await page.screenshot({path:'/artifacts/engine-failure.png',fullPage:true}).catch(()=>{});await writeFile('/artifacts/engine.json',JSON.stringify({passed:false,cases,error:error instanceof Error?error.message:'ENGINE_UI_FAILED',snapshot:await snapshot().catch(()=>null)},null,2));throw error;}
}
