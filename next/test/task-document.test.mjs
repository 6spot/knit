import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Text } from "../dist/contracts/digest.js";
import {
  currentStatus,
  parseTaskDocument,
  renderTaskDocument,
  requirementDigest,
} from "../dist/domain/task-document.js";
import { parseTaskRecord, renderTaskRecord } from "../dist/domain/task-record.js";

const FRONTMATTER = `id: k-19c962be9fb8
title: 交接只传需求部分
status: draft
stage: null
verification: self
parent: null
dependsOn: []
priority: P2
createdAt: 2026-11-14T13:36:56.000Z`;

const REQUIREMENT = `## 目标与范围

## 完成条件

## 待澄清

## 相关资料`;

const EXAMPLE = `---
${FRONTMATTER}
---

${REQUIREMENT}

## 结果

交接改为只传需求部分。
`;

const EMPTY_RECORD = { confirmedDigest: null, changedPaths: [], runs: [], authorization: null };

function documentOf(markdown) {
  const parsed = parseTaskDocument(markdown);
  assert.deepEqual(parsed.problems, []);
  return parsed.document;
}

test("解析出九个字段、需求部分和结果", () => {
  assert.deepEqual(documentOf(EXAMPLE), {
    frontmatter: {
      id: "k-19c962be9fb8",
      title: "交接只传需求部分",
      status: "draft",
      stage: null,
      verification: "self",
      parent: null,
      dependsOn: [],
      priority: "P2",
      createdAt: "2026-11-14T13:36:56.000Z",
    },
    requirement: REQUIREMENT,
    result: "交接改为只传需求部分。",
  });
});

test("解析后再渲染与原文逐字相同", () => {
  assert.equal(renderTaskDocument(documentOf(EXAMPLE)), EXAMPLE);
  const full = EXAMPLE.replace("status: draft\nstage: null", "status: active\nstage: implement")
    .replace("title: 交接只传需求部分", 'title: "C1 任务文档：解析 a: b # c"')
    .replace("parent: null", "parent: k-aaaaaaaaaaaa")
    .replace("dependsOn: []", "dependsOn:\n  - k-bbbbbbbbbbbb\n  - k-cccccccccccc");
  assert.equal(renderTaskDocument(documentOf(full)), full);
});

test("改状态、写结果后需求部分和需求摘要不变", () => {
  const before = documentOf(EXAMPLE.replace("## 目标与范围\n", "## 目标与范围\n\n  缩进的一行  \n\n\n- 列表\n"));
  const rendered = renderTaskDocument({
    ...before,
    frontmatter: { ...before.frontmatter, status: "done" },
    result: "做完了。\n\n未验证：无。",
  });
  const after = documentOf(rendered);
  assert.equal(after.frontmatter.status, "done");
  assert.equal(after.result, "做完了。\n\n未验证：无。");
  assert.equal(after.requirement, before.requirement);
  assert.equal(requirementDigest(after), requirementDigest(before));
  assert.equal(requirementDigest(before), sha256Text(before.requirement));
});

test("代码围栏里的 ## 结果 留在需求部分", () => {
  const fenced = "## 目标与范围\n\n````markdown\n```\n## 结果\n```\n\n## 结果\n````\n\n~~~\n## 结果\n~~~";
  const document = documentOf(`---\n${FRONTMATTER}\n---\n\n${fenced}\n\n## 结果\n\n真正的结果\n`);
  assert.equal(document.requirement, fenced);
  assert.equal(document.result, "真正的结果");
});

test("没有 ## 结果 时结果是 null，渲染出的文本里没有这一节", () => {
  const markdown = `---\n${FRONTMATTER}\n---\n\n${REQUIREMENT}\n`;
  const document = documentOf(markdown);
  assert.equal(document.result, null);
  assert.equal(renderTaskDocument(document), markdown);
  assert.equal(renderTaskDocument(document).includes("## 结果"), false);
});

