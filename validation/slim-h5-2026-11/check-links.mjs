// 列出 Markdown 文件里指向不存在路径的链接。在仓库根目录运行：
//   node validation/slim-h5-2026-11/check-links.mjs <文件或目录>...
// 查两种链接：相对路径的；写成 https://github.com/6spot/knit/blob|tree/main/<路径> 的（按 <路径> 在仓库里有没有来判断）。
// 一条断链一行，退出码 1；没有断链时什么都不输出，退出码 0。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const GITHUB = /^https:\/\/github\.com\/6spot\/knit\/(?:blob|tree)\/main\/(.*)$/;
const files = [];
const collect = (path) => {
  if (statSync(path).isDirectory()) readdirSync(path).forEach((name) => collect(join(path, name)));
  else if (path.endsWith(".md")) files.push(path);
};
process.argv.slice(2).forEach(collect);

let broken = 0;
for (const file of files.sort()) {
  for (const [, link] of readFileSync(file, "utf8").matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = link.split("#")[0];
    if (target === "") continue;
    const github = GITHUB.exec(target);
    if (github === null && /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const path = github === null ? resolve(dirname(file), decodeURIComponent(target)) : resolve(github[1]);
    if (existsSync(path)) continue;
    console.log(`${file}: ${link}`);
    broken += 1;
  }
}
process.exitCode = broken === 0 ? 0 : 1;
