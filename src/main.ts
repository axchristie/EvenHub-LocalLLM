import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

// --- Settings schema ----------------------------------------------------------
interface MenuOptionConfig {
  enabled:   boolean
  key:       string
  label:     string
  model:     string
  multiTurn: boolean
  saveChat:  boolean
}

interface AppConfig {
  chatEndpoint:        string
  chatsEndpoint:       string
  sttEndpoint:         string
  apiKey:              string
  routerModel:         string
  manualStop:          boolean
  silenceMultiplier:   number
  silenceDuration:     number
  minSpeechChunks:     number
  calibrationChunks:   number
  options:             MenuOptionConfig[]
}

const STORAGE_KEY = 'app_config_v2'

const DEFAULT_SILENCE_MULTIPLIER = 4.0
const DEFAULT_SILENCE_DURATION   = 20
const DEFAULT_MIN_SPEECH_CHUNKS  = 3
const DEFAULT_CALIBRATION_CHUNKS = 10
const MIN_CHUNKS                 = 10
const MAX_CONTENT_CHARS          = 1900   // textContainerUpgrade limit is 2000
const PAGE_CHARS                 = MAX_CONTENT_CHARS  // each response page stays under that limit

// Layout - 576x288 canvas
const CONTENT_HEIGHT = 220
const GAP            = 4
const PILL_Y         = CONTENT_HEIGHT + GAP
const PILL_HEIGHT    = 60
// -----------------------------------------------------------------------------

type Message  = { role: 'user' | 'assistant'; content: string }
type AppState =
  | 'unconfigured'
  | 'menu_listening' | 'menu_processing'
  | 'query_listening' | 'query_processing'
  | 'response'

let cfg: AppConfig | null = null
let menuOptions: Record<string, MenuOptionConfig> = {}

let state: AppState = 'unconfigured'
let activeOption: MenuOptionConfig | null = null
let conversationHistory: Message[] = []

// Pagination for long replies. The content container scrolls natively up to
// the ~2000-char textContainerUpgrade limit; replies longer than one page are
// split here and walked with scroll gestures. Empty array === single-screen
// behavior (menu/labels/errors), so non-response screens are unaffected.
let responsePages: string[] = []
let currentPage   = 0

const pcmChunks: Uint8Array[] = []
let silentChunkCount  = 0
let speechChunkCount  = 0
let speechDetected    = false

let ambientRmsBaseline: number | null = null
let ambientRmsSumTemp   = 0
let ambientRmsCountTemp = 0

// Processing animation handle
let pillAnimationTimer: ReturnType<typeof setInterval> | null = null

// -- Bridge init ---------------------------------------------------------------

const bridge = await waitForEvenAppBridge()

await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [
      new TextContainerProperty({
        xPosition:     0,
        yPosition:     0,
        width:         576,
        height:        CONTENT_HEIGHT,
        borderWidth:   0,
        borderColor:   0,
        borderRadius:  0,
        paddingLength: 6,
        containerID:   1,
        containerName: 'content',
        content:       'Loading...',
        isEventCapture: 1,
      }),
      new TextContainerProperty({
        xPosition:     8,
        yPosition:     PILL_Y,
        width:         560,
        height:        PILL_HEIGHT,
        borderWidth:   2,
        borderColor:   12,
        borderRadius:  10,
        paddingLength: 6,
        containerID:   2,
        containerName: 'hud',
        content:       '',
        isEventCapture: 0,
      }),
    ],
  }),
)

// -- Helpers ------------------------------------------------------------------

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

function rms(chunk: Uint8Array): number {
  const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2)
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

function buildWav(chunks: Uint8Array[]): Blob {
  const pcm = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.byteLength }
  const dataSize      = pcm.byteLength
  const sampleRate    = 16000
  const numChannels   = 1
  const bitsPerSample = 16
  const byteRate      = sampleRate * numChannels * bitsPerSample / 8
  const blockAlign    = numChannels * bitsPerSample / 8
  const header        = new ArrayBuffer(44)
  const view          = new DataView(header)
  const write = (o: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)))
  write(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); write(8, 'WAVE')
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true); write(36, 'data'); view.setUint32(40, dataSize, true)
  return new Blob([header, pcm], { type: 'audio/wav' })
}

