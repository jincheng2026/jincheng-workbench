"""封面 Skill 的脚本：找位置、整理对标封面、拆封面 VI 的清单校验和报告、封面设置、生成记录。

只用 Python 3.9 以上自带的模块，不用 pip 装任何东西（装了 Pillow 时多做两件事，见 images.py）。入口是 scripts/cover.py。
"""


class UserError(Exception):
    """能直接说给用户听的错误：原因和怎么办都写在消息里，命令行只打印消息、不打印报错堆栈。"""

    exit_code = 2
