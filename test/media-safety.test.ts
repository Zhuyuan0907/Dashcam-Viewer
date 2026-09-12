import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=mkdtempSync(path.join(os.tmpdir(),'media-safety-'));
process.env.DASHCAM_DATA_DIR=root;
const {createDb}=await import('../src/db.js');
const {commitMedia,recoverMediaCommits}=await import('../src/media/commit.js');
const {computeTrimPlan}=await import('../src/routes/edit.js');
const {timeAt,continuous,sliceTimeline}=await import('../src/media/timeline.js');

test('failed metadata commit restores both cameras and retains database state',async()=>{
  const dir=path.join(root,'trips','rollback');await fs.mkdir(dir,{recursive:true});
  const db=createDb(':memory:');
  const files=['front','rear'].map(n=>({target:path.join(dir,n),staged:path.join(dir,n+'.tmp')}));
  for(const f of files){await fs.writeFile(f.target,'original');await fs.writeFile(f.staged,'trimmed');}
  await assert.rejects(commitMedia(db,'trip',files,()=>{throw Error('DB failure')}));
  for(const f of files)assert.equal(await fs.readFile(f.target,'utf8'),'original');
  assert.equal(db.prepare('SELECT count(*) n FROM media_commits').get().n,0);
  db.close();
});
test('startup replays incomplete file commit without consuming rollback copies',async()=>{
  const dir=path.join(root,'trips','restart');await fs.mkdir(dir,{recursive:true});
  const target=path.join(dir,'front'),rollback=target+'.rollback',staged=target+'.tmp';
  await fs.writeFile(target,'partial commit');await fs.writeFile(rollback,'previous version');
  const db=createDb(':memory:');
  db.prepare('INSERT INTO media_commits VALUES (?,?,?)').run('j','t',JSON.stringify([{target,staged,rollback}]));
  assert.equal(await recoverMediaCommits(db),1);
  assert.equal(await fs.readFile(target,'utf8'),'previous version');db.close();
});
test('repeated fractional trim keeps exact source position',()=>{
  const one=computeTrimPlan({start_epoch:1000,end_epoch:1060,duration_sec:60,orig_start_epoch:null},2.4,20);
  const two=computeTrimPlan({start_epoch:one.newStart,end_epoch:one.newEnd,duration_sec:one.newDur,orig_start_epoch:1000},0.2,3);
  assert.ok(Math.abs(two.srcStart-2.6)<1e-9);
});
test('camera gaps retain recording time and cannot become a continuous export',()=>{
  const spans=[{start:0,duration:60,epoch:1000},{start:60,duration:60,epoch:1300}];
  assert.equal(timeAt(spans,70),1310);
  assert.equal(continuous(spans,50,70),false);
  assert.deepEqual(sliceTimeline({front:spans,rear:[]},70,80).front,[{start:0,duration:10,epoch:1310}]);
});