test("格式问题：得不到数据，问题里点到对应的字段", () => {
  const cases = [
    [EXAMPLE.replace("---\n", ""), /没有开头字段/],
    [EXAMPLE.replace("title: 交接只传需求部分", "title: a: b"), /不是合法的 YAML/],
    [EXAMPLE.replace("title: 交接只传需求部分\n", ""), /缺少字段 title/],
    [EXAMPLE.replace("priority: P2", "priority: P2\nowner: me"), /多了字段 owner/],
    [EXAMPLE.replace("status: draft", "status: open"), /字段 status 的值不对/],
    [EXAMPLE.replace("status: draft", "status: active"), /字段 stage 的值不对/],
    [EXAMPLE.replace("stage: null", "stage: implement"), /字段 stage 的值不对/],
  ];
  for (const [markdown, expected] of cases) {
    const parsed = parseTaskDocument(markdown);
    assert.equal(parsed.document, null);
    assert.match(parsed.problems.join("\n"), expected);
  }
});

test("currentStatus：确认之后改过需求的 ready／active 按 draft 算", () => {
  const withStatus = (status, stage = null) => {
    const document = documentOf(EXAMPLE);
    return { ...document, frontmatter: { ...document.frontmatter, status, stage } };
  };
  const confirmed = { ...EMPTY_RECORD, confirmedDigest: requirementDigest(documentOf(EXAMPLE)) };
  const stale = { ...EMPTY_RECORD, confirmedDigest: sha256Text("改动之前的需求") };

  assert.equal(currentStatus(withStatus("ready"), confirmed), "ready");
  assert.equal(currentStatus(withStatus("active", "implement"), confirmed), "active");
  assert.equal(currentStatus(withStatus("ready"), stale), "draft");
  assert.equal(currentStatus(withStatus("active", "implement"), stale), "draft");
  assert.equal(currentStatus(withStatus("ready"), EMPTY_RECORD), "draft");
  assert.equal(currentStatus(withStatus("done"), stale), "done");
  assert.equal(currentStatus(withStatus("draft"), confirmed), "draft");
});

test("record.json：空记录、往返和格式问题", () => {
  assert.deepEqual(parseTaskRecord(null), { record: EMPTY_RECORD, problems: [] });
  assert.equal(
    renderTaskRecord(EMPTY_RECORD),
    '{\n  "confirmedDigest": null,\n  "changedPaths": [],\n  "runs": [],\n  "authorization": null\n}\n',
  );

  const record = {
    authorization: "user:1f7f9eea",
    runs: [
      {
        sessionFile: null,
        changedPaths: ["next/src/a.ts"],
        requirementDigest: sha256Text("需求"),
        verdict: "pass",
        failure: null,
        endedAt: null,
        startedAt: "2026-11-15T01:00:00.000Z",
        stage: "review",
        id: "r-1",
      },
    ],
    changedPaths: ["next/src/b.ts"],
    confirmedDigest: sha256Text("需求"),
  };
  const rendered = renderTaskRecord(record);
  assert.deepEqual(parseTaskRecord(rendered), { record, problems: [] });
  assert.deepEqual(Object.keys(JSON.parse(rendered)), ["confirmedDigest", "changedPaths", "runs", "authorization"]);
  assert.deepEqual(Object.keys(JSON.parse(rendered).runs[0]), [
    "id",
    "stage",
    "startedAt",
    "endedAt",
    "verdict",
    "failure",
    "requirementDigest",
    "changedPaths",
    "sessionFile",
  ]);

  const cases = [
    ["{", /不是合法的 JSON/],
    [JSON.stringify({ ...EMPTY_RECORD, owner: "me" }), /多了字段 owner/],
    [JSON.stringify({ ...EMPTY_RECORD, changedPaths: "next/src/a.ts" }), /字段 changedPaths 的值不对/],
  ];
  for (const [json, expected] of cases) {
    const parsed = parseTaskRecord(json);
    assert.equal(parsed.record, null);
    assert.match(parsed.problems.join("\n"), expected);
  }
});
