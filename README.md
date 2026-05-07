# EvenHub-LocalLLM

A voice-driven AI assistant app for the [Even Realities G2](https://www.evenrealities.com) smart glasses. Speak a menu option, speak your query, read the reply on your G2s — entirely hands-free, entirely on your own infrastructure.

---

> **Development note:** This app was developed entirely using [Claude](https://claude.ai) by Anthropic through an iterative, conversation-driven development process. Every line of TypeScript, every architectural decision, and every UI refinement was produced collaboratively with Claude. The Even Hub SDK, simulator, and platform are the work of Even Realities.

---

## What this app does

Local LLM connects your Even Realities G2 smart glasses to a self-hosted [open-webui](https://github.com/open-webui/open-webui) instance running on your own hardware. You speak a voice command to select a menu option, speak your query, and the response from your chosen model is displayed on the glasses. No third-party cloud AI services are used. Your voice data and queries go to your server and nowhere else.

The app is designed around a specific, proven stack:

- **Even Realities G2** glasses + Even Realities iPhone app
- **open-webui** — self-hosted LLM frontend with built-in Whisper STT
- **Tailscale** — secure private network to connect your phone to your server over HTTPS

If you are not running this stack, this app will not work for you.

---

## Prerequisites

Before installing the app, you need the following in place:

### Hardware
- Even Realities G2 glasses, paired and working with the Even Realities iPhone app
- A server (Linux, Windows, or Mac) with a GPU capable of running local LLMs — an RTX 3080 or equivalent is a reasonable minimum for useful model sizes

### Software stack
- [open-webui](https://github.com/open-webui/open-webui) installed and running on your server
- [Ollama](https://ollama.com) (recommended) or another OpenAI-compatible backend connected to open-webui
- [Tailscale](https://tailscale.com) installed on both your server and your iPhone
- An Even Hub developer account at [evenhub.evenrealities.com](https://evenhub.evenrealities.com)

---

## Stack setup

### 1. Install and configure open-webui

Follow the [open-webui installation guide](https://docs.openwebui.com) for your platform. The quickest path on Linux with an Nvidia GPU is:

```bash
pip install open-webui
open-webui serve
```

open-webui runs on port `3000` by default. Once running, open it in a browser and create an admin account.

**Enable Whisper STT:**

1. In open-webui, go to **Admin Panel → Settings → Audio**
2. Under Speech to Text, select **Whisper** as the backend
3. Choose a Whisper model size — `base` or `small` is fast enough for real-time use; `medium` gives better accuracy
4. Save settings

**Pull a router model:**

The app uses a small, fast model to route your voice commands to the right menu option. Pull one via Ollama:

```bash
ollama pull qwen2.5:0.5b
```

Then in open-webui, go to **Workspace → Models** and create a new model called `router-model` (or any name you choose — you will enter it in the app settings). Set its base model to `qwen2.5:0.5b` and give it the following system prompt:

```
You are a voice command router. Your only job is to read a voice transcript
and return exactly one routing key — nothing else. No punctuation, no
explanation, no preamble.

Valid routing keys:
- VOICE_ASSISTANT
- NEW_EMAIL
- SMART_QUERY
- UNKNOWN

Rules:
- If the user's input clearly matches one of the options, return that key.
- If the input is ambiguous, too short, or matches nothing, return UNKNOWN.
- Your entire response must be a single word from the list above.

Menu option mappings (update these to match your configured options):
- VOICE_ASSISTANT: "voice assistant", "chat", "ask a question"
- NEW_EMAIL:       "new email", "write an email", "compose"
- SMART_QUERY:     "smart query", "deep query", "reasoning"
```

Replace the routing keys and trigger phrases to match whatever menu options you configure in the app. The router model only needs to return one keyword, so a 0.5B model is sufficient and very fast.

**Pull your query models:**

Pull whichever models you want to use for actual queries:

```bash
ollama pull llama3.1:8b
ollama pull gemma3:12b
# etc.
```

**Generate an API key:**

In open-webui, go to **Settings → Account → API Keys** and create a new key. Copy it — you will need it in the app settings.

---

### 2. Set up Tailscale

Tailscale creates a secure private network (a "tailnet") between your devices. Your iPhone and your server will communicate over this network without exposing your server to the public internet.

**On your server (Linux example):**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Authenticate via the URL it prints.

**On your iPhone:**

Install the [Tailscale app](https://apps.apple.com/app/tailscale/id1470499037) from the App Store and sign in with the same Tailscale account.

**Enable HTTPS on your server:**

Tailscale provides free HTTPS certificates for nodes on your tailnet. Enable it:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
```

This proxies HTTPS traffic on port 443 to your local open-webui on port 3000. Get your Tailscale hostname:

```bash
tailscale status
```

Your open-webui instance is now reachable at `https://your-machine.your-tailnet.ts.net` from any device on your tailnet, including your iPhone. Verify this by opening that URL in Safari on your iPhone before proceeding.

---

## Installing the app

### Option A: Install from Even Hub (recommended)

Search for **Local LLM** in the Even Hub section of the Even Realities iPhone app and install it directly.

### Option B: Build from source

Clone this repository:

```bash
git clone https://github.com/yourusername/EvenHub-LocalLLM.git
cd EvenHub-LocalLLM
npm install
```

For development with the simulator:

```bash
npm run dev
npx evenhub-simulator http://localhost:5173
```

To sideload directly to your glasses:

```bash
npm run dev
npx evenhub qr --url http://<your-local-ip>:5173
```

Scan the QR code with the Even Realities iPhone app.

To build and pack for private distribution:

```bash
npm run build
evenhub pack app.json dist -o localllm.ehpk
```

Upload `localllm.ehpk` to [evenhub.evenrealities.com](https://evenhub.evenrealities.com) and share the private link.

---

## Configuring the app

On first launch, the Even Realities iPhone app displays a settings form. Fill in all fields before starting.

### Connection settings

| Field | Value |
|---|---|
| **Chat Endpoint** | `https://your-machine.your-tailnet.ts.net/api/chat/completions` |
| **Chats Endpoint** | `https://your-machine.your-tailnet.ts.net/api/v1/chats/new` |
| **STT Endpoint** | `https://your-machine.your-tailnet.ts.net/api/v1/audio/transcriptions` |
| **API Key** | Your open-webui API key |
| **Router Model** | The model ID of your router workspace model (e.g. `router-model`) |

### Menu options (up to 5)

Each option has the following fields:

| Field | Description |
|---|---|
| **Enabled** | Toggle the option on or off |
| **Router Key** | The exact keyword your router model returns (e.g. `VOICE_ASSISTANT`) — must match your system prompt exactly |
| **Display Label** | Text shown on the glasses when this option is selected (e.g. `Voice Assistant\nSpeak your query.`) |
| **Model** | The open-webui model ID to use for queries under this option (e.g. `llama3.1:8b`) |
| **Multi-turn** | Allow follow-up queries within the same session |
| **Save chat** | Save the exchange to open-webui chat history, viewable later in the browser |

Settings are saved to local storage and persist between sessions. Tap **⚙ Edit Settings** in the iPhone app at any time to update them.

---

## How to use the app

Launch the app from the Even Realities iPhone app. From that point, everything is controlled via the G2 glasses.

**On the glasses:**

| Gesture | Effect |
|---|---|
| Speak (auto) | Menu listening starts immediately — speak a menu option |
| Silence (~1.5s) | Recording stops automatically |
| Single tap | Follow up (multi-turn) / return to menu (single-turn) |
| Scroll up | Return to main menu from a response |
| Double-tap | Exit the app |

The app adapts automatically to background noise — it measures ambient sound levels at the start of each recording and sets the silence threshold relative to your environment. It works in quiet rooms and noisy environments like moving cars.

---

## Interaction model

```
App launches → menu listening starts automatically
       │
       ▼
User speaks menu option (e.g. "voice assistant")
       │
       ▼
Router model maps speech → routing key → menu option selected
       │
       ▼
Query listening starts → user speaks query
       │
       ▼
Audio → Whisper STT → transcript → chat completion → reply displayed on G2s
       │
  ┌────┴────────────────────┐
  │                         │
Single-turn              Multi-turn
Tap → menu            Tap → follow up
                    Scroll up → menu
```

---

## Troubleshooting

**"Not recognised" after speaking a menu option**
Your router model returned `UNKNOWN` or something that didn't match any enabled option key. Check that your system prompt lists the exact routing keys you've configured in the app, and that the router model is small and fast enough to follow instructions reliably. `qwen2.5:0.5b` is recommended.

**"STT 405 Method Not Allowed"**
Your STT endpoint path is wrong. Confirm it is `/api/v1/audio/transcriptions` (not `/api/audio/transcriptions` or `/v1/audio/transcriptions`). Also confirm Whisper is enabled in open-webui's Audio settings.

**"STT 500" errors (intermittent)**
The app retries once automatically. If it persists, the audio recording may be too short — hold your thought slightly longer before pausing. The minimum recording length is ~1 second.

**Recording never stops (especially in a car)**
The silence detector is adaptive but has limits in very loud environments. Increase `SILENCE_MULTIPLIER` in `main.ts` (default `2.5`) or increase `SILENCE_DURATION_CHUNKS` (default `15`) if it is cutting off too early.

**"Load failed" or network errors in the simulator**
CORS. The simulator runs in a browser WebView subject to CORS restrictions. Add a Vite dev proxy in `vite.config.ts` pointing to your open-webui host. This is not needed on real hardware.

**App works on phone but not after locking the screen**
Ensure the Even Realities iPhone app has background app refresh enabled in iOS Settings, and that your iPhone's Low Power Mode is off. The app is built to handle foreground/background transitions but iOS may still restrict it in some battery-saving configurations.

---

## Project structure

```
├── src/
│   └── main.ts          # App logic — glasses display, audio pipeline, routing
├── index.html           # Settings UI rendered in the Even Realities iPhone app
├── app.json             # Even Hub manifest
├── vite.config.ts       # Vite config (includes dev CORS proxy)
└── package.json
```

---

## Acknowledgements

- Built with the [Even Hub SDK](https://hub.evenrealities.com) by Even Realities
- AI pipeline powered by [open-webui](https://github.com/open-webui/open-webui)
- Speech-to-text via [Whisper](https://github.com/openai/whisper) (via open-webui)
- Secure networking via [Tailscale](https://tailscale.com)
- **Developed entirely with [Claude](https://claude.ai) by Anthropic** — every line of code, every architectural decision, and every UI refinement in this project was produced through a collaborative conversation with Claude

---

## Licence

MIT
