import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseGenericFilename} from '../src/dashcams/generic.js';
import {classifyUpload, describeUpload} from '../src/uploads/routing.js';
import {scanSegments} from '../src/trips/organizer.js';
import {fileHash} from '../src/util/file-hash.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {processBatch} from '../src/trips/organizer.js';

test('generic names require real dates and explicit cameras',()=>{
  assert.equal(parseGenericFilename('20260230_120000_F.mp4'),null);
  assert.equal(parseGenericFilename('20260101_250000_R.mov'),null);
  assert.equal(parseGenericFilename('holiday.mp4'),null);
  assert.equal(describeUpload('20260912_103045_R_02.mov').profile,'generic');
  assert.deepEqual(classifyUpload('folder/20260912_103045_R_02.mov'),{action:'raw',subdir:'R',basename:'20260912_103045_R_02.mov'});
});

test('rear-only generic, MiVue and Polaroid survive without a front directory',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rear-scan-'));
  try {
    const rear=path.join(root,'R');await fs.mkdir(rear);
    for(const name of ['20260912_103045_R.mp4','FILE260912-110000-001R.mp4','2026_0912_120000_001B.TS']) await fs.writeFile(path.join(rear,name),'fixture');
    const segments=await scanSegments(path.join(root,'F'),rear);
    assert.equal(segments.length,3);assert.ok(segments.every(s=>s.rearFilename));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('generic pairs are not double-counted; equal size does not imply equal content',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'generic-pair-'));
  try {
    await fs.mkdir(path.join(root,'F'));await fs.mkdir(path.join(root,'R'));
    const front=path.join(root,'F','20260912_103045_F.mp4'),rear=path.join(root,'R','20260912_103045_R.mp4');
    await fs.writeFile(front,'abc');await fs.writeFile(rear,'def');
    const segments=await scanSegments(path.join(root,'F'),path.join(root,'R'));
    assert.equal(segments.length,1);assert.equal(segments[0]?.rearFilename,path.basename(rear));
    assert.notEqual(await fileHash(front),await fileHash(rear));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('a rear-only generic video completes the real merge pipeline',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'generic-merge-'));
  try {
    await fs.mkdir(path.join(root,'uploads','R'),{recursive:true});
    await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=size=160x90:rate=25','-t','1.2','-c:v','libx264','-threads','1',path.join(root,'uploads','R','20260912_103045_R.mp4')]);
    let info;
    for await(const event of processBatch({uploadDir:path.join(root,'uploads'),tripsDir:path.join(root,'trips')})) if(event.tripInfo)info=event.tripInfo;
    assert.ok(info);assert.equal(info.has_front,false);assert.equal(info.has_rear,true);
    assert.ok(Math.abs(info.duration_sec-1.2)<0.1);assert.equal(info.timeline?.rear.length,1);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
