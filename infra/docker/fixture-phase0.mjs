import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const sessions=new Map(), accounts=new Map(), ledger=[];
const page=await readFile(new URL('./fixture-phase0.html',import.meta.url),'utf8');
function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>16384)throw Error('too-large');}return JSON.parse(text||'{}');}
createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://fixture.test');
    const cookie=req.headers.cookie?.match(/(?:^|;\s*)msm_fixture=([a-f0-9]+)/)?.[1];
    const user=sessions.get(cookie);
    if(url.pathname==='/api/login'&&req.method==='POST'){
      const input=await body(req);
      if(!/^demo-[a-zA-Z0-9-]{1,40}$/.test(input.username??'')||input.password!=='phase0-demo'){json(res,401,{error:'INVALID_LOGIN'});return;}
      const token=randomBytes(24).toString('hex');sessions.set(token,input.username);
      if(!accounts.has(input.username))accounts.set(input.username,{username:input.username,heals:0,visits:0,canvasClicks:0,note:''});
      res.setHeader('Set-Cookie',`msm_fixture=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`);
      json(res,200,{...accounts.get(input.username),marker:createHash('sha256').update(input.username).digest('hex').slice(0,16)});return;
    }
    if(url.pathname==='/api/me'){json(res,user?200:401,user?accounts.get(user):{error:'LOGIN_REQUIRED'});return;}
    if(url.pathname==='/api/action'&&req.method==='POST'){
      if(!user){json(res,401,{error:'LOGIN_REQUIRED'});return;}
      const input=await body(req), account=accounts.get(user);
      if(input.action==='reject'){json(res,409,{error:'BUSINESS_REJECTED'});return;}
      if(!['heal','shop','canvas','note'].includes(input.action)){json(res,400,{error:'UNKNOWN_ACTION'});return;}
      if(input.action==='heal')account.heals++;
      if(input.action==='shop')account.visits++;
      if(input.action==='canvas')account.canvasClicks++;
      if(input.action==='note')account.note=String(input.value??'').slice(0,500);
      ledger.push({username:user,action:input.action,at:Date.now()});
      json(res,200,account);return;
    }
    if(url.pathname==='/api/ledger'){json(res,user?200:401,user?ledger.filter(event=>event.username===user):{error:'LOGIN_REQUIRED'});return;}
    if(req.method==='GET'&&!url.pathname.startsWith('/api/')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:"});res.end(page);return;}
    json(res,404,{error:'NOT_FOUND'});
  }catch{json(res,400,{error:'INVALID_REQUEST'});}
}).listen(8080,'0.0.0.0');
