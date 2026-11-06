/**
 * 应用设置（应用级偏好，和具体谱面无关）。
 *
 * 分四页：
 *   常规   —— osu! 谱面库 / 音效库的目录
 *   导入   —— 导入 .osu 音效时 12 个组合（soft/normal/drum × 4 种类型）的默认代号与配色
 *   Timing —— 弱起红线阈值、时间轴颜色随音量变化
 *   导出   —— 槽位优先级、导出前清理旧 [EZHS*]
 *
 * 代号每格按优先级填、逗号分隔：`Ka, Kb, Kc` = 第一条用 Ka、第二条用 Kb…
 * 填 `=` 表示这一条默认当白板。每个格子右边是它默认代号的颜色（写进 [Define] 第五段）。
 *
 * 和难度选择器一样用「模块级开关 + 独立订阅」，菜单里调 openAppSettings()。
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import {
  COMBO_HITS,
  COMBO_KEYS,
  COMBO_SETS,
  DEFAULT_COMBO_COLORS,
  DEFAULT_INHERIT_MS,
  comboColor,
  invalidTokens,
  loadComboColors,
  loadComboPrefs,
  loadTimingPrefs,
  normalizePrefLine,
  saveComboColors,
  saveComboPrefs,
  saveTimingPrefs,
  type ComboColors,
  type ComboKey,
  type ComboPrefs,
} from '../core/importPrefs'
import { desktopApi } from '../core/desktop'
import { getSongsFolder, setSongsFolder } from '../core/osuMapsets'
import { getSoundFolder, setSoundFolder } from '../core/soundLibrary'
import { getDisplayPrefs, setDisplayPrefs, type VolumeDisplay } from '../core/displayPrefs'
import { isValidOrder, loadExportPrefs, orderToText, saveExportPrefs, textToOrder } from '../core/exportPrefs'
import {
  CHART_BOOL_KEYS,
  DEFAULT_CHART_DEFAULTS,
  formatIndexList,
  loadChartDefaults,
  parseIndexList,
  saveChartDefaults,
  type ChartBoolKey,
  type ChartDefaults,
} from '../core/chartDefaults'
import { DEFAULT_SLOT_ORDER } from '../core/osuExport'
import { useStore } from '../store'
import { t } from '../i18n'
import {
  currentLang,
  installLangText,
  isBuiltinLang,
  listLangs,
  openLangFolder,
  pickLangFile,
  removeLang,
  setLang,
  type LangPack,
} from '../i18n'

let opened = false
const subs = new Set<() => void>()
function emit() {
  subs.forEach((f) => f())
}

export function openAppSettings() {
  opened = true
  emit()
}

// 自动化调试用：生产构建也挂上，CDP 可以直接打开设置窗
;(window as any).__openAppSettings = openAppSettings

function closeAppSettings() {
  opened = false
  emit()
}

/** [Settings] 里 6 个开关的一句话说明 */
const CHART_BOOL_LABEL: Record<ChartBoolKey, string> = {
  AutoHitsoundIndex: '自动按红/绿线给物件分配音效组编号',
  SliderSlideHitsound: '滑条滑动（sliderslide）也发声',
  SliderTickHitsound: '滑条刻度（slidertick）也发声',
  SpinnerHitsound: '转盘（spinner）也发声',
  DefaultOverride: '允许 [Define] 覆盖游戏内置的默认音效',
  StandardFormat: '按 osu 标准槽位命名（不写 custom）',
}

const HIT_LABEL: Record<string, string> = {
  hitnormal: 'hitnormal',
  hitwhistle: 'hitwhistle',
  hitfinish: 'hitfinish',
  hitclap: 'hitclap',
}

type TabId = 'general' | 'chart' | 'import' | 'timing' | 'export' | 'language'

/** 格子里 `<v=xx>` 的三种显示方式 */
const VOL_MODES: { id: VolumeDisplay; label: string }[] = [
  { id: 'number', label: '显示数字' },
  { id: 'bar', label: '显示音量条' },
  { id: 'none', label: '不显示' },
]

const TABS: { id: TabId; label: string; sub: string }[] = [
  { id: 'general', label: '常规', sub: 'osu! 谱面库与音效库的目录' },
  { id: 'chart', label: '谱面', sub: '新建 / 导入的谱面默认写进 [Settings] 的值' },
  { id: 'import', label: '导入', sub: '导入 .osu 音效时各组合的默认代号与颜色' },
  { id: 'timing', label: 'Timing', sub: '弱起红线阈值、时间轴颜色' },
  { id: 'export', label: '导出', sub: '导出 .osu 时的槽位优先级与清理' },
  { id: 'language', label: '语言', sub: '界面语言与 .lang 语言包' },
]