// Sanitize model output for the G2 display. The firmware font supports a
// limited character set; unsupported typographic codepoints (fractions,
// en/em dashes, curly quotes, math symbols, emoji) can cause
// textContainerUpgrade to silently fail, leaving stale content on screen.
// Reasoning models like nemotron are especially prone to emitting these,
// particularly in formatted content such as recipes. We normalize the
// common offenders to ASCII equivalents and strip anything else outside
// a safe range. (Note: the pill HUD glyphs we use deliberately — ■ ▶ ● ▲ —
// are known-good, so we do not strip the geometric-shapes block.)
function sanitizeForDisplay(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")        // curly/low single quotes
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')        // curly/low double quotes
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-') // hyphens, en/em dashes
    .replace(/\u2026/g, '...')                            // ellipsis
    .replace(/\u00BD/g, '1/2')                            // 1/2
    .replace(/\u00BC/g, '1/4')                            // 1/4
    .replace(/\u00BE/g, '3/4')                            // 3/4
    .replace(/\u2153/g, '1/3').replace(/\u2154/g, '2/3')  // thirds
    .replace(/[\u2150-\u215F\u2189]/g, '')               // any other fraction glyphs
    .replace(/\u00D7/g, 'x')                              // multiplication sign
    .replace(/\u00F7/g, '/')                              // division sign
    .replace(/\u2248/g, '~').replace(/\u2245/g, '~')      // approximately
    .replace(/[\u2260\u2264\u2265]/g, m =>               // != <= >=
      m === '\u2260' ? '!=' : m === '\u2264' ? '<=' : '>=')
    .replace(/\u00B0/g, ' deg')                           // degree sign
    .replace(/[\u00A0\u2007\u202F]/g, ' ')               // non-breaking / figure spaces
    .replace(/[\u2022\u00B7\u2219]/g, '-')               // bullets -> dash
    .replace(/\u2122/g, '(TM)').replace(/\u00AE/g, '(R)').replace(/\u00A9/g, '(C)')
    .replace(/\u20AC/g, 'EUR').replace(/\u00A3/g, 'GBP').replace(/\u00A5/g, 'JPY')
    // Fold common accented Latin letters to their base form so words like
    // "cafe", "jalapeno", "puree" degrade gracefully rather than losing
    // letters entirely in the allowlist sweep below.
    .replace(/[\u00C0-\u00C5]/g, 'A').replace(/[\u00E0-\u00E5]/g, 'a')
    .replace(/[\u00C8-\u00CB]/g, 'E').replace(/[\u00E8-\u00EB]/g, 'e')
    .replace(/[\u00CC-\u00CF]/g, 'I').replace(/[\u00EC-\u00EF]/g, 'i')
    .replace(/[\u00D2-\u00D6]/g, 'O').replace(/[\u00F2-\u00F6]/g, 'o')
    .replace(/[\u00D9-\u00DC]/g, 'U').replace(/[\u00F9-\u00FC]/g, 'u')
    .replace(/\u00D1/g, 'N').replace(/\u00F1/g, 'n')
    .replace(/\u00C7/g, 'C').replace(/\u00E7/g, 'c')
    .replace(/\u00DD/g, 'Y').replace(/[\u00FD\u00FF]/g, 'y')
    .replace(/\u00DF/g, 'ss')
    // Strip emoji / pictographs / dingbats (but NOT the box-drawing /
    // block-elements / geometric-shapes span U+2500-U+25FF, preserved below)
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u2600-\u26FF\u2700-\u27BF]/g, '')
    // Drop remaining control characters except newline (U+000A) and tab
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    // Allowlist catch-all: keep tab, newline, printable ASCII, and the
    // Box Drawing + Block Elements + Geometric Shapes span (U+2500-U+25FF).
    // These render correctly on the G2 firmware (confirmed in use): the
    // pill glyphs (\u25A0 \u25B6 \u25CF \u25B2), divider lines (\u2500),
    // and progress-bar blocks (\u2588 full, \u2591 light shade) used by
    // dashboard-style pipeline output all live here. Anything else still
    // present after the targeted normalizations above — CJK, exotic
    // symbols, emoji, unanticipated model output — is dropped so it can
    // never silently break the display.
    .replace(/[^\x09\x0A\x20-\x7E\u2500-\u25FF]/g, '')
}

