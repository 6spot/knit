'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { formatAmount } = require('../bin/amount.js');

const cliPath = path.join(__dirname, '..', 'bin', 'amount.js');

function runCli(...args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

test('正常金额格式化为千分位和两位小数', () => {
  assert.equal(formatAmount(1234.5), '1,234.50');
  assert.equal(formatAmount(0), '0.00');
  assert.equal(formatAmount(1234567.891), '1,234,567.89');
  assert.equal(formatAmount(-1234.5), '-1,234.50');
});

test('命令行正常参数输出格式化结果并成功退出', () => {
  const result = runCli('1234.5');

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '1,234.50\n');
  assert.equal(result.stderr, '');
});

test('缺少参数时输出中文错误并以非零退出码结束', () => {
  const result = runCli();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /错误：缺少金额参数/);
  assert.equal(result.stdout, '');
});

test('参数非数字时输出中文错误并以非零退出码结束', () => {
  for (const input of ['abc', '12abc', '']) {
    const result = runCli(input);

    assert.notEqual(result.status, 0, `输入 ${JSON.stringify(input)} 应失败`);
    assert.match(result.stderr, /错误：金额必须是数字/, `输入 ${JSON.stringify(input)} 应输出中文错误`);
    assert.equal(result.stdout, '');
  }
});
