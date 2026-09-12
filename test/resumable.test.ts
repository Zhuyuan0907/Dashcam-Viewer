import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import {mkdtempSync} from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
const root=mkdtempSync(path.join(os.tmpdir(),'resumable-'));process.env.DASHCAM_DATA_DIR=root;process.env.DASHCAM_MIN_FREE_DISK_BYTES='0';
const {makeAdminApp}=await import('./_appctx.js');
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
