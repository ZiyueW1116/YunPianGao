"""从隔离配置启动持久存活的 OpenHands SDK 入口。"""

import argparse
import os
from pathlib import Path

from openhands.sdk import LLM, Agent
from openhands.sdk.context.condenser import LLMSummarizingCondenser
from .session import OpenHandsSession


def main():
    parser = argparse.ArgumentParser(description="云片糕 OpenHands SDK 入口")
    parser.add_argument("--core-entry", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--prompt", required=True)
    args = parser.parse_args()
    llm = LLM(model=os.environ["LLM_MODEL"], api_key=os.environ.get("LLM_API_KEY"),
              base_url=os.environ.get("LLM_BASE_URL"))
    agent = Agent(llm=llm, condenser=LLMSummarizingCondenser(
        llm=llm.model_copy(update={"usage_id": "condenser"})))
    session = OpenHandsSession(agent=agent, workspace=str(args.workspace),
        core_entry=args.core_entry, persistence_dir=args.state_dir / "sessions",
        profile_store_dir=args.state_dir / "profiles")
    try:
        session.prompt(args.prompt).result()
        print("入口保持运行；新输入会结束当前等待。输入 /quit 退出。")
        while True:
            text = input("> ")
            if text == "/quit":
                break
            session.prompt(text).result()
    except (EOFError, KeyboardInterrupt):
        pass
    finally:
        session.close().result()


if __name__ == "__main__":
    main()
