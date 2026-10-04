"""解析 TikHub 返回：样例的结构照 2026-10-03 用真密钥采到的返回（抖音 App V3、小红书 App V2），内容全是虚构的。"""
import unittest

from support import DY_AWEME, XHS_NOTE as NOTE, dy_comment, dy_page, xhs_comment, xhs_page

from research_kit import platforms as P


class PlaceTest(unittest.TestCase):
    def test_英文的省份和国家换成中文(self):
        cases = {"Sichuan": "四川", "Zhejiang": "浙江", "Inner Mongolia": "内蒙古", "Hong Kong": "香港", "Shaanxi": "陕西",
                 "Shanxi": "山西", "United Kingdom": "英国", "the United States": "美国", "South Korea": "韩国"}
        for raw, want in cases.items():
            self.assertEqual(P.place_zh(raw), want, raw)

    def test_中文和认不出的原样留着(self):
        self.assertEqual(P.place_zh("韩国"), "韩国")
        self.assertEqual(P.place_zh("IP属地：浙江"), "浙江")
        self.assertEqual(P.place_zh("Atlantis"), "Atlantis")
        self.assertEqual(P.place_zh(None), "")

    def test_小红书评论的属地(self):
        page = xhs_page([xhs_comment("6b1000000000000000000001", "这个怎么做的", ip="Sichuan"),
                         xhs_comment("6b1000000000000000000002", "求教程", ip="United Kingdom"),
                         xhs_comment("6b1000000000000000000003", "好看", ip="韩国"),
                         xhs_comment("6b1000000000000000000004", "想要同款")])  # 这条平台没给属地
        rows, _nxt, _more, _total = P.xhs_comments(page, NOTE)
        self.assertEqual([r["ip"] for r in rows], ["四川", "英国", "韩国", ""])


class XhsCommentTest(unittest.TestCase):
    def test_作者的回复认得出来(self):
        reply = xhs_comment("6b2000000000000000000002", "可以的，下单备注就行", ip="Zhejiang")
        reply["show_tags_v2"] = [{"style_id": "gray", "type": "is_author", "pos": "cmt_bottom", "text": "Author"}]
        reply["target_comment"] = {"id": "6b2000000000000000000001", "status": 0}
        reader = xhs_comment("6b2000000000000000000001", "能定制吗", subs=[reply], sub_count=3)
        reader["show_tags_v2"] = [{"style_id": "gray", "type": "note_first", "pos": "cmt_bottom", "text": "First comment"}]
        rows, _nxt, _more, _total = P.xhs_comments(xhs_page([reader]), NOTE)
        self.assertEqual([(r["level"], r["by_author"]) for r in rows], [("一级", False), ("回复", True)])
        self.assertEqual(rows[1]["parent"], "6b2000000000000000000001")
        self.assertEqual(rows[0]["replies"], 3)

    def test_翻页游标是一段JSON文字_拆开带到下一页(self):
        page = xhs_page([xhs_comment("6b3000000000000000000001", "第一条")],
                        cursor={"contextId": "fake-context", "cursor": "6b3000000000000000000001", "index": 2, "pageArea": "ALL"})
        _rows, nxt, more, total = P.xhs_comments(page, NOTE)
        self.assertEqual(nxt, {"cursor": "6b3000000000000000000001", "index": 2, "pageArea": "ALL"})
        self.assertTrue(more)
        self.assertEqual(total, 40)
        # 楼中楼的游标也是 JSON 文字：{"cursor": "…", "index": 3}
        sub_page = xhs_page([xhs_comment("6b3000000000000000000009", "回复")], cursor={"cursor": "6b3000000000000000000009", "index": 3})
        _rows, nxt, _more, _total = P.xhs_comments(sub_page, NOTE, "6b3000000000000000000001")
        self.assertEqual((nxt["cursor"], nxt["index"]), ("6b3000000000000000000009", 3))


