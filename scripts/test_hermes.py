"""用显式指定的隔离 Hermes 安装运行真实入口验收，不跳过缺失的宿主。"""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
host = os.environ.get("HERMES_CHECKOUT")
python = os.environ.get("HERMES_PYTHON")
if not host or not python:
    raise SystemExit("请设置 HERMES_CHECKOUT（已应用固定补丁的源码目录）与 HERMES_PYTHON（隔离安装的解释器）。")
subprocess.run([sys.executable, str(root / "scripts/prepare_hermes.py"), host], check=True)
env = dict(os.environ)
env["PYTHONPATH"] = os.pathsep.join([str(root / "dist/adapters/hermes"), str(Path(host).resolve())])
subprocess.run([python, str(root / "test/hermes/runtime.py")], env=env, cwd=root, check=True)
