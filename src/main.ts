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
  chatEndpoint:  string
  chatsEndpoint: string
  sttEndpoint:   string
  apiKey:        string
  routerModel:   string
  options:       MenuOptionConfig[]
}

const STORAGE_KEY = 'app_config'

// Silence detection
const SILENCE_DURATION_CHUNKS   = 15    // consecutive silent chunks before auto-stop (~1.5s)
const MIN_CHUNKS                 = 10   // recordings shorter than this are discarded (~1s)
const AMBIENT_CALIBRATION_CHUNKS = 10   // first ~1s used to establish ambient baseline
const SILENCE_MULTIPLIER         = 2.5  // silence threshold = ambient RMS x this value

// Layout - 576x288 canvas
// Content layer occupies the top portion; pill sits below with a small gap.
const CONTENT_HEIGHT = 220
const GAP            = 4
const PILL_Y         = CONTENT_HEIGHT + GAP   // 224
const PILL_HEIGHT    = 60                      // 224 + 60 = 284, within 288px canvas
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

const pcmChunks: Uint8Array[] = []
let silentChunkCount = 0

// Ambient noise baseline — measured once per session during menu listening,
// then reused for all subsequent turns. Prevents speech on turn 2+ from
// corrupting the ambient measurement and causing premature cutoff.
let ambientRmsBaseline: number | null = null
let ambientRmsSumTemp   = 0
let ambientRmsCountTemp = 0

// -- Bridge init ---------------------------------------------------------------

const bridge = await waitForEvenAppBridge()

// Two-container stacked layout:
//   Container 1 - content layer: top 220px, isEventCapture=1, scrollable
//   Container 2 - pill HUD:      bottom strip below a 4px gap, no event capture
await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [
      // Content layer - scrollable reading area
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
      // Pill HUD - status and hints, always visible below content
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

// Update the content layer (container 1)
async function setContent(text: string): Promise<void> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const encoded = encoder.encode(text)
  const display = encoded.length <= 980
    ? text
    : decoder.decode(encoded.slice(0, 980)) + '...'
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: 1, containerName: 'content', content: display }),
  )
}

// Update the pill HUD (container 2)
async function setHud(text: string): Promise<void> {
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: 2, containerName: 'hud', content: text }),
  )
}

// Reset per-recording state only — preserves ambient baseline across turns
function resetAudio(): void {
  pcmChunks.length  = 0
  silentChunkCount  = 0
  ambientRmsSumTemp  = 0
  ambientRmsCountTemp = 0
}

// Reset everything including the ambient baseline — called on return to menu
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
  await startApp(newCfg)
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
  resetSession()
  activeOption = null
  conversationHistory = []
  state = 'menu_listening'
  await setContent('Local LLM')
  await setHud('■ Listening')
  await bridge.audioControl(true)
}

async function startQueryListening(): Promise<void> {
  resetAudio()   // preserve ambient baseline, reset per-recording state only
  state = 'query_listening'
  await setContent(activeOption!.label)
  await setHud('■ Listening')
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
  const text = await res.text()
  if (text.trimStart().startsWith('data:')) {
    return text
      .split('\n')
      .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map(line => {
        try { return JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '' }
        catch { return '' }
      })
      .join('')
  }
  try {
    return JSON.parse(text).choices?.[0]?.message?.content ?? 'No content in response'
  } catch {
    return `Parse error: ${text.slice(0, 200)}`
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
  await setHud('▶ Processing')
  try {
    if (pcmChunks.length < MIN_CHUNKS) { await startMenuListening(); return }
    const wav        = buildWav(pcmChunks)
    const transcript = await transcribeAudio(wav)
    console.log('menu transcript:', transcript)
    if (!transcript.trim()) { await startMenuListening(); return }
    const routerReply = await chatCompletion(
      [{ role: 'user', content: transcript }], cfg!.routerModel,
    )
    const key    = routerReply.trim().toUpperCase()
    console.log('router key:', key)
    const option = menuOptions[key]
    if (!option) {
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
    await setContent(`Error: ${err instanceof Error ? err.message : String(err)}`)
    await setHud('')
    await new Promise(r => setTimeout(r, 2000))
    await startMenuListening()
  }
}

async function processQueryAudio(): Promise<void> {
  await bridge.audioControl(false)
  state = 'query_processing'
  await setHud('▶ Processing')
  try {
    if (pcmChunks.length < MIN_CHUNKS) { await startQueryListening(); return }
    const wav        = buildWav(pcmChunks)
    const transcript = await transcribeAudio(wav)
    console.log('query transcript:', transcript)
    if (!transcript.trim()) { await startQueryListening(); return }

    conversationHistory.push({ role: 'user', content: transcript })
    const reply = await chatCompletion(conversationHistory, activeOption!.model)
    conversationHistory.push({ role: 'assistant', content: reply })

    state = 'response'

    if (activeOption!.multiTurn) {
      await setContent(reply)
      await setHud('● Tap · ▲ Scroll up · ●● Exit')
    } else {
      if (activeOption!.saveChat) await saveChat(conversationHistory, activeOption!.model)
      await setContent(reply)
      await setHud('● Tap · ●● Exit')
    }
  } catch (err) {
    state = 'response'
    await setContent(`Error: ${err instanceof Error ? err.message : String(err)}`)
    await setHud('● Tap to start over')
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

  // Double-tap exits from any state
  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
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

  // Audio accumulation and adaptive silence detection
  if ((state === 'menu_listening' || state === 'query_listening') && event.audioEvent?.audioPcm) {
    const chunk    = new Uint8Array(event.audioEvent.audioPcm)
    const chunkRms = rms(chunk)
    pcmChunks.push(chunk)

    // Calibration phase: runs only until baseline is established for this session.
    // The baseline is locked after the first AMBIENT_CALIBRATION_CHUNKS chunks
    // and reused for all subsequent turns, so turn 2+ speech does not corrupt it.
    if (ambientRmsBaseline === null) {
      ambientRmsSumTemp += chunkRms
      ambientRmsCountTemp++
      if (ambientRmsCountTemp >= AMBIENT_CALIBRATION_CHUNKS) {
        ambientRmsBaseline = ambientRmsSumTemp / ambientRmsCountTemp
        console.log('ambient baseline set:', ambientRmsBaseline.toFixed(0))
      }
      return
    }

    const dynamicThreshold = ambientRmsBaseline * SILENCE_MULTIPLIER
    if (chunkRms < dynamicThreshold) {
      silentChunkCount++
      if (silentChunkCount >= SILENCE_DURATION_CHUNKS) {
        if (state === 'menu_listening') await processMenuAudio()
        else await processQueryAudio()
      }
    } else {
      silentChunkCount = 0
    }
    return
  }

  // Scroll up in response state: return to menu
  if (state === 'response' && textType === OsEventTypeList.SCROLL_TOP_EVENT) {
    await returnToMenu()
    return
  }

  const isTap = (sysType ?? 0) === OsEventTypeList.CLICK_EVENT
  if (!isTap) return

  if (state === 'response') {
    if (activeOption?.multiTurn) {
      await startQueryListening()
    } else {
      await startMenuListening()
    }
  }
})
