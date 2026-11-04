// Python 入口随 TypeScript 构建产物打包；缓存文件不进入公开归档。
import { copyFileSync, mkdirSync, readdirSync } from "node:fs"

const source = new URL("../src/adapters/hermes/yunpiangao_hermes/", import.meta.url)
const target = new URL("../dist/adapters/hermes/yunpiangao_hermes/", import.meta.url)
mkdirSync(target, { recursive: true })
for (const name of readdirSync(source)) {
  if (name.endsWith(".py")) copyFileSync(new URL(name, source), new URL(name, target))
}
