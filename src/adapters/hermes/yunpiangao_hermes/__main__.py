"""独立嵌入式终端入口；/close 释放实例，/compact 发起原生压缩。"""
import argparse
import asyncio
import json
from pathlib import Path
import sys

from .session import create_hermes_session


async def main():
    parser = argparse.ArgumentParser(description="云片糕 Hermes 嵌入入口")
    parser.add_argument("--agent-options", type=Path, help="AIAgent 参数 JSON 文件；凭证可使用 Hermes 原生配置")
    parser.add_argument("--threshold-tokens", type=int, default=100000)
    parser.add_argument("--idle-delay-ms", type=int, default=1500)
    args = parser.parse_args()
    options = json.loads(args.agent_options.read_text(encoding="utf-8")) if args.agent_options else {}
    session = await create_hermes_session(options, scheduling={"thresholdTokens": args.threshold_tokens, "idleDelayMs": args.idle_delay_ms})
    pending = set()

    async def render():
        while True:
            result = await session.events.get()
            print(result.get("final_response", ""), flush=True)

    async def prompt(text):
        try:
            await session.prompt(text)
        except Exception as error:
            print(str(error), file=sys.stderr, flush=True)

    output = asyncio.create_task(render())
    try:
        print("云片糕 Hermes：输入消息；/compact 压缩，/snapshot 查看状态，/close 退出。", flush=True)
        while line := await asyncio.to_thread(sys.stdin.readline):
            text = line.strip()
            if text == "/close":
                break
            if text == "/snapshot":
                print(json.dumps(await session.snapshot(), ensure_ascii=False), flush=True)
            elif text == "/compact":
                print(json.dumps(await session.compact(), ensure_ascii=False), flush=True)
            elif text:
                task = asyncio.create_task(prompt(text))
                pending.add(task)
                task.add_done_callback(pending.discard)
    finally:
        await session.close()
        await asyncio.gather(*pending, return_exceptions=True)
        output.cancel()
        await asyncio.gather(output, return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
