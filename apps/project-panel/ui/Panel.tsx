import { Checkbox } from "@action-driver/ui-components/codex/checkbox";
import { ProgressRing } from "@action-driver/ui-components/codex/progress-ring";
import { DisclosureTrigger } from "@action-driver/ui-components/codex/disclosure-trigger";
import { ExpandableContent } from "@action-driver/ui-components/codex/expandable-content";
import {
  useCallback,
  useEffect,
  useId,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { Badge } from "@action-driver/ui-components/codex/badge";
import { Button } from "@action-driver/ui-components/codex/button";
import type {
  Change,
  RuntimeRun,
  RuntimeSnapshot,
  Snapshot,
  Task,
} from "../src/snapshot";

export type ProjectSource = (signal: AbortSignal) => Promise<Snapshot>;
const doneCount = (change: Change) =>
  change.tasks.filter((task) => task.done).length;

function displayName(id: string) {
  const name = id.replace(/^act-\d+-/, "").replaceAll("-", " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function OverviewName({
  change,
  currentTask,
}: {
  change: Change;
  currentTask: Task | undefined;
}) {
  const next = change.tasks.find(
    (task) => !task.done && /\p{Script=Han}/u.test(task.title),
  );
  const label =
    currentTask && /\p{Script=Han}/u.test(currentTask.title)
      ? currentTask.title
      : change.name ||
        (next ? "下一项 · " + next.title : displayName(change.id));
  const chars = Array.from(label);
  const visible =
    chars.length > 32 ? chars.slice(0, 32).join("").trimEnd() + "…" : label;
  const full = [
    ...new Set([label, change.name, change.id].filter(Boolean)),
  ].join("\n");
  return (
    <span className="overview-name" title={full}>
      {visible}
    </span>
  );
}

function isComplete(change: Change) {
  return change.tasks.length > 0 && change.tasks.every((task) => task.done);
}

function State({ state }: { state: string }) {
  return (
    <Badge
      color={
        state === "进行中" ? "info" : state === "已完成" ? "success" : "warning"
      }
    >
      {state}
    </Badge>
  );
}

function PanelDisclosure({
  className,
  label,
  children,
}: {
  className: string;
  label: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return (
    <div className={className}>
      <DisclosureTrigger
        expanded={expanded}
        onExpandedChange={setExpanded}
        aria-controls={contentId}
        label={<span className="fold-label">{label}</span>}
      />
      <div id={contentId}>
        <ExpandableContent expanded={expanded}>{children}</ExpandableContent>
      </div>
    </div>
  );
}

function TaskRow({ task, next = false }: { task: Task; next?: boolean }) {
  const [summary, ...rest] = task.title.split("。");
  const body = [rest.join("。").trim(), task.body.trim()]
    .filter(Boolean)
    .join("\n");
  const label = (
    <>
      <span className="task-marker" aria-hidden="true">
        {task.done ? "✓" : "○"}
      </span>
      <span className="task-title">{summary}</span>
      {next && <Badge color="info">下一项</Badge>}
      {task.activity && <State state={task.activity.state} />}
    </>
  );
  if (!body)
    return (
      <div className="task">
        <div className="task-static fold-label">{label}</div>
      </div>
    );
  return (
    <PanelDisclosure className="task" label={label}>
      <div className="body">{body}</div>
    </PanelDisclosure>
  );
}

function SessionProgress({ runs }: { runs: RuntimeRun[] }) {
  if (!runs.length) return null;
  return (
    <ul className="runtime-runs">
      {runs.map((run) => (
        <li className="overview-task" key={run.id}>
          <div className="run-status">
            <State state={run.state} />
            <time dateTime={run.time} title={run.time}>
              {new Date(run.time).toLocaleTimeString("zh-CN")}
            </time>
          </div>
          <PanelDisclosure
            className="run-feedback"
            label={
              <span
                className="feedback-summary"
                title={run.detail ? run.title + "\n" + run.detail : run.title}
              >
                {run.state === "进行中" ? run.detail || run.title : run.title}
              </span>
            }
          >
            <div className="feedback-detail">
              <strong>{run.title}</strong>
              <p>{run.detail || "等待会话报告进展"}</p>
            </div>
          </PanelDisclosure>
          {run.state !== "进行中" && run.detail && (
            <p className="block-reason">{run.detail}</p>
          )}
          {run.lastFailure && <Badge color="warning">{run.lastFailure}</Badge>}
          <small className="operation-count">
            本回合操作 {run.finished} / {run.operations}
          </small>
        </li>
      ))}
    </ul>
  );
}

function ExecutionOverview({
  changes,
  runtime,
  openChange,
}: {
  changes: Change[];
  runtime: RuntimeSnapshot | undefined;
  openChange: (id: string) => void;
}) {
  const unlinked = runtime?.runs.filter((run) => !run.changeId) ?? [];
  const active = changes.flatMap((change) => {
    const tasks = change.tasks.filter((task) => !task.done && task.activity);
    const runs =
      runtime?.runs.filter((run) => run.changeId === change.id) ?? [];
    return tasks.length || runs.length ? [{ change, tasks, runs }] : [];
  });
  const attention = [
    ...active.flatMap(({ change, tasks }) =>
      tasks
        .filter((task) => task.activity!.state !== "进行中")
        .map((task) => ({
          key: change.id + ":" + task.key,
          changeId: change.id,
          title: task.title,
          state: task.activity!.state,
          reason: task.activity!.detail,
          action: task.activity!.resume,
        })),
    ),
    ...(runtime?.runs ?? [])
      .filter((run) => run.state !== "进行中")
      .map((run) => ({
        key: run.id,
        changeId: run.changeId,
        title:
          changes.find((change) => change.id === run.changeId)?.name ||
          run.title,
        state: run.state,
        reason: run.detail || run.lastFailure,
        action: run.requestedAction,
      })),
  ];
  const ongoing = active
    .map(({ change, tasks, runs }) => ({
      change,
      tasks: tasks.filter((task) => task.activity!.state === "进行中"),
      runs: runs.filter((run) => run.state === "进行中"),
    }))
    .filter((entry) => entry.tasks.length || entry.runs.length);
  const otherRunning = unlinked.filter((run) => run.state === "进行中");
  const total = active.reduce(
    (sum, { change }) => sum + change.tasks.length,
    0,
  );
  const completed = active.reduce(
    (sum, { change }) => sum + doneCount(change),
    0,
  );
  const percent = total ? (100 * completed) / total : 0;
  return (
    <section className="overview" aria-label="当前执行总览">
      <h2>当前执行总览</h2>
      <div className="metrics">
        <div>
          <small>活跃变更</small>
          <strong>{active.length}</strong>
        </div>
        <div>
          <small>运行会话</small>
          <strong>
            {runtime?.error && !runtime.runs.length
              ? "—"
              : (runtime?.runs.length ?? 0)}
          </strong>
        </div>
        <div>
          <small>清单总进度</small>
          <strong>
            {total ? (
              <>
                <ProgressRing percent={percent} size={24} />
                {Math.round(percent)}%
              </>
            ) : (
              "—"
            )}
          </strong>
          <small>
            {completed} / {total} 项
          </small>
        </div>
      </div>
      {runtime?.error && <p role="alert">{runtime.error}</p>}
      {attention.length > 0 && (
        <section className="attention" aria-label="阻塞与待确认">
          <h3>
            阻塞与待确认 <small>{attention.length}</small>
          </h3>
          <ul>
            {attention.map((item) => (
              <li key={item.key}>
                <State state={item.state} />
                <div>
                  {item.changeId ? (
                    <button
                      className="attention-title"
                      title={item.title}
                      onClick={() => openChange(item.changeId!)}
                    >
                      {item.title}
                    </button>
                  ) : (
                    <strong>{item.title}</strong>
                  )}
                  <dl>
                    <dt>卡点</dt>
                    <dd>{item.reason || "执行记录尚未说明原因"}</dd>
                    <dt>
                      {item.state === "阻塞" && item.action
                        ? "解除条件"
                        : "需要你做"}
                    </dt>
                    <dd>
                      {item.action ||
                        (["等待输入", "等待确认", "待确认"].includes(item.state)
                          ? "在执行会话中查看并回复待确认的问题。"
                          : "尚未记录需要你处理的操作。")}
                    </dd>
                  </dl>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {active.length === 0 && !unlinked.length && !runtime?.error ? (
        <p>当前没有已报告的执行任务</p>
      ) : (
        <ul>
          {ongoing.map(({ change, tasks, runs }) => (
            <li key={change.id}>
              <div className="overview-row">
                <Button variant="ghost" onClick={() => openChange(change.id)}>
                  <OverviewName change={change} currentTask={tasks[0]} />
                </Button>
                <small>
                  已完成 {doneCount(change)} / {change.tasks.length} 项
                </small>
              </div>
              <SessionProgress runs={runs} />
              <ul>
                {tasks.map((task) => (
                  <li key={task.key} className="overview-task">
                    <State state={task.activity!.state} />
                    <div>
                      <strong title={task.title}>
                        {task.title.split("。")[0]}
                      </strong>
                      <p>{task.activity!.detail}</p>
                      {task.activity!.resume && (
                        <p>解除条件 · {task.activity!.resume}</p>
                      )}
                    </div>
                    <time>{task.activity!.time}</time>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {otherRunning.length > 0 && (
        <div>
          <h3 className="unlinked-title">未关联变更的会话</h3>
          <SessionProgress runs={otherRunning} />
        </div>
      )}
    </section>
  );
}

function Detail({ change, runs }: { change: Change; runs: RuntimeRun[] }) {
  const { tasks } = change;
  const active = tasks.filter((task) => task.activity);
  const pending = tasks.filter((task) => !task.done);
  const complete = tasks.filter((task) => task.done);
  const percent = tasks.length ? (100 * complete.length) / tasks.length : 0;
  const groups = [...new Set(pending.map((task) => task.group))];
  return (
    <article>
      <header>
        <small className="id">{change.id}</small>
        <h2>{change.name || displayName(change.id)}</h2>
      </header>
      {change.error ? (
        <p role="alert">{change.error}</p>
      ) : (
        <>
          <section className="progress-card">
            <div className="metric">
              <h3>整体进度</h3>
              {tasks.length ? (
                <span
                  className="progress-value"
                  role="progressbar"
                  aria-label="整体进度"
                  aria-valuenow={complete.length}
                  aria-valuemax={tasks.length}
                  aria-valuemin={0}
                  aria-valuetext={`已完成 ${complete.length} 项，共 ${tasks.length} 项`}
                >
                  <ProgressRing percent={percent} size={24} strokeWidth={3} />
                  <b>{Math.round(percent)}%</b>
                </span>
              ) : (
                <b>—</b>
              )}
            </div>
            <strong>
              {complete.length} / {tasks.length}
            </strong>{" "}
            项已完成
          </section>
          <section className="execution" aria-label="执行状态">
            <h3>当前执行</h3>
            <SessionProgress runs={runs} />
            {active.length ? (
              active.map((task) => (
                <div
                  className="activity"
                  data-state={task.activity!.state}
                  key={task.key}
                >
                  <State state={task.activity!.state} />
                  <time>{task.activity!.time}</time>
                  <h4>{task.title.split("。")[0]}</h4>
                  <p>{task.activity!.detail}</p>
                  {task.activity!.resume && (
                    <p>解除条件 · {task.activity!.resume}</p>
                  )}
                </div>
              ))
            ) : runs.length ? null : (
              <p>
                {pending.length
                  ? "暂无可关联的执行记录"
                  : tasks.length
                    ? "清单已全部完成"
                    : "尚无任务"}
              </p>
            )}
          </section>
          {pending.length > 0 && (
            <section>
              <h3>
                后续任务 <small>{pending.length}</small>
              </h3>
              {groups.map((group) => (
                <div className="phase" key={group}>
                  <h4>{group}</h4>
                  {pending
                    .filter((task) => task.group === group)
                    .map((task) => (
                      <TaskRow
                        key={task.key}
                        task={task}
                        next={!active.length && task === pending[0]}
                      />
                    ))}
                </div>
              ))}
            </section>
          )}
          {complete.length > 0 && (
            <PanelDisclosure
              className="completed"
              label={`已完成 · ${complete.length}`}
            >
              {complete.map((task) => (
                <TaskRow task={task} key={task.key} />
              ))}
            </PanelDisclosure>
          )}
        </>
      )}
    </article>
  );
}

export function Panel({ source }: { source: ProjectSource }) {
  const [data, setData] = useState<Snapshot>();
  const [selected, select] = useState(
    () => new URLSearchParams(location.search).get("change") ?? "",
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const pane = useRef<HTMLDivElement>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [synced, setSynced] = useState("");
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    try {
      const snapshot = await source(
        AbortSignal.any([request.signal, AbortSignal.timeout(8000)]),
      );
      if (!request.signal.aborted) {
        setData((previous) => {
          if (!snapshot.runtime?.error || !previous?.runtime?.runs.length)
            return snapshot;
          return {
            ...snapshot,
            runtime: {
              ...snapshot.runtime,
              runs: previous.runtime.runs,
              error: snapshot.runtime.error + " 以下为上次成功读取的会话状态。",
            },
          };
        });
        setFailed(false);
        setSynced(new Date().toLocaleTimeString("zh-CN"));
      }
    } catch {
      if (!request.signal.aborted) setFailed(true);
    } finally {
      if (controller.current === request) controller.current = null;
    }
  }, [source]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      clearInterval(timer);
      controller.current?.abort();
      controller.current = null;
    };
  }, [refresh]);
  const changes = data?.changes ?? [];
  const completed = changes.filter(isComplete);
  const visible = changes.filter(
    (change) =>
      showCompleted ||
      !isComplete(change) ||
      data?.runtime?.runs.some((run) => run.changeId === change.id),
  );
  const current = visible.find((change) => change.id === selected);
  function navigate(id: string) {
    select(id);
    const url = new URL(location.href);
    if (id) url.searchParams.set("change", id);
    else url.searchParams.delete("change");
    if (url.href !== location.href) history.pushState(null, "", url);
    setMenuOpen(false);
    pane.current?.scrollTo(0, 0);
  }
  useEffect(() => {
    const restore = () => {
      select(new URLSearchParams(location.search).get("change") ?? "");
      setMenuOpen(false);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (!data || !selected || current) return;
    select("");
    const url = new URL(location.href);
    url.searchParams.delete("change");
    history.replaceState(null, "", url);
  }, [data, selected, current]);
  return (
    <main data-menu={menuOpen}>
      <header className="top">
        <div className="identity">
          <span className="brand-symbol" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <strong>Architecture Kit</strong>
          <span className="crumb">/</span>
          <span>{data?.project ?? "项目执行面板"}</span>
        </div>
        <div className="sync">
          <small>{synced && "最近同步 " + synced}</small>
          <Button variant="outline" onClick={refresh}>
            刷新
          </Button>
          <div className="menu-toggle">
            <Button
              variant="outline"
              aria-expanded={menuOpen}
              aria-controls="project-navigation"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              项目导航
            </Button>
          </div>
        </div>
      </header>
      {failed && (
        <p role="alert">
          状态更新中断
          {synced ? "，当前展示上次同步的数据" : "，暂时无法读取项目"}
          。正在重试。
        </p>
      )}
      <div className="layout">
        <nav id="project-navigation" aria-label="项目导航">
          <button
            className="overview-link"
            aria-current={!current ? "page" : undefined}
            onClick={() => navigate("")}
          >
            <span className="overview-grid" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
            执行总览
          </button>
          <h3>
            未归档变更 <small>{data ? visible.length : "…"}</small>
          </h3>
          {completed.length > 0 && (
            <div className="toggle">
              <Checkbox
                size="desktop"
                label={`显示已完成（${completed.length}）`}
                checked={showCompleted}
                onCheckedChange={(value) => setShowCompleted(value === true)}
              />
            </div>
          )}
          {visible.map((change) => {
            const states = [
              ...new Set(
                change.tasks
                  .flatMap((task) =>
                    task.activity ? [task.activity.state] : [],
                  )
                  .concat(
                    data?.runtime?.runs
                      .filter((run) => run.changeId === change.id)
                      .map((run) => run.state) ?? [],
                  ),
              ),
            ];
            return (
              <button
                className="nav-change"
                key={change.id}
                aria-current={current?.id === change.id ? "true" : undefined}
                onClick={() => navigate(change.id)}
              >
                <span className="nav-progress" aria-hidden="true">
                  <ProgressRing
                    percent={
                      change.tasks.length
                        ? (doneCount(change) * 100) / change.tasks.length
                        : 0
                    }
                    size={16}
                  />
                </span>
                <span
                  className="change-name"
                  title={[change.name, change.id].filter(Boolean).join("\n")}
                >
                  {change.name || displayName(change.id)}
                </span>
                <small>
                  {change.id.match(/^act-\d+/)?.[0].toUpperCase()}{" "}
                  {change.error ||
                    doneCount(change) + " / " + change.tasks.length}
                  {states.map((state) => (
                    <State key={state} state={state} />
                  ))}
                </small>
              </button>
            );
          })}
        </nav>
        <div
          className="detail"
          ref={pane}
          role="region"
          aria-label={current ? "变更详情" : "项目执行总览"}
          tabIndex={0}
        >
          {data?.runtime?.error && current && (
            <p role="alert">{data.runtime.error}</p>
          )}
          {current ? (
            <Detail
              key={current.id}
              change={current}
              runs={
                data?.runtime?.runs.filter(
                  (run) => run.changeId === current.id,
                ) ?? []
              }
            />
          ) : data ? (
            <ExecutionOverview
              changes={changes}
              runtime={data.runtime}
              openChange={navigate}
            />
          ) : (
            <p>{failed ? "等待重新连接" : "正在读取项目…"}</p>
          )}
        </div>
      </div>
    </main>
  );
}
