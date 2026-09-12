import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import {mkdtempSync} from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
const root=mkdtempSync(path.join(os.tmpdir(),'resumable-'));process.env.DASHCAM_DATA_DIR=root;process.env.DASHCAM_MIN_FREE_DISK_BYTES='0';
const {makeAdminApp}=await import('./_appctx.js');
const {execFile}=await import('node:child_process');
const {promisify}=await import('node:util');
test('resumed chunks preserve earlier bytes, reject incorrect offsets and block incomplete confirmation',async()=>{
 const {app,ctx,cookie}=await makeAdminApp(root);const headers={cookie};
 const s=(await app.inject({method:'POST',url:'/api/upload-sessions',headers})).json();
 const name='FILE260101-080000-001F.mp4';
 const manifest=await app.inject({method:'POST',url:`/api/upload-sessions/${s.id}/manifest`,headers,payload:{files:[{name,size:6,fingerprint:'same-file'}],auto_process:false}});assert.equal(manifest.statusCode,200);
 const put=(offset:number,data:string,hash?:string)=>app.inject({method:'PUT',url:`/api/upload-sessions/${s.id}/chunks/${name}?offset=${offset}`,headers:{cookie,'content-type':'application/octet-stream',...(hash?{'x-chunk-sha256':hash}:{})},payload:Buffer.from(data)});
 assert.equal((await put(0,'abc')).json().received,3);
 assert.equal((await put(0,'abc')).statusCode,409);
 assert.equal((await app.inject({method:'POST',url:`/api/upload-sessions/${s.id}/confirm`,headers})).statusCode,409);
 assert.equal((await put(3,'def','bad')).statusCode,422);
 assert.equal((await put(3,'def',createHash('sha256').update('def').digest('hex'))).json().complete,true);
 assert.equal(await fs.readFile(path.join(ctx.sessions.rootDir(s.id),name),'utf8'),'abcdef');
 const wrong=await app.inject({method:'POST',url:`/api/upload-sessions/${s.id}/manifest`,headers,payload:{files:[{name,size:6,fingerprint:'different-file'}]}});assert.equal(wrong.statusCode,409);
 await app.close();
});

test('complete upload automatically runs without any page or progress subscriber',async()=>{
  const {app,ctx,cookie}=await makeAdminApp(root);const headers={cookie};
  const source=path.join(root,'fixture.mp4');
  await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=size=160x90:rate=25','-t','1.5','-c:v','libx264','-threads','1',source]);
  const bytes=await fs.readFile(source),name='FILE260101-090000-002R.mp4';
  const session=(await app.inject({method:'POST',url:'/api/upload-sessions',headers})).json();
  await app.inject({method:'POST',url:`/api/upload-sessions/${session.id}/manifest`,headers,payload:{files:[{name,size:bytes.length,fingerprint:'immutable-fixture'}],auto_process:true}});
  const middle=Math.floor(bytes.length/2);
  for(const [offset,end] of [[0,middle],[middle,bytes.length]]) {
    const reply=await app.inject({method:'PUT',url:`/api/upload-sessions/${session.id}/chunks/${name}?offset=${offset}`,headers:{cookie,'content-type':'application/octet-stream'},payload:bytes.subarray(offset,end)});
    assert.equal(reply.statusCode,200);
    if(end===bytes.length)assert.equal(reply.json().processing,true);
  }
  // No SSE client ever connects. Processing must be independent of an open page.
  for(let i=0;i<200&&ctx.tasks!.list(1)[0]?.status!=='succeeded';i++)await new Promise(r=>setTimeout(r,25));
  assert.equal(ctx.tasks!.list(1)[0]?.status,'succeeded');
  const trip=ctx.db.prepare('SELECT * FROM trips').get() as {has_rear:number;has_front:number;rear_path:string};
  assert.equal(trip.has_rear,1);assert.equal(trip.has_front,0);assert.ok((await fs.stat(trip.rear_path)).size>0);
  assert.equal(ctx.sessions.get(session.id),undefined);
  await app.close();ctx.db.close();
});
