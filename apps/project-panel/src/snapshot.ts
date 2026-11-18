import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt();
const marker = /^\[([ xX])\]\s+([\s\S]+)/;
const statusLine =
  /^\s*>\s*执行状态[：:]\s*(进行中|阻塞|等待输入|等待确认|待确认)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)(?:\s*\|\s*(.+))?\s*$/;

export interface Activity {
  state: string;
  time: string;
  detail: string;
  resume: string;
}
export interface Task {
  key: string;
  group: string;
  title: string;
  body: string;
  done: boolean;
  activity: Activity | null;
}
export interface Change {
  name?: string;
  id: string;
  tasks: Task[];
  error: string;
}
export interface RuntimeRun {
  id: string;
  changeId: string | null;
  title: string;
  state: string;
  detail: string;
  time: string;
  finished: number;
  operations: number;
  lastFailure: string;
  requestedAction: string;
}
export interface RuntimeSnapshot {
  runs: RuntimeRun[];
  error: string;
}
export interface Snapshot {
  runtime?: RuntimeSnapshot;
  project: string;
  changes: Change[];
}

export function parseTasks(source: string): Task[] {
  const lines = source.split(/\r?\n/);
  const tokens = markdown.parse(source, {});
  const nestedTaskEnds = new Map<number, number>();
  const quotes = new Set<number>();
  for (const [i, token] of tokens.entries()) {
    if (!token.map) continue;
    if (token.type === "blockquote_open") quotes.add(token.map[0]);
    const first = tokens[i + 2];
    if (
      token.type === "list_item_open" &&
      first?.type === "inline" &&
      marker.test(first.content)
    )
      nestedTaskEnds.set(token.map[0], token.map[1]);
  }
  let group = "任务";
  const tasks: Task[] = [];
  for (const [i, token] of tokens.entries()) {
    if (token.type === "heading_open") group = tokens[i + 1]?.content ?? group;
    if (token.type !== "list_item_open" || !token.map) continue;
    const inline = tokens[i + 2];
    if (inline?.type !== "inline") continue;
    const match = marker.exec(inline.content);
    if (!match) continue;
    const done = match[1]?.toLowerCase() === "x";
    const title = match[2]!.split("\n")[0]!;
    const body: string[] = [];
    let activity: Activity | null = null;
    for (let row = token.map[0] + 1; row < token.map[1]; row++) {
      const nestedEnd = nestedTaskEnds.get(row);
      if (nestedEnd !== undefined) {
        row = nestedEnd - 1;
        continue;
      }
      const line = lines[row]!;
      const record = quotes.has(row) ? statusLine.exec(line) : null;
      if (record && !done) {
        activity = {
          state: record[1]!,
          time: record[2]!,
          detail: record[3]!,
          resume: record[4] ?? "",
        };
      } else if (!record) body.push(line.trimStart());
    }
    tasks.push({
      key: String(token.map[0]),
      group,
      title,
      body: body.join("\n").trim(),
      done,
      activity,
    });
  }
  return tasks;
}

async function optionalText(path: string) {
  try {
    if ((await realpath(path)) === path) return await readFile(path, "utf8");
  } catch {
    /* Older changes may only have a task list. */
  }
  return "";
}

function chineseHeading(text: string) {
  const heading = /^#\s+(.+)$/m
    .exec(text)?.[1]
    ?.trim()
    .replace(/\s+Specification$/i, "");
  return heading && /\p{Script=Han}/u.test(heading) ? heading : "";
}

async function changeName(root: string, directory: string) {
  const proposal = await optionalText(join(directory, "proposal.md"));
  const heading = chineseHeading(proposal);
  if (heading) return heading;
  const capabilities =
    /^## Capabilities\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(proposal)?.[1] ??
    "";
  const first = /^[-*]\s+`([a-z0-9-]+(?:\/[a-z0-9-]+)*)`[：:\s]*(.*)$/m.exec(
    capabilities,
  );
  if (!first) return "";
  const title = chineseHeading(
    await optionalText(join(root, "openspec", "specs", first[1]!, "spec.md")),
  );
  return (
    title || (/\p{Script=Han}/u.test(first[2] ?? "") ? first[2]!.trim() : "")
  );
}

export async function loadSnapshot(root: string): Promise<Snapshot> {
  const project = basename(root);
  const dir = join(root, "openspec", "changes");
  let entries;
  try {
    if ((await realpath(dir)) !== dir)
      throw new Error("变更目录必须位于项目内");
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { project, changes: [] };
    throw error;
  }
  const ids = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== "archive" &&
        !entry.name.startsWith("."),
    )
    .map((entry) => entry.name)
    .sort();
  const changes = await Promise.all(
    ids.map(async (id) => {
      const file = join(dir, id, "tasks.md");
      try {
        if ((await realpath(file)) !== file)
          throw new Error("任务文件必须位于变更目录内");
        return {
          id,
          name: await changeName(root, join(dir, id)),
          tasks: parseTasks(await readFile(file, "utf8")),
          error: "",
        };
      } catch {
        return { id, tasks: [], error: "无法读取该变更的 tasks.md" };
      }
    }),
  );
  return { project, changes };
}
