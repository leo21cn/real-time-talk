"""conftest.py - 让 `tests/` 下的测试能 import server 包。

不依赖 pytest/unittest discover，纯标准库也能跑（直接 python tests/test_xxx.py）。
"""
import sys
from pathlib import Path

# 把项目根目录加入 sys.path，使 `from server.xxx import yyy` 可用
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))