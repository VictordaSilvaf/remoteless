import {request} from 'node:http';
import {labCommandSchema,uuidSchema,type LabCommand,type LabResult,type LabStatus,type LabFrame} from '@msm/contracts';
export class LabClient {
  constructor(private readonly socket:string,private readonly capability:string){}
  async call<T>(path:string,body?:unknown):Promise<T>{
    const encoded=body===undefined?undefined:JSON.stringify(body);
    return new Promise((resolve,reject)=>{
      const req=request({socketPath:this.socket,path,method:encoded?'POST':'GET',headers:{authorization:`Bearer ${this.capability}`,...(encoded?{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}:{})}},res=>{
        let bytes=0;const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2_000_000){res.destroy();reject(new Error('LAB_RESPONSE_TOO_LARGE'));return;}chunks.push(chunk);});
        res.on('error',()=>reject(new Error('LAB_UNAVAILABLE')));res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString()) as {error?:string};if((res.statusCode??500)>=400){reject(new Error(value.error??'LAB_REQUEST_FAILED'));return;}resolve(value as T);}catch{reject(new Error('LAB_INVALID_RESPONSE'));}});
      });
      req.setTimeout(30_000,()=>req.destroy());req.on('error',()=>reject(new Error('LAB_UNAVAILABLE')));req.end(encoded);
    });
  }
  status(){return this.call<LabStatus>('/status');}
  command(input:LabCommand){return this.call<LabResult>('/command',labCommandSchema.parse(input));}
  frame(id:string){return this.call<LabFrame|null>(`/frame/${uuidSchema.parse(id)}`);}
}
