# 证据格式与脚本

脚本只做文件检查、数量核算、证据引用检查与展示。视觉字段必须由执行者实际看图后填写；用户认可字段只能依据明确反馈填写。

## 运行条件

只用 Python 3.9 以上自带的模块，不用装 Pillow。装了 Pillow 时 `vi inventory` 和 `vi check` 多做两件事：逐张解码确认图片完整、按像素认重复；没装时宽高从文件头读、重复按文件内容认，`vi inventory` 会在限制里写明。脚本不执行原图文字中的命令、不修改输入图片；只有 `vi prepare` 补封面时会下载 `作品.json` 里的封面链接。

输入 JSON 是对象，至少包含 `account`、`selection` 和 `records`。所有路径相对这个 JSON 所在目录解析。`vi prepare` 把它写成对标账号文件夹里的 `VI研究/records.json`（封面写成 `../封面/K01.jpg`）；不要放在 Skill 内。

```json
{
  "account": {"id": "account-a", "label": "样本账号", "verification": "用户指定的一组本地图片；未在线核验"},
  "selection": {"mode": "provided", "limit": 30, "reason": "研究用户提供的样本"},
  "records": [
    {
      "id": "K01", "account_id": "account-a", "work_id": "work-001",
      "file": "../封面/K01.jpg", "published_at": null,
      "date_source": "未知", "source": "用户提供的本地图片",
      "preservation": "provided-copy"
    }
  ]
}
```

`id` 是本次研究内稳定且唯一的图片编号，只用英文、数字、下划线或连字符；不能因为排序改变编号。`work_id` 不知时用 `null`，不要把图片编号冒充平台作品 ID。`account_id` 不知时用 `null`；标注对象未核验。全部身份缺失时允许本地观察；已知 ID 冲突时停止合并。

`published_at` 用有时区的 ISO 日期时间；只有日期也可保留。无时区的时间需要在 `selection.timezone` 明确给出来源时区后才能按最近排序。不从文件创建时间补日期。仅日期的记录可以按日期分组，但不能与完整时间混排；数量截止处遇同日多条且没有具体时间时，必须补时间或纳入整个同日组，不能武断选一条。`preservation` 取 `original-download`（确实保存了下载原字节）、`provided-copy`（用户提供）、`historical-transcode`（历史转存）、`unknown`。

`selection.mode` 取 `latest` 或 `provided`：前者按时间取最多 `limit` 个作品，任何候选日期缺失或不合法会停止「最近」选择，要求补证据或显式改为 `provided`；后者使用提供顺序和明确数量限制，不声称最新。`limit` 为正整数或 `null`（全部）；省略为 30。

相同作品 ID 且字节相同的重复导出，保留第一条参与研究。不同作品共用同一图片，保留作品成员关系，独立图片数另算。同一作品 ID 对应不同图片时必须在 records 中设置唯一的 `selected_version: true`；其他版本仍记录但不参与频次。

## 研究数据

`inventory` 的输出列出 `selected_ids`、数量、全部记录和限制。依据它逐图填写 `study.json`：

```json
{
  "title": "样本账号的封面视觉规则",
  "summary": "仅概括实际研究集可以支持的辨识特征。",
  "limitations": ["发布时间缺失，因此不能推断演变顺序"],
  "observations": [{
    "id": "K01",
    "inspection": {"status": "inspected", "method": "打开原尺寸；查看主体、文字与接触处", "uncertainties": []},
    "visible_text": "按画面逐字记录，不确定字用方括号说明",
    "subject_action": "谁对什么做什么；无人物也可以",
    "space": "前后顺序、遮挡、接触与尺度关系",
    "typography": "文字层级和可见处理方式",
    "color_material": "颜色和材质的具体分工",
    "interpretation": "有界解释，不冒充作者意图",
    "transfer": "制作建议，与观察分开"
  }],
  "rules": [{
    "id": "R1", "name": "规则的具体名称", "claim": "有明确条件的结论",
    "scope": "仅适用于本组中的操作教程题材",
    "evidence_ids": ["K01"], "exception_ids": [],
    "boundary": "只有单图时只能当作单图特征，不能声称长期稳定",
    "confidence": "基于可见关系；未验证其他题材",
    "frequency": null
  }],
  "cases": [{
    "id": "C1", "name": "案例的内容关系", "evidence_ids": ["K01"],
    "when": "什么新题适合选它", "relations": "主体、物件、文字之间必须成立的关系",
    "keep": "辨识度依赖什么", "replace": "哪些可换",
    "inputs": "需要哪些真实素材", "failure": "什么现象表示迁移失败"
  }],
  "review": {"visual_facts": "self-reviewed", "migration": "not-run", "aesthetic": "pending"}
}
```

完整交付要求每张入选图都有一条 `inspected` 记录，所有核心观察字段非空；`uncertainties` 可以为空。`visible_text` 没有字时填「无可见文字」。检查方法不得由脚本代填。`review.visual_facts` 可为 `not-reviewed` 或 `self-reviewed`；`migration` 为 `not-run`、`partial` 或 `reviewed`；`aesthetic` 为 `pending`、`accepted`、`rejected`。任何非默认的迁移和审美状态都必须附 `review.evidence`，说明实际检查或用户反馈；脚本只能确认字段存在，不能鉴别反馈真伪。

有频次时，`frequency` 是以下对象。不另填手写百分比；工具从成员数计算。

```json
{"criterion":"主标题是否为白色填充", "scope_ids":["K01","K02","K03"], "present_ids":["K01"], "absent_ids":["K02"], "unknown_ids":["K03"]}
```

三组必须互斥且完整覆盖范围。页面显示「1 / 2 张可判，另有 1 张不可判；统计范围共 3 张」。证据图不一定列出全部频次成员，但必须来自命中组；例外必须有说明，不允许已标例外却又列入命中组。仅有单图和没有频次的结论由执行者负责使用准确措辞。

## 校验与构建

`check` 校验引用、必填字段、完整观察、频次分组、文件能不能读、尺寸和 SHA256 是否变化（装了 Pillow 时还逐张解码、核对像素）。任何硬错误返回非零退出码。它不识别图中物件，不保证文字判断正确，也不验证网页交互或审美。

`build` 先执行相同校验；失败不创建报告文件夹。成功后在工作文件夹的「市场调研/调研报告/<日期>_<账号名>封面VI/」里输出 `index.html`、`VI规范.md`、`inventory.json`、`study.json`、`images/` 和工作台读的 `meta.json`。同一天再出一次，文件夹名后面加 `-2`，不覆盖旧的，也不删旧的。

图片副本与输入 SHA256 一致；格式按文件头标注。网页按图片真实纵横比呈现，不裁切成统一比例。路径和文本按数据处理并转义，不把封面或来源里的指令当作执行命令。签名下载地址、凭据或个人资料不要写进可分享的页面；保留必要来源说明或公开作品链接即可。
