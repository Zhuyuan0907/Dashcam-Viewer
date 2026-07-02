import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { hashPassword, verifyPassword } from "../src/auth.js";

test("與 Python pbkdf2 相容性向量(現有帳號可登入的保證)", () => {
  // 由 Python `hashlib.pbkdf2_hmac("sha256", b"secret123", salt, 310000)` 產生
  const saltHex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const expected = "662cf26bba296983ca0e6a3bfb90b93446265136f4d0a26205f25e06d2692949";
  const salt = Buffer.from(saltHex, "hex");
  const key = crypto.pbkdf2Sync("secret123", salt, 310_000, 32, "sha256");
  assert.equal(key.toString("hex"), expected, "Node pbkdf2 必須與 Python 位元相同");

  // 並確認 verifyPassword 能驗證這種 Python 格式的儲存值
  const stored = `${saltHex}:${expected}`;
  assert.equal(verifyPassword("secret123", stored), true);
  assert.equal(verifyPassword("wrong", stored), false);
});

test("hashPassword / verifyPassword roundtrip", () => {
  const stored = hashPassword("hunter2!");
  assert.match(stored, /^[0-9a-f]{64}:[0-9a-f]{64}$/);
  assert.equal(verifyPassword("hunter2!", stored), true);
  assert.equal(verifyPassword("hunter2", stored), false);
});

test("verifyPassword: 損壞輸入不丟例外", () => {
  assert.equal(verifyPassword("x", "garbage"), false);
  assert.equal(verifyPassword("x", ""), false);
  assert.equal(verifyPassword("x", "abc:"), false);
});