// Split already-sanitized text into pages no longer than `maxChars`. Breaks on
// the last newline within the window, else the last space, else a hard cut for
// a single oversized token; leading whitespace is trimmed off each subsequent
// page. Text that already fits returns as a single page, so short replies are
// unchanged. Pure (no SDK) and unit-testable.
function paginate(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const pages: string[] = []
  let rest = text
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars)
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf(' ', maxChars) // avoid tiny pages
    if (cut <= 0) cut = maxChars                                     // no break point -> hard cut
    pages.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest.length) pages.push(rest)
  return pages
}

// Raw content write — assumes the caller already sanitized and length-bounded
// the text (response pages do; they are paginated post-sanitize at <= PAGE_CHARS).
async function pushContent(text: string): Promise<void> {
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: 1, containerName: 'content', content: text }),
  )
}

async function setContent(text: string): Promise<void> {
  const clean = sanitizeForDisplay(text)
  const display = clean.length <= MAX_CONTENT_CHARS
    ? clean
    : clean.slice(0, MAX_CONTENT_CHARS) + '...'
  await pushContent(display)
}

async function setHud(text: string): Promise<void> {
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: 2, containerName: 'hud', content: text }),
  )
}

function listeningHud(): string {
  return cfg?.manualStop ? '■ Listening  ● Stop' : '■ Listening'
}

function resetPagination(): void {
  responsePages = []
  currentPage   = 0
}

// HUD line for the response screen. Single-page replies keep the exact strings
// the app used before (no regression). Multi-page replies gain a `p/n` counter
// plus the contextual scroll affordance. ▲ ▼ ● glyphs live in the firmware's
// known-good Geometric Shapes range (see sanitizeForDisplay).
function responseHud(i: number, n: number): string {
  if (n <= 1) {
    return activeOption?.multiTurn
      ? '● Tap · ▲ Scroll up · ●● Exit'
      : '● Tap · ●● Exit'
  }
  const pos = `${i + 1}/${n}`
  if (i < n - 1 && i > 0) return `${pos}  ▲▼ Pages · ●● Exit`
  if (i < n - 1)          return `${pos}  ▼ More · ●● Exit`
  return `${pos}  ▲ Back · ● Tap · ●● Exit`   // last page
}

// Paginate a reply and show the first page. Pagination is display-only — the
// full reply still lives in conversationHistory and is what saveChat persists.
async function showResponse(text: string): Promise<void> {
  responsePages = paginate(sanitizeForDisplay(text), PAGE_CHARS)
  currentPage   = 0
  await renderResponsePage()
}

async function renderResponsePage(): Promise<void> {
  await pushContent(responsePages[currentPage] ?? '')
  await setHud(responseHud(currentPage, responsePages.length))
}

// Item 3: Processing animation. Fixed-width frames keep "Processing"
// anchored while only the trailing markers change — no horizontal jitter.
const PILL_FRAMES = [
  'Processing ▶  ',
  'Processing ▶▶ ',
  'Processing ▶▶▶',
]
function startPillAnimation(): void {
  stopPillAnimation()
  let i = 0
  // Show first frame immediately, then cycle
  void setHud(PILL_FRAMES[0])
  pillAnimationTimer = setInterval(() => {
    i = (i + 1) % PILL_FRAMES.length
    void setHud(PILL_FRAMES[i])
  }, 400)
}
function stopPillAnimation(): void {
  if (pillAnimationTimer !== null) {
    clearInterval(pillAnimationTimer)
    pillAnimationTimer = null
  }
}

