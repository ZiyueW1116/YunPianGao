import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { TaskSnapshot, TaskSource } from "../wait.js"

/** 进程由适配层拥有；关闭等待 runtime 不终止独立任务。 */
export function launchProcess(command: string, args: string[], cwd: string) {
  let snapshot: TaskSnapshot = { status: "working" }
  let output = Buffer.alloc(0), truncated = false, cancelRequested = false
  const changed = new Set<() => void>()
  const child = spawn(command, args, { cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] })
  const collect = (chunk: Buffer) => {
    const combined = Buffer.concat([output, chunk])
    truncated ||= combined.length > 65536
    output = combined.subarray(Math.max(0, combined.length - 65536))
  }
  child.stdout?.on("data", collect)
  child.stderr?.on("data", collect)
  const notify = () => { for (const fn of changed) fn() }
  child.once("error", () => { snapshot = { status: "failed", finishedAt: Date.now(), error: "无法启动进程。" }; notify() })
  child.once("close", (exitCode, signal) => {
    if (snapshot.status !== "failed") snapshot = {
      status: cancelRequested && signal === "SIGTERM" ? "cancelled" : exitCode === 0 ? "succeeded" : "failed",
      finishedAt: Date.now(), result: { exitCode, signal, output: output.toString("utf8"), truncated },
    }
    notify()
  })
  child.unref()
  const source: TaskSource = {
    async read() { return snapshot },
    subscribe(fn) { changed.add(fn); return () => { changed.delete(fn) } },
    async cancel() {
      if (snapshot.status !== "working") return
      cancelRequested = true
      try {
        if (process.platform === "win32") child.kill("SIGTERM")
        else if (child.pid) process.kill(-child.pid, "SIGTERM")
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    },
  }
  return { executionID: `${randomUUID()}:${child.pid ?? "spawn-error"}`, source }
}
