import {WorkspaceError} from './errors.js';

/** Bounded RFC 4180-style reader, including doubled quotes and quoted newlines. */
export function parseCsv(raw:string):string[][] {
  const source=raw.replace(/^\uFEFF/,'');
  let quoted=false;const scores=new Map([ [',',0],[';',0],['\t',0] ]);
  for(let i=0;i<source.length;i++){
    const char=source[i]!;
    if(char==='"'){if(quoted&&source[i+1]==='"')i++;else quoted=!quoted;}
    if(!quoted){if(char==='\n'||char==='\r')break;if(scores.has(char))scores.set(char,scores.get(char)!+1);}
  }
  const delimiter=[...scores].sort((a,b)=>b[1]-a[1])[0]![0];
  const rows:string[][]=[];let row:string[]=[],field='',inside=false,afterQuote=false;
  const endField=()=>{row.push(field);field='';afterQuote=false;};
  const endRow=()=>{endField();if(row.some(value=>value.trim()))rows.push(row);row=[];if(rows.length>501)throw new WorkspaceError('IMPORT_ROW_LIMIT',400);};
  for(let i=0;i<source.length;i++){
    const char=source[i]!;
    if(inside){if(char==='"'){if(source[i+1]==='"'){field+='"';i++;}else{inside=false;afterQuote=true;}}else field+=char;continue;}
    if(char===delimiter){endField();continue;}
    if(char==='\n'||char==='\r'){if(char==='\r'&&source[i+1]==='\n')i++;endRow();continue;}
    if(afterQuote)throw new WorkspaceError('CSV_MALFORMED',400);
    if(char==='"'){if(field)throw new WorkspaceError('CSV_MALFORMED',400);inside=true;}else field+=char;
  }
  if(inside)throw new WorkspaceError('CSV_MALFORMED',400);
  if(field||row.length||afterQuote)endRow();
  return rows;
}
export function importRecords(raw:string,entity:'accounts'|'proxies'):{row:number;values:Record<string,string>;error:string}[]{
  const lines=raw.trim().split(/\r?\n/).filter(line=>line.trim());
  if(entity==='proxies'&&lines.every(line=>/^(https?|socks5):\/\//.test(line.trim()))){
    if(lines.length>500)throw new WorkspaceError('IMPORT_ROW_LIMIT',400);
    return lines.map((line,index)=>{
      try{const url=new URL(line.trim());if(!['','/'].includes(url.pathname)||url.search||url.hash)throw Error();return {row:index+1,values:{scheme:url.protocol.slice(0,-1),host:url.hostname,port:url.port||String(url.protocol==='https:'?443:url.protocol==='socks5:'?1080:80),username:decodeURIComponent(url.username),password:decodeURIComponent(url.password)},error:''};}
      catch{return {row:index+1,values:{} as Record<string,string>,error:'INVALID_PROXY_URL'};}
    });
  }
  if(entity==='accounts'&&lines.every(line=>!line.includes(',')&&!line.includes(';')&&!line.includes('\t')&&line.includes(':'))){
    if(lines.length>500)throw new WorkspaceError('IMPORT_ROW_LIMIT',400);
    return lines.map((line,index)=>{const colon=line.indexOf(':');return {row:index+1,values:{login:line.slice(0,colon).trim(),password:line.slice(colon+1)},error:''};});
  }
  const rows=parseCsv(raw);if(rows.length<2)throw new WorkspaceError('CSV_HEADER_REQUIRED',400);
  const aliases:Record<string,string>={nome:'alias',apelido:'alias',usuario:entity==='accounts'?'login':'username',user:entity==='accounts'?'login':'username',senha:'password',observacoes:'notes',ativo:'enabled',porta:'port',protocolo:'scheme',limite:'max_accounts'};
  const header=rows.shift()!.map(value=>{const key=value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'_');return aliases[key]??key;});
  const allowed=entity==='accounts'?['alias','login','password','notes','enabled']:['scheme','host','port','username','password','max_accounts'];
  if(new Set(header).size!==header.length||header.some(value=>!allowed.includes(value)))throw new WorkspaceError('CSV_HEADER_UNSUPPORTED',400);
  return rows.map((row,index)=>({row:index+2,values:Object.fromEntries(header.map((key,column)=>[key,row[column]??''])),error:row.length!==header.length?'COLUMN_COUNT_MISMATCH':''}));
}
