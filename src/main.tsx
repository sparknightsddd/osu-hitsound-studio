import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { initSettingsFile, watchSettingsFile } from './core/settingsFile'

function render() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

/**
 * 先把 settings.cfg 读进来（主题/语言/显示偏好会在首帧之前落位，避免闪一下），
 * 没有这个文件就按当前设置生成一份。读文件失败也不阻塞启动。
 */
initSettingsFile()
  .then((r) => {
    if (r.errors.length) console.warn('[settings.cfg]', r.errors.join('\n'))
    // 主题 / 语言不在设置窗口的「保存」按钮里，单独订阅一下
    watchSettingsFile()
  })
  .catch((e) => console.warn('[settings.cfg] 读取失败', e))
  .finally(render)
