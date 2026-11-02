/**
 * `git status --porcelain=v1 -z` 改动路径的唯一解析实现。
 * 交付资格（dirtyPaths）与检查副作用签名（worktreeSignature）共用；含 rename／copy 两端。
 */
export function porcelainStatusPaths(stdout: string): string[] {
  const parts = stdout.split("\0");
  const out: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    out.push(record.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const original = parts[index + 1];
      if (original !== undefined && original !== "") out.push(original);
      index += 1;
    }
  }
  return out;
}
