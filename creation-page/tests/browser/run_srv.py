"""浏览器测试用：在指定端口起保存服务（server/brain_save.py），起好后打印 ready。
用法：run_srv.py <root> <port>
环境变量 JC_KIT 指向别的 kit 文件时改用它（模拟 kit.js 写坏）。"""
import os, sys

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(APP, 'server'))
import brain_save as server  # noqa: E402

if os.environ.get('JC_KIT'):
    server.KIT_PATH = os.environ['JC_KIT']
root, port = sys.argv[1], int(sys.argv[2])
srv = server.make_server(root, port)
print('ready', srv.port, flush=True)
srv.serve_forever()
