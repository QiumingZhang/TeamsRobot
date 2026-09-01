import asyncio
import audioop
import json
import os
import time
import uuid

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from qwen_asr import Qwen3ASRModel


MODEL_PATH = os.getenv(
    "ASR_MODEL_PATH",
    "/mnt/deepseek/Qwen3-ASR-1.7B",
)

TARGET_SAMPLE_RATE = 16000
TARGET_CHANNELS = 1
TARGET_SAMPLE_WIDTH = 2

app = FastAPI(title="Qwen3-ASR Streaming Server")
asr_model: Qwen3ASRModel | None = None

# 第一版限制同一时刻只有一个请求进入模型推理。
inference_lock = asyncio.Lock()


@app.on_event("startup")
async def startup():
    global asr_model

    asr_model = Qwen3ASRModel.LLM(
        model=MODEL_PATH,
        gpu_memory_utilization=0.80,
        max_new_tokens=256,
        enforce_eager=True,
    )

    print(f"Loaded ASR model: {MODEL_PATH}")


def create_streaming_state():
    if asr_model is None:
        raise RuntimeError("ASR model is not ready")

    return asr_model.init_streaming_state(
        unfixed_chunk_num=3,
        unfixed_token_num=8,
        chunk_size_sec=3.0,
    )


@app.get("/health")
async def health():
    return {
        "status": "ok" if asr_model is not None else "loading",
        "model": MODEL_PATH,
        "targetAudio": {
            "sampleRate": TARGET_SAMPLE_RATE,
            "channels": TARGET_CHANNELS,
            "sampleWidth": TARGET_SAMPLE_WIDTH,
            "encoding": "pcm_s16le",
        },
    }


@app.get("/metrics", response_class=PlainTextResponse)
async def metrics():
    model_ready = 1 if asr_model is not None else 0
    return (
        "# HELP asr_model_ready Whether the ASR model is ready.\n"
        "# TYPE asr_model_ready gauge\n"
        f"asr_model_ready {model_ready}\n"
    )


