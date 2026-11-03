"""在固定 Hermes checkout 应用可复现补丁；不修改用户安装。"""
import argparse
from pathlib import Path
import subprocess

BASE = "f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path)
    args = parser.parse_args()
    root = args.checkout.resolve()
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if head != BASE:
        raise SystemExit("Hermes HEAD 与固定 v0.22.6 基线不一致。")
    patch = Path(__file__).resolve().parents[1] / "docs/hermes/host.patch"
    result = subprocess.run(["git", "apply", "--unidiff-zero", "--reverse", "--check", str(patch)], cwd=root, capture_output=True)
    if result.returncode == 0:
        print("Hermes 宿主补丁已应用。")
        return
    subprocess.run(["git", "apply", "--unidiff-zero", "--check", str(patch)], cwd=root, check=True)
    subprocess.run(["git", "apply", "--unidiff-zero", str(patch)], cwd=root, check=True)
    print("Hermes 宿主补丁应用完成。")


if __name__ == "__main__":
    main()
