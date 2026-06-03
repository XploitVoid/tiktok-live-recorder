import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react'

const th: Record<string, string> = {
  liveGrid: 'ดูไลฟ์หลายจอ',
  localTag: 'ใช้งานบนเครื่อง · ไม่เป็นทางการ',
  usernameLabel: 'ชื่อผู้ใช้ TikTok',
  btnCheck: 'ตรวจสอบ',
  hintText: '💡 พิมพ์ชื่อผู้ใช้แล้วกด Enter ได้เลย',
  recordTitle: 'อัดวิดีโอ',
  qualityLabel: 'คุณภาพ:',
  btnStartRec: 'เริ่มอัด',
  watchlistSub: '(อัดอัตโนมัติเมื่อเริ่มไลฟ์)',
  pollEvery: 'ตรวจทุก',
  secLabel: 'วินาที',
  btnSave: 'บันทึก',
  btnPollNow: 'ตรวจตอนนี้',
  btnNotif: 'เปิดแจ้งเตือน',
  qAuto: 'อัตโนมัติ (คุณภาพสูงสุด)',
  autoRecord: 'อัดอัตโนมัติ',
  btnAdd: 'เพิ่ม',
  emptyList: '— ยังไม่มีรายการ —',
  recentEvents: 'กิจกรรมล่าสุด',
  noneYet: '— ยังไม่มี —',
  activeJobs: 'งานที่กำลังทำ / ล่าสุด',
  btnRefresh: 'โหลดใหม่',
  noJobs: '— ยังไม่มีงาน —',
  savedRec: 'วิดีโอที่อัดไว้',
  btnReplay: '▶ เล่นซ้ำ',
  btnDownload: 'ดาวน์โหลด',
  autoRec: 'อัดอัตโนมัติ',
  chatStart: 'เริ่ม',
  chatStop: 'หยุด',
  autoScroll: 'เลื่อนตาม',
  previewTitle: 'ดูตัวอย่าง',
  streamUrlsTitle: 'ลิงก์สตรีม',
  colsLabel: 'คอลัมน์',
  muteAll: 'ปิดเสียงทั้งหมด',
  btnBack: 'กลับ',
  gridWarning: '⚠ เปิดหลายสตรีมพร้อมกันจะใช้ CPU และอินเทอร์เน็ตมาก',
  noOneLive: 'ยังไม่มีใครในรายการเฝ้าดูที่กำลังไลฟ์อยู่ตอนนี้',
  noTitle: '(ไม่มีชื่อ)',
  loading: '— กำลังโหลด —',
  footerText: 'โหลดใหม่อัตโนมัติทุก 60 วินาที · จัดการรายการเฝ้าดูได้ที่หน้าหลัก',
  chatSync: 'แชท (ตามเวลาจริง)',
  fAll: 'ทั้งหมด',
  fChat: 'เฉพาะแชท',
  fGift: 'ของขวัญ',
  fLike: 'กดถูกใจ',
  fMember: 'เข้าร่วม/ติดตาม',
  btnJump: '↓ ไปที่ล่าสุด',
  noStreamsTitle: 'ไม่พบลิงก์สตรีม',
  noStreamsDesc: 'TikTok ไม่ได้ส่งลิงก์สตรีมกลับมาสำหรับ',
  noStreamsFix: 'วิธีแก้: ตั้งค่า TIKTOK_SESSIONID เป็นค่า cookie sessionid จากบัญชี TikTok ที่ล็อกอินอยู่',
  chatRecHint: 'เมื่อเริ่มอัดวิดีโอ ระบบจะบันทึกแชทให้อัตโนมัติ',
  favorites: 'รายการโปรด',
  recentSearch: 'ค้นหาล่าสุด',
  clearHistory: 'ลบประวัติ',
  accTitle: 'บัญชี TikTok',
  accAnonymous: 'ไม่ล็อกอิน',
  accAdd: 'เพิ่มบัญชี',
  accLabel: 'ชื่อบัญชี',
  btnCancel: 'ยกเลิก',
  chatHighlight: 'คำที่เน้น',
  chatFilterPlaceholder: 'พิมพ์คำที่ต้องการเน้น...',
  pip: 'หน้าต่างลอย',
  stealthLabel: 'Stealth Mode',
  stealthOn: 'เปิด Stealth — ดูแบบไม่ระบุตัวตน',
  stealthOff: 'ปิด Stealth — ใช้บัญชีปกติ',
  stealthOnDesc: 'กำลังดูแบบซ่อนตัว ไม่มีใครรู้',
  stealthOffDesc: 'เปิดเพื่อดูโดยไม่เปิดเผยตัวตน',
  // ── Highlights ──
  highlights: 'ไฮไลต์',
  highlightsTab: '⭐ ไฮไลต์',
  hlNone: 'ยังไม่พบไฮไลต์',
  hlNoEvents: 'ไม่มีข้อมูลแชทของไฟล์นี้ — สร้างไฮไลต์ไม่ได้',
  hlAnalyzing: 'กำลังวิเคราะห์...',
  hlReanalyze: 'วิเคราะห์ใหม่',
  hlGenerate: '✂ ตัดคลิป',
  hlGenerating: 'กำลังตัด...',
  hlJump: 'ข้ามไป',
  hlClipsTitle: 'คลิปที่ตัดไว้',
  hlReasonGift: 'พีคของขวัญ',
  hlReasonChat: 'แชทพุ่ง',
  hlReasonActivity: 'กิจกรรมพุ่ง',
  hlScoreLabel: 'คะแนน',
  hlBaselineLabel: 'พื้นฐาน',
  hlChats: 'แชท',
  hlGifts: 'ของขวัญ',
  hlDiamonds: 'เพชร',
  hlLikes: 'ไลก์',
  hlFollows: 'ติดตาม',
  hlClipBadge: 'คลิป',
  hlAuto: 'วิเคราะห์อัตโนมัติเมื่ออัดเสร็จ',
  hlFallbackBadge: 'จุดที่คึกคักที่สุด',
  hlFallbackHint: 'ไม่พบ spike ชัดเจน — กำลังแสดงช่วงที่มีกิจกรรมมากที่สุด',
  hlReasonPK: 'PK / ดวล',
  hlPKOpponents: 'คู่ดวล',
  hlPKDuration: 'รวม',
  // ── Leaderboard ──
  lbTitle: 'ผู้สนับสนุนยอดเยี่ยม',
  lbOverall: 'รวม',
  lbGifters: 'ของขวัญ',
  lbChatters: 'แชท',
  lbLikers: 'ไลก์',
  lbFollowers: 'ติดตาม',
  lbEmpty: 'ไม่มีข้อมูลสำหรับไฟล์นี้',
  lbNoEvents: 'ไม่มีไฟล์แชท — ดูผู้สนับสนุนไม่ได้',
  lbTotals: 'สรุปไลฟ์',
  lbUniqueUsers: 'คนที่เข้าร่วม',
  lbDiamonds: 'เพชรรวม',
  lbChatsTotal: 'แชทรวม',
  lbLikesTotal: 'ไลก์รวม',
  lbGiftsTotal: 'ของขวัญรวม',
  lbTopGifts: 'ของขวัญยอดนิยม',
  lbScore: 'คะแนน',
  // ── Gift Economy ──
  geTitle: 'สถิติของขวัญ',
  geGifts: 'ของขวัญ',
  geChat: 'แชท',
  geTotalDiamonds: 'เพชรรวม',
  geAvgPerMin: '💎/นาที',
  gePeak: 'พีค',
  geTotalGifts: 'ของขวัญรวม',
  geGiftHeatmap: 'เพชร/ช่วงเวลา',
  geChatHeatmap: 'แชท/ช่วงเวลา',
  geBreakdown: 'แยกตามชนิด',
  geClickToJump: 'คลิกเพื่อข้ามไปจุดนั้น',
  // ── Word Cloud ──
  wcTitle: 'คำที่พูดถึงบ่อย',
  wcMessages: 'ข้อความ',
  wcWord: 'คำ',
  wcCount: 'จำนวน',
  wcEmpty: 'ไม่มีข้อมูลเพียงพอ',
  // ── Spam Filter ──
  spamHide: 'ซ่อนสแปม',
  spamShow: 'แสดงทั้งหมด',
  spamCount: 'สแปม',
  // ── Bookmarks ──
  bmTitle: 'บุ๊กมาร์ก',
  bmAdd: 'เพิ่ม',
  bmAdded: 'เพิ่มบุ๊กมาร์กแล้ว',
  bmNotePlaceholder: 'โน้ต (ไม่บังคับ)...',
  // ── Dashboard ──
  dashLink: 'แดชบอร์ด',
  dashTitle: 'แดชบอร์ดรวม',
  dashStreams: 'สตรีมที่ติดตาม',
  dashViewers: 'ผู้ชมรวม',
  dashDiamonds: 'เพชรล่าสุด',
  dashEvents: 'อีเวนต์รวม',
  dashUnifiedChat: 'แชทรวมทุกสตรีม',
  dashNoChat: 'ยังไม่มีแชท — เริ่มจับแชทจากหน้าหลักก่อน',
  dashEmpty: 'ยังไม่มีสตรีมที่กำลังติดตามอยู่',
  dashEmptyHint: 'เริ่มจับแชทจากหน้าหลัก หรือเพิ่มคนเข้า Watchlist',
  dashHealthWarning: 'การเชื่อมต่อไม่เสถียร',
  dashHealth: 'สถานะการเชื่อมต่อ',
  dashHealthy: 'ปกติ',
  dashUnstable: 'ไม่เสถียร',
  dashStale: 'ไม่ตอบสนอง',
}