class DouyinCommentTest(unittest.TestCase):
    def test_一级评论里附带的作者回复也取出来(self):
        answer = dy_comment("7600000000000000102", "手动删了就可以了", ip="山东", parent="7600000000000000101", author=True)
        question = dy_comment("7600000000000000101", "卸载后留在 C 盘的文件删不掉", likes=2, ip="河北", replies=1, preview=[answer])
        plain = dy_comment("7600000000000000103", "学到了，谢谢")
        rows, cursor, more, total = P.douyin_comments(dy_page([question, plain], cursor=20), DY_AWEME)
        self.assertEqual([(r["cid"], r["level"], r["parent"], r["by_author"]) for r in rows],
                         [("7600000000000000101", "一级", None, False), ("7600000000000000102", "回复", "7600000000000000101", True),
                          ("7600000000000000103", "一级", None, False)])
        self.assertEqual((rows[0]["likes"], rows[0]["ip"], rows[0]["replies"]), (2, "河北", 1))
        self.assertEqual((cursor, more, total), (20, True, 73))

    def test_楼中楼接口里的回复不再往下拆(self):
        answer = dy_comment("7600000000000000202", "是的", parent="7600000000000000201", author=True,
                            preview=[dy_comment("7600000000000000203", "嵌套的", parent="7600000000000000202")])
        rows, _cursor, _more, _total = P.douyin_comments(dy_page([answer], cursor=1, has_more=False), DY_AWEME, "7600000000000000201")
        self.assertEqual([(r["cid"], r["parent"]) for r in rows], [("7600000000000000202", "7600000000000000201")])



class XhsNoteTest(unittest.TestCase):
    def note(self, nid, ntype, **extra):
        """笔记列表里的一条，字段照真实返回：likes、comments_count、collected_count、share_count、create_time（秒）、sticky。"""
        n = {"id": nid, "cursor": nid, "type": ntype, "display_title": "虚构笔记 %s" % nid[-2:], "title": "虚构笔记 %s" % nid[-2:],
             "desc": "虚构的文案", "likes": 120, "comments_count": 8, "collected_count": 30, "share_count": 4, "view_count": 0,
             "create_time": 1790000000, "sticky": False, "images_list": [{"url": "https://example.invalid/cover.webp"}],
             "user": {"nickname": "虚构博主", "userid": "65f000000000000000000001"}}
        n.update(extra)
        return n

    def test_视频笔记的时长(self):
        video = self.note("6c0000000000000000000001", "video", video_info_v2={"capa": {"duration": 320, "frame_ts": 0}})
        normal = self.note("6c0000000000000000000002", "normal", sticky=True)
        resp = {"code": 200, "data": {"code": 0, "success": True, "data": {"has_more": True, "tags": [], "notes": [video, normal]}}}
        works, cursor, more = P.xhs_notes(resp)
        self.assertEqual([(w["type"], w["duration_seconds"], w["pinned"]) for w in works], [("视频", 320, False), ("图文", None, True)])
        self.assertEqual((works[0]["likes"], works[0]["comments"], works[0]["collects"], works[0]["shares"]), (120, 8, 30, 4))
        self.assertEqual((cursor, more), ("6c0000000000000000000002", True))  # 下一页从列表最后一条的 cursor 接着拉

    def test_笔记详情的话题(self):
        note = self.note("6c0000000000000000000003", "normal", desc="做了一个小网站\n#生日礼物[话题]# #生日[话题]##设计网站[话题]#",
                         hash_tag=[{"name": "生日礼物", "type": "topic"}, {"name": "生日", "type": "topic"}])
        detail = {"code": 200, "data": {"code": 0, "success": True, "data": [{"note_list": [note], "model_type": "note"}]}}
        self.assertEqual(P.xhs_note_detail(detail)["tags"], ["生日礼物", "生日"])
        del note["hash_tag"]  # 没有 hash_tag 时从文案里认
        self.assertEqual(P.xhs_note_detail(detail)["tags"], ["生日礼物", "生日", "设计网站"])


if __name__ == "__main__":
    unittest.main()
