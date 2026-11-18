import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import type { Change, RuntimeRun, RuntimeSnapshot } from "./snapshot.js";

const execute = promisify(execFile);
const blockedGoals: Record<string, string> = {
  blocked: "阻塞",
  budget_limited: "预算受限",
  usage_limited: "额度受限",
};

function linkedChange(text: string, changes: Change[]) {
  const words = new Set(
    text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [],
  );
  const exact = changes.filter((c) => words.has(c.id.toLowerCase()));
  if (exact.length) return exact.length === 1 ? exact[0]!.id : null;
  const matched = changes.filter((c) => {
    const issue = c.id.match(/\bact-\d+(?=-|$)/i)?.[0];
    return issue && words.has(issue.toLowerCase());
  });
  return matched.length === 1 ? matched[0]!.id : null;
}

// An interrupted app can leave an inProgress projection behind. Check for an
// open writer descriptor, not merely the zero-byte lock file on disk.
async function liveWriters(home: string, ids: string[]) {
  const paths = ids
    .filter((id) => /^[a-f0-9-]{36}$/i.test(id))
    .map((id) => join(home, "thread-writer-locks", id + ".lock"));
  if (!paths.length) return new Set<string>();
  let output: string;
  try {
    ({ stdout: output } = await execute(
      "lsof",
      ["-nP", "-Fn", "--", ...paths],
      { timeout: 2500 },
    ));
  } catch (error) {
    const result = error as { code?: number; stdout?: string };
    if (result.code !== 1) throw error;
    output = result.stdout ?? "";
  }
  return new Set(
    output
      .split("\n")
      .filter((s) => s.startsWith("n"))
      .map((s) => basename(s.slice(1), ".lock")),
  );
}

