import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopBridge, FoundationStatus, Peer } from '@msm/contracts';
import './style.css';
import {LabWorkbench} from './lab-workbench.js';
import {Workspace} from './workspace.js';
import {Campaigns} from './engine.js';

declare global { interface Window { multisession: DesktopBridge; } }
const messages: Record<string, string> = {
  BACKEND_UNAVAILABLE: 'O serviço local está indisponível. Verifique se os containers estão iniciados.',
  VAULT_PASSPHRASE_REQUIRED: 'O cofre do sistema não está disponível. Informe uma senha de pelo menos 12 caracteres para proteger o cofre local.',
  VAULT_PASSPHRASE_INVALID: 'A senha do cofre não confere.',
  PAIRING_REJECTED: 'O pareamento expirou ou foi recusado. Renove o token pelo procedimento de configuração.',
};
function App() {
  const [lab,setLab]=useState(false);
  const [workspace,setWorkspace]=useState(false);
  const [campaigns,setCampaigns]=useState(false);
  const [peer, setPeer] = useState<Peer>();
  const [status, setStatus] = useState<FoundationStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  async function action(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); }
    catch (e) {
      const code = e instanceof Error ? e.message.split(': ').at(-1) ?? '' : '';
      if (code === 'VAULT_PASSPHRASE_REQUIRED') setNeedsPassphrase(true);
      setError(messages[code] ?? 'Não foi possível concluir. Confira a configuração local e tente novamente.');
    } finally { setBusy(false); setPassphrase(''); }
  }
  const labels = {healthy: 'Disponível', unavailable: 'Indisponível', locked: 'Bloqueado'};
  if(lab)return <LabWorkbench port={window.multisession.lab} onBack={()=>setLab(false)}/>;
  if(workspace)return <Workspace port={window.multisession.workspace} onBack={()=>setWorkspace(false)}/>;
  if(campaigns)return <Campaigns port={window.multisession.engine} workspace={window.multisession.workspace} onBack={()=>setCampaigns(false)}/>;
  return <div className="layout">
    <aside><div className="brand"><span className="mark">M</span><div>MultiSession<small>MANAGER</small></div></div><nav aria-label="Navegação principal"><span className="selected">◈ &nbsp; Ambiente local</span></nav><div className="aside-bottom"><span className="dot"/> Fundação · Fase 1</div></aside>
    <main><header><span className="eyebrow">WORKSPACE / CONFIGURAÇÃO</span><span className="tag">DESENVOLVIMENTO LOCAL</span></header>
      <section className="intro"><div><h1>Seu ambiente, protegido.</h1><p>Conecte esta instalação ao serviço local e prepare o cofre de sessões.</p></div><button disabled={busy} onClick={() => void action(async () => { setPeer(await window.multisession.connect()); setStatus(await window.multisession.status()); })}>{busy ? 'Verificando…' : peer ? 'Atualizar ambiente' : 'Conectar instalação'}</button></section>
      <div className="cards">{(['database', 'redis', 'vault'] as const).map((key, index) => <article className="card" key={key}><div className="card-head"><span className="icon">{['▤', '⇄', '◇'][index]}</span><span className={`state ${status?.[key] ?? 'unknown'}`}>{status ? labels[status[key]] : 'A verificar'}</span></div><h2>{['Banco de dados', 'Fila de trabalho', 'Cofre de sessões'][index]}</h2><p>{['PostgreSQL com isolamento por tenant.', 'Redis com persistência e acesso restrito.', 'Criptografia autenticada e bloqueio automático.'][index]}</p></article>)}</div>
      <section className="panel"><div className="panel-title"><h2>Proteção da instalação</h2><span className="tag">TLS MÚTUO</span></div><div className="row"><div><strong>Pareamento local</strong><p>{peer ? `Instalação ${peer.installationId.slice(0, 8)} · protocolo ${peer.protocolVersion}` : 'Apenas esta instalação autorizada pode acessar a API.'}</p></div><span className={`state ${peer ? 'healthy' : 'unknown'}`}>{peer ? 'Pareado' : 'Pendente'}</span></div><div className="row"><div><strong>Chave do cofre</strong><p>Protegida pelo sistema operacional ou por uma senha local.</p></div><button className="secondary" disabled={!peer || busy} onClick={() => void action(async () => { if (status?.vault === 'healthy') await window.multisession.lockVault(); else await window.multisession.unlockVault(passphrase ? {passphrase} : {}); setStatus(await window.multisession.status()); })}>{status?.vault === 'healthy' ? 'Bloquear cofre' : 'Desbloquear cofre'}</button></div>{needsPassphrase && status?.vault !== 'healthy' && <label className="passphrase">Senha do cofre<input type="password" autoComplete="off" minLength={12} maxLength={256} value={passphrase} onChange={event => setPassphrase(event.target.value)} placeholder="Pelo menos 12 caracteres"/></label>}</section>
      {error && <div className="error" role="alert">{error}</div>}
      <section className="notice"><span>▤</span><div><strong>Contas, grupos e proxies.</strong><p>Cadastre os sites escolhidos por você, proteja credenciais e importe listas com revisão.</p><button className="secondary" disabled={!peer} onClick={()=>setWorkspace(true)}>Abrir cadastro</button></div></section>
      <section className="notice"><span>⇄</span><div><strong>Campanhas com revisão e histórico.</strong><p>Planeje diagnósticos, confira a simulação e acompanhe a execução por conta.</p><button className="secondary" disabled={!peer} onClick={()=>setCampaigns(true)}>Abrir campanhas</button></div></section>
      <section className="notice"><span>↗</span><div><strong>Laboratório da fase 0.</strong><p>Teste login, quatro sessões, espelhamento e receitas em sites de demonstração.</p><button className="secondary" disabled={!peer} onClick={()=>setLab(true)}>Abrir laboratório</button></div></section>
      <footer>Estado obtido do serviço local · Credenciais e chaves não são expostas à interface.</footer>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