const en: Record<string, string> = {
  liveGrid: 'Live Grid',
  localTag: 'local · unofficial',
  usernameLabel: 'TikTok username',
  btnCheck: 'Check',
  hintText: 'Tip: change username and press Enter',
  recordTitle: 'Record',
  qualityLabel: 'Quality:',
  btnStartRec: 'Start Recording',
  watchlistSub: '(auto-record when live)',
  pollEvery: 'Poll every',
  secLabel: 'sec',
  btnSave: 'Save',
  btnPollNow: 'Poll now',
  btnNotif: 'Enable notifs',
  qAuto: 'auto (highest)',
  autoRecord: 'auto-record',
  btnAdd: 'Add',
  emptyList: '— empty —',
  recentEvents: 'Recent events',
  noneYet: '— none yet —',
  activeJobs: 'Active / Recent jobs',
  btnRefresh: 'Refresh',
  noJobs: '— no jobs yet —',
  savedRec: 'Saved recordings',
  btnReplay: '▶ Replay',
  btnDownload: 'Download',
  autoRec: 'auto-rec',
  chatStart: 'Start',
  chatStop: 'Stop',
  autoScroll: 'auto-scroll',
  previewTitle: 'Preview',
  streamUrlsTitle: 'Stream URLs',
  colsLabel: 'COLS',
  muteAll: 'mute all',
  btnBack: 'back',
  gridWarning: '⚠ Multiple streams use CPU & bandwidth',
  noOneLive: 'No one in your watchlist is live right now',
  noTitle: '(no title)',
  loading: '— loading —',
  footerText: 'Auto-refresh every 60 seconds · manage watchlist on home page',
  chatSync: 'Chat (sync)',
  fAll: 'all',
  fChat: 'chat only',
  fGift: 'gifts',
  fLike: 'likes',
  fMember: 'joins/follows',
  btnJump: '↓ jump to live time',
  noStreamsTitle: 'No stream URLs found',
  noStreamsDesc: 'TikTok did not return stream URLs for',
  noStreamsFix: 'Fix: set TIKTOK_SESSIONID to your TikTok cookie sessionid value',
  chatRecHint: 'Chat events will be recorded automatically alongside the video',
  favorites: 'Favorites',
  recentSearch: 'Recent',
  clearHistory: 'Clear history',
  accTitle: 'TikTok Accounts',
  accAnonymous: 'Anonymous',
  accAdd: 'Add account',
  accLabel: 'Account name',
  btnCancel: 'Cancel',
  chatHighlight: 'Highlights',
  chatFilterPlaceholder: 'Type word to highlight...',
  pip: 'PiP',
  stealthLabel: 'Stealth Mode',
  stealthOn: 'Stealth ON — watching anonymously',
  stealthOff: 'Stealth OFF — using account',
  stealthOnDesc: 'Watching invisibly, no one can see you',
  stealthOffDesc: 'Enable to watch without revealing identity',
  // ── Highlights ──
  highlights: 'Highlights',
  highlightsTab: '⭐ Highlights',
  hlNone: 'No highlights detected',
  hlNoEvents: 'No chat data for this recording — cannot detect highlights',
  hlAnalyzing: 'Analyzing...',
  hlReanalyze: 'Re-analyze',
  hlGenerate: '✂ Cut clip',
  hlGenerating: 'Cutting...',
  hlJump: 'Jump',
  hlClipsTitle: 'Generated clips',
  hlReasonGift: 'Gift spike',
  hlReasonChat: 'Chat spike',
  hlReasonActivity: 'Activity spike',
  hlScoreLabel: 'score',
  hlBaselineLabel: 'baseline',
  hlChats: 'chats',
  hlGifts: 'gifts',
  hlDiamonds: 'diamonds',
  hlLikes: 'likes',
  hlFollows: 'follows',
  hlClipBadge: 'clip',
  hlAuto: 'auto-analyzed when recording finishes',
  hlFallbackBadge: 'Top moments',
  hlFallbackHint: 'No clear spikes — showing busiest moments',
  hlReasonPK: 'PK battle',
  hlPKOpponents: 'vs',
  hlPKDuration: 'duration',
  // ── Leaderboard ──
  lbTitle: 'Top Supporters',
  lbOverall: 'Overall',
  lbGifters: 'Gifters',
  lbChatters: 'Chatters',
  lbLikers: 'Likers',
  lbFollowers: 'Followers',
  lbEmpty: 'No data for this recording',
  lbNoEvents: 'No chat data — leaderboard unavailable',
  lbTotals: 'Stream stats',
  lbUniqueUsers: 'unique users',
  lbDiamonds: 'total diamonds',
  lbChatsTotal: 'total chats',
  lbLikesTotal: 'total likes',
  lbGiftsTotal: 'total gifts',
  lbTopGifts: 'Top gifts',
  lbScore: 'score',
  // ── Gift Economy ──
  geTitle: 'Gift Economy',
  geGifts: 'Gifts',
  geChat: 'Chat',
  geTotalDiamonds: 'total diamonds',
  geAvgPerMin: '💎/min',
  gePeak: 'peak',
  geTotalGifts: 'total gifts',
  geGiftHeatmap: 'diamonds over time',
  geChatHeatmap: 'chat over time',
  geBreakdown: 'by type',
  geClickToJump: 'Click to jump',
  // ── Word Cloud ──
  wcTitle: 'Trending Words',
  wcMessages: 'messages',
  wcWord: 'Word',
  wcCount: 'Count',
  wcEmpty: 'Not enough data',
  // ── Spam Filter ──
  spamHide: 'Hide spam',
  spamShow: 'Show all',
  spamCount: 'spam',
  // ── Bookmarks ──
  bmTitle: 'Bookmarks',
  bmAdd: 'Add',
  bmAdded: 'Bookmark added',
  bmNotePlaceholder: 'Note (optional)...',
  // ── Dashboard ──
  dashLink: 'Dashboard',
  dashTitle: 'Multi-stream Dashboard',
  dashStreams: 'streams tracked',
  dashViewers: 'total viewers',
  dashDiamonds: 'recent diamonds',
  dashEvents: 'total events',
  dashUnifiedChat: 'Unified chat feed',
  dashNoChat: 'No chat yet — start capturing from the home page',
  dashEmpty: 'No streams being tracked right now',
  dashEmptyHint: 'Start chat capture from the home page or add users to Watchlist',
  dashHealthWarning: 'Connection issues detected',
  dashHealth: 'Stream Health',
  dashHealthy: 'Healthy',
  dashUnstable: 'Unstable',
  dashStale: 'No response',
}

