import { useEffect, useRef, useState, type ReactNode } from 'react'
import { engine } from '../audio/engine'
import { IconChevronDown, IconMetronome, IconMusic, IconVolume, IconWave } from './Icons'
import { t } from '../i18n'

/**
 * 音量控制。
 * 四条独立通道：总 / 音乐 / 音效 / 节拍器，各自写进 localStorage 并即时生效。
 *   总音量   -> master（最后一级，压住所有声音）
 *   音乐音量 -> songBus（歌曲 <audio>）
 *   音效音量 -> sfxBus（hitsound / keysound）
 *   节拍器   -> metroBus
 *
 * 每条通道都有自己的静音键（时间轴工具条上是 4 个图标按钮），
 * 静音只是把对应总线的增益压到 0，音量原值保留。
 *
 * compact（时间轴工具条）：4 个静音键 + 总音量滑杆 + 展开按钮，
 * 展开后是四条完整滑杆；非 compact（侧栏）直接平铺四条。
 */
function pct(v: number) {
  return `${Math.round(v * 100)}`
}

/** 一个通道的静音键（图标按钮，静音时变灰并划一道斜线） */
function MuteBtn({
  icon,
  label,
  muted,
  onClick,
}: {
  icon: ReactNode
  label: string
  muted: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`tl-btn vol-mute${muted ? ' muted' : ''}`}
      title={muted ? t('{label}已静音（点击恢复）', { label }) : t('静音{label}', { label })}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

function Row({
  label,
  value,
  onChange,
  title,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  title?: string
}) {
  return (
    <div className="vol-row" title={title}>
      <span className="vol-label">{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="vol-val mono">{pct(value)}</span>
    </div>
  )
}

export function VolumeRows() {
  return (
    <>
      <Row
        label={t('总音量')}
        value={engine.muted ? 0 : engine.masterVolume}
        onChange={(v) => {
          engine.setMasterVolume(v)
          if (engine.muted && v > 0) engine.setMuted(false)
        }}
        title={t('所有声音的最后一级增益')}
      />
      <Row
        label={t('音乐')}
        value={engine.songVolume}
        onChange={(v) => engine.setSongVolume(v)}
        title={t('歌曲音频（[Files] 里载入的那条）')}
      />
      <Row
        label={t('音效')}
        value={engine.hitsoundVolume}
        onChange={(v) => engine.setHitsoundVolume(v)}
        title={t('hitsound / keysound 样本与合成音')}
      />
      <Row
        label={t('节拍器')}
        value={engine.metronomeVolume}
        onChange={(v) => engine.setMetronomeVolume(v)}
        title={t('节拍器点击声（需先开启节拍器）')}
      />
    </>
  )
}

export default function VolumeControl({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // 音量是引擎里的可变字段，靠引擎广播触发重渲染
  const [, force] = useState(0)
  useEffect(() => engine.subscribe(() => force((f) => f + 1)), [])

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [open])

  if (!compact) {
    return (
      <div className="vol-panel">
        <VolumeRows />
      </div>
    )
  }

  const shown = engine.muted ? 0 : engine.masterVolume
  return (
    <div className="vol-ctl" ref={ref}>
      <MuteBtn
        icon={<IconVolume />}
        label={t('总音量')}
        muted={engine.muted}
        onClick={() => engine.setMuted(!engine.muted)}
      />
      <MuteBtn
        icon={<IconMusic />}
        label={t('音乐')}
        muted={engine.songMuted}
        onClick={() => engine.setSongMuted(!engine.songMuted)}
      />
      <MuteBtn
        icon={<IconWave />}
        label={t('音效')}
        muted={engine.hitsoundMuted}
        onClick={() => engine.setHitsoundMuted(!engine.hitsoundMuted)}
      />
      <MuteBtn
        icon={<IconMetronome />}
        label={t('节拍器')}
        muted={engine.metronomeMuted}
        onClick={() => engine.setMetronomeMuted(!engine.metronomeMuted)}
      />
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={shown}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (engine.muted && v > 0) engine.setMuted(false)
          engine.setMasterVolume(v)
        }}
        style={{ width: 62 }}
        title={t('总音量 {v}%', { v: pct(shown) })}
      />
      <span className="mono vol-ctl-val">{pct(shown)}</span>
      <button
        className={`tl-btn ${open ? 'on' : ''}`}
        title={t('音乐 / 音效 / 节拍器音量')}
        onClick={() => setOpen((o) => !o)}
      >
        {t('音量')}
        <IconChevronDown className="sm" />
      </button>
      {open && (
        <div className="vol-pop">
          <VolumeRows />
        </div>
      )}
    </div>
  )
}
