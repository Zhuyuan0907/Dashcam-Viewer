import fs from 'node:fs/promises';
import { DATA_DIR, MIN_FREE_DISK_BYTES } from '../config.js';
let reserved=0;
export async function reserveSpace(bytes:number):Promise<()=>void>{
  const disk=await fs.statfs(DATA_DIR);
  if(disk.bavail*disk.bsize-reserved<bytes+MIN_FREE_DISK_BYTES)throw Error('磁碟空間不足，請清理容量後重試');
  reserved+=bytes;let released=false;
  return ()=>{if(!released){released=true;reserved-=bytes;}};
}
export async function reserveForMedia(paths:string[],factor=3):Promise<()=>void>{
  const sizes=await Promise.all(paths.map(p=>fs.stat(p).then(s=>s.size)));
  return reserveSpace(sizes.reduce((a,b)=>a+b,0)*factor);
}
