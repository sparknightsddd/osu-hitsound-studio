/**
 * 开发模式启动器：先确保 Vite dev server 在跑，再拉起 Electron 连上去。
 * 这样不依赖 concurrently / cross-env 之类的额外包。
 *
 * 两种情况都处理：
 *   5173 已经有 vite -> 直接复用（不重复起，避免端口漂移到 5174 导致连错服务）
 *   没有            -> 自己起一个，并等端口就绪
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const net = require('node:net')
const http = require('node:http')

const ROOT = path.join(__dirname, '..')
const HOST = '127.0.0.1'
const PORT = 5173
const URL = `http://${HOST}:${PORT}`
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))

/** 这个端口上是不是我们的 vite（返回 index.html 才算） */
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/', timeout: 1200 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve(res.statusCode === 200 && /<div id="root">/.test(body)))
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

function waitPort(port, host, timeoutMs = 60000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, host)
      sock.once('connect', () => {
        sock.destroy()
        resolve()
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() - start > timeoutMs) reject(new Error('Vite dev server 启动超时'))
        else setTimeout(tryOnce, 400)
      })
    }
    tryOnce()
  })
}

async function main() {
  let vite = null

  if (await probe(PORT)) {
    console.log(`[electron-dev] 复用已在运行的 Vite（${URL}）`)
  } else {
    console.log('[electron-dev] 启动 Vite…')
    vite = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['--no-install', 'vite', '--host', HOST, '--port', String(PORT), '--strictPort'],
      { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' },
    )
    try {
      await waitPort(PORT, HOST)
    } catch (e) {
      console.error('[electron-dev]', e.message)
      vite.kill()
      process.exit(1)
    }
  }

  console.log('[electron-dev] 启动 Electron（改动会自动热更新）…')
  // 允许透传参数给 electron，例如 --remote-debugging-port=9366
  // 容器/无显示器环境额外要的开关：HSS_ELECTRON_ARGS="--no-sandbox"
  const envArgs = (process.env.HSS_ELECTRON_ARGS || '').split(/\s+/).filter(Boolean)
  const passthrough = [...envArgs, ...process.argv.slice(2)]
  launch(passthrough, false)

  /**
   * 有些环境（无显示器的远程/虚拟机、部分老显卡驱动）会让 GPU 进程起不来，
   * Electron 会直接 FATAL 退出。碰到这种情况自动加软件渲染参数重试一次。
   */
  function launch(extraArgs, isRetry) {
    // ELECTRON_RUN_AS_NODE=1 会让 electron 退化成纯 node，必须去掉
    const env = { ...process.env, VITE_DEV_SERVER_URL: URL }
    delete env.ELECTRON_RUN_AS_NODE
    // 两路输出都走管道（GPU 崩溃信息有时打 stdout、有时打 stderr），再手动转发给终端
    const child = spawn(electronBin, ['.', ...extraArgs], {
      cwd: ROOT,
      stdio: ['inherit', 'pipe', 'pipe'],
      env,
    })

    let retried = isRetry
    let out = ''
    const tap = (stream, sink) => {
      if (!stream) return
      stream.on('data', (d) => {
        out += d.toString()
        sink.write(d)
      })
    }
    tap(child.stdout, process.stdout)
    tap(child.stderr, process.stderr)

    child.on('exit', (code) => {
      // 退出时 stdout 的数据事件可能还没派发完，等一下再判断是不是 GPU 崩的
      setTimeout(() => {
        if (!retried && /GPU process isn't usable|GPU process exited unexpectedly/.test(out)) {
          retried = true
          console.log('[electron-dev] GPU 初始化失败，改用软件渲染重试…')
          launch([...passthrough, '--disable-gpu', '--disable-software-rasterizer'], true)
          return
        }
        if (vite) vite.kill()
        process.exit(code == null ? 0 : code)
      }, 500)
    })
  }
}

main()