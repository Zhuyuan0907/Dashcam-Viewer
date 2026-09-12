import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDb} from '../src/db.js';
import {BackgroundTasks} from '../src/background.js';
import {SSERegistry} from '../src/uploads/sse.js';
const until=async(fn:()=>boolean)=>{for(let i=0;i<200&&!fn();i++)await new Promise(r=>setTimeout(r,5));assert.ok(fn());};
test('queue limits per-user execution and records result only after finalization',async()=>{
  const db=createDb(':memory:'),tasks=new BackgroundTasks(db,2,1),sse=new SSERegistry();let release!:()=>void;
  const gate=new Promise<void>(r=>release=r),first=sse.create('a');let secondStarted=false;
  const a=tasks.enqueue({type:'clip',owner:1,target:'a',payload:{},key:'a'},first,async()=>{first.push({stage:'done',clip:{id:4}});await gate;first.close();});
  const second=sse.create('b');const b=tasks.enqueue({type:'clip',owner:1,target:'b',payload:{},key:'b'},second,async()=>{secondStarted=true;second.push({stage:'done'});second.close();});
  await until(()=>tasks.get(a)?.status==='running');assert.equal(secondStarted,false);assert.equal(tasks.get(b)?.status,'queued');
  release();await until(()=>tasks.get(b)?.status==='succeeded');assert.equal(JSON.parse(tasks.get(a)!.result!).clip.id,4);db.close();
});
test('restart marks persistent nonterminal work interrupted and keeps owner history isolated',()=>{
  const db=createDb(':memory:');new BackgroundTasks(db);
  db.prepare("INSERT INTO background_jobs VALUES ('a','trim',1,'t','{}','trim:t','running','encode',20,'',NULL,1,1)").run();
  const tasks=new BackgroundTasks(db);assert.equal(tasks.get('a')?.status,'interrupted');assert.equal(tasks.list(2).length,0);assert.equal(tasks.list(1).length,1);db.close();
});
