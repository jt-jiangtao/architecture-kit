import ts from "typescript";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ScanEntry } from "../../../packages/config/src/index.js";

type Declaration =
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.ClassDeclaration
  | ts.FunctionDeclaration
  | ts.EnumDeclaration
  | ts.VariableDeclaration;
function supported(node: ts.Node): node is Declaration {
  return (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) ||
    ts.isEnumDeclaration(node)
  );
}
export interface TypeField {
  path: string;
  optional: boolean;
  text: string;
  values: string[];
  links: { start: number; end: number; id: string }[];
}
export interface TypePage {
  id: string;
  name: string;
  file: string;
  line: number;
  character: number;
  kind: string;
  group: string;
  route: string;
  fields: TypeField[];
  referencedBy: { id: string; name: string; path: string; href: string }[];
}
export const fieldAnchor = (p: string) => "field-" + p;
type Start = { name: string; file: string; line: number; character?: number };
function packageTypes(root: string, entry: ScanEntry, starts: Start[]) {
  const tsconfig = join(root, entry.tsconfig);
  const raw = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (raw.error)
    throw Error(ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"));
  const options = ts.parseJsonConfigFileContent(
    raw.config,
    ts.sys,
    dirname(tsconfig),
    {},
    tsconfig,
  ).options;
  const program = ts.createProgram([join(root, entry.entry)], options);
  const checker = program.getTypeChecker();
  const pending = new Map<string, Declaration>(),
    pages = new Map<string, TypePage>();
  function queue(decl: ts.Declaration | undefined) {
    if (!decl || !supported(decl) || !decl.name) return;
    const full = resolve(decl.getSourceFile().fileName);
    const file = relative(root, full).split(sep).join("/");
    if (
      !full.startsWith(root + sep) ||
      file.split("/").some((p) => ["node_modules", "dist"].includes(p))
    )
      return;
    const id = file + "#" + decl.name.getText();
    if (!pending.has(id)) pending.set(id, decl);
    return id;
  }
  const barrel = program.getSourceFile(join(root, entry.entry));
  const moduleSymbol = barrel && checker.getSymbolAtLocation(barrel);
  if (!moduleSymbol)
    throw Error(entry.entry + ": cannot resolve exported symbols");
  const exports = checker.getExportsOfModule(moduleSymbol);
  for (const start of starts) {
    let symbol = exports.find((s) => s.name === start.name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
      symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.declarations?.find((d) => {
      if (!supported(d) || !d.name) return false;
      const sf = d.getSourceFile(),
        loc = sf.getLineAndCharacterOfPosition(d.name.getStart(sf));
      return (
        relative(root, sf.fileName).split(sep).join("/") === start.file &&
        loc.line + 1 === start.line &&
        (start.character === undefined || start.character === loc.character)
      );
    });
    queue(decl);
  }
  for (const [id, decl] of pending) {
    const sf = decl.getSourceFile(),
      name = decl.name!.getText(),
      file = relative(root, sf.fileName).split(sep).join("/");
    const route =
      "/types/" +
      file.split("/").map(encodeURIComponent).join("/") +
      "/" +
      encodeURIComponent(name);
    const fields: TypeField[] = [];
    function add(
      path: string,
      node: ts.Node,
      optional = false,
      textEnd = node.end,
    ) {
      const start = node.getStart(sf);
      const text = sf.text.slice(start, textEnd).trimEnd();
      const links: TypeField["links"] = [];
      function visit(n: ts.Node) {
        if (n.getStart(sf) >= start + text.length) return;
        if (ts.isIdentifier(n)) {
          let symbol = checker.getSymbolAtLocation(n);
          if (symbol && symbol.flags & ts.SymbolFlags.Alias)
            symbol = checker.getAliasedSymbol(symbol);
          const target = queue(symbol?.declarations?.find(supported));
          if (target && target !== id)
            links.push({
              start: n.getStart(sf) - start,
              end: n.end - start,
              id: target,
            });
        }
        ts.forEachChild(n, visit);
      }
      visit(node);
      const literals = ts.isUnionTypeNode(node) ? node.types : [node];
      const values = literals
        .filter(ts.isLiteralTypeNode)
        .map((n) => n.literal.getText(sf));
      fields.push({ path, optional, text, values, links });
    }
    function members(
      nodes: ts.NodeArray<ts.TypeElement> | ts.NodeArray<ts.ClassElement>,
      prefix: string,
    ) {
      for (const m of nodes) {
        if (
          ts.canHaveModifiers(m) &&
          ts
            .getModifiers(m)
            ?.some(
              (x) =>
                x.kind === ts.SyntaxKind.PrivateKeyword ||
                x.kind === ts.SyntaxKind.ProtectedKeyword,
            )
        )
          continue;
        if (ts.isConstructorDeclaration(m)) {
          params(m, "constructor");
          continue;
        }
        if (!m.name || ts.isPrivateIdentifier(m.name)) continue;
        const p = (prefix ? prefix + "." : "") + m.name.getText(sf);
        if (ts.isPropertySignature(m) || ts.isPropertyDeclaration(m)) {
          if (m.type) typed(p, m.type, !!m.questionToken);
          else if (
            ts.isPropertyDeclaration(m) &&
            m.initializer &&
            (ts.isLiteralExpression(m.initializer) ||
              m.initializer.kind === ts.SyntaxKind.TrueKeyword ||
              m.initializer.kind === ts.SyntaxKind.FalseKeyword)
          )
            add(p, m.initializer);
        } else if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) {
          add(
            p,
            m,
            !!m.questionToken,
            ts.isMethodDeclaration(m) ? (m.body?.getStart(sf) ?? m.end) : m.end,
          );
          params(m, p);
        }
      }
    }
    function typed(p: string, n: ts.TypeNode, optional = false) {
      add(p, n, optional);
      if (ts.isTypeLiteralNode(n)) members(n.members, p);
    }
    function params(n: ts.SignatureDeclaration, p: string) {
      for (const param of n.parameters)
        if (param.type)
          typed(
            (p ? p + "." : "") + param.name.getText(sf),
            param.type,
            !!param.questionToken || !!param.initializer,
          );
      if (n.type) typed((p ? p + "." : "") + "return", n.type);
    }
    if (ts.isFunctionDeclaration(decl)) params(decl, "");
    if (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)) {
      members(decl.members, "");
      for (const clause of decl.heritageClauses ?? [])
        for (const type of clause.types) add("extends/implements", type);
    }
    if (ts.isTypeAliasDeclaration(decl)) {
      if (ts.isTypeLiteralNode(decl.type)) members(decl.type.members, "");
      else {
        add(name, decl.type);
        function variants(type: ts.TypeNode) {
          if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
            type.types.forEach(variants);
            return;
          }
          if (ts.isParenthesizedTypeNode(type)) {
            variants(type.type);
            return;
          }
          if (ts.isTypeLiteralNode(type)) {
            const tag = type.members.find(
              (m): m is ts.PropertySignature =>
                ts.isPropertySignature(m) &&
                !!m.type &&
                ts.isLiteralTypeNode(m.type),
            );
            members(
              type.members,
              tag ? tag.name.getText(sf) + "=" + tag.type!.getText(sf) : "",
            );
          }
        }
        variants(decl.type);
      }
    }
    if (ts.isVariableDeclaration(decl)) {
      if (decl.type) typed(name, decl.type);
      if (
        decl.initializer &&
        (ts.isLiteralExpression(decl.initializer) ||
          [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(
            decl.initializer.kind,
          ))
      )
        add("value", decl.initializer);
    }
    if (ts.isEnumDeclaration(decl))
      for (const e of decl.members) {
        const value = checker.getConstantValue(e);
        if (value !== undefined)
          fields.push({
            path: e.name.getText(sf),
            text: JSON.stringify(value),
            optional: false,
            links: [],
            values: [JSON.stringify(value)],
          });
      }
    const first = sf.statements[0];
    const fileDoc =
      first &&
      ts
        .getJSDocCommentsAndTags(first)
        .filter(ts.isJSDoc)
        .find((d) =>
          d.tags?.some((t) => t.tagName.text === "packageDocumentation"),
        );
    const tag = fileDoc?.tags?.find((t) => t.tagName.text === "group");
    const group = ts.getTextOfJSDocComment(tag?.comment) ?? "";
    pages.set(id, {
      id,
      name,
      file,
      group,
      line: sf.getLineAndCharacterOfPosition(decl.name!.getStart(sf)).line + 1,
      character: sf.getLineAndCharacterOfPosition(decl.name!.getStart(sf))
        .character,
      kind: ts.SyntaxKind[decl.kind],
      fields,
      route,
      referencedBy: [],
    });
  }
  return pages;
}

export function typeCatalog(
  root: string,
  scan: ScanEntry[],
  starts: Start[][],
) {
  const pages = new Map<string, TypePage>();
  for (const [i, entry] of scan.entries()) {
    for (const [id, page] of packageTypes(root, entry, starts[i] ?? [])) {
      if (!pages.has(id) || page.file.startsWith(dirname(entry.manifest) + "/"))
        pages.set(id, page);
    }
  }
  for (const p of pages.values())
    for (const f of p.fields)
      for (const id of new Set(f.links.map((l) => l.id))) {
        pages.get(id)?.referencedBy.push({
          id: p.id,
          name: p.name,
          path: f.path,
          href: p.route + ".html#" + encodeURIComponent(fieldAnchor(f.path)),
        });
      }
  return [...pages.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}