// Item 2: Friendly error mapping. Raw error still goes to console;
// the user sees something actionable.
function friendlyError(err: unknown): { content: string; pill: string } {
  const msg = err instanceof Error ? err.message : String(err)
  console.log('[error]', msg)

  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return {
      content: "Can't reach your server.\nCheck it's running and\non your network.",
      pill: '✗ No connection',
    }
  }
  if (/\b401\b/.test(msg)) {
    return {
      content: 'Authentication failed.\nCheck your API key\nin settings.',
      pill: '✗ Auth failed',
    }
  }
  if (/\b403\b/.test(msg)) {
    return {
      content: 'Access denied.\nCheck your API key\nand permissions.',
      pill: '✗ Access denied',
    }
  }
  if (/\b404\b/.test(msg)) {
    return {
      content: 'Endpoint not found.\nCheck your endpoint URLs\nin settings.',
      pill: '✗ Not found',
    }
  }
  if (/STT 5\d\d/.test(msg)) {
    return {
      content: "Couldn't process audio.\nPlease try again.",
      pill: '✗ Audio error',
    }
  }
  if (/\b5\d\d\b/.test(msg)) {
    return {
      content: "The model didn't respond.\nIt may be loading —\ntry again.",
      pill: '✗ No response',
    }
  }
  if (/Parse error/i.test(msg)) {
    return {
      content: 'Got an unexpected response.\nCheck your model is\nconfigured correctly.',
      pill: '✗ Bad response',
    }
  }
  return {
    content: `Something went wrong.\n${msg.slice(0, 80)}`,
    pill: '✗ Error',
  }
}

function resetAudio(): void {
  pcmChunks.length    = 0
  silentChunkCount    = 0
  speechChunkCount    = 0
  speechDetected      = false
  ambientRmsSumTemp   = 0
  ambientRmsCountTemp = 0
}

function resetSession(): void {
  resetAudio()
  ambientRmsBaseline = null
}

function buildMenuOptions(options: MenuOptionConfig[]): Record<string, MenuOptionConfig> {
  const result: Record<string, MenuOptionConfig> = {}
  for (const opt of options) {
    if (opt.enabled && opt.key) result[opt.key.toUpperCase()] = opt
  }
  return result
}

// -- Settings persistence -----------------------------------------------------

async function loadConfig(): Promise<AppConfig | null> {
  try {
    const raw = await bridge.getLocalStorage(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as AppConfig
  } catch {
    return null
  }
}

async function persistConfig(newCfg: AppConfig): Promise<void> {
  await bridge.setLocalStorage(STORAGE_KEY, JSON.stringify(newCfg))
}

// -- App bootstrap ------------------------------------------------------------

async function startApp(config: AppConfig): Promise<void> {
  cfg         = config
  menuOptions = buildMenuOptions(cfg.options)
  if (Object.keys(menuOptions).length === 0) {
    state = 'unconfigured'
    await setContent('No options enabled.\nConfigure in the\nEven Hub app.')
    await setHud('')
    return
  }
  ;(window as any).__showRunning?.()
  await startMenuListening()
}

;(window as any).__saveSettings = async (newCfg: AppConfig): Promise<void> => {
  await persistConfig(newCfg)
  if (state === 'menu_listening' || state === 'query_listening') {
    await bridge.audioControl(false)
  }
  stopPillAnimation()
  await startApp(newCfg)
}

// Item 1: Connection test. Runs against the SAVED config (cfg), routed
// through the same logic the glasses experience uses. Called from the
// settings page after the user saves. Returns a human-readable result.
;(window as any).__testConnection = async (): Promise<string> => {
  if (!cfg) {
    return '✗ No saved settings. Tap Save & Start first.'
  }

  const results: string[] = []

  // Check 1: Chat endpoint + API key + router model
  try {
    const res = await fetch(cfg.chatEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.routerModel,
        messages: [{ role: 'user', content: 'test' }],
      }),
    })
    if (res.ok) {
      results.push('✓ Chat endpoint OK')
    } else if (res.status === 401 || res.status === 403) {
      results.push(`✗ Chat: auth failed (${res.status}) — check API key`)
    } else if (res.status === 404) {
      results.push('✗ Chat: endpoint not found (404) — check URL')
    } else {
      results.push(`✗ Chat: error ${res.status}`)
    }
  } catch (e) {
    results.push(`✗ Chat: can't reach server — ${e instanceof Error ? e.message : 'network error'}`)
  }

  // Check 2: STT endpoint. An empty POST returning 400 (no file) means
  // auth and routing worked — that's a PASS. A 401/403 is a real failure.
  try {
    const res = await fetch(cfg.sttEndpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
      body: new FormData(),
    })
    if (res.status === 401 || res.status === 403) {
      results.push(`✗ STT: auth failed (${res.status}) — check API key / endpoint`)
    } else if (res.status === 404) {
      results.push('✗ STT: endpoint not found (404) — check URL')
    } else {
      // 400 (no file), 422, or 200 all mean auth + routing succeeded
      results.push('✓ STT endpoint OK')
    }
  } catch (e) {
    results.push(`✗ STT: can't reach server — ${e instanceof Error ? e.message : 'network error'}`)
  }

  return results.join('\n')
}

