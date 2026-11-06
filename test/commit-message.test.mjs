/** 交付提交文案：格式校验、trailer 解析与新格式／旧格式识别（任务 k-1d796caf7d12）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_MESSAGE_BYTES,
  composeCommitMessage,
  isStageCommit,
  parseMessageDraft,
  readKnitTrailers,
  readMessageFile,
  truncateMessageSubject,
} from "../dist/application/delivery.js";

function guardReason(fn) {
  try {
    fn();
  } catch (error) {
    return error.guardReason;
  }
  return null;
}

test("文案校验：空、超长首行、缺空行、Knit- 冲突与纯 ID 标题", () => {
  assert.equal(guardReason(() => parseMessageDraft("  \n\n")), "message_empty");
  assert.equal(guardReason(() => parseMessageDraft(`${"标".repeat(73)}\n\n正文`)), "message_subject_invalid");
  assert.equal(guardReason(() => parseMessageDraft("标题\n正文")), "message_body_missing");
  assert.equal(guardReason(() => parseMessageDraft("标题\n\nKnit-Task: k-000000000000")), "message_trailer_conflict");
  assert.equal(guardReason(() => parseMessageDraft("knit: artifact k-000000000000 (op-abc)\n\n正文")), "message_subject_invalid");
  assert.equal(guardReason(() => parseMessageDraft("k-000000000000 (op-abcdef)\n\n正文")), "message_subject_invalid");
  assert.equal(guardReason(() => parseMessageDraft("标题\n\n")), "message_body_missing");
});

test("文案规范化：CRLF 转 LF、去行尾空白、补单个结尾换行", () => {
  const draft = parseMessageDraft("可读标题  \r\n\r\n第一行\t\r\n第二行\r\n\r\n\r\n");
  assert.equal(draft.subject, "可读标题");
  assert.equal(draft.body, "第一行\n第二行");
});

test("文案大小限制：正文超 4000 字符与文件超 8 KB", () => {
  assert.equal(guardReason(() => parseMessageDraft(`标题\n\n${"字".repeat(4001)}`)), "message_too_long");
  const huge = `标题\n\n${"a".repeat(MAX_MESSAGE_BYTES)}`;
  assert.equal(guardReason(() => parseMessageDraft(huge)), "message_too_long");
});

test("文案文件：UTF-8 校验与缺失文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "knit-message-"));
  try {
    const good = join(dir, "good.txt");
    writeFileSync(good, "标题\n\n正文\n");
    assert.deepEqual(readMessageFile(good), { subject: "标题", body: "正文" });
    const bad = join(dir, "bad.txt");
    writeFileSync(bad, Buffer.from([0xff, 0xfe, 0xfd]));
    assert.equal(guardReason(() => readMessageFile(bad)), "message_encoding_invalid");
    assert.equal(guardReason(() => readMessageFile(join(dir, "missing.txt"))), "message_file_missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("首行截断按码点保持在 72 字符内", () => {
  const text = "😀".repeat(80);
  const truncated = truncateMessageSubject(text);
  assert.equal([...truncated].length, 72);
  assert.equal(truncated.endsWith("…"), true);
  assert.equal(truncateMessageSubject("短标题"), "短标题");
});

test("最终结构：人读首行／正文在前，四个 trailer 在末尾", () => {
  const message = composeCommitMessage(
    { subject: "交付文案", body: "为什么改。\n改了什么。" },
    { taskId: "k-000000000000", operationId: "op-abcdef", stage: "artifact", verification: "self" },
  );
  assert.equal(message, [
    "交付文案",
    "",
    "为什么改。",
    "改了什么。",
    "",
    "Knit-Task: k-000000000000",
    "Knit-Operation: op-abcdef",
    "Knit-Stage: artifact",
    "Knit-Verification: self",
    "",
  ].join("\n"));
});

test("trailer 解析与阶段判定：新格式、旧格式与缺失", () => {
  const message = composeCommitMessage(
    { subject: "标题", body: "正文" },
    { taskId: "k-000000000000", operationId: "op-abcdef", stage: "metadata", verification: "none" },
  );
  assert.deepEqual(readKnitTrailers(message), {
    task: "k-000000000000",
    operation: "op-abcdef",
    stage: "metadata",
    verification: "none",
  });
  assert.equal(isStageCommit(message, "metadata", "op-abcdef"), true);
  assert.equal(isStageCommit(message, "artifact", "op-abcdef"), false);
  assert.equal(isStageCommit(message, "metadata", "op-000000"), false);

  assert.equal(readKnitTrailers("Knit-Task: k-000000000000\nKnit-Operation: op-abcdef"), null);

  const legacy = `knit: archive k-000000000000 (op-abcdef)\n`;
  assert.equal(readKnitTrailers(legacy), null);
  assert.equal(isStageCommit(legacy, "archive", "op-abcdef"), true);
  assert.equal(isStageCommit(legacy, "metadata", "op-abcdef"), false);

  const legacyDeliver = `knit: deliver k-000000000000 (op-abcdef)\n`;
  assert.equal(isStageCommit(legacyDeliver, "deliver", "op-abcdef"), true);
  assert.equal(isStageCommit("随手写的提交说明", "archive", "op-abcdef"), false);
});
