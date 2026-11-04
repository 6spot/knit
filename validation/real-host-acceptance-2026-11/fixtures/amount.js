#!/usr/bin/env node
'use strict';

/**
 * 把命令行参数解析为有限数字；无法解析时返回 null。
 *
 * @param {string} input
 * @returns {number | null}
 */
function parseAmount(input) {
  if (typeof input !== 'string') {
    return null;
  }
  const text = input.trim();
  if (text === '') {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * 把数字格式化为带千分位、两位小数的金额字符串。
 *
 * @param {number} value
 * @returns {string}
 */
function formatAmount(value) {
  if (!Number.isFinite(value)) {
    throw new TypeError('金额必须是有限数字。');
  }
  const [integer, fraction] = Math.abs(value).toFixed(2).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}${grouped}.${fraction}`;
}

if (require.main === module) {
  const input = process.argv[2];

  if (input === undefined) {
    console.error('错误：缺少金额参数。用法：amount <金额数字>');
    process.exit(1);
  }

  const value = parseAmount(input);
  if (value === null) {
    console.error(`错误：金额必须是数字，收到 "${input}"。用法：amount <金额数字>`);
    process.exit(1);
  }

  console.log(formatAmount(value));
}

module.exports = { formatAmount, parseAmount };
