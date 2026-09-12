import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "share-token-vault-"));
process.env.DASHCAM_DATA_DIR = DATA;

const { hashShareToken } = await import("../src/shares/repo.js");
const { initializeShareTokenVault, openShareToken, sealShareToken } = await import(
  "../src/shares/token-vault.js"
);

const KEY_PATH = path.join(DATA, "share_token.key");
const TOKEN = crypto.randomBytes(32).toString("base64url");
const HASH = hashShareToken(TOKEN);

test("AES-GCM 保管可還原 token，且金鑰獨立、權限為 0600", () => {
  initializeShareTokenVault(false);
  const key = fs.readFileSync(KEY_PATH);
  assert.equal(key.length, 32);
  assert.equal(fs.statSync(KEY_PATH).mode & 0o777, 0o600);
  assert.equal(key.includes(Buffer.from(TOKEN)), false);

  const ciphertext = sealShareToken(TOKEN, 7, HASH);
  assert.equal(ciphertext.includes(TOKEN), false);
  assert.equal(openShareToken(ciphertext, 7, HASH), TOKEN);
});

test("密文、share id、token hash 任一遭竄改都無法解密", () => {
  initializeShareTokenVault(false);
  const ciphertext = sealShareToken(TOKEN, 7, HASH);
  const packed = Buffer.from(ciphertext, "base64url");
  packed[packed.length - 1] ^= 1;
  assert.equal(openShareToken(packed.toString("base64url"), 7, HASH), null);
  assert.equal(openShareToken(ciphertext, 8, HASH), null);
  assert.equal(openShareToken(ciphertext, 7, hashShareToken("different")), null);
});

test("已有密文卻遺失金鑰時啟動失敗；錯誤金鑰不能解開舊密文", () => {
  initializeShareTokenVault(false);
  const ciphertext = sealShareToken(TOKEN, 11, HASH);
  const originalKey = fs.readFileSync(KEY_PATH);

  fs.unlinkSync(KEY_PATH);
  assert.throws(() => initializeShareTokenVault(true), /找不到分享連結金鑰/);

  fs.writeFileSync(KEY_PATH, crypto.randomBytes(32), { mode: 0o600 });
  initializeShareTokenVault(true);
  assert.equal(openShareToken(ciphertext, 11, HASH), null);

  fs.writeFileSync(KEY_PATH, originalKey, { mode: 0o600 });
});
