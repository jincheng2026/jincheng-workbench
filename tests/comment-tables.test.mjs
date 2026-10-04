// 评论表：认得出社媒助手导出的几种格式（Excel、CSV、TSV、JSON），数得对几条评论、来自几条笔记或视频。
// 样例全是虚构的（社媒助手的条款不许传播导出的数据，仓库里不放真的导出文件）；Excel 文件在测试里现拼。
import test from "node:test";
import assert from "node:assert/strict";
import { decodeText, inspectCommentTable, recognizeComments } from "../lib/comment-tables.mjs";
import { DOUYIN_HEAD, DOUYIN_ROWS, xlsx } from "./helpers.mjs";

test("Excel：认出评论内容那一列（不是「一级评论内容」），空评论不算，按视频 ID 数来自几条视频", () => {
  const result = inspectCommentTable(xlsx([DOUYIN_HEAD, ...DOUYIN_ROWS, []]), ".xlsx");
  assert.equal(result.ok, true);
  assert.equal(result.comments, 4);
  assert.equal(result.notes, 2);
  assert.equal(result.unit, "视频");
  assert.deepEqual(result.headers.slice(0, 5), ["评论ID", "视频ID", "视频链接", "用户名称", "评论内容"]);
});

test("CSV：带 BOM、字段里有逗号和换行；小红书的按笔记数；GB18030 编码的也读得出", () => {
  const csv = "﻿笔记ID,笔记链接,评论内容,点赞数\nn1,https://www.xiaohongshu.com/explore/n1,\"第一行\n第二行\",2\nn1,https://www.xiaohongshu.com/explore/n1,\"带逗号, 也没事\",0\nn2,https://www.xiaohongshu.com/explore/n2,\"他说 \"\"好\"\"\",5\n";
  const result = inspectCommentTable(Buffer.from(csv, "utf8"), ".csv");
  assert.deepEqual([result.ok, result.comments, result.notes, result.unit], [true, 3, 2, "笔记"]);
  // GB18030：「评论内容,链接\n很好,https://www.douyin.com/video/1」的 GB18030 字节
  const bytes = Buffer.from("c6c0c2dbc4dac8dd2cc1b4bdd30abadcbac32c68747470733a2f2f7777772e646f7579696e2e636f6d2f766964656f2f310a", "hex");
  assert.equal(decodeText(bytes), "评论内容,链接\n很好,https://www.douyin.com/video/1\n");
  const fromGbk = inspectCommentTable(bytes, ".csv");
  assert.deepEqual([fromGbk.ok, fromGbk.comments], [true, 1]);
});

test("TSV（UTF-16 带 BOM，Excel 存「Unicode 文本」就是这样）和 JSON 都认得出", () => {
  const tsv = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("笔记标题\t评论内容\n标题一\t好\n标题二\t不错\n", "utf16le")]);
  const fromTsv = inspectCommentTable(tsv, ".tsv");
  assert.deepEqual([fromTsv.ok, fromTsv.comments, fromTsv.notes], [true, 2, 2]);
  const json = JSON.stringify({ data: [{ 视频ID: "v1", 评论内容: "一" }, { 视频ID: "v1", 评论内容: "二" }, { 视频ID: "v2", 评论内容: "" }] });
  const fromJson = inspectCommentTable(Buffer.from(json), ".json");
  assert.deepEqual([fromJson.ok, fromJson.comments, fromJson.notes, fromJson.unit], [true, 2, 1, "视频"]);
});

test("不是评论表、表是空的、老版 .xls、坏文件：都说清楚为什么", () => {
  const notComments = inspectCommentTable(Buffer.from("标题,点赞\n一,2\n"), ".csv");
  assert.equal(notComments.ok, false);
  assert.match(notComments.problem, /表头里要有「评论内容」.*「标题、点赞」/);
  const empty = inspectCommentTable(Buffer.from("评论内容,视频ID\n"), ".csv");
  assert.equal(empty.ok, false);
  assert.match(empty.problem, /一条评论都没有/);
  assert.throws(() => inspectCommentTable(Buffer.from("x"), ".xls"), /老版 Excel/);
  assert.throws(() => inspectCommentTable(Buffer.from("不是 zip"), ".xlsx"), /不是完整的 Excel 表/);
  assert.throws(() => inspectCommentTable(Buffer.from("{坏"), ".json"), /JSON 文件写坏了/);
  assert.throws(() => inspectCommentTable(Buffer.from("x"), ".docx"), /只收/);
});

test("表头不在第一行、列名改过（评论 / content）也认；没有笔记那一列时只数条数", () => {
  const rows = [["导出时间：2026-10-03"], [], ["序号", "comment"], ["1", "第一条"], ["2", "第二条"]];
  const result = recognizeComments(rows);
  assert.deepEqual([result.ok, result.comments, result.notes, result.unit], [true, 2, null, null]);
});
