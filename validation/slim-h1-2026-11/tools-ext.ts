// 只用来演练：加一个命令，把已经注册的工具写进 H1_OUT 指的文件。不调用模型。
import { writeFileSync } from "node:fs";

export default function (pi: any) {
  pi.registerCommand("h1-tools", {
    description: "H1：列出已注册的工具",
    handler: async () => {
      const all = pi.getAllTools().map((tool: any) => ({ name: tool.name, scope: tool.sourceInfo?.scope ?? null }));
      writeFileSync(process.env.H1_OUT!, JSON.stringify({ active: pi.getActiveTools(), all }));
    },
  });
}
