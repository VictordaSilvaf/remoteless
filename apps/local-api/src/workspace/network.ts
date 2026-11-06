import {lookup} from 'node:dns/promises';
import {BlockList,isIP} from 'node:net';
import {WorkspaceError} from './errors.js';

export interface NetworkPolicy {
  resolve?:(host:string)=>Promise<{address:string;family:number}[]>;
  /** Only supplied by in-process fixtures; never accepted from an API request. */
  allowPrivate?:boolean;
  proxyCa?:Buffer;
  probeCa?:Buffer;
}
const blocked4=new BlockList(),blocked6=new BlockList(),global6=new BlockList();
global6.addSubnet('2000::',3,'ipv6');
for(const cidr of ['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','240.0.0.0/4']){
  const [ip,prefix]=cidr.split('/');blocked4.addSubnet(ip!,Number(prefix),'ipv4');
}
for(const cidr of ['::/128','::1/128','::ffff:0:0/96','64:ff9b::/96','100::/64','2001::/23','2001:db8::/32','2002::/16','3fff::/20','fc00::/7','fe80::/10','fec0::/10','ff00::/8']){
  const [ip,prefix]=cidr.split('/');blocked6.addSubnet(ip!,Number(prefix),'ipv6');
}
export function publicAddress(address:string){const family=isIP(address);return family===4?!blocked4.check(address,'ipv4'):family===6&&global6.check(address,'ipv6')&&!blocked6.check(address,'ipv6');}
export function canonicalHost(value:string){
  const input=value.replace(/^\[|\]$/g,'');
  if(isIP(input)===4)return input;
  if(isIP(input)===6){try{return new URL(`http://[${input}]`).hostname.slice(1,-1);}catch{throw new WorkspaceError('INVALID_HOST',400);}}
  if(!/^[\p{L}\p{N}.-]+$/u.test(input)||input.length>253)throw new WorkspaceError('INVALID_HOST',400);
  let host:string;try{host=new URL(`http://${input}`).hostname.toLowerCase().replace(/\.$/,'');}catch{throw new WorkspaceError('INVALID_HOST',400);}
  if(!host||host.split('.').some(part=>!part||part.length>63))throw new WorkspaceError('INVALID_HOST',400);
  return host;
}
export function destinationHost(hostname:string,policy:NetworkPolicy={}){
  const host=canonicalHost(hostname);
  if(!policy.allowPrivate&&/(^|\.)(localhost|local|internal|invalid|test)$/.test(host))throw new WorkspaceError('DESTINATION_FORBIDDEN',400);
  if(isIP(host)&&!policy.allowPrivate&&!publicAddress(host))throw new WorkspaceError('DESTINATION_FORBIDDEN',400);
  return host;
}
export async function resolvePublic(hostname:string,policy:NetworkPolicy={}){
  const host=destinationHost(hostname,policy);
  let addresses:{address:string;family:number}[];
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{addresses=isIP(host)?[{address:host,family:isIP(host)}]:await Promise.race([(policy.resolve??(name=>lookup(name,{all:true,verbatim:true})))(host),new Promise<never>((_done,reject)=>{timeout=setTimeout(()=>reject(Error('DNS_TIMEOUT')),3000);timeout.unref();})]);}
  catch{throw new WorkspaceError('DNS_LOOKUP_FAILED',400);}
  finally{clearTimeout(timeout);}
  if(!addresses.length||addresses.some(value=>!isIP(value.address)||(!policy.allowPrivate&&!publicAddress(value.address))))throw new WorkspaceError('DESTINATION_FORBIDDEN',400);
  return {host,addresses};
}
export async function siteUrl(raw:string,policy:NetworkPolicy={}){
  let url:URL;try{url=new URL(raw);}catch{throw new WorkspaceError('INVALID_SITE_URL',400);}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new WorkspaceError('INVALID_SITE_URL',400);
  await resolvePublic(url.hostname,policy);
  return url;
}
