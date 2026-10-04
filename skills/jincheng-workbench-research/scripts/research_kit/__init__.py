"""调研 Skill 的脚本：读评论导出、调 TikHub、建对标账号档案、出调研报告。

只用 Python 3.8 以上自带的模块，不用 pip 装任何东西。入口是 scripts/research.py。
"""


class UserError(Exception):
    """能直接说给用户听的错误：原因和怎么办都写在消息里，命令行只打印消息、不打印报错堆栈。"""

    exit_code = 2


class NeedsAgreement(UserError):
    """要先问用户、用户在对话里明确同意才能继续（花钱超过默认上限、评论超过默认条数、小红书接口）。"""

    exit_code = 3
