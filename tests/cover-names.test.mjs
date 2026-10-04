// 封面页上几处纯计算（ui/lib/cover-names.ts）：K 编号、出一批默认参考哪几张构图、风格叫什么和从哪来、「我的封面」按风格分组、自检的颜色。
import test from "node:test";
import assert from "node:assert/strict";
import { checkTone, defaultCompositions, groupByStyle, kIds, styleName, styleSource } from "../ui/lib/cover-names.ts";

test("K 编号：只认 K01 这种名字，按数字排", () => {
  assert.deepEqual(kIds(["K10.jpg", "K02.png", "小红书截图.png", "k03.webp", "K1.png"]), ["K02", "K03", "K10"]);
});

test("默认参考构图：用风格里存的（只留还在的图），没有就取前 5 张", () => {
  const images = ["K01.jpg", "K02.jpg", "K03.jpg", "K04.jpg", "K05.jpg", "K06.jpg"];
  assert.deepEqual(defaultCompositions({ images, compositions: { ids: ["K06", "K09", "K02"], by: "你" } }), ["K06", "K02"]);
  assert.deepEqual(defaultCompositions({ images, compositions: null }), ["K01", "K02", "K03", "K04", "K05"]);
  assert.deepEqual(defaultCompositions({ images: ["截图.png"], compositions: null }), [], "还没拆、没有 K 图的风格没有构图可参考");
  assert.deepEqual(defaultCompositions(null), []);
});

test("风格叫什么、从哪来：拆好了用风格名；还没拆说清是谁、几张；放进来的图写哪天放的", () => {
  const account = { name: null, kind: "account", accountName: "某某", platform: "抖音", folder: "抖音-某某", covers: 0 };
  const images = { name: null, kind: "images", folder: "2026-10-04_8张", covers: 8 };
  assert.equal(styleName(account), "「某某」还没拆");
  assert.equal(styleName(images), "还没拆的 8 张图");
  assert.equal(styleName({ ...images, name: "蓝白大字风" }), "蓝白大字风");
  assert.equal(styleSource(account), "对标账号「某某」（抖音）");
  assert.equal(styleSource(images), "你放进来的 8 张图（10 月 4 日放的）");
  assert.equal(styleSource({ ...images, folder: "别的名字" }), "你放进来的 8 张图");
});

test("我的封面按风格分组：同一个风格的放一组、新的在前；不知道照哪个风格出的放最后", () => {
  const groups = [
    { id: "T002", title: "文章", covers: [{ no: "01", style: "风格/a", styleName: "蓝白大字风", modifiedAt: "2026-10-04T10:00:00Z" }] },
    {
      id: "T001",
      title: "视频",
      covers: [
        { no: "02", style: "抖音-某某", styleName: null, modifiedAt: "2026-10-03T10:00:00Z" },
        { no: "01", style: "抖音-某某", styleName: "暖黄手写风", modifiedAt: "2026-10-02T10:00:00Z" },
        { no: "03", style: null, styleName: null, modifiedAt: "2026-10-05T10:00:00Z" },
      ],
    },
  ];
  const result = groupByStyle(groups);
  assert.deepEqual(result.map((g) => [g.style, g.styleName, g.covers.map((c) => `${c.id}-${c.no}`)]), [
    ["风格/a", "蓝白大字风", ["T002-01"]],
    ["抖音-某某", "暖黄手写风", ["T001-02", "T001-01"]],
    [null, null, ["T001-03"]],
  ]);
});

test("自检的颜色：通过是绿的，只出了提示词是灰的，其余是问题", () => {
  assert.deepEqual(["通过", "只出了提示词", "三只手", null].map(checkTone), ["ok", "gray", "warn", "gray"]);
});