@app.websocket("/v1/asr/stream")
async def asr_stream(websocket: WebSocket):
    await websocket.accept()

    if asr_model is None:
        await websocket.send_json({
            "type": "error",
            "message": "ASR model is not ready",
        })
        await websocket.close(code=1013)
        return

    session_id = str(uuid.uuid4())
    state = create_streaming_state()

    input_sample_rate = TARGET_SAMPLE_RATE
    input_channels = TARGET_CHANNELS
    input_sample_width = TARGET_SAMPLE_WIDTH
    input_encoding = "pcm_s16le"
    resample_state = None

    started_at = time.monotonic()
    total_input_frames = 0
    total_output_samples = 0
    last_text = ""
    segment_index = 0
    committed_segments: list[str] = []
    configured = False

    await websocket.send_json({
        "type": "ready",
        "sessionId": session_id,
        "targetSampleRate": TARGET_SAMPLE_RATE,
        "targetChannels": TARGET_CHANNELS,
        "targetSampleWidth": TARGET_SAMPLE_WIDTH,
        "targetEncoding": "pcm_s16le",
        "message": "Send start, binary PCM audio, segment_end, then stop.",
    })

    async def process_pcm(pcm_bytes: bytes):
        nonlocal resample_state
        nonlocal total_input_frames
        nonlocal total_output_samples
        nonlocal last_text

        if not pcm_bytes:
            return

        if input_sample_width != 2:
            raise ValueError("Only 16-bit PCM input is supported")

        frame_size = input_sample_width * input_channels
        if len(pcm_bytes) % frame_size != 0:
            raise ValueError(
                "PCM byte count isn't aligned to frame size: "
                f"bytes={len(pcm_bytes)}, frameSize={frame_size}"
            )

        total_input_frames += len(pcm_bytes) // frame_size

        if input_channels == 2:
            pcm_bytes = audioop.tomono(
                pcm_bytes,
                input_sample_width,
                0.5,
                0.5,
            )
        elif input_channels != 1:
            raise ValueError("Only mono or stereo input is supported")

        if input_sample_rate != TARGET_SAMPLE_RATE:
            pcm_bytes, resample_state = audioop.ratecv(
                pcm_bytes,
                input_sample_width,
                1,
                input_sample_rate,
                TARGET_SAMPLE_RATE,
                resample_state,
            )

        if not pcm_bytes:
            return

        pcm16 = np.frombuffer(pcm_bytes, dtype="<i2")
        if pcm16.size == 0:
            return

        audio = pcm16.astype(np.float32) / 32768.0
        total_output_samples += audio.size

        async with inference_lock:
            await asyncio.to_thread(
                asr_model.streaming_transcribe,
                audio,
                state,
            )

        current_text = (getattr(state, "text", "") or "").strip()
        language = getattr(state, "language", "") or ""

        if current_text != last_text:
            last_text = current_text
            await websocket.send_json({
                "type": "partial",
                "sessionId": session_id,
                "text": current_text,
                "language": language,
                "inputAudioTimeMs": round(
                    total_input_frames / input_sample_rate * 1000
                ),
                "processedAudioTimeMs": round(
                    total_output_samples / TARGET_SAMPLE_RATE * 1000
                ),
            })

    async def commit_segment():
        nonlocal state
        nonlocal last_text
        nonlocal segment_index
        nonlocal resample_state

        segment_text = (getattr(state, "text", "") or "").strip()
        language = getattr(state, "language", "") or ""

        # segment_end 可能由误触静音触发。空文本不保存。
        if segment_text:
            segment_index += 1
            committed_segments.append(segment_text)

            await websocket.send_json({
                "type": "segment",
                "sessionId": session_id,
                "segmentIndex": segment_index,
                "text": segment_text,
                "language": language,
                "audioTimeMs": round(
                    total_output_samples / TARGET_SAMPLE_RATE * 1000
                ),
            })

        # 每个静音段后建立新的状态，避免整场会议文本无限累积。
        state = create_streaming_state()
        last_text = ""
        resample_state = None

        await websocket.send_json({
            "type": "segment_ready",
            "sessionId": session_id,
            "nextSegmentIndex": segment_index + 1,
        })

    try:
        while True:
            message = await websocket.receive()
            event_type = message.get("type")

            if event_type == "websocket.disconnect":
                print(
                    f"WebSocket disconnected: session={session_id}, "
                    f"code={message.get('code')}"
                )
                break

            if event_type != "websocket.receive":
                continue

            if message.get("bytes") is not None:
                await process_pcm(message["bytes"])
                continue

            if message.get("text") is None:
                continue

            try:
                command = json.loads(message["text"])
            except json.JSONDecodeError as exc:
                await websocket.send_json({
                    "type": "error",
                    "sessionId": session_id,
                    "message": f"Invalid JSON command: {exc}",
                })
                continue

            command_type = command.get("type")

            if command_type == "start":
                requested_sample_rate = int(
                    command.get("sampleRate", TARGET_SAMPLE_RATE)
                )
                requested_channels = int(
                    command.get("channels", TARGET_CHANNELS)
                )
                requested_sample_width = int(
                    command.get("sampleWidth", TARGET_SAMPLE_WIDTH)
                )
                requested_encoding = command.get(
                    "encoding", "pcm_s16le"
                )

                if requested_sample_rate <= 0:
                    raise ValueError("sampleRate must be greater than 0")
                if requested_channels not in (1, 2):
                    raise ValueError("channels must be 1 or 2")
                if requested_sample_width != 2:
                    raise ValueError("sampleWidth must be 2")
                if requested_encoding != "pcm_s16le":
                    raise ValueError("Only pcm_s16le is supported")

                input_sample_rate = requested_sample_rate
                input_channels = requested_channels
                input_sample_width = requested_sample_width
                input_encoding = requested_encoding
                resample_state = None
                configured = True

                await websocket.send_json({
                    "type": "started",
                    "sessionId": session_id,
                    "inputSampleRate": input_sample_rate,
                    "inputChannels": input_channels,
                    "inputSampleWidth": input_sample_width,
                    "inputEncoding": input_encoding,
                    "targetSampleRate": TARGET_SAMPLE_RATE,
                    "targetChannels": TARGET_CHANNELS,
                    "targetEncoding": "pcm_s16le",
                })
                continue

            if command_type == "segment_end":
                await commit_segment()
                continue

            if command_type == "stop":
                remaining_text = (
                    getattr(state, "text", "") or ""
                ).strip()
                language = getattr(state, "language", "") or ""

                if remaining_text:
                    if (
                        not committed_segments
                        or remaining_text != committed_segments[-1]
                    ):
                        committed_segments.append(remaining_text)

                final_text = "\n".join(
                    text for text in committed_segments if text
                )

                await websocket.send_json({
                    "type": "final",
                    "sessionId": session_id,
                    "text": final_text,
                    "language": language,
                    "segmentCount": len(committed_segments),
                    "inputDurationMs": round(
                        total_input_frames / input_sample_rate * 1000
                    ),
                    "processedDurationMs": round(
                        total_output_samples / TARGET_SAMPLE_RATE * 1000
                    ),
                })
                await websocket.close(code=1000)
                return

            if command_type == "ping":
                await websocket.send_json({
                    "type": "pong",
                    "sessionId": session_id,
                })
                continue

            await websocket.send_json({
                "type": "error",
                "sessionId": session_id,
                "message": f"Unsupported command type: {command_type}",
            })

    except WebSocketDisconnect as exc:
        print(f"Disconnected: session={session_id}, code={exc.code}")

    except Exception as exc:
        print(
            f"ASR session error {session_id}: "
            f"{type(exc).__name__}: {exc}"
        )

        try:
            await websocket.send_json({
                "type": "error",
                "sessionId": session_id,
                "message": str(exc),
            })
        except Exception:
            pass

        try:
            await websocket.close(code=1011)
        except Exception:
            pass

    finally:
        elapsed = time.monotonic() - started_at
        input_duration = (
            total_input_frames / input_sample_rate
            if input_sample_rate > 0 else 0
        )
        output_duration = total_output_samples / TARGET_SAMPLE_RATE

        print(
            f"Session={session_id}, configured={configured}, "
            f"input_format={input_sample_rate}Hz/"
            f"{input_channels}ch/{input_sample_width * 8}bit, "
            f"segments={len(committed_segments)}, "
            f"input_audio={input_duration:.1f}s, "
            f"processed_audio={output_duration:.1f}s, "
            f"elapsed={elapsed:.1f}s"
        )