const existingCfg = await loadConfig()
if (existingCfg) {
  ;(window as any).__populateForm?.(existingCfg)
  await startApp(existingCfg)
} else {
  ;(window as any).__showSettings?.()
  await setContent('Open the Even Hub app\nto configure settings.')
  await setHud('')
}

// -- Glasses experience -------------------------------------------------------

async function startMenuListening(): Promise<void> {
  stopPillAnimation()
  resetSession()
  resetPagination()
  activeOption = null
  conversationHistory = []
  state = 'menu_listening'
  await setContent('Local LLM')
  await setHud(listeningHud())
  await bridge.audioControl(true)
}

async function startQueryListening(): Promise<void> {
  stopPillAnimation()
  resetAudio()
  resetPagination()
  state = 'query_listening'
  await setContent(activeOption!.label)
  await setHud(listeningHud())
  await bridge.audioControl(true)
}

async function transcribeAudio(wav: Blob): Promise<string> {
  const form = new FormData()
  form.append('file', wav, 'recording.wav')
  form.append('model', 'whisper-1')
  const attempt = async () => fetch(cfg!.sttEndpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg!.apiKey}` },
    body: form,
  })
  let res = await attempt()
  if (res.status === 500) {
    await new Promise(r => setTimeout(r, 1000))
    res = await attempt()
  }
  if (!res.ok) throw new Error(`STT ${res.status} ${res.statusText}`)
  const json = await res.json()
  return json.text ?? ''
}

async function chatCompletion(history: Message[], model: string): Promise<string> {
  const res = await fetch(cfg!.chatEndpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg!.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages: history }),
  })
  if (!res.ok) throw new Error(`Chat ${res.status} ${res.statusText}`)
  const text = await res.text()
  console.log(`[chat] raw response length: ${text.length}`)

  // Streaming (SSE) response
  if (text.trimStart().startsWith('data:')) {
    const parsed = text
      .split('\n')
      .map(l => l.trim())
      // Accept "data:" with or without a trailing space; skip the [DONE] sentinel
      .filter(l => l.startsWith('data:') && !l.includes('[DONE]'))
      .map(line => {
        try {
          const json = JSON.parse(line.replace(/^data:\s*/, ''))
          const choice = json.choices?.[0]
          // Prefer streamed delta content; fall back to message content,
          // then to reasoning fields some reasoning models use
          return choice?.delta?.content
              ?? choice?.message?.content
              ?? choice?.delta?.reasoning_content
              ?? choice?.delta?.reasoning
              ?? ''
        } catch { return '' }
      })
      .join('')
    console.log(`[chat] parsed streamed reply length: ${parsed.length}`)
    return parsed
  }

  // Non-streaming JSON response
  try {
    const json = JSON.parse(text)
    const choice = json.choices?.[0]
    const content = choice?.message?.content
                 ?? choice?.message?.reasoning_content
                 ?? ''
    console.log(`[chat] parsed non-stream reply length: ${content.length}`)
    return content
  } catch {
    throw new Error('Parse error')
  }
}

async function saveChat(history: Message[], model: string): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000)
  const ids = history.map(() => generateUUID())
  const messages: Record<string, object> = {}
  history.forEach((msg, i) => {
    messages[ids[i]] = {
      id:          ids[i],
      role:        msg.role,
      content:     msg.content,
      timestamp:   timestamp + i,
      parentId:    i === 0 ? null : ids[i - 1],
      childrenIds: i < history.length - 1 ? [ids[i + 1]] : [],
      ...(msg.role === 'assistant'
        ? { model, modelIdx: 0, done: true }
        : { models: [model] }),
    }
  })
  await fetch(cfg!.chatsEndpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg!.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat: {
        title:   history[0]?.content.slice(0, 60) ?? 'G2 Chat',
        models:  [model],
        history: { currentId: ids[ids.length - 1], messages },
        messages: history,
      },
    }),
  })
  console.log('chat saved, turns:', history.length / 2)
}

async function processMenuAudio(): Promise<void> {
  await bridge.audioControl(false)
  state = 'menu_processing'
  startPillAnimation()
  try {
    if (pcmChunks.length < MIN_CHUNKS) { await startMenuListening(); return }
    const wav        = buildWav(pcmChunks)
    const transcript = await transcribeAudio(wav)
    console.log(`[menu] transcript: "${transcript}"`)
    if (!transcript.trim()) { await startMenuListening(); return }
    const routerReply = await chatCompletion(
      [{ role: 'user', content: transcript }], cfg!.routerModel,
    )
    const key    = routerReply.trim().toUpperCase()
    console.log(`[menu] router key: "${key}"`)
    const option = menuOptions[key]
    if (!option) {
      stopPillAnimation()
      await setContent('Not recognised.\nPlease try again.')
      await setHud('')
      await new Promise(r => setTimeout(r, 2000))
      await startMenuListening()
      return
    }
    activeOption = option
    conversationHistory = []
    await startQueryListening()
  } catch (err) {
    stopPillAnimation()
    const fe = friendlyError(err)
    await setContent(fe.content)
    await setHud(fe.pill)
    await new Promise(r => setTimeout(r, 2500))
    await startMenuListening()
  }
}

async function processQueryAudio(): Promise<void> {
  await bridge.audioControl(false)
  state = 'query_processing'
  startPillAnimation()
  try {
    if (pcmChunks.length < MIN_CHUNKS) { await startQueryListening(); return }
    const wav        = buildWav(pcmChunks)
    const transcript = await transcribeAudio(wav)
    console.log(`[query] transcript: "${transcript}"`)
    if (!transcript.trim()) { await startQueryListening(); return }

    conversationHistory.push({ role: 'user', content: transcript })
    const reply = await chatCompletion(conversationHistory, activeOption!.model)

    // Guard against empty replies. An empty string passed to
    // textContainerUpgrade is ignored by the firmware, leaving the stale
    // menu label on screen. Show an explicit message instead so the user
    // is never left staring at unchanged text.
    const safeReply = reply.trim() ||
      'No readable response.\nThe model may have returned\nan empty or unsupported reply.\nTap to try again.'

    conversationHistory.push({ role: 'assistant', content: safeReply })

    stopPillAnimation()
    state = 'response'

    if (!activeOption!.multiTurn && activeOption!.saveChat && reply.trim()) {
      await saveChat(conversationHistory, activeOption!.model)
    }
    // showResponse paginates and sets the HUD (page indicator + nav hints,
    // multi-turn aware). Single-page replies keep the prior behavior exactly.
    await showResponse(safeReply)
  } catch (err) {
    stopPillAnimation()
    state = 'response'
    const fe = friendlyError(err)
    await setContent(fe.content + '\n\n(Tap to start over)')
    await setHud(fe.pill)
  }
}

async function returnToMenu(): Promise<void> {
  if (activeOption?.multiTurn && activeOption?.saveChat && conversationHistory.length > 0) {
    await saveChat(conversationHistory, activeOption.model)
  }
  await startMenuListening()
}

// -- Event routing -------------------------------------------------------------
// Critical details:
//   * Protobuf omits zero-value fields on the wire, so CLICK_EVENT (0)
//     arrives as `undefined`. Always coalesce with `?? 0` before comparing.
//   * Taps/double-taps/lifecycle come through `event.sysEvent`.
//     Scroll gestures come through `event.textEvent`. Never mix them.
//   * Double-tap -> `shutDownPageContainer(1)` is a root-level check: it
//     must fire no matter which envelope the event arrives in, so users
//     can always exit the app.
const unsubscribe = bridge.onEvenHubEvent(async event => {
  const sysType  = event.sysEvent?.eventType ?? null
  const textType = event.textEvent?.eventType ?? null

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    stopPillAnimation()
    if (state === 'menu_listening' || state === 'query_listening') {
      await bridge.audioControl(false)
    }
    if (activeOption?.multiTurn && activeOption?.saveChat && conversationHistory.length > 0) {
      await saveChat(conversationHistory, activeOption.model)
    }
    bridge.shutDownPageContainer(1)
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    stopPillAnimation()
    if (state === 'menu_listening' || state === 'query_listening') {
      await bridge.audioControl(false)
    }
    if (activeOption?.multiTurn && activeOption?.saveChat && conversationHistory.length > 0) {
      await saveChat(conversationHistory, activeOption.model)
    }
    unsubscribe()
    return
  }

  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    if (state === 'menu_listening' || state === 'query_listening') {
      await bridge.audioControl(false)
    }
    return
  }

  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    if (state === 'menu_listening' || state === 'query_listening') {
      await bridge.audioControl(true)
    }
    return
  }

  // Audio accumulation
  if ((state === 'menu_listening' || state === 'query_listening') && event.audioEvent?.audioPcm) {
    const chunk    = new Uint8Array(event.audioEvent.audioPcm)
    const chunkRms = rms(chunk)
    pcmChunks.push(chunk)

    if (cfg?.manualStop) return

    if (ambientRmsBaseline === null) {
      ambientRmsSumTemp += chunkRms
      ambientRmsCountTemp++
      if (ambientRmsCountTemp >= (cfg?.calibrationChunks ?? DEFAULT_CALIBRATION_CHUNKS)) {
        ambientRmsBaseline = ambientRmsSumTemp / ambientRmsCountTemp
        console.log(`[audio] baseline: ${ambientRmsBaseline.toFixed(0)}`)
      }
      return
    }

    const dynamicThreshold = ambientRmsBaseline * (cfg?.silenceMultiplier ?? DEFAULT_SILENCE_MULTIPLIER)

    if (chunkRms > dynamicThreshold) {
      speechChunkCount++
      silentChunkCount = 0
      if (!speechDetected && speechChunkCount >= (cfg?.minSpeechChunks ?? DEFAULT_MIN_SPEECH_CHUNKS)) {
        speechDetected = true
        console.log('[audio] speech confirmed')
      }
    } else {
      speechChunkCount = 0
      if (speechDetected) {
        silentChunkCount++
        if (silentChunkCount >= (cfg?.silenceDuration ?? DEFAULT_SILENCE_DURATION)) {
          console.log('[audio] end of speech detected')
          if (state === 'menu_listening') await processMenuAudio()
          else await processQueryAudio()
        }
      }
    }
    return
  }

  // Scroll down: advance to the next response page. No-op when there is no
  // next page or we are not on a response (empty responsePages => unchanged).
  if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    if (state === 'response' && currentPage < responsePages.length - 1) {
      currentPage++
      await renderResponsePage()
    }
    return
  }

  // Scroll up: go to the previous page, or return to the menu from the first
  // page (preserving the prior "scroll up from a response -> menu" behavior).
  if (state === 'response' && textType === OsEventTypeList.SCROLL_TOP_EVENT) {
    if (currentPage > 0) {
      currentPage--
      await renderResponsePage()
    } else {
      await returnToMenu()
    }
    return
  }

  const isTap = (sysType ?? 0) === OsEventTypeList.CLICK_EVENT
  if (!isTap) return

  // Manual stop: tap ends recording
  if (cfg?.manualStop && (state === 'menu_listening' || state === 'query_listening')) {
    if (state === 'menu_listening') await processMenuAudio()
    else await processQueryAudio()
    return
  }

  // Response: tap navigates
  if (state === 'response') {
    if (activeOption?.multiTurn) {
      await startQueryListening()
    } else {
      await startMenuListening()
    }
  }
})
