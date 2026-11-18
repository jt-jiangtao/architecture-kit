import {
  createOverlayEnvironment,
  OverlayEnvironmentProvider,
} from "@action-driver/ui-components/codex/overlay-environment";
import { createRoot } from "react-dom/client";
import { Panel, type ProjectSource } from "./Panel";
import "@action-driver/ui-components/codex/theme.css";
import "@action-driver/codex-tokens/colors.css";
import "./panel.css";

const live: ProjectSource = async (signal) => {
  const response = await fetch("/api/project", { signal });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
};
const preview: ProjectSource = async () => ({
  project: "组件预览",
  changes: [
    {
      id: "示例变更",
      error: "",
      tasks: [
        {
          key: "1",
          group: "接入项目",
          title: "1.1 读取项目清单",
          body: "读取所选工作区。",
          done: true,
          activity: null,
        },
        {
          key: "2",
          group: "接入项目",
          title: "1.2 核对执行记录",
          body: "比对任务编号并核对状态来源。",
          done: false,
          activity: {
            state: "等待输入",
            time: "示例时间",
            detail: "需要指定项目目录",
            resume: "选择目标目录",
          },
        },
      ],
    },
  ],
});
createRoot(document.getElementById("root")!).render(
  <OverlayEnvironmentProvider value={createOverlayEnvironment(document)}>
    <Panel source={location.pathname === "/playground" ? preview : live} />
  </OverlayEnvironmentProvider>,
);
