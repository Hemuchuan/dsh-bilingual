/**
 * 把 dsh-bilingual 以本地 link 方式装进 DSH 的某个 profile。
 *
 * 用法：
 *   node install.mjs --profile desktop
 *
 * 做三件事（写 package.json 前先备份）：
 *   1. dependencies["dsh-bilingual"] = "link:<本目录>"
 *   2. dsh.profile.bundles 加入 "dsh-bilingual"
 *   3. profiles/<profile>/node_modules/dsh-bilingual → 本目录（junction / symlink）
 *
 * 不做：不启动/重启 DSH，不跑 pnpm install。装完请手动重启 DSH。
 */

import { copyFileSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-bilingual'
const source = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const profileArg = args.indexOf('--profile')
const profile = profileArg !== -1 ? args[profileArg + 1] : process.env.DSH_PROFILE || 'desktop'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.join(home, 'profiles', profile)
const packagePath = path.join(profileDir, 'package.json')
const modulesDir = path.join(profileDir, 'node_modules')
const linkPath = path.join(modulesDir, PACKAGE)

let packageStat = null
try {
  packageStat = lstatSync(packagePath)
} catch {
  packageStat = null
}
if (packageStat === null) {
  console.error(`找不到 profile 的 package.json：${packagePath}`)
  console.error('请确认 DSH 已初始化，或用 --profile 指定正确的 profile。')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(packagePath, 'utf8').replace(/^\uFEFF/, ''))
manifest.dependencies = manifest.dependencies || {}
manifest.dependencies[PACKAGE] = `link:${source.replace(/\\/g, '/')}`

manifest.dsh = manifest.dsh || {}
manifest.dsh.profile = manifest.dsh.profile || {}
manifest.dsh.profile.bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
if (!manifest.dsh.profile.bundles.includes(PACKAGE)) manifest.dsh.profile.bundles.push(PACKAGE)

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
copyFileSync(packagePath, `${packagePath}.bak-bilingual-${stamp}`)
writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

mkdirSync(modulesDir, { recursive: true })

let linkState = 'created'
let existing = null
try {
  existing = lstatSync(linkPath)
} catch {
  existing = null
}

if (existing !== null) {
  if (existing.isSymbolicLink()) {
    const target = path.resolve(modulesDir, readlinkSync(linkPath))
    if (target === path.resolve(source)) {
      linkState = 'already linked'
    } else {
      console.error(`${linkPath} 已存在，指向 ${target}，不是本目录；请先手动删除它。`)
      process.exit(1)
    }
  } else {
    console.error(`${linkPath} 已存在且不是链接；请先手动删除它。`)
    process.exit(1)
  }
} else {
  symlinkSync(source, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

console.log(`profile : ${profileDir}`)
console.log(`package : ${packagePath}（已备份）`)
console.log(`link    : ${linkPath}（${linkState}）`)
console.log('')
console.log('安装完成。请完全退出并重新打开 DSH，然后打开 设置 → 双语 填 Key。')
