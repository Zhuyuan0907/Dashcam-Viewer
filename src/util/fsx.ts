/**
 * 檔案系統小工具 —— 集中重複的存在性檢查(原本散落在 process/edit/ops 各一份)。
 */
import fs from "node:fs/promises";

/** 路徑是否存在(檔案或目錄皆可);任何錯誤視為不存在。 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 路徑是否為「檔案」;不存在或非檔案回 false。 */
export async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}
