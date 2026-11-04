declare module 'claude-code' {
  interface PluginState {
    yunpiangao: {
      /** 仅抑制热重载后的旧原生通知；不恢复执行 handle 或等待。 */
      ownedTasks: { sessionID: string; ids: string[] }
    }
  }
}
