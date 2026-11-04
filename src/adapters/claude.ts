import { fileURLToPath } from 'node:url'
import { query, type Query, type Options as ClaudeOptions, type Settings, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Options } from '../scheduler.js'

/** 构建后的正式 Mods 目录；可传给 Claude Code 的 --plugin-dir。 */
export const claudeModPath = fileURLToPath(new URL('../claude-mod/', import.meta.url))

export type ClaudeQuery = Omit<Query, 'close'> & { close(): Promise<void> }

export type ClaudeQueryOptions = Omit<ClaudeOptions, 'settings'> & { settings?: Settings }

/**
 * 保留原生 Query 与 streaming input 生命周期，加载固定 2.1.317 Mods。
 * 调用方必须持续消费消息并保持输入流存活；close 先 interrupt 再关闭进程，
 * 并发调用共用一个 Promise。退出时还须等待消费循环结束。
 * 字符串 prompt 采用宿主单轮生命周期，不承诺回答后的后台接续。
 */
export function createClaudeQuery(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeQueryOptions }, scheduling: Options = {}) {
  for (const [key, fallback, minimum] of [['thresholdTokens', 100000, 1], ['idleDelayMs', 1500, 0]] as const) {
    const value = scheduling[key] ?? fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw new TypeError(`${key} 的数值无效。`)
  }
  if (scheduling.strategy === 'direct') throw new Error('Claude Mods 入口只支持提前准备并复核提交。')
  const options = params.options ?? {}
  const settings = options.settings ?? {}
  const config = settings.pluginConfigs ?? {}
  const plugin = config['yunpiangao@inline'] ?? {}
  let closing: Promise<void> | undefined
  const originalPrompt = params.prompt
  const prompt = typeof originalPrompt === 'string' ? originalPrompt : (async function* () {
    for await (const message of originalPrompt) { if (closing) return; yield message }
  })()
  const session = query({ prompt, options: {
    ...options,
    plugins: [...(options.plugins ?? []), { type: 'local', path: claudeModPath }],
    settings: { ...settings, pluginConfigs: { ...config, 'yunpiangao@inline': {
      ...plugin, options: { ...(typeof plugin.options === 'object' && plugin.options !== null ? plugin.options : {}), thresholdTokens: scheduling.thresholdTokens ?? 100000, idleDelayMs: scheduling.idleDelayMs ?? 1500 },
    } } },
  } })
  const nativeClose = session.close.bind(session)
  const close = () => {
    if (closing) return closing
    let finish!: () => void
    closing = new Promise<void>(resolve => { finish = resolve })
    // interrupt 终止当前工具派发；仅 SIGTERM 的收尾窗口不足以阻止迟到创建回执。
    void session.interrupt().catch(() => {}).finally(() => { nativeClose(); finish() })
    return closing
  }
  const streamInput = session.streamInput.bind(session)
  session.streamInput = stream => {
    if (closing) return Promise.reject(new Error('Claude 适配实例已关闭，请创建新实例。'))
    return streamInput(stream)
  }
  session.close = close
  return session as ClaudeQuery
}