/** 上次停留的页签：关掉再开会回到原处 */
let lastTab: TabId = 'import'

export default function AppSettingsDialog() {
  const [, force] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<TabId>(lastTab)
  const [prefs, setPrefs] = useState<ComboPrefs>({})
  const [colors, setColors] = useState<ComboColors>({})
  const [inheritMs, setInheritMs] = useState(DEFAULT_INHERIT_MS)
  const [alphaByVol, setAlphaByVol] = useState(true)
  const [volMode, setVolMode] = useState<VolumeDisplay>('bar')
  const [showOsuObjects, setShowOsuObjects] = useState(true)
  const [songsFolder, setSongs] = useState('')
  const [soundFolder, setSoundDir] = useState('')
  const [langMsg, setLangMsg] = useState('')
  const [songsHint, setSongsHint] = useState('')
  const [orderText, setOrderText] = useState('')
  const [cleanOld, setCleanOld] = useState(false)
  const [chartDef, setChartDef] = useState<ChartDefaults>(DEFAULT_CHART_DEFAULTS)
  const [indexText, setIndexText] = useState(formatIndexList(DEFAULT_CHART_DEFAULTS.PreferredIndex))

  useEffect(() => {
    const f = () => force((n) => n + 1)
    subs.add(f)
    return () => {
      subs.delete(f)
    }
  }, [])

  const isOpen = opened
  useEffect(() => {
    if (!isOpen) return
    setPrefs(loadComboPrefs())
    setColors(loadComboColors())
    setInheritMs(loadTimingPrefs().inheritMs)
    const dp = getDisplayPrefs()
    setAlphaByVol(dp.colorAlphaByVol)
    setVolMode(dp.volumeDisplay)
    setShowOsuObjects(dp.showOsuObjects)
    const ep = loadExportPrefs()
    setOrderText(orderToText(ep.slotOrder))
    setCleanOld(ep.cleanOld)
    const cd = loadChartDefaults()
    setChartDef(cd)
    setIndexText(formatIndexList(cd.PreferredIndex))
    box.current?.focus()
    void getSongsFolder().then((p) => {
      setSongs(p)
      setSongsHint(p ? '' : '没能自动探测到 osu!，请手动选择 Songs 文件夹')
    })
    void getSoundFolder().then(setSoundDir)
  }, [isOpen])

  if (!isOpen) return null

  const bad: string[] = []
  if (!(Number(inheritMs) > 0)) bad.push('继承阈值必须是正数（毫秒）')
  for (const k of COMBO_KEYS) {
    const list = invalidTokens(prefs[k] || '')
    if (list.length) bad.push(`${k} 里的 ${list.join(', ')} 不是合法代号（大写字母开头 + 小写字母，或用 = 表示白板）`)
  }
  const order = textToOrder(orderText)
  if (!isValidOrder(order)) bad.push('导出槽位顺序要正好 9 个、互不重复（如 sw, sf, sc, nw, nf, nc, dw, df, dc）')
  const prefIndex = parseIndexList(indexText)
  if (!prefIndex) bad.push('PreferredIndex 只能填数字，用逗号分隔（如 11, 45, 14；留空 = 从 1 开始）')

  const tabBad: Record<TabId, boolean> = {
    general: false,
    chart: !prefIndex,
    import: COMBO_KEYS.some((k) => invalidTokens(prefs[k] || '').length > 0),
    timing: !(Number(inheritMs) > 0),
    export: !isValidOrder(order),
    language: false,
  }

  const set = (k: ComboKey, v: string) => setPrefs((p) => ({ ...p, [k]: v }))
  const setColor = (k: ComboKey, v: string) => setColors((p) => ({ ...p, [k]: v }))

  const go = (id: TabId) => {
    lastTab = id
    setTab(id)
  }

  const save = () => {
    if (bad.length) return
    const clean: ComboPrefs = {}
    for (const k of COMBO_KEYS) {
      const v = normalizePrefLine(prefs[k] || '')
      if (v) clean[k] = v
    }
    saveComboPrefs(clean)
    saveComboColors(colors)
    saveTimingPrefs({ inheritMs: Number(inheritMs) })
    saveExportPrefs({ slotOrder: order, cleanOld })
    saveChartDefaults({ ...chartDef, PreferredIndex: prefIndex || [] })
    setDisplayPrefs({ colorAlphaByVol: alphaByVol, volumeDisplay: volMode, showOsuObjects })
    // 这两项影响画法/排版，让已经挂着的视图立刻按新偏好重画一次
    useStore.getState().bumpUi()
    void setSongsFolder(songsFolder.trim())
    void setSoundFolder(soundFolder.trim())
    closeAppSettings()
  }

  const browseSounds = async () => {
    const api = desktopApi()
    if (!api) return
    const r = await api.openFolder({ title: '选择音效文件夹', defaultPath: soundFolder || undefined })
    if (!r.canceled && r.dir) setSoundDir(r.dir)
  }

  const browseSongs = async () => {
    const api = desktopApi()
    if (!api) {
      setSongsHint('浏览器模式无法选择本地目录')
      return
    }
    const res = await api.openFolder({
      title: '选择 osu! Songs 文件夹',
      defaultPath: songsFolder || undefined,
    })
    if (res.canceled || !res.dir) return
    setSongs(res.dir)
    setSongsHint('')
  }

  const active = TABS.find((t) => t.id === tab) || TABS[0]
  const curLang = currentLang()
  // 每次渲染现取：装/删语言包后 i18n 会 bumpUi，整棵树重渲染，列表自然更新
  const langs: LangPack[] = listLangs()
  const installLang = async () => {
    setLangMsg('')
    try {
      const f = await pickLangFile()
      if (!f) {
        if (!desktopApi()) setLangMsg('浏览器模式请把 .lang 放到本地存储；桌面版可直接选择文件')
        return
      }
      const pack = await installLangText(f.text)
      setLang(pack.id)
      setLangMsg(`已安装 ${pack.name}（${pack.id}）`)
    } catch (e) {
      setLangMsg(`安装失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const dropLang = async (p: LangPack) => {
    const ok = await removeLang(p.id)
    setLangMsg(ok ? `已删除 ${p.name}` : '内置语言包不能删除')
  }

  return (
    <div
      className="osu-diff-overlay"
      onMouseDown={closeAppSettings}
      onKeyDown={(e) => {
        if (e.key === 'Escape') closeAppSettings()
      }}
    >
      <div className="osu-diff set-dialog" tabIndex={-1} ref={box} onMouseDown={(e) => e.stopPropagation()}>
        <div className="osu-diff-head">
          {t('设置')}
          <span className="osu-diff-sub">{t(active.sub)}</span>
        </div>

        <div className="set-tabs" role="tablist">
          {TABS.map((tabDef) => (
            <button
              key={tabDef.id}
              role="tab"
              aria-selected={tabDef.id === tab}
              className={`set-tab${tabDef.id === tab ? ' on' : ''}`}
              onClick={() => go(tabDef.id)}
            >
              {t(tabDef.label)}
              {tabBad[tabDef.id] ? <i className="set-dot" title={t('这一页有需要修正的项')} /> : null}
            </button>
          ))}
        </div>

        <div className="set-body">
          {tab === 'general' ? (
            <>
              <div className="set-section">
                <div className="set-section-title">{t('osu! 谱面库')}</div>
                <div className="row" style={{ marginBottom: 4 }}>
                  <label style={{ width: 116 }}>{t('Songs 文件夹')}</label>
                  <input
                    className="mono"
                    style={{ flex: 1, minWidth: 0, fontSize: 11.5 }}
                    value={songsFolder}
                    placeholder={t('留空则每次自动探测')}
                    spellCheck={false}
                    onChange={(e) => setSongs(e.target.value)}
                  />
                  <button className="btn small" onClick={() => void browseSongs()}>
                    {t('浏览…')}
                  </button>
                </div>
                <div className="hint">
                  {t('左栏第 5 个图标（谱面库）读取这个目录。留空会自动探测（注册表 → osu! 配置 → 常见安装位置）。')}
                  {songsHint ? <span style={{ color: 'var(--warn)' }}> ⚠ {songsHint}</span> : ''}
                </div>
              </div>

              <div className="set-section">
                <div className="set-section-title">{t('音效库')}</div>
                <div className="row" style={{ marginBottom: 4 }}>
                  <label style={{ width: 116 }}>{t('音效文件夹')}</label>
                  <input
                    className="mono"
                    style={{ flex: 1, minWidth: 0, fontSize: 11.5 }}
                    value={soundFolder}
                    placeholder={t('留空则用左栏音效库里的「选择…」')}
                    spellCheck={false}
                    onChange={(e) => setSoundDir(e.target.value)}
                  />
                  <button className="btn small" onClick={() => void browseSounds()}>
                    {t('浏览…')}
                  </button>
                </div>
                <div className="hint">
                  {t('左栏第 6 个图标（音效库）扫描这个目录下的 .wav / .ogg，可以逐个试听并添加到当前谱面的 [Define]。')}
                </div>
              </div>
            </>
          ) : null}

          {tab === 'chart' ? (
            <>
              <div className="set-section">
                {/* 这个类名会把标题转大写，所以标题只写中文 */}
                <div className="set-section-title">{t('新谱面的默认值')}</div>
                <div className="hint" style={{ marginBottom: 8 }}>
                  {t('这些值会写进')}<b>{t('新建')}</b>{t('和')}<b>{t('从 .osu 导入')}</b>{t('的谱面；已经存在的谱面不受影响，要改某一份谱直接在文本里改它的 [Settings]。')}
                </div>
                {CHART_BOOL_KEYS.map((k) => (
                  <label className="set-check" key={k}>
                    <input
                      type="checkbox"
                      checked={chartDef[k]}
                      onChange={(e) => setChartDef((p) => ({ ...p, [k]: e.target.checked }))}
                    />
                    <span className="mono" style={{ minWidth: 148 }}>
                      {k}
                    </span>
                    <span className="hint">{t(CHART_BOOL_LABEL[k])}</span>
                  </label>
                ))}
              </div>

              <div className="set-section">
                <div className="row" style={{ marginBottom: 4 }}>
                  <label style={{ width: 116 }}>PreferredIndex</label>
                  <input
                    className={`mono ${prefIndex ? '' : 'is-bad'}`}
                    style={{ flex: 1, minWidth: 0, fontSize: 11.5, borderColor: prefIndex ? undefined : 'var(--danger)' }}
                    value={indexText}
                    placeholder="11, 45, 14"
                    spellCheck={false}
                    onChange={(e) => setIndexText(e.target.value)}
                    onBlur={() => {
                      const v = parseIndexList(indexText)
                      setIndexText(formatIndexList(v || chartDef.PreferredIndex))
                    }}
                  />
                  <button
                    className="btn small"
                    onClick={() => setIndexText(formatIndexList(DEFAULT_CHART_DEFAULTS.PreferredIndex))}
                  >
                    {t('恢复默认')}
                  </button>
                </div>
                <div className="hint">
                  {t('导出 .osu 时音效组编号的分配顺序：')} <span className="mono">11, 45, 14</span> {t('表示先用 11、45、14，再补 1、2、3…；留空 = 从 1 开始。写进谱面时是')}
                  <span className="mono">{formatIndexList(prefIndex || [])}</span>{t('。')}
                </div>
              </div>
            </>
          ) : null}

          {tab === 'import' ? (
            <>
              <div className="si-tip">
                {t('每个格子按')}<b>{t('优先级')}</b>{t('填，逗号分隔：')} <span className="mono">Ka, Kb, Kc</span>{' '}
                {t('表示第一条用 Ka、第二条用 Kb、第三条用 Kc（同一组合因为编号/音色不同可能有多个）。填')} <span className="mono">=</span> {t('表示这一条默认当')}<b>{t('白板')}</b>{t('。留空则自动 Aa、Ab…')}
              </div>

              <div className="set-grid">
                <div className="set-corner" />
                {COMBO_HITS.map((h) => (
                  <div key={h} className="set-col">
                    {HIT_LABEL[h]}
                  </div>
                ))}
                {COMBO_SETS.map((s) => (
                  <Fragment key={s}>
                    <div className="set-row">{s}</div>
                    {COMBO_HITS.map((h) => {
                      const k = `${s}-${h}` as ComboKey
                      const isBad = invalidTokens(prefs[k] || '').length > 0
                      const c = comboColor(k, colors)
                      return (
                        <div className="set-cell" key={k}>
                          <input
                            className={`set-input mono ${isBad ? 'is-bad' : ''}`}
                            value={prefs[k] || ''}
                            placeholder="Aa, Ab, …"
                            spellCheck={false}
                            onChange={(e) => set(k, e.target.value)}
                            onBlur={(e) => set(k, normalizePrefLine(e.target.value))}
                          />
                          <label
                            className="set-color"
                            style={{ ['--cc' as string]: c }}
                            title={`这个槽位默认代号的颜色：${c}（导入时写进 [Define]）`}
                          >
                            <input type="color" value={c} onChange={(e) => setColor(k, e.target.value)} />
                          </label>
                        </div>
                      )
                    })}
                  </Fragment>
                ))}
              </div>

              <div className="set-section">
                <div className="row" style={{ marginBottom: 4 }}>
                  <span className="hint" style={{ flex: 1 }}>
                    颜色写进 [Define] 的第五段（<span className="mono">hitsound soft-hitclap Aa = &quot;x.wav&quot; #4cc2ff</span>
                    ），时间轴和格子按它上色；同一槽位里的第二个代号会自动做深浅变化。
                  </span>
                  <button
                    className="btn small"
                    onClick={() =>
                      setColors(
                        Object.fromEntries(COMBO_KEYS.map((k) => [k, DEFAULT_COMBO_COLORS[k]])) as ComboColors,
                      )
                    }
                  >
                    {t('恢复默认')}
                  </button>
                </div>
                <div className="hint">不填代号、让它自动生成时，也同样用这里的颜色。</div>
              </div>
            </>
          ) : null}

          {tab === 'timing' ? (
            <>
              <div className="set-section">
                <div className="set-section-title">{t('Timing · 弱起与继承')}</div>
                <div className="row" style={{ marginBottom: 4 }}>
                  <label style={{ width: 116 }}>{t('继承阈值')}</label>
                  <input
                    className="mono"
                    type="number"
                    min={500}
                    step={100}
                    style={{ width: 110 }}
                    value={inheritMs}
                    onChange={(e) => setInheritMs(Number(e.target.value))}
                  />
                  <span className="hint">ms</span>
                </div>
                <div className="hint">
                  一条红线到下一次 BPM 变更超过这个时长 → 在这条红线处开新小节（不继承拍数）；
                  短于此值的段（弱起、过渡）才接着上一小节数拍。默认 4000ms。
                </div>
              </div>

              <div className="set-section">
                <div className="set-section-title">{t('时间轴')}</div>
                <label className="set-check">
                  <input type="checkbox" checked={alphaByVol} onChange={(e) => setAlphaByVol(e.target.checked)} />
                  <span>{t('音效颜色的不透明度随音量变化')}</span>
                </label>
                <label className="set-check">
                  <input
                    type="checkbox"
                    checked={showOsuObjects}
                    onChange={(e) => setShowOsuObjects(e.target.checked)}
                  />
                  <span>{t('显示 [Files] ImportOsu 的物件时间轴')}</span>
                </label>
                <div className="hint" style={{ margin: '0 0 8px' }}>
                  开启后，网格每行格子下方多一条物件轨道（circle / slider / spinner），行距相应加高 22px；
                  没写 <span className="mono">ImportOsu</span> 时不占地方。关掉只隐藏轨道、不改格子高度。
                </div>
                <div className="row" style={{ margin: '2px 0 6px' }}>
                  <label style={{ width: 96 }}>{t('格子里音量')}</label>
                  <div className="set-seg">
                    {VOL_MODES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={volMode === m.id ? 'on' : ''}
                        onClick={() => setVolMode(m.id)}
                      >
                        {m.id === 'bar' ? <i className="set-seg-bar" /> : null}
                        {t(m.label)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="hint">
                  只标在正文里真的写了 <span className="mono">&lt;v=58&gt;</span> 的位置（包括空格子）。
                  <br />
                  <b>显示数字</b>：左边缝隙显示 <span className="mono">58</span>，2~3 位数字要占地方，间距加宽到 18px。
                  <br />
                  <b>显示音量条</b>：同一位置画一根小竖条，下面浅绿 = 当前音量、上面深绿 = 还差的
                  （<span className="mono">&lt;v=70&gt;</span> 就是下 70% 浅绿 + 上 30% 深绿），间距保持 4px。
                  <br />
                  <b>不显示</b>：什么都不画。
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                  勾上：音量 100 → <span className="mono">FF</span>、音量 0 → <span className="mono">37</span>
                  （55/255），中间线性；取消则一律不透明。没写颜色的默认色同样适用。
                  [Define] 里可以给每条音效配色：<span className="mono">hitsound custom Aa = &quot;x.wav&quot; red</span>
                  {' '}或 <span className="mono">#FF0000</span>。
                </div>
              </div>
            </>
          ) : null}

          {tab === 'export' ? (
            <div className="set-section">
              <div className="set-section-title">{t('导出音效')}</div>
              <div className="row" style={{ marginBottom: 4 }}>
                <label style={{ width: 116 }}>{t('槽位优先级')}</label>
                <input
                  className="mono"
                  style={{ flex: 1, minWidth: 0, fontSize: 11.5 }}
                  value={orderText}
                  placeholder={DEFAULT_SLOT_ORDER.join(', ')}
                  spellCheck={false}
                  onChange={(e) => setOrderText(e.target.value)}
                  onBlur={() => setOrderText(orderToText(textToOrder(orderText)))}
                />
                <button className="btn small" onClick={() => setOrderText(orderToText(DEFAULT_SLOT_ORDER))}>
                  恢复默认
                </button>
              </div>
              <div className="hint">
                导出 .osu 时，代号只写了 <span className="mono">hitwhistle</span> /
                <span className="mono">hitclap</span> / <span className="mono">custom</span>（没定 s/n/d）就按这个顺序挑槽位。
                缩写：s/n/d = soft/normal/drum，w/f/c = whistle/finish/clap；也可以直接写
                <span className="mono">soft-hitwhistle</span>。
              </div>
              <label className="set-check">
                <input type="checkbox" checked={cleanOld} onChange={(e) => setCleanOld(e.target.checked)} />
                <span>{t('导出前删掉本谱之前生成的 [EZHS]、[EZHS1]… .osu')}</span>
              </label>
              <div className="hint">
                只删文件名匹配 <span className="mono">&lt;artist&gt; - &lt;title&gt; (&lt;creator&gt;) [[EZHS*]].osu</span>{' '}
                的文件，别的谱和音效文件不动；如果这次导出因为音效同名冲突被拦下，旧文件也不会先被删。
              </div>
            </div>
          ) : null}

          {tab === 'language' ? (
            <>
              <div className="set-section">
                <div className="set-section-title">{t('界面语言 / Language')}</div>
                <div className="row" style={{ marginBottom: 4 }}>
                  <label style={{ width: 116 }}>{t('语言')}</label>
                  <select
                    style={{ flex: 1, minWidth: 0 }}
                    value={curLang.id}
                    onChange={(e) => setLang(e.target.value)}
                  >
                    {langs.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.id})
                      </option>
                    ))}
                  </select>
                  <button className="btn small" onClick={() => void installLang()}>
                    {t('安装 .lang…')}
                  </button>
                  <button className="btn small" onClick={() => void openLangFolder()}>
                    {t('打开文件夹')}
                  </button>
                </div>
                <div className="hint">
                  {t('切换后立即生效。内置简体中文 / English；其他语言可以安装')} <span className="mono">.lang</span> {t('语言包，放进语言文件夹或直接选文件都行（第三方语言包只影响界面文本，原生菜单只有中/英）。')}
                </div>
                {langMsg ? <div className="hint">{langMsg}</div> : null}
              </div>

              <div className="set-section">
                <div className="set-section-title">{t('已安装语言包')}</div>
                {langs.map((p) => (
                  <div className="row" key={p.id} style={{ marginBottom: 4 }}>
                    <span className="mono" style={{ width: 70 }}>
                      {p.id}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {p.name}
                      {p.author ? <span className="hint"> · {p.author}</span> : null}
                      {p.messages ? <span className="hint"> · {Object.keys(p.messages).length} {t('条')}</span> : null}
                    </span>
                    {isBuiltinLang(p.id) ? (
                      <span className="hint">{t('内置')}</span>
                    ) : (
                      <button className="btn small" onClick={() => void dropLang(p)}>
                        {t('删除')}
                      </button>
                    )}
                  </div>
                ))}
                <div className="hint" style={{ marginTop: 6 }}>
                  <span className="mono">.lang</span> {t('就是 JSON：')}
                  <span className="mono">{'{"id":"xx-XX","name":"…","messages":{"保存":"Save"}}'}</span>
                  <br />
                  {t('键是界面里的中文原文（msgid）；没翻到的词条会自动显示中文，所以语言包可以慢慢补。')}
                </div>
              </div>
            </>
          ) : null}
        </div>

        <div className="osu-diff-foot">
          <span className={`osu-diff-hint ${bad.length ? 'si-err' : ''}`}>
            {bad.length ? `⚠ ${bad[0]}` : t('Esc 或点击空白处 = 取消')}
          </span>
          <div className="si-actions">
            <button className="osu-diff-cancel" onClick={closeAppSettings}>
              {t('取消')}
            </button>
            <button className="si-ok" disabled={bad.length > 0} onClick={save}>
              {t('保存')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
