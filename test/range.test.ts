/**
 * resolveRange 的 HTTP Range byte 數學單元測試(影片串流核心,原本零覆蓋)。
 * 這些 off-by-one / 邊界最容易在重構時靜默寫錯,錯誤只表現為「拖曳到某處卡住/讀不到尾段」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRange } from "../src/routes/video.js";

const SIZE = 1000;

test("無 Range → 全檔", () => {
  assert.deepEqual(resolveRange(undefined, SIZE), { type: "full" });
  assert.deepEqual(resolveRange("", SIZE), { type: "full" });
});

test("格式不符 → 全檔(降級,不 416)", () => {
  assert.deepEqual(resolveRange("bytes=abc", SIZE), { type: "full" });
  assert.deepEqual(resolveRange("items=0-10", SIZE), { type: "full" });
});

test("bytes=0-99 → [0,99]", () => {
  assert.deepEqual(resolveRange("bytes=0-99", SIZE), { type: "partial", start: 0, end: 99 });
});

test("開放式 end(bytes=100-)→ 到檔尾 size-1", () => {
  assert.deepEqual(resolveRange("bytes=100-", SIZE), { type: "partial", start: 100, end: 999 });
});

test("end 超出檔尾 → 夾到 size-1", () => {
  assert.deepEqual(resolveRange("bytes=0-99999", SIZE), { type: "partial", start: 0, end: 999 });
});

test("start 超界(≥size)→ 不可滿足(416)", () => {
  assert.deepEqual(resolveRange("bytes=1000-1100", SIZE), { type: "unsatisfiable" });
  assert.deepEqual(resolveRange("bytes=5000-", SIZE), { type: "unsatisfiable" });
});

test("最後一個位元組 bytes=999-999 → [999,999](長度 1)", () => {
  const r = resolveRange("bytes=999-999", SIZE);
  assert.deepEqual(r, { type: "partial", start: 999, end: 999 });
  assert.equal((r as { end: number; start: number }).end - (r as { start: number }).start + 1, 1);
});