const LANGS: Record<string, Record<string, string>> = { th, en }

// Add new languages here. The dropdown in Header reads from this list.
export const SUPPORTED_LANGS = [
  { code: 'th', label: 'TH', name: 'ไทย', flag: '🇹🇭' },
  { code: 'en', label: 'EN', name: 'English', flag: '🇬🇧' },
] as const

export type LangCode = typeof SUPPORTED_LANGS[number]['code']

type I18nContextType = {
  lang: LangCode
  t: (key: string) => string
  setLang: (code: LangCode) => void
  /** Cycles to the next language in SUPPORTED_LANGS. Kept for backward compat
   *  with components that called toggle() against the old TH↔EN switcher. */
  toggle: () => void
}

const I18nContext = createContext<I18nContextType>({
  lang: 'en',
  t: (k) => k,
  setLang: () => {},
  toggle: () => {},
})

function isSupported(code: string): code is LangCode {
  return SUPPORTED_LANGS.some((l) => l.code === code)
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<LangCode>(() => {
    const stored = localStorage.getItem('tiktok_lang') || ''
    if (isSupported(stored)) return stored
    // Default to browser language if it matches a supported one.
    const browser = (navigator.language || '').toLowerCase().slice(0, 2)
    if (isSupported(browser)) return browser
    return 'en'
  })

  const setLang = useCallback((code: LangCode) => {
    localStorage.setItem('tiktok_lang', code)
    setLangState(code)
  }, [])

  const t = useCallback(
    (key: string) => (LANGS[lang] || LANGS.en)[key] || LANGS.en[key] || key,
    [lang],
  )

  const toggle = useCallback(() => {
    setLangState((prev) => {
      const idx = SUPPORTED_LANGS.findIndex((l) => l.code === prev)
      const next = SUPPORTED_LANGS[(idx + 1) % SUPPORTED_LANGS.length].code
      localStorage.setItem('tiktok_lang', next)
      return next
    })
  }, [])

  return (
    <I18nContext.Provider value={useMemo(() => ({ lang, t, setLang, toggle }), [lang, t, setLang, toggle])}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  return useContext(I18nContext)
}
