/** 对所有环节都成立的规则：由程序给，不写在角色文件里。只做计算，不读写文件。 */
import { isReportEnum, type ReportFieldType } from "../contracts/workflow.js";
import type { WorkflowDefinition, WorkflowStage } from "./workflow.js";

const SCALAR_WORDING = {
  string: "字符串",
  "string[]": "字符串数组",
  paths: "路径数组",
  bool: "true 或 false",
} as const;

/** 接在系统提示末尾的一段；同样的输入得到逐字相同的输出。 */
export function stageRules(workflow: WorkflowDefinition, stage: WorkflowStage): string {
  // 和结束一次执行时核对的受保护文件是同一批。
  const guarded = [
    ".knit/standards/ 下的文件",
    ".knit/workflow.yaml",
    ".knit/config.json",
    ...new Set(workflow.stages.flatMap((item) => item.prompt ?? [])),
  ];
  const fields = Object.entries(stage.report);
  return [
    "<rules>",
    "- 不要提交，也不要切换或新建分支。结束时 HEAD 变了，这次执行记为失败。",
    `- 不要修改这些文件，改了这次执行记为失败：${guarded.join("、")}。`,
    "- 你的最后一条消息就是这个环节的报告，会原样交给下一个环节和用户。",
    ...(fields.length === 0
      ? []
      : [
          "- 报告的结尾放一个 json 代码块，给出这些字段：",
          ...fields.map(([name, type]) => `  - ${name}：${wordingOf(type)}`),
        ]),
    "</rules>",
  ].join("\n");
}

function wordingOf(type: ReportFieldType): string {
  return isReportEnum(type) ? `${type.join("、")} 之一` : SCALAR_WORDING[type];
}
