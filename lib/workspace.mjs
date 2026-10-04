// 第一次启动自动建好工作文件夹：选题库（总览 + 各类型文件夹 + 一条示例选题）、内容草稿（示例选题的草稿文件夹带参考材料）、写稿方法（说明 + 七份默认写法）、
// 市场调研（对标账号、调研报告、评论导入三个文件夹 + 一份说明）、提示词（说明 + 两条示例）、最外层给 AI 看的 AGENTS.md 和 CLAUDE.md。
// 只补缺的，从不覆盖已有文件：示例只在对应文件夹是这次新建的时候才写，删掉的示例不会再冒出来。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RESEARCH_PATH_KEYS } from "./config.mjs";
import { FAV_DIR, PHOTO_DIR } from "./cover-files.mjs";
import {
  EXAMPLE_DRAFT_DIR,
  EXAMPLE_PROMPTS,
  agentsGuide,
  categoryOrder,
  claudeGuide,
  exampleBreakdown,
  exampleCard,
  exampleCardName,
  exampleReferenceTranscript,
  overviewTemplate,
  promptFormatGuide,
  researchGuide,
  researchRoot,
  writingMethodFiles,
} from "./templates.mjs";

const GROUPS = ["待做", "已做"];

function makeDir(dir, created) {
  if (existsSync(dir)) return false;
  mkdirSync(dir, { recursive: true });
  created.push(dir);
  return true;
}

function writeNew(file, text, created) {
  if (existsSync(file)) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
  created.push(file);
  return true;
}

/** 返回这次新建的文件夹和文件（绝对路径），什么都没建时是空数组。设置里关掉的栏目，它的文件夹不建。 */
export function ensureWorkspace(config) {
  const created = [];
  const freshRoot = makeDir(config.workFolder, created);
  if (freshRoot) {
    writeNew(path.join(config.workFolder, "AGENTS.md"), agentsGuide(config), created);
    writeNew(path.join(config.workFolder, "CLAUDE.md"), claudeGuide(), created);
  }

  if (config.columns.includes("content")) {
    const freshTopics = makeDir(config.paths.topics, created);
    for (const type of config.contentTypes) {
      for (const group of GROUPS) makeDir(path.join(config.paths.topics, type, group), created);
    }
    // 选题总览：选题库是新建的就带一条示例；选题库原来就有、只是总览不见了，补一份空白的。
    writeNew(config.paths.overview, overviewTemplate(config, { example: freshTopics }), created);
    if (freshTopics) {
      writeNew(path.join(config.paths.topics, exampleCardName(config.contentTypes[0])), exampleCard(), created);
    }
    const freshDrafts = makeDir(config.paths.drafts, created);
    // 示例选题的草稿文件夹：一份虚构的参考视频逐字稿、一份写好的参考拆解，新用户第一次让 AI 写 T001 就有东西可拆。
    // 只在选题库和内容草稿都是这次新建时放（示例选题也是这时才有）；参考材料不算开始写，T001 还在「选题」里
    if (freshTopics && freshDrafts) {
      const dir = path.join(config.paths.drafts, EXAMPLE_DRAFT_DIR);
      writeNew(path.join(dir, "参考拆解.md"), exampleBreakdown(), created);
      writeNew(path.join(dir, "参考素材", "参考视频逐字稿.md"), exampleReferenceTranscript(), created);
    }
    // 写稿方法：这个文件夹是这次新建的才放说明和七份默认写法（用户删掉的不会再冒出来）
    if (makeDir(config.paths.writingMethod, created)) {
      for (const file of writingMethodFiles()) writeNew(path.join(config.paths.writingMethod, file.name), file.text, created);
    }
    // 封面素材（1.1 加）：我的照片/、收藏/ 是结构，缺了就补（1.0 装的工作文件夹更新后也会补上）；封面设置.json 等放照片、设对标时再写
    makeDir(path.join(config.paths.coverAssets, PHOTO_DIR), created);
    makeDir(path.join(config.paths.coverAssets, FAV_DIR), created);
  }

  // 市场调研：三个文件夹是结构，缺了就补；说明文件只在「市场调研」这一层是这次新建时写（删掉的不会再冒出来）
  if (config.columns.includes("research")) {
    const root = researchRoot(config);
    const freshRoot = root ? makeDir(root, created) : false;
    for (const key of RESEARCH_PATH_KEYS) makeDir(config.paths[key], created);
    if (freshRoot) writeNew(path.join(root, "README.md"), researchGuide(config), created);
  }

  if (config.columns.includes("prompts") && makeDir(config.paths.prompts, created)) {
    writeNew(path.join(config.paths.prompts, "_格式说明.md"), promptFormatGuide(), created);
    writeNew(path.join(config.paths.prompts, "_分类顺序.md"), categoryOrder(), created);
    for (const prompt of EXAMPLE_PROMPTS) writeNew(path.join(config.paths.prompts, prompt.file), prompt.text, created);
  }
  return created;
}

/** 选题总览被删掉时，界面上的「重新建一份空白总览」走这里：只补总览，不动别的。 */
export function restoreOverview(config) {
  const created = [];
  writeNew(config.paths.overview, overviewTemplate(config, { example: false }), created);
  return created;
}
