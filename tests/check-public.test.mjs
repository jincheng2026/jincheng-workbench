// 公开前自查（scripts/check-public.mjs）里管图片的那一段：README 的截图只许放在 docs/images/，PNG 或 JPEG，不带元数据。
import test from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { imageProblems } from "../scripts/check-public.mjs";

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 一张 1×1 的 PNG；extra 是插在图像数据前面的数据块，比如 [["tEXt", "Author\0某人"]] */
function png(extra = []) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // 每个颜色 8 位
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...extra.map(([type, text]) => chunk(type, Buffer.from(text, "latin1"))),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 只有开头几段的 JPEG（够自查读到图像数据之前） */
function jpeg(withExif) {
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x08]), Buffer.from("Exif\0\0", "latin1")]);
  const quant = Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x04]), Buffer.from([0, 1])]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...(withExif ? [app1] : []), quant, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);
}

test("README 的截图：docs/images/ 下、不带元数据的 PNG 和 JPEG 没问题", () => {
  assert.deepEqual(imageProblems("docs/images/content.png", png()), []);
  assert.deepEqual(imageProblems("docs/images/a.jpg", jpeg(false)), []);
  assert.deepEqual(imageProblems("README.md", Buffer.from("# 标题")), [], "不是图片的文件不管");
  assert.deepEqual(imageProblems("ui/app/icon.svg", Buffer.from("<svg/>")), [], "SVG 是手写的文字，不算截图");
});

test("图片带着元数据（文字块、EXIF、时间）就报出来", () => {
  const text = imageProblems("docs/images/a.png", png([["tEXt", "Author\0someone"]]));
  assert.equal(text.length, 1);
  assert.match(text[0], /元数据（tEXt）/);
  assert.match(imageProblems("docs/images/a.png", png([["eXIf", "MM"], ["tIME", "1234567"]]))[0], /eXIf、tIME/);
  assert.match(imageProblems("docs/images/a.jpg", jpeg(true))[0], /EXIF 或 XMP/);
});

test("图片放错地方、格式不对也报出来", () => {
  assert.match(imageProblems("ui/public/shot.png", png()).join(""), /只放在 docs\/images\//);
  assert.match(imageProblems("docs/images/a.gif", Buffer.from("GIF89a")).join(""), /只收 PNG 和 JPEG/);
  assert.match(imageProblems("docs/images/fake.png", Buffer.from("not a png")).join(""), /内容不是 PNG/);
});
