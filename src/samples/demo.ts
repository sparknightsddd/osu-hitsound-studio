export const DEMO = `[Metadata]
Title = Hiiro no Bara
TitleUnicode = 緋色の薔薇
Artist = Shimotsuki Haruka
ArtistUnicode = 霜月はるか
Creator = foo bar
Source = 明日方舟
Tags = foo bar
BeatmapID = 114514
BeatmapSetID = 1919810

[Files]
## path 是后面所有相对路径的基准目录，audio 是相对 path 的音频文件
path = "E:\\osu\\Songs\\foobar"
audio = "audio.mp3"

[Settings]
Mode = default                  ## 游戏模式：default / taiko / mania
Key = {D, F, J, K}              ## mania 键位代号
AutoHitsoundIndex = true        ## 自动音效组编号
SliderSlideHitsound = false     ## 滑条身音效
SliderTickHitsound = false      ## 滑条点音效
SpinnerHitsound = false         ## 转盘尾音效
DefaultOverride = false         ## 默认音效覆写
StandardFormat = false          ## 标准格式（开启后只能用 W F C Ws Fs Cs Wfcs Dwfcs）
PreferredIndex = {11, 45, 14}   ## 优先音效组编号
TimingAdsorb = beat(0,1,2)      ## 时间轴吸附，默认 1/2 拍
Bookmarks = {114514, 1919810}   ## 书签（毫秒），正文里用 #bookmark(0) 引用

[Define]
## 定义音效：hitsound <槽位> [名称] = <路径或 default.xxx>
hitsound custom D = default.normal-hitnormal
hitsound custom K = "D:\\Music\\Kick.wav"
hitsound custom J = "hs/Juju.wav"
hitsound soft-hitclap Wx = "Wax.wav"
hitsound drum-hitwhistle{11,45,14} Wy = "Way.wav"
hitsound normal-hitfinish|soft-hitfinish{(1,5),(11,15)} Ni = "finish.ogg"
hitsound sliderside = default.blank

## 定义乐句，@后面只能是字母和数字
@Fill = /K (K K) (K K K) (K K K K)/
@Backbeat = /D - K -/

## keysound（有音高的音效）：每个音高一个 wav，模板里用 <loop()> 列音名、<int()> 算八度
## 下面这行会按 A0.wav … C8.wav 展开 88 个音高；第二个写法是音色库文件（.sf2/.sf3）
keysound custom piano = ("piano/<loop("A","L","B","C","H","D","I","E","F","J","G","K")><int((i+9)/12)>.wav", A0, C8)
keysound custom guitar = "guitar.sf2"      ## 音色库模式（暂不支持解码，会用内置合成音试听）

[Timing]
## 时间轴(ms), 每拍毫秒数(可用 bpm(135)), 每小节拍数, 重置模式, 重置拍数, 偏移
839,bpm(174),4,0,0

[Keysound]
## 第一行用花括号指定各谱表使用的乐器
{piano}
## 音符是音名代号：C H D I E F J G K A L B（H I J K L 是黑键）
## 数字在空格/斜杠后表示绝对八度；^ 上移、_ 下移相对八度
/4C D E F/
/^G _C/
#02:03.456
/4A/

[Hitsound]
## 每行以 / 开头，两个 / 之间是一个小节
/D D K (D D) (D D) (D D) K -/
/@Backbeat/ D D K K/
//K*16/
/[@Fill] [@Fill]/
/*3/
/<v=70> D D D K/
/(D K)*4/
/ 5 D - K - Wx/

## "#" 开头是段落标记，后面的内容从该时间点继续
#02:03.456
## /5/ 等价于 /////：把下一小节的内容摊在 5 个小节里
/5/ D - K -/
`

export const TEMPLATE = `[Metadata]
Title =
TitleUnicode =
Artist =
ArtistUnicode =
Creator =
Source =
Tags =
BeatmapID = 0
BeatmapSetID = -1

[Files]
path = ""
audio = ""

[Settings]
Mode = default
Key = {D, F, J, K}
AutoHitsoundIndex = true
SliderSlideHitsound = false
SliderTickHitsound = false
SpinnerHitsound = false
DefaultOverride = false
StandardFormat = false
PreferredIndex = {11, 45, 14}
TimingAdsorb = beat(0,1,2)
Bookmarks = {}

[Define]
hitsound custom D = default.normal-hitnormal

[Timing]
0,bpm(120),4,0,0

[Keysound]
## 第一行用花括号指定乐器，乐器需要先用 keysound 定义，例如：
## keysound custom piano = ("piano/<loop("A","L","B","C")><int((i+9)/12)>.wav", A0, C8)
## {piano}
## /4C D E F/

[Hitsound]
## # 开头是段落标记：#123456 / #2:03.456 / #bookmark(0) / #timing(0)
/D D K K/
`
