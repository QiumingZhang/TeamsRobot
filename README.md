# Teams Meeting ASR Assistant v2

## Central configuration

Edit the constants at the top of `background.js`:

- `ASR_WS_URL`
- `CHAT_COMPLETIONS_URL`
- `CHAT_MODEL`

Set `CHAT_MODEL` to a model name accepted by your OpenAI-compatible chat gateway.

## Behavior

- Automatically finds an open Teams web tab, preferring an audible one.
- Captures Teams tab audio and microphone audio simultaneously.
- Mixes both streams and sends mono PCM16 to ASR.
- The microphone mute button stops the microphone track; unmute reacquires it.
- Separate sliders control Teams and microphone gain.
- On stop, the full transcript is sent to Chat Completions to generate Chinese meeting minutes within 200 Chinese characters.

## Server

Run Uvicorn with WebSocket compression disabled:

```bash
python -m uvicorn server:app --host 0.0.0.0 --port 8000 --workers 1 --ws-per-message-deflate false
```

## Important

Use only with participant notice and in accordance with company recording, privacy, and retention policy. A headset is strongly recommended to avoid speaker audio being recorded again by the microphone.
