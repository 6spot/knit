export interface SharedSettings {
  target: string;
  launcher: string;
  events: readonly string[];
}

interface HostSpec {
  id: string;
  optionDescription: string;
  optionOrder: number;
  templates: readonly string[];
  controlDirs: readonly string[];
  sharedSettings?: SharedSettings;
  hook?: { module: string; exportName: string; hidden: boolean; omitNull: boolean };
}

const desktopEvents = ["SessionStart", "UserPromptSubmit", "PreToolUse"] as const;

// 列表按组合安装的生成顺序排列，optionOrder 保留 init 帮助中的选项顺序。
export const HOST_SPECS = [
  {
    id: "pi",
    optionDescription: "安装 Pi 项目桥接",
    optionOrder: 1,
    templates: ["pi/extensions/knit.ts"],
    controlDirs: [".pi"],
  },
  {
    id: "workbuddy",
    optionDescription: "安装 WorkBuddy 桌面端主会话钩子",
    optionOrder: 4,
    templates: ["workbuddy/knit-hook.sh", "workbuddy/settings.json"],
    controlDirs: [".workbuddy"],
    sharedSettings: { target: ".workbuddy/settings.json", launcher: ".workbuddy/knit-hook.sh", events: desktopEvents },
    hook: { module: "workbuddy/host-hook.js", exportName: "workbuddyHostHook", hidden: true, omitNull: true },
  },
  {
    id: "qoder",
    optionDescription: "安装 Qoder 桌面端主会话钩子",
    optionOrder: 3,
    templates: ["qoder/knit-hook.sh", "qoder/settings.json"],
    controlDirs: [".qoder"],
    sharedSettings: { target: ".qoder/settings.json", launcher: ".qoder/knit-hook.sh", events: desktopEvents },
    hook: { module: "qoder/host-hook.js", exportName: "qoderHostHook", hidden: true, omitNull: true },
  },
  {
    id: "agy",
    optionDescription: "安装 Antigravity 项目插件",
    optionOrder: 2,
    templates: ["agents/plugins/knit/plugin.json", "agents/plugins/knit/hooks.json", "agents/plugins/knit/rules/AGENTS.md"],
    controlDirs: [".agents"],
    hook: { module: "antigravity/host-hook.js", exportName: "agyHostHook", hidden: false, omitNull: false },
  },
] as const satisfies readonly HostSpec[];

export type HostId = (typeof HOST_SPECS)[number]["id"];
export type HostOptions = Partial<Record<HostId, boolean>>;
