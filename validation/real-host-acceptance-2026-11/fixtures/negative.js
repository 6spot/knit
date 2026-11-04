#!/usr/bin/env node
'use strict';

const { formatAmount, parseAmount } = require('./amount.js');

/**
 * 把金额格式化为带千分位、两位小数的字符串，并按负数展示约定输出。
 *
 * 负数展示约定（业务方尚未确认，属实现时的合理假设）：
 * - 负数使用会计括号形式，例如 (1,234.50)，而不是负号；
 * - 括号外不添加货币符号，避免在币种与符号位置未定时引入额外假设；
 * - 零与正数按普通金额展示，例如 0.00、1,234.50。
 *
 * 若业务后续确认采用负号或其他形式，只需调整本函数的返回值拼接。
 *
 * @param {number} value
 * @returns {string}
 */
function formatNegative(value) {
  if (!Number.isFinite(value)) {
    throw new TypeError('金额必须是有限数字。');
  }
  const text = formatAmount(Math.abs(value));
  return value < 0 ? `(${text})` : text;
}

if (require.main === module) {
  const input = process.argv[2];

  if (input === undefined) {
    console.error('错误：缺少金额参数。用法：negative <金额数字>');
    process.exit(1);
  }

  const value = parseAmount(input);
  if (value === null) {
    console.error(`错误：金额必须是数字，收到 "${input}"。用法：negative <金额数字>`);
    process.exit(1);
  }

  console.log(formatNegative(value));
}

module.exports = { formatNegative };
