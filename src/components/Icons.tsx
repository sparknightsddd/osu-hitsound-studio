interface P {
  className?: string
}
const s = (c?: string) => `i ${c || ''}`

export const IconFiles = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M4 4h6l2 2h8v14H4z" />
    <path d="M4 9h16" />
  </svg>
)
export const IconSearch = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.5-4.5" />
  </svg>
)
export const IconAudio = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M4 9v6h3l5 4V5L7 9H4z" />
    <path d="M16 8.5a5 5 0 010 7" />
    <path d="M18.5 6a8 8 0 010 12" />
  </svg>
)
export const IconWave = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M3 12h2l2-6 2.5 12L12 6l2 10 2.5-8 1.5 4h3" />
  </svg>
)
export const IconSettings = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2m0 14v2M4.5 7.5l1.7 1M17.8 15.5l1.7 1M4.5 16.5l1.7-1M17.8 8.5l1.7-1M3 12h2m14 0h2" />
  </svg>
)
export const IconPlay = ({ className }: P) => (
  <svg className={`${s(className)} fill`} viewBox="0 0 24 24">
    <path d="M8 5l11 7-11 7z" />
  </svg>
)
export const IconPause = ({ className }: P) => (
  <svg className={`${s(className)} fill`} viewBox="0 0 24 24">
    <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
  </svg>
)
export const IconStop = ({ className }: P) => (
  <svg className={`${s(className)} fill`} viewBox="0 0 24 24">
    <rect x="6" y="6" width="12" height="12" rx="1" />
  </svg>
)
export const IconClose = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)
export const IconPlus = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M12 5v14M5 12h14" />
  </svg>
)
export const IconTrash = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </svg>
)
export const IconDownload = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" />
  </svg>
)
export const IconUpload = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M12 19V8m0 0l-4 4m4-4l4 4M5 5h14" />
  </svg>
)
export const IconError = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v6M12 16.5v.5" />
  </svg>
)
export const IconWarn = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4M12 17v.5" />
  </svg>
)
export const IconInfo = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v6M12 7.5v.5" />
  </svg>
)
export const IconRefresh = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M20 12a8 8 0 10-2.5 5.8" />
    <path d="M20 5v5h-5" />
  </svg>
)
export const IconPencil = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M4 20h4l10-10-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  </svg>
)
export const IconTimeline = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M3 6h18M3 12h18M3 18h18" />
    <circle cx="8" cy="6" r="1.6" />
    <circle cx="15" cy="12" r="1.6" />
    <circle cx="10" cy="18" r="1.6" />
  </svg>
)
export const IconLogo = () => (
  <svg viewBox="0 0 24 24" className="i" style={{ width: 18, height: 18 }}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" fill="none" />
    <circle cx="12" cy="12" r="3.2" fill="currentColor" />
    <circle cx="12" cy="6.2" r="1.4" fill="currentColor" />
  </svg>
)
export const IconChevronDown = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M6 9l6 6 6-6" />
  </svg>
)
export const IconChevronUp = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M6 15l6-6 6 6" />
  </svg>
)
export const IconMetronome = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M9 3h6l4 16H5z" />
    <path d="M12 19V8" />
  </svg>
)
/** 谱面库：一叠唱片/谱面（左栏第 5 个图标） */
export const IconMapset = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="2.6" />
    <path d="M12 3.5v2.2M12 18.3v2.2" />
  </svg>
)
/** 格子视图：2×2 圆角方块 */
export const IconGrid = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
  </svg>
)
/** 音效库：文件夹 + 波形条（左栏第 6 个图标） */
export const IconSound = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M3 7.5h5l2 2h11v9.5H3z" />
    <path d="M8.2 15.5v-2.4M11.2 15.5v-4.6M14.2 15.5v-3.4M17.2 15.5v-5" />
  </svg>
)
export const IconFolder = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M3 7h6l2 2h10v10H3z" />
  </svg>
)
/** 喇叭：n>0 时画 n 条声波，0 表示静音（画叉） */
export const IconVolume = ({ className, muted }: P & { muted?: boolean }) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M4 9h3l5-4v14l-5-4H4z" />
    {muted ? (
      <path d="M16 9l5 6M21 9l-5 6" />
    ) : (
      <>
        <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
        <path d="M18 7a7.5 7.5 0 0 1 0 10" />
      </>
    )}
  </svg>
)
/** 音符：音乐通道（时间轴的四条静音键之一） */
export const IconMusic = ({ className }: P) => (
  <svg className={s(className)} viewBox="0 0 24 24">
    <path d="M9 17V5l9-2v12" />
    <circle cx="6.5" cy="17" r="2.5" />
    <circle cx="15.5" cy="15" r="2.5" />
  </svg>
)
