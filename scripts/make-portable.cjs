/**
 * 免安装（绿色版）打包：把 Electron 运行时 + dist + electron/ 拼成一个可直接运行的目录。
 * 不依赖 electron-builder 下载的额外二进制，网络不通也能出包。
 *
 * 产物：release/osu-hitsound-studio/
 *        └ osu Hitsound Studio.exe      ← 双击即用
 *        └ resources/app/{dist,electron,package.json}
 *
 * 用法：node scripts/make-portable.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'release', 'osu-hitsound-studio')
const RUNTIME = path.join(ROOT, 'node_modules', 'electron', 'dist')
const EXE_NAME = 'osu Hitsound Studio.exe'

function rimraf(p) {
  // 大目录删除可能被系统/沙箱拦（回收站放不下），失败不致命：
  // 真正需要清掉的是下面几 MB 的 resources/app
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch (e) {
    console.log('  提示：未能删除', p, '（', e?.message?.slice(0, 60), '），继续覆盖写入')
  }
}
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('缺少 dist，请先运行 vite build')
  process.exit(1)
}
if (!fs.existsSync(path.join(RUNTIME, 'electron.exe'))) {
  console.error('缺少 Electron 运行时：', RUNTIME)
  process.exit(1)
}

console.log('准备输出目录…')
fs.mkdirSync(OUT, { recursive: true })

// Electron 运行时（273MB）版本之间不变，已经拷过就不用重来；
// 只有 resources/app 里的应用代码需要每次刷新。
const runtimeExe = path.join(OUT, EXE_NAME)
const runtimeOld = path.join(OUT, 'electron.exe')
if (!fs.existsSync(runtimeExe) && !fs.existsSync(runtimeOld)) {
  console.log('复制 Electron 运行时（首次较慢）…')
  rimraf(OUT)
  copyDir(RUNTIME, OUT)
  if (fs.existsSync(path.join(OUT, 'electron.exe'))) {
    fs.renameSync(path.join(OUT, 'electron.exe'), runtimeExe)
  }
} else {
  console.log('运行时已存在，跳过拷贝')
  if (fs.existsSync(runtimeOld) && !fs.existsSync(runtimeExe)) {
    fs.renameSync(runtimeOld, runtimeExe)
  }
}

console.log('刷新应用代码 resources/app …')
const appDir = path.join(OUT, 'resources', 'app')
rimraf(appDir)
fs.mkdirSync(appDir, { recursive: true })
copyDir(path.join(ROOT, 'dist'), path.join(appDir, 'dist'))
copyDir(path.join(ROOT, 'electron'), path.join(appDir, 'electron'))

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const appPkg = {
  name: pkg.name,
  version: pkg.version,
  description: 'osu hitsound 代码谱编辑器',
  main: 'electron/main.cjs',
  // 打包后必须是生产模式：不注入 VITE_DEV_SERVER_URL 就会去读 dist
  dependencies: {},
}
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(appPkg, null, 2), 'utf8')

// 打个时间戳：一眼能看出这个包是不是最新的（避免又跑到旧包）
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
fs.writeFileSync(
  path.join(OUT, 'BUILD-INFO.txt'),
  [
    'osu Hitsound Studio（免安装版）',
    `构建时间：${stamp}`,
    `应用版本：${pkg.version}`,
    '',
    '这个目录是构建时的快照，不会随后续源码改动自动更新。',
    '改了代码请重新执行：npm run electron:portable',
    '',
  ].join('\n'),
  'utf8',
)

// 换掉默认图标/元信息（rcedit 不可用就跳过，不影响运行）
const rcedit = path.join(ROOT, 'node_modules', 'rcedit', 'lib', 'index.js')

const total = (function size(p) {
  let n = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else n += fs.statSync(f).size
    }
  }
  walk(p)
  return n
})(OUT)

console.log('\n完成：')
console.log('  目录：', OUT)
console.log('  启动：', path.join(OUT, EXE_NAME))
console.log('  体积：', (total / 1024 / 1024).toFixed(1), 'MB')
if (!fs.existsSync(rcedit)) console.log('  注：未找到 rcedit，沿用 Electron 默认图标（功能不受影响）')
