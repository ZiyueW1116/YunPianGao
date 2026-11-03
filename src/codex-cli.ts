import { createInterface } from "node:readline"
import { createCodexSession } from "./adapters/codex.js"

const [codexPath, codexHome, cwd] = process.argv.slice(2)
if (!codexPath || !codexHome || !cwd) throw new Error("用法：node dist/codex-cli.js <Codex 二进制绝对路径> <独立 CODEX_HOME> <项目绝对路径>")
const streamed = new Set<string>()
let owner: string | undefined
const session = await createCodexSession({ codexPath, codexHome, cwd,
  onEvent(message) {
    if (message.params?.threadId === owner && message.method === "item/agentMessage/delta") {
      streamed.add(message.params.itemId); process.stdout.write(message.params.delta)
    }
    if (message.params?.threadId === owner && message.method === "item/completed" && message.params.item.type === "agentMessage" && !streamed.has(message.params.item.id)) process.stdout.write(message.params.item.text)
    if (message.id !== undefined && message.method && message.method !== "item/tool/call")
      process.stderr.write("\n宿主需要审批或交互；此示例没有审批 UI，可使用 /interrupt 结束当前执行。\n")
    if (message.params?.threadId === owner && message.method === "turn/completed") process.stdout.write("\n")
  },
  onError(error) { process.stderr.write(`${error instanceof Error ? error.message : "Codex 运行失败。"}\n`) },
})
owner = session.threadId
const lines = createInterface({ input: process.stdin, output: process.stdout })
lines.on("line", (line) => {
  const operation = line === "/compact" ? session.compact() : line === "/interrupt" ? session.interrupt() : line === "/close" ? session.close().then(() => lines.close()) : session.prompt(line)
  void operation.catch((error) => process.stderr.write(`${error.message}\n`))
})
lines.once("close", () => { void session.close() })
process.once("SIGINT", () => lines.close())
process.stdout.write("Codex 实验性等待入口已启动。输入 /compact、/interrupt 或 /close。\n")
