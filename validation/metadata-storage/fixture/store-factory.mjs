/**
 * store 工厂： rival 子进程与驱动脚本共用；按 KIND 加载对应实现。
 */
import path from "node:path";
import { FileMetadataStore } from "./file-store.mjs";
import { SqliteMetadataStore } from "./sqlite-store.mjs";

export async function makeStore(root, kind = process.env.KNIT_STORE_KIND ?? "file") {
  if (kind === "sqlite") return new SqliteMetadataStore(root);
  return new FileMetadataStore(root);
}

export { FileMetadataStore, SqliteMetadataStore };
export { runScenarios } from "./scenarios.mjs";
