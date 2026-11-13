/**
 * settings.cfg 的格式测试：序列化 / 解析 / 部分应用 / 手改容错。
 *
 * 不碰真实磁盘：applySettingsText 只写各个偏好模块（localStorage 用内存桩）。
 */
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  },
}

// 这些模块会在 import 时读 localStorage，所以用动态 import（上面的桩先装好）
const { parseSettingsFile, serializeSettings, applySettingsText, initSettingsFile } = await import('../src/core/settingsFile')
const { loadComboPrefs, loadComboColors } = await import('../src/core/importPrefs')
const { loadChartDefaults } = await import('../src/core/chartDefaults')
const { getDisplayPrefs } = await import('../src/core/displayPrefs')
const { loadExportPrefs } = await import('../src/core/exportPrefs')
const { useStore } = await import('../src/store')
type SettingsValues = import('../src/core/settingsFile').SettingsValues

let pass = 0
let fail = 0
function T(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

const sample: SettingsValues = {
  songsFolder: 'E:/osu/Songs',
  soundFolder: 'D:/samples',
  theme: 'dark',
  lang: 'zh-CN',
  importCodes: {
    'soft-hitnormal': 'Ka, Kb',
    'drum-hitclap': '=',
    'normal-hitwhistle': 'Xy',
  },
  importColors: {
    'soft-hitnormal': '#4cc2ff',
    'drum-hitclap': '#ff9d6b',
  },
  inheritMs: 4000,
  colorAlphaByVol: false,
  volumeDisplay: 'number',
  showOsuObjects: true,
  slotOrder: ['soft-hitwhistle', 'soft-hitfinish', 'soft-hitclap', 'normal-hitwhistle', 'normal-hitfinish', 'normal-hitclap', 'drum-hitwhistle', 'drum-hitfinish', 'drum-hitclap'],
  cleanOld: true,
  chart: {
    AutoHitsoundIndex: true,
    SliderSlideHitsound: true,
    SliderTickHitsound: false,
    SpinnerHitsound: true,
    DefaultOverride: false,
    StandardFormat: true,
    PreferredIndex: [11, 45, 14],
  },
}

const text = serializeSettings(sample)

// 1) 结构
{
  T('文件头有说明', text.startsWith('#'), text.slice(0, 24))
  for (const sec of ['[General]', '[Appearance]', '[Language]', '[Import]', '[ImportColors]', '[Timing]', '[Export]', '[Chart]']) {
    T(`包含 ${sec} 段`, text.includes(sec))
  }
  T('12 个组合的代号都有行', ['soft-hitnormal', 'normal-hitfinish', 'drum-hitclap'].every((k) => text.includes(k)))
  T('颜色带引号（# 不会被当注释）', text.includes('"#4cc2ff"'))
  T('槽位顺序写成一行', text.includes('"soft-hitwhistle, soft-hitfinish'))
}

// 2) 解析回来
{
  const p = parseSettingsFile(text)
  T('解析没有错误', p.errors.length === 0, p.errors.join(' | '))
  T('SongsFolder 去掉引号', p.sections.get('general')?.get('songsfolder') === 'E:/osu/Songs')
  T('Theme 正确', p.sections.get('appearance')?.get('theme') === 'dark')
  T('代号里的逗号原样保留', p.sections.get('import')?.get('soft-hitnormal') === 'Ka, Kb')
  T('空代号是空串', p.sections.get('import')?.get('soft-hitclap') === '')
  T('布尔写成 true/false', p.sections.get('timing')?.get('coloralphabyvol') === 'false')
}

// 3) 手改容错
{
  const hand = [
    '; 这是注释',
    '# 也是注释',
    'Theme = "light"   # 行尾注释',
    '[Import]',
    'soft-hitnormal = Aa, Ab',
    'drum-hitclap = # 清空这一项',
    '[Timing]',
    'InheritMs = 2500',
    'VolumeDisplay = none ; 分号注释',
    '[Chart]',
    'PreferredIndex = {11, 22}',
    '不认识的键 = 随便',
    '乱七八糟没有等号',
  ].join('\r\n')
  const p = parseSettingsFile(hand)
  T('没有段名的键落到 [general]', p.sections.get('general')?.get('theme') === 'light')
  T('行尾 # 注释被去掉', p.sections.get('general')?.get('theme') === 'light')
  T('值里的 #（前面是空格）当注释', p.sections.get('import')?.get('drum-hitclap') === '')
  T('分号注释被去掉', p.sections.get('timing')?.get('volumedisplay') === 'none')
  {
    const c = parseSettingsFile('[ImportColors]\nsoft-hitnormal = #4CC2FF\ndrum-hitclap = #ff9d6b   # 橙色')
    T('没加引号的颜色也能读', c.sections.get('importcolors')?.get('soft-hitnormal') === '#4CC2FF', JSON.stringify([...c.sections]))
    T('颜色后面的行尾注释照常去掉', c.sections.get('importcolors')?.get('drum-hitclap') === '#ff9d6b')
  }
  T('CRLF 也能解析', p.sections.get('timing')?.get('inheritms') === '2500')
  T('非法行只报一条错误', p.errors.length === 1, p.errors.join(' | '))
}

// 4) 应用（部分字段）
{
  store.clear()
  const r = await applySettingsText(
    ['[Timing]', 'InheritMs = 2500', 'VolumeDisplay = none', '[Import]', 'soft-hitnormal = Aa, Ab', ''].join('\n'),
  )
  T('应用没有报错', r.errors.length === 0, r.errors.join(' | '))
  const dp = getDisplayPrefs()
  T('VolumeDisplay 生效', dp.volumeDisplay === 'none', dp.volumeDisplay)
  T('没写的 ColorAlphaByVol 保持默认', dp.colorAlphaByVol === true, String(dp.colorAlphaByVol))
  T('代号写回 import prefs', loadComboPrefs()['soft-hitnormal'] === 'Aa, Ab', JSON.stringify(loadComboPrefs()))
  T('其它组合没被清空', Object.keys(loadComboPrefs()).length === 1)
}

// 5) 非法值 → 报错且不覆盖
{
  store.clear()
  const before = loadChartDefaults().AutoHitsoundIndex
  const r = await applySettingsText(
    [
      '[Appearance]',
      'Theme = purple',
      '[Timing]',
      'InheritMs = -5',
      '[Export]',
      'SlotOrder = sw, sw',
      '[Chart]',
      'AutoHitsoundIndex = 也许',
      'PreferredIndex = 11, x',
      '',
    ].join('\n'),
  )
  T('非法 Theme 报错', r.errors.some((e) => e.includes('Theme')), r.errors.join(' | '))
  T('非法 InheritMs 报错', r.errors.some((e) => e.includes('InheritMs')))
  T('非法 SlotOrder 报错', r.errors.some((e) => e.includes('SlotOrder')))
  T('非法布尔报错', r.errors.some((e) => e.includes('AutoHitsoundIndex')))
  T('非法 PreferredIndex 报错', r.errors.some((e) => e.includes('PreferredIndex')))
  T('非法值不改变现有设置', loadChartDefaults().AutoHitsoundIndex === before)
  T('主题没被改成 purple', useStore.getState().theme !== ('purple' as any))
}

// 6) 完整往返：先应用 sample，再序列化，结果应一致
{
  store.clear()
  useStore.getState().setTheme('dark')
  // 去掉 [Language] 段：node 下 i18n 会静态 import .lang，tsx 不认识这个扩展名。
  // 应用逻辑本身对语言失败是「记一条 error、其余照常」，浏览器/Electron 里不会走到这条。
  const noLang = text.replace(/\[Language\][\s\S]*?(?=\n\[)/, '')
  T('测试用文本里已经没有 [Language]', !noLang.includes('[Language]'))
  const r = await applySettingsText(noLang)
  T('完整文件应用无错误', r.errors.length === 0, r.errors.join(' | '))
  T('Theme 应用', useStore.getState().theme === 'dark')
  T('彩色应用', loadComboColors()['soft-hitnormal'] === '#4cc2ff', JSON.stringify(loadComboColors()))
  T('槽位顺序应用', loadExportPrefs().slotOrder[0] === 'soft-hitwhistle')
  T('CleanOld 应用', loadExportPrefs().cleanOld === true)
  T('PreferredIndex 应用', loadChartDefaults().PreferredIndex.join(',') === '11,45,14')
  const again = serializeSettings({
    ...sample,
    importCodes: loadComboPrefs(),
    importColors: loadComboColors(),
    chart: loadChartDefaults(),
    slotOrder: loadExportPrefs().slotOrder,
    cleanOld: loadExportPrefs().cleanOld,
    theme: useStore.getState().theme,
    lang: sample.lang,
  })
  T('二次序列化和第一次一致', again === text, '（差异见文件）')
  if (again !== text) {
    const a = text.split('\n')
    const b = again.split('\n')
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.log('    第一处差异 @', i + 1, '\n      A:', a[i], '\n      B:', b[i])
        break
      }
    }
  }
}

// 7) 打包时放的「只有注释」空壳 → 首次启动补全成完整配置
{
  store.clear()
  store.set('hsstudio.settingsCfgText', '# =====\n#  说明性注释\n# =====\n')
  const r = await initSettingsFile()
  const written = store.get('hsstudio.settingsCfgText') || ''
  T('只有注释的文件被当成首次运行', r.missing === true)
  T('补全后带 [General]', written.includes('[General]'))
  T('补全后带 [Chart] 与 PreferredIndex', written.includes('[Chart]') && written.includes('PreferredIndex'))
  T('补全后文件头是 settings.cfg', written.includes('osu Hitsound Studio · settings.cfg'))
}

console.log(`\n${fail ? `${fail} 项失败` : '全部通过'}（${pass} 项）`)
process.exit(fail ? 1 : 0)