export async function readCodexRuntime(
  home: string,
  root: string,
  changes: Change[],
): Promise<RuntimeSnapshot> {
  const connections: DatabaseSync[] = [];
  function open(file: string) {
    const db = new DatabaseSync(join(home, file), { readOnly: true });
    connections.push(db);
    return db;
  }
  try {
    const state = open("state_5.sqlite"),
      history = open("thread_history_1.sqlite"),
      goals = open("goals_1.sqlite");
    const threads = state
      .prepare(
        "SELECT id, substr(title,1,120) AS title FROM threads WHERE archived=0 AND cwd=?",
      )
      .all(root);
    const lastTurn = history.prepare(
      "SELECT turn_id,status,started_at,completed_at,substr(json_extract(error_json,'$.message'),1,300) AS failure FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1",
    );
    const goalById = goals.prepare(
      "SELECT status, objective, updated_at_ms FROM thread_goals WHERE thread_id=?",
    );
    const candidates = threads.flatMap((thread) => {
      const id = String(thread.id),
        turn = lastTurn.get(id),
        goal = goalById.get(id);
      if (
        !turn ||
        (turn.status !== "inProgress" &&
          !blockedGoals[String(goal?.status)] &&
          !(goal?.status === "active" && turn.status === "failed"))
      )
        return [];
      return [{ id, title: String(thread.title), turn, goal }];
    });
    const writers = await liveWriters(
      home,
      candidates.filter((c) => c.turn.status === "inProgress").map((c) => c.id),
    );
    const progress =
      history.prepare(`SELECT count(*) AS operations, count(completed_at_ms) AS finished
      FROM thread_items WHERE thread_id=? AND turn_id=? AND item_type IN ('commandExecution','mcpToolCall','fileChange','webSearch')`);
    const lastOperation =
      history.prepare(`SELECT item_type, json_extract(item_json,'$.status') AS status,
      json_extract(item_json,'$.exitCode') AS code FROM thread_items WHERE thread_id=? AND turn_id=?
      AND item_type IN ('commandExecution','mcpToolCall','fileChange','webSearch') ORDER BY updated_at_ordinal DESC, rollout_ordinal DESC LIMIT 1`);
    const lastMessage =
      history.prepare(`SELECT substr(json_extract(item_json,'$.text'),1,520) AS text,
      (SELECT group_concat(coalesce(json_extract(q.value,'$.question'), json_extract(q.value,'$.title')), char(10)) FROM json_each(item_json,'$.questions') q WHERE q.type='object') AS questionText,
      json_array_length(item_json,'$.questions') AS questions, created_at_ms AS time
      FROM thread_items WHERE thread_id=? AND turn_id=? AND item_type='agentMessage' ORDER BY rollout_ordinal DESC LIMIT 1`);
    const lastItem = history.prepare(
      "SELECT item_type,coalesce(completed_at_ms,started_at_ms,created_at_ms) AS time FROM thread_items WHERE thread_id=? AND turn_id=? ORDER BY updated_at_ordinal DESC,rollout_ordinal DESC LIMIT 1",
    );
    const wait =
      history.prepare(`SELECT (SELECT group_concat(coalesce(json_extract(q.value,'$.question'), json_extract(q.value,'$.title')), char(10)) FROM json_each(item_json,'$.arguments.questions') q WHERE q.type='object') AS questionText FROM thread_items WHERE thread_id=? AND turn_id=?
      AND item_type='mcpToolCall' AND completed_at_ms IS NULL AND json_extract(item_json,'$.status')='inProgress'
      AND json_extract(item_json,'$.tool') IN ('request_user_input','request_user_input_async') LIMIT 1`);
    const runs: RuntimeRun[] = [];
    for (const { id, title, turn, goal } of candidates) {
      const running = turn.status === "inProgress" && writers.has(id);
      const goalState = blockedGoals[String(goal?.status)];
      const terminalFailure =
        goal?.status === "active" && turn.status === "failed";
      if (!running && !goalState && !terminalFailure) continue;
      const args = [id, String(turn.turn_id)];
      const message = lastMessage.get(...args),
        item = lastItem.get(...args),
        counts = progress.get(...args)!;
      const operation = lastOperation.get(...args);
      let lastFailure = "";
      if (typeof operation?.code === "number" && operation.code !== 0)
        lastFailure = `最近命令退出码 ${operation.code}`;
      else if (operation?.status === "failed")
        lastFailure = "最近一次工具操作失败";
      const blocked =
        goalState &&
        (!running ||
          Number(goal?.updated_at_ms) >= Number(turn.started_at) * 1000);
      const pendingInput = wait.get(...args);
      const awaiting =
        (Number(message?.questions) > 0 &&
          item?.item_type === "agentMessage") ||
        pendingInput;
      const status = blocked
        ? goalState
        : terminalFailure
          ? "回合失败"
          : awaiting
            ? "等待输入"
            : "进行中";
      const objective =
        goal && goal.status !== "complete" && goal.status !== "paused"
          ? String(goal.objective)
          : "";
      const updated = Math.max(
        Number(item?.time ?? 0),
        Number(turn.started_at) * 1000,
        blocked ? Number(goal?.updated_at_ms) : 0,
      );
      runs.push({
        id,
        changeId: linkedChange(objective || title, changes),
        title: title || "项目会话",
        state: status,
        lastFailure,
        requestedAction: awaiting
          ? String(pendingInput?.questionText || message?.questionText || "")
          : "",
        detail:
          terminalFailure && turn.failure
            ? String(turn.failure)
            : String(message?.text ?? ""),
        time: new Date(updated).toISOString(),
        finished: Number(counts.finished),
        operations: Number(counts.operations),
      });
    }
    return {
      runs: runs.sort((a, b) => b.time.localeCompare(a.time)),
      error: "",
    };
  } catch {
    return {
      runs: [],
      error:
        "无法读取本机 Codex 执行状态，请核对 Codex 数据目录、数据库版本与 lsof。",
    };
  } finally {
    for (const db of connections) db.close();
  }
}
