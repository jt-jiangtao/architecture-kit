import ts from "typescript";
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ScanEntry } from "../../../packages/config/src/index.js";

type Location = { file: string; line: number };
type Component = Location & { id: string; title: string; description: string };
type Relation = Location & { from: string; to: string; label: string };
type Decision = Location & { id: string; title: string; body: string };
type Member = Location & {
  character: number;
  component: string;
  decisions: string[];
  packageRoot: string;
};
type Evidence = Location & { id: string; name: string };

function split(value: string, at: string) {
  const match = /^([A-Za-z_][\w-]*)(?:\s+([\s\S]+))?$/.exec(value.trim());
  if (!match) throw Error(at + " invalid annotation ID: " + value);
  return { id: match[1]!, text: match[2]?.trim() ?? "" };
}

export async function annotations(
  root: string,
  scan: ScanEntry[],
  source: (file: string) => Promise<string>,
  committed: boolean,
) {
  const components = new Map<string, Component>(),
    decisions = new Map<string, Decision>();
  const relations: Relation[] = [],
    members: Member[] = [],
    tests: Evidence[] = [];
  for (const pkg of scan) {
    const packageRoot = dirname(pkg.manifest);
    // A removed annotation no longer passes the worktree prefilter. Check the
    // committed side as well before labelling the output with a Git revision.
    if (committed) {
      const changed = execFileSync(
        "git",
        [
          "diff",
          "--no-renames",
          "--name-only",
          "--diff-filter=MDT",
          "-z",
          "HEAD",
          "--",
          packageRoot,
        ],
        { cwd: root, encoding: "utf8" },
      );
      for (const file of changed
        .split("\0")
        .filter((f) => /\.[cm]?tsx?$/.test(f))) {
        const old = execFileSync("git", ["show", "HEAD:" + file], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 16_000_000,
        });
        if (/@(architecture|decision|uses|verifies)\b/.test(old))
          await source(file);
      }
    }
    const files = pkg.sources ?? execFileSync(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z", "--", packageRoot],
      { cwd: root, encoding: "utf8", maxBuffer: 16_000_000 },
    ).split("\0");
    for (const file of [...new Set(files)].sort()) {
      if (!/\.[cm]?tsx?$/.test(file)) continue;
      const disk = join(root, file);
      const stat = await lstat(disk).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat?.isFile()) continue;
      if (
        !/@(architecture|decision|uses|verifies)\b/.test(
          await readFile(disk, "utf8"),
        )
      )
        continue;
      const sf = ts.createSourceFile(
        file,
        await source(file),
        ts.ScriptTarget.Latest,
        true,
      );
      function visit(node: ts.Node) {
        const docs = ts
          .getJSDocCommentsAndTags(node)
          .filter(ts.isJSDoc)
          .filter((doc) => doc.parent === node);
        for (const doc of docs) {
          const tags = (doc.tags ?? []).filter((t) =>
            ["architecture", "decision", "uses", "verifies"].includes(
              t.tagName.text,
            ),
          );
          if (!tags.length) continue;
          const nameNode = ts.isVariableStatement(node)
            ? node.declarationList.declarations[0]?.name
            : (node as ts.NamedDeclaration).name;
          const line =
            1 +
            sf.getLineAndCharacterOfPosition((nameNode ?? node).getStart(sf))
              .line;
          const loc = { file, line },
            at = file + ":" + line;
          const values = (name: string) =>
            tags
              .filter((t) => t.tagName.text === name)
              .map((t) => split(ts.getTextOfJSDocComment(t.comment) ?? "", at));
          const checks = values("verifies");
          if (checks.length) {
            if (checks.length !== tags.length)
              throw Error(
                at +
                  " @verifies cannot be combined with declaration annotations",
              );
            const call =
              ts.isExpressionStatement(node) &&
              ts.isCallExpression(node.expression)
                ? node.expression
                : undefined;
            const literal = call?.arguments[0];
            if (
              !call ||
              !["it", "test"].includes(call.expression.getText(sf)) ||
              !literal ||
              !ts.isStringLiteralLike(literal)
            )
              throw Error(
                at + " @verifies requires it/test with a literal name",
              );
            for (const check of checks)
              tests.push({ ...loc, id: check.id, name: literal.text });
            continue;
          }
          const owners = values("architecture"),
            owner = owners[0];
          if (!owner || owners.length !== 1)
            throw Error(at + " expected one @architecture");
          if (owner.text) {
            if (components.has(owner.id))
              throw Error(at + " duplicate component " + owner.id);
            if (!/^[A-Za-z_]\w*$/.test(owner.id))
              throw Error(at + " invalid LikeC4 component ID " + owner.id);
            components.set(owner.id, {
              ...loc,
              id: owner.id,
              title: owner.text,
              description: ts.getTextOfJSDocComment(doc.comment) ?? "",
            });
          }
          for (const use of values("uses"))
            relations.push({
              ...loc,
              from: owner.id,
              to: use.id,
              label: use.text,
            });
          const refs = values("decision");
          for (const ref of refs) {
            if (!ref.text) continue;
            if (decisions.has(ref.id))
              throw Error(at + " duplicate decision " + ref.id);
            const [title, ...body] = ref.text.split("\n");
            if (!body.join("\n").trim())
              throw Error(
                at +
                  " @decision definition needs a title and rationale on the following line",
              );
            decisions.set(ref.id, {
              ...loc,
              id: ref.id,
              title: title!,
              body: body.join("\n").trim(),
            });
          }
          members.push({
            ...loc,
            character: sf.getLineAndCharacterOfPosition(
              (nameNode ?? node).getStart(sf),
            ).character,
            packageRoot,
            component: owner.id,
            decisions: refs.map((r) => r.id),
          });
        }
        ts.forEachChild(node, visit);
      }
      visit(sf);
    }
    if (pkg.documents?.length && !members.some(m => m.packageRoot === packageRoot)) {
      const data = JSON.parse(await source(pkg.manifest));
      const id = "pkg_" + Buffer.from(data.name).toString("hex");
      if (components.has(id)) throw Error("Duplicate component " + id);
      components.set(id, { id, title: data.name, description: data.description ?? "", file: pkg.manifest, line: 1 });
    }
  }
  for (const m of members) {
    if (!components.has(m.component))
      throw Error(m.file + ":" + m.line + " unknown component " + m.component);
    for (const id of m.decisions)
      if (!decisions.has(id))
        throw Error(m.file + ":" + m.line + " unknown decision " + id);
  }
  for (const r of relations)
    if (!components.has(r.to))
      throw Error(r.file + ":" + r.line + " unknown @uses " + r.to);
  for (const t of tests)
    if (!decisions.has(t.id))
      throw Error(t.file + ":" + t.line + " unknown @verifies " + t.id);
  const elements = [...components.values()];
  const quote = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").trim());
  const dsl = [
    "specification { element component }",
    "model {",
    ...elements.map(
      (c) =>
        c.id +
        " = component " +
        quote(c.title) +
        " { description " +
        quote(c.description) +
        " }",
    ),
    ...relations.map(
      (r) => r.from + " -> " + r.to + (r.label ? " " + quote(r.label) : ""),
    ),
    "}",
    "views { view architecture { include * } }",
    "",
  ].join("\n");
  return {
    components: elements,
    decisions: [...decisions.values()],
    relations,
    members,
    tests,
    dsl,
  };
}
