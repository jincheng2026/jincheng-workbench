"""测试共用：路径、临时目录、样例数据、小工具。

临时目录默认建在系统临时目录下的 jc-creation-page-tests 里（环境变量 JC_TEST_TMP 可以换），不写别处。
测试不碰真实工作文件夹、不碰 8878、8879、8888、8890、8977、8978、18977 端口：服务一律用系统随机分配的端口。
"""
import copy, http.client, io, json, os, socket, sys, tempfile, threading, unittest

TESTS = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(TESTS)
FIXTURES = os.path.join(TESTS, 'fixtures')
for p in (os.path.join(APP, 'server'), APP, FIXTURES):
    if p not in sys.path:
        sys.path.insert(0, p)

import brain_save as bs  # noqa: E402

TEST_TMP = os.environ.get('JC_TEST_TMP') or os.path.join(tempfile.gettempdir(), 'jc-creation-page-tests')
os.makedirs(TEST_TMP, exist_ok=True)
tempfile.tempdir = TEST_TMP
KIT_FILE = os.environ.get('JC_KIT_FILE') or os.path.join(APP, 'kit', 'kit.js')
ORIG_KIT_PATH = bs.KIT_PATH
ORIG_TEMPLATE_DIR = bs.TEMPLATE_DIR
FIX_TEMPLATE = os.path.join(FIXTURES, 'template')  # 测试用的最小模板，不随界面代码变
FIX_KIT = os.path.join(FIXTURES, 'kit-stub.js')
bs.Handler.log_message = lambda *a: None  # 测试时不打印访问日志
os.environ.pop('JC_BRAIN_ROOT', None)  # 别让本机环境变量影响根目录的找法
# 工作台的设置也换成一个空的临时文件夹：测试不读本机真实的设置和工作文件夹
os.environ['WORKBENCH_CONFIG_DIR'] = tempfile.mkdtemp(prefix='jc-settings-', dir=TEST_TMP)


def read(p):
    with open(p, 'rb') as f:
        return f.read()


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


SAMPLE = {
    'content_id': 'T901', 'type': '口播', 'stage': '写稿', 'title': 'AI是我们普通人最值得抓住的杠杆',
    'narrative': {'story': '转行做视频一年半，从上班族变成全职做视频的人', 'audience': '想抓住 AI 的普通人',
                  'problem': 'AI 到底能给普通年轻人带来什么'},
    'speech_rate': 4, 'service_origin': 'http://127.0.0.1:%d' % free_port(),  # 一个没人监听的临时端口，测试不碰常用端口
    'segments': [
        {'title': '开头一句观点', 'role': '开头：一句钩子，一句观点',
         'refs': [{'who': '博主甲', 'source_type': '口播原话', 'time': '0:00 起', 'text': '我觉得 AI 真的是我们普通人最值得抓住的杠杆。',
                   'url': 'https://example.com/video/1001'}],
         'baseline': '我觉得 AI 真的是我们普通人最值得抓的杠杆，因为回头看这一年半，我自己都觉得跟做梦一样。',
         'mine': '我觉得AI真的是我们普通人最值得抓住的杠杆，因为回头看转行做视频的这一年半，我自己都觉得跟做梦一样。', 'note': ''},
        {'title': '第一件事', 'role': '第一件事：当剪辑',
         'refs': [{'who': '博主甲', 'source_type': '口播原话', 'time': '0:00 到 0:28', 'text': '第一件事情是，昨天有一个人加了我。', 'url': ''}],
         'baseline': '第一件事，我去给一个博主当剪辑。', 'mine': '第一件事，我去给一个博主当剪辑。他问我会不会用 AI。', 'note': '这段能不能再短一点？'},
        {'title': '结尾', 'role': '结尾：回到观点', 'refs': [], 'baseline': '', 'mine': '所以我说，AI 是我们最值得抓住的杠杆。', 'note': ''},
    ],
    'suggestions': [
        {'segment': 1, 'category': '拗口', 'source': 'AI', 'original': '回头看转行做视频的这一年半', 'proposed': '回头看转行这一年半',
         'reason': '「转行做视频的这一年半」一口气念有点绕', 'basis': {'type': 'AI 自己的判断', 'text': '念出来多了两个字的停顿'}, 'verdict': '待你定'},
        {'segment': 2, 'category': '衔接', 'original': '他问我会不会用 AI。', 'proposed': '他第一句就问我：你会用 AI 吗？',
         'reason': '换成直接引语，和上一句接得更顺', 'basis': {'type': '参考口播', 'text': '博主甲这里用的是对话'}},
        {'segment': 3, 'category': '口径', 'original': '最值得抓住的杠杆', 'proposed': '最值得抓住的那根杠杆',
         'reason': '和开头呼应', 'basis': {'type': '你之前定的', 'text': '开头说的是杠杆'}, 'verdict': '待你定'},
    ],
}


def sample(**over):
    d = copy.deepcopy(SAMPLE)
    d.update(over)
    return d


def fixture(name):
    """读 tests/fixtures 下的 JSON 数据（每次都是新副本）。"""
    with open(os.path.join(FIXTURES, name), encoding='utf-8') as f:
        return json.load(f)


def post(port, body, origin='self'):
    headers = {'Host': '127.0.0.1:%d' % port, 'Content-Type': 'application/json'}
    if origin == 'self':
        headers['Origin'] = 'http://127.0.0.1:%d' % port
    elif origin:
        headers['Origin'] = origin
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    c.request('POST', '/save', body=json.dumps(body, ensure_ascii=False).encode('utf-8'), headers=headers)
    r = c.getresponse()
    raw = r.read()
    c.close()
    return r.status, json.loads(raw.decode('utf-8'))


def get(port, path, origin=None):
    headers = {'Host': '127.0.0.1:%d' % port}
    if origin:
        headers['Origin'] = origin
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    c.request('GET', path, headers=headers)
    r = c.getresponse()
    raw, hdrs = r.read(), {k.lower(): v for k, v in r.getheaders()}
    c.close()
    return r.status, raw, hdrs


class ServerCase(unittest.TestCase):
    """起一个临时根目录和随机端口的保存服务，测完关掉。"""
    def start_server(self, root, read_only=False):
        self.log = bs.LOG = io.StringIO()
        bs._fail_seen.clear()
        self.srv = bs.make_server(root, 0, read_only=read_only)
        self.port = self.srv.port
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def stop_server(self):
        bs.BEFORE_REPLACE = None
        bs.KIT_PATH = ORIG_KIT_PATH
        bs.TEMPLATE_DIR = ORIG_TEMPLATE_DIR
        bs.LOG = None
        if getattr(self, 'srv', None):
            self.srv.shutdown()
            self.srv.server_close()
            self.srv = None
