import { parsePatch } from "diff";

export type DiffLine = {
  kind: "context" | "add" | "remove" | "meta";
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

export type DiffHunk = {
  header: string;
  lines: DiffLine[];
};

export function presentDiff(patch: string): {
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
} {
  const file = parsePatch(patch)[0];
  let additions = 0;
  let deletions = 0;
  const hunks = (file?.hunks ?? []).map((hunk) => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const lines = hunk.lines.map((line): DiffLine => {
      const kind = line[0];
      const text = line.slice(1);
      if (kind === "+") {
        additions += 1;
        return { kind: "add", oldLine: null, newLine: newLine++, text };
      }
      if (kind === "-") {
        deletions += 1;
        return { kind: "remove", oldLine: oldLine++, newLine: null, text };
      }
      if (kind === " ") {
        return { kind: "context", oldLine: oldLine++, newLine: newLine++, text };
      }
      return { kind: "meta", oldLine: null, newLine: null, text: line };
    });
    return {
      header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      lines,
    };
  });
  return { additions, deletions, hunks };
}
