import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeRequireUser, type AppContext } from '../context.js';
import { MAX_FILE_BYTES, MAX_SESSION_BYTES, MIN_FREE_DISK_BYTES } from '../config.js';
import { safeJoin } from '../util/paths.js';
interface UploadFile { session_id:string; name:string; size:number; fingerprint:string; received:number; complete:number }
const CHUNK=4*1024*1024;
function validName(name:unknown):name is string {
  return typeof name==='string'&&name.length>0&&name.length<=512&&!name.includes('\\')&&!name.includes('\0')&&name.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!p.endsWith('.part'));
}
export function registerResumable(app:FastifyInstance,ctx:AppContext):void {
  const {db,sessions}=ctx,preHandler=makeRequireUser(ctx),busy=new Set<string>();
  db.exec(`CREATE TABLE IF NOT EXISTS upload_manifests(session_id TEXT PRIMARY KEY REFERENCES sftp_sessions(id) ON DELETE CASCADE,auto_process INTEGER NOT NULL,gap_min INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS upload_files(session_id TEXT NOT NULL REFERENCES sftp_sessions(id) ON DELETE CASCADE,name TEXT NOT NULL,size INTEGER NOT NULL,fingerprint TEXT NOT NULL,received INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,name));`);
  const files=(sid:string)=>db.prepare('SELECT * FROM upload_files WHERE session_id=? ORDER BY name').all(sid) as UploadFile[];
  app.post<{Params:{id:string};Body:{files?:{name:string;size:number;fingerprint:string}[];auto_process?:boolean;gap_min?:number}}>('/api/upload-sessions/:id/manifest',{preHandler},(req,reply)=>{
    const s=sessions.get(req.params.id),body=req.body;
    if(!s||s.userId!==req.user!.id)return reply.code(404).send({detail:'工作階段不存在'});
    if(s.status!=='active'||s.conns)return reply.code(409).send({detail:'請等目前傳輸結束再增加檔案'});
    if(!Array.isArray(body?.files)||!body.files.length||body.files.length>5000)return reply.code(400).send({detail:'檔案清單需包含 1–5000 個檔案'});
    const names=new Set<string>();
    for(const f of body.files){
      if(!f||typeof f!=='object')return reply.code(400).send({detail:'檔案清單格式不合法'});
      if(!validName(f.name)||!Number.isSafeInteger(f.size)||f.size<=0||(MAX_FILE_BYTES>0&&f.size>MAX_FILE_BYTES)||typeof f.fingerprint!=='string'||f.fingerprint.length>256||!f.fingerprint||names.has(f.name))return reply.code(400).send({detail:'檔案名稱、大小或識別資料不合法'});
      names.add(f.name);
      const previous=db.prepare('SELECT * FROM upload_files WHERE session_id=? AND name=?').get(s.id,f.name) as UploadFile|undefined;
      if(previous&&(previous.size!==f.size||previous.fingerprint!==f.fingerprint))return reply.code(409).send({detail:`${f.name} 與原本檔案不同，請建立新的上傳工作階段`});
    }
    const total=new Map(files(s.id).map(f=>[f.name,f.size]));for(const f of body.files)total.set(f.name,f.size);
    if(MAX_SESSION_BYTES>0&&[...total.values()].reduce((a,b)=>a+b,0)>MAX_SESSION_BYTES)return reply.code(413).send({detail:'整批檔案超過上傳容量限制'});
    db.transaction(()=>{
      db.prepare('INSERT INTO upload_manifests VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET auto_process=excluded.auto_process,gap_min=excluded.gap_min').run(s.id,body.auto_process===true?1:0,Number.isFinite(body.gap_min)?Math.min(120,Math.max(1,Math.round(body.gap_min!))):15);
      const insert=db.prepare('INSERT OR IGNORE INTO upload_files(session_id,name,size,fingerprint) VALUES (?,?,?,?)');for(const f of body.files!)insert.run(s.id,f.name,f.size,f.fingerprint);
    })();
    if(s.idleSec>0&&s.idleSec<86400){s.idleSec=86400;db.prepare('UPDATE sftp_sessions SET idle_sec=? WHERE id=?').run(s.idleSec,s.id);}
    sessions.touch(s.id,{});return {chunk_size:CHUNK,files:files(s.id)};
  });
  app.get<{Params:{id:string}}>('/api/upload-sessions/:id/manifest',{preHandler},(req,reply)=>{
    const s=sessions.get(req.params.id);if(!s||s.userId!==req.user!.id)return reply.code(404).send({detail:'工作階段不存在'});
    return {chunk_size:CHUNK,files:files(s.id)};
  });
  app.put<{Params:{id:string;'*':string};Querystring:{offset?:string}}>('/api/upload-sessions/:id/chunks/*',{preHandler,bodyLimit:CHUNK},async(req,reply)=>{
    const s=sessions.get(req.params.id),name=req.params['*'],offset=Number(req.query.offset);
    if(!s||s.userId!==req.user!.id)return reply.code(404).send({detail:'工作階段不存在'});
    if(s.status!=='active'||!validName(name)||!Number.isSafeInteger(offset)||offset<0)return reply.code(409).send({detail:'工作階段或續傳位置不合法'});
    const f=db.prepare('SELECT * FROM upload_files WHERE session_id=? AND name=?').get(s.id,name) as UploadFile|undefined;
    if(!f)return reply.code(400).send({detail:'請先登記檔案清單'});
    if(f.complete)return {received:f.received,complete:true};
    if(f.received!==offset)return reply.code(409).send({detail:'續傳位置已更新',received:f.received});
    const key=s.id+'/'+name;if(busy.has(key))return reply.code(409).send({detail:'此檔案正在傳輸'});
    busy.add(key);sessions.connOpened(s.id);
    let received=offset,complete=false;
    try {
      if(f.received===f.size){
        const dest=safeJoin(sessions.rootDir(s.id),name),tmp=dest+'.part';
        const staged=await fs.stat(tmp).catch(()=>null),published=await fs.stat(dest).catch(()=>null);
        if(staged?.size===f.size)await fs.rename(tmp,dest);
        else if(published?.size!==f.size)throw Error('完成檔案缺失，請建立新的上傳工作階段');
        db.prepare('UPDATE upload_files SET complete=1 WHERE session_id=? AND name=?').run(s.id,name);
        complete=true;received=f.size;
      }else{
      const parts:Buffer[]=[];let size=0;
      for await(const part of req.body as AsyncIterable<Buffer>){size+=part.length;if(size>CHUNK)throw Error('分塊過大');parts.push(part);}
      if(!size||offset+size>f.size)throw Error('分塊大小與檔案清單不符');
      const chunk=Buffer.concat(parts),digest=createHash('sha256').update(chunk).digest('hex');
      const expected=req.headers['x-chunk-sha256'];
      if(expected&&expected!==digest)return reply.code(422).send({detail:'分塊校驗失敗，請重傳'});
      const root=sessions.rootDir(s.id),dest=safeJoin(root,name),tmp=dest+'.part';
      const st=await fs.statfs(root);
      if(st.bavail*st.bsize<size+MIN_FREE_DISK_BYTES)return reply.code(507).send({detail:'磁碟空間不足，已保存續傳位置'});
      if(MAX_SESSION_BYTES>0&&s.totalBytes+size>MAX_SESSION_BYTES)return reply.code(413).send({detail:'上傳工作階段容量不足'});
      await fs.mkdir(path.dirname(dest),{recursive:true});
      const file=await fs.open(tmp,offset===0?'w':'r+');
      try {
        await file.truncate(offset);
        let written=0;
        while(written<chunk.length){const r=await file.write(chunk,written,chunk.length-written,offset+written);if(!r.bytesWritten)throw Error('磁碟寫入未完成');written+=r.bytesWritten;}
        await file.sync();
      } finally {await file.close();}
      received=offset+size;complete=received===f.size;
      db.prepare('UPDATE upload_files SET received=? WHERE session_id=? AND name=?').run(received,s.id,name);
      if(complete){await fs.rename(tmp,dest);db.prepare('UPDATE upload_files SET complete=1 WHERE session_id=? AND name=?').run(s.id,name);}
      sessions.touch(s.id,{bytes:size,files:complete?1:0});
      }
    } catch(error){return reply.code(400).send({detail:error instanceof Error?error.message:String(error),received:offset});}
    finally{busy.delete(key);sessions.connClosed(s.id);}
    const manifest=db.prepare('SELECT * FROM upload_manifests WHERE session_id=?').get(s.id) as {auto_process:number;gap_min:number}|undefined;
    if(complete&&manifest?.auto_process&&s.conns===0&&files(s.id).every(f=>f.complete)){
      const confirmed=await app.inject({method:'POST',url:`/api/upload-sessions/${s.id}/confirm?gap_min=${manifest.gap_min}`,headers:{cookie:req.headers.cookie??''}});
      return {received,complete,processing:confirmed.statusCode===200,detail:confirmed.statusCode===200?'伺服器已接手，可以關閉網頁':confirmed.json().detail};
    }
    return {received,complete};
  });
}
