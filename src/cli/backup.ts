import {DATA_DIR, SHARE_TOKEN_KEY_PATH} from '../config.js';
import path from 'node:path';
import {createBundle,verifyBundle,restoreBundle} from '../storage/bundle.js';

const [action,directory,...flags]=process.argv.slice(2);
try {
  if(!directory || !['create','verify','restore'].includes(action??''))throw Error('用法：npm run backup -- create|verify|restore <備份目錄> [--server-stopped]');
  if(action!=='verify' && !flags.includes('--server-stopped'))throw Error('請先停止服務及所有匯入工具，再加 --server-stopped 確認');
  if(!SHARE_TOKEN_KEY_PATH.startsWith(DATA_DIR+path.sep))throw Error('分享金鑰位於資料目錄外；請先依維運文件另行備份並調整金鑰路徑');
  if(action==='create') {
    const result=await createBundle(DATA_DIR,directory);console.log(`完整備份及校驗完成：${result.files.length} 個檔案`);
  } else if(action==='verify') {
    const result=await verifyBundle(directory);console.log(`校驗通過：${result.files.length} 個檔案，原始路徑 ${result.source}`);
  } else {
    await restoreBundle(directory,DATA_DIR);console.log('已還原至原始資料路徑；啟動前請確認檔案擁有者與存取權限。');
  }
} catch(error) {console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
