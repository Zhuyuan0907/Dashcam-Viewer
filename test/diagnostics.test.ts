import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root=mkdtempSync(path.join(os.tmpdir(),'diagnostics-'));
process.env.DASHCAM_DATA_DIR=root;
process.env.DASHCAM_MIN_FREE_DISK_BYTES='0';
const {makeAdminApp}=await import('./_appctx.js');

test('public health has no deployment details; diagnostics require admin',async()=>{
  const {app,ctx,cookie}=await makeAdminApp(root);
  try {
    const health=await app.inject({method:'GET',url:'/healthz'});
    assert.deepEqual(health.json(),{status:'ok'});
    assert.equal((await app.inject({method:'GET',url:'/api/admin/diagnostics'})).statusCode,401);
    const result=await app.inject({method:'GET',url:'/api/admin/diagnostics',headers:{cookie}});
    assert.equal(result.statusCode,200);assert.equal(result.json().ok,true);
    assert.ok(!result.body.includes('password'));
  } finally {await app.close();ctx.db.close();await fs.rm(root,{recursive:true,force:true});}
});
