// 用这台 Mac 的程序打开文件：文件交给系统默认程序（和在访达里双击一样），文件夹在访达里打开。
// 不假设装了哪个编辑器。只用 /usr/bin/open，不经过 shell。
// 环境变量 WORKBENCH_DRY_OPEN=1 时只记下要打开什么、不真的打开（自动化测试用，免得弹出一堆窗口）。
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".json", ".jsonl", ".csv"]);

function fail(message, statusCode = 500) {
  return Object.assign(new Error(message), { statusCode });
}

export function createOpener({ dryRun = process.env.WORKBENCH_DRY_OPEN === "1", exec = run, log = () => {} } = {}) {
  const calls = [];
  async function call(args) {
    calls.push(args);
    if (dryRun) {
      log(`[打开·演练] open ${args.join(" ")}`);
      return;
    }
    await exec("/usr/bin/open", args, { timeout: 8000 });
  }

  return {
    dryRun,
    calls,
    /** reveal：在访达里打开（文件夹直接打开，文件选中它）；否则交给默认程序。 */
    async open(target, { reveal = false } = {}) {
      let stat;
      try {
        stat = statSync(target);
      } catch {
        throw fail("找不到这个文件或文件夹，可能已经被移走或删除。", 404);
      }
      if (reveal || stat.isDirectory()) {
        await call(stat.isDirectory() ? [target] : ["-R", target]);
        return { how: "finder" };
      }
      try {
        await call([target]);
        return { how: "default" };
      } catch (error) {
        // 这类文字文件没有设默认程序时，退一步用「文本编辑」打开
        if (!TEXT_EXT.has(path.extname(target).toLowerCase())) {
          throw fail(`这台 Mac 上没有能打开这种文件的程序：${path.basename(target)}`);
        }
        try {
          await call(["-t", target]);
          return { how: "text" };
        } catch {
          throw fail(`没能打开 ${path.basename(target)}：${error?.message ?? error}`);
        }
      }
    },
  };
}
