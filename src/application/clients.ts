/**
 * 客户端注册表（DESIGN.md 第14节）：CLI 按注册项生成布尔开关，不做客户端 ID 字符串校验。
 * 当前只有 Pi；新增客户端须同时接入桥接模板与启动入口，未注册的开关交给 commander 报未知选项。
 */
export interface ClientSpec {
  /** 清单与适配使用的稳定 ID。 */
  id: string;
  /** CLI 布尔开关名（`--<flag>`）。 */
  flag: string;
  /** 选项说明。 */
  description: string;
  /** 未带任何客户端开关时启用。 */
  default?: boolean;
}

export const CLIENT_SPECS: readonly ClientSpec[] = [
  {
    id: "pi",
    flag: "pi",
    description: "启用 Pi 客户端（默认）",
    default: true,
  },
];

/** 按注册表解析客户端 ID；无选择时回退默认项，保持零参数体验。 */
export function resolveClientIds(selected: readonly string[]): string[] {
  const unique = [...new Set(selected)];
  if (unique.length > 0) return unique;
  const fallback = CLIENT_SPECS.find((spec) => spec.default) ?? CLIENT_SPECS[0];
  return fallback === undefined ? [] : [fallback.id];
}

/** 未带任何客户端开关时的默认客户端。 */
export function defaultClientIds(): string[] {
  return resolveClientIds([]);
}
