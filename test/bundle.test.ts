import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {createBundle,verifyBundle,restoreBundle} from '../src/storage/bundle.js';

test('offline bundle verifies media and SQLite and refuses overwrite or unsafe relocation',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bundle-test-'));
  try {
    const source=path.join(root,'source'),bundle=path.join(root,'backup');await fs.mkdir(source);
    const db=new Database(path.join(source,'dashcam.db'));db.exec('CREATE TABLE example(id INTEGER); INSERT INTO example VALUES(42)');db.close();
    await fs.writeFile(path.join(source,'share_token.key'),'secret-fixture');
    await fs.writeFile(path.join(source,'video.mp4'),'media-fixture');
    const manifest=await createBundle(source,bundle);assert.equal(manifest.files.length,3);
    await assert.rejects(createBundle(source,bundle));await assert.rejects(restoreBundle(bundle,source));
    await assert.rejects(restoreBundle(bundle,path.join(root,'different-root')));
    await fs.rename(source,path.join(root,'old-source'));await restoreBundle(bundle,source);
    assert.equal(await fs.readFile(path.join(source,'video.mp4'),'utf8'),'media-fixture');
    await fs.writeFile(path.join(bundle,'data','video.mp4'),'corrupt');await assert.rejects(verifyBundle(bundle));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
