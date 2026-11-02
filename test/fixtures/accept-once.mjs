// 任务018：独立进程执行一次接收，在 binding 落盘时注入一次失败；保留检查点后退出。
import { join } from "node:path";
import { SqliteMetadataStore } from "../../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../../dist/infrastructure/locks.js";
import { RunAcceptanceService } from "../../dist/application/run-acceptance.js";

const [dir, runId] = process.argv.slice(2);
const store = new SqliteMetadataStore(join(dir, ".knit", ".runtime", "metadata.db"));
const originalSave = store.bindings.save.bind(store.bindings);
let failed = false;
store.bindings.save = async (binding) => {
  if (!failed) {
    failed = true;
    throw new Error("injected binding failure in child");
  }
  return originalSave(binding);
};
try {
  const acceptance = new RunAcceptanceService({
    store,
    locks: new LockManager({ root: join(dir, ".locks") }),
  });
  const result = await acceptance.accept({ dir, runId });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.accepted ? 0 : 2;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}
