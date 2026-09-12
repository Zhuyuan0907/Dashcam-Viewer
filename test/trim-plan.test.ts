/**
 * computeTrimPlan 的座標換算單元測試(整趟裁剪最高風險的純邏輯)。
 *
 * 重點回歸:重複裁剪時,前端送的是「目前播放檔」秒數,後端必須換算成對 .orig 的秒數
 * 再裁切 —— 否則第二次裁剪會剪錯內容(舊缺陷)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTrimPlan } from "../src/routes/edit.js";

test("首次裁剪:srcStart=start、epoch 以目前 start_epoch 位移", () => {
  const row = {
    start_epoch: 1_000_000,
    end_epoch: 1_000_100, // 100 秒
    duration_sec: 100,
    orig_start_epoch: null, // 尚未裁剪
  };
  const plan = computeTrimPlan(row, 10, 40); // 取 [10,40] → 30 秒
  assert.equal(plan.srcStart, 10, "首次裁剪對 .orig 起點 = start");
  assert.equal(plan.dur, 30);
  assert.equal(plan.newDur, 30);
  assert.equal(plan.newStart, 1_000_010, "新起始 = 目前 start_epoch + start");
  assert.equal(plan.newEnd, 1_000_040);
  // COALESCE 保留的原始值 = 裁剪前的目前值
  assert.equal(plan.prevStart, 1_000_000);
  assert.equal(plan.prevEnd, 1_000_100);
  assert.equal(plan.prevDur, 100);
});

test("重複裁剪:srcStart 換算為對 .orig 的座標(加上先前已剪掉的秒數)", () => {
  // 原片 100 秒(orig_start_epoch=1_000_000)。首次裁剪取 [10,40] 後:
  //   目前 start_epoch = 1_000_010、duration_sec = 30。
  const row = {
    start_epoch: 1_000_010, // 已從 .orig 前面剪掉 10 秒
    end_epoch: 1_000_040,
    duration_sec: 30,
    orig_start_epoch: 1_000_000,
  };
  // 在「目前 30 秒的播放檔」上再取 [5,15] → 10 秒。
  const plan = computeTrimPlan(row, 5, 15);
  // 對 .orig 而言,起點是「先前剪掉的 10 秒 + 本次 5 秒」= 15 秒(不是 5 秒!)。
  assert.equal(plan.srcStart, 15, "重複裁剪必須換算到 .orig 座標");
  assert.equal(plan.dur, 10);
  assert.equal(plan.newDur, 10);
  assert.equal(plan.newStart, 1_000_015, "新起始 = 目前 start_epoch + 本次 start");
  assert.equal(plan.newEnd, 1_000_025);
});

test("小數秒:srcStart/dur 保留小數,epoch/duration 取整", () => {
  const row = { start_epoch: 500, end_epoch: 560, duration_sec: 60, orig_start_epoch: null };
  const plan = computeTrimPlan(row, 2.4, 5.9);
  assert.ok(Math.abs(plan.srcStart - 2.4) < 1e-9);
  assert.ok(Math.abs(plan.dur - 3.5) < 1e-9);
  assert.ok(Math.abs(plan.newDur - 3.5) < 1e-9);
  assert.equal(plan.newStart, 502.4, "保留小數避免重複裁剪偏移");
});
