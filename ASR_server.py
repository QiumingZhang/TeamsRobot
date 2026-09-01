import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Optional

import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from qwen_asr import Qwen3ASRModel


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

logger = logging.getLogger("teams-asr")

MODEL_NAME = os.getenv(
    "ASR_MODEL",
    "Qwen/Qwen3-ASR-0.6B",
)

GPU_MEMORY_UTILIZATION = float(
    os.getenv("GPU_MEMORY_UTILIZATION", "0.80")
)

# 浏览器发送 16 kHz、单声道、int16 PCM
SAMPLE_RATE = 16000

# 每积累 500 ms 音频，调用一次流式识别
STEP_MS = 500
STEP_SAMPLES = int(SAMPLE_RATE * STEP_MS / 1000)
STEP_BYTES = STEP_SAMPLES * 2

asr_model: Optional[Qwen3ASRModel] = None

# 第一版先限制为单路推理，避免多个线程同时访问模型。
# 后续可改成任务队列或单独的模型推理进程。
inference_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global asr_model

    logger.info("Loading ASR model: %s", MODEL_NAME)

    asr_model = Qwen3ASRModel.LLM(
        model=MODEL_NAME,
        gpu_memory_utilization=GPU_MEMORY_UTILIZATION,

        # 流式识别不需要设置得太大
        max_new_tokens=64,
    )

    logger.info("ASR model loaded")

    yield

    logger.info("ASR server shutting down")
    asr_model = None


app = FastAPI(
    title="Teams Qwen3-ASR Gateway",
    lifespan=lifespan,
)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "sample_rate": SAMPLE_RATE,
    }


async def run_streaming_transcribe(
    samples: np.ndarray,
    state,
) -> str:
    """
    vLLM 推理通常是同步调用，因此放入工作线程，
    避免直接阻塞 FastAPI 事件循环。
    """
    if asr_model is None:
        raise RuntimeError("ASR model is not loaded")

    async with inference_lock:
        await asyncio.to_thread(
            asr_model.streaming_transcribe,
            samples,
            state,
        )

    return state.text or ""


async def finish_streaming(state) -> str:
    if asr_model is None:
        raise RuntimeError("ASR model is not loaded")

    async with inference_lock:
        await asyncio.to_thread(
            asr_model.finish_streaming_transcribe,
            state,
        )

    return state.text or ""


@app.websocket("/ws/asr")
async def asr_websocket(websocket: WebSocket):
    await websocket.accept()

    client = websocket.client
    logger.info("WebSocket connected: %s", client)

    if asr_model is None:
        await websocket.send_json({
            "type": "error",
            "message": "ASR model is not ready",
        })
        await websocket.close(code=1013)
        return

    state = asr_model.init_streaming_state(
        unfixed_chunk_num=2,
        unfixed_token_num=5,
        chunk_size_sec=2.0,
    )

    pcm_buffer = bytearray()
    last_text = ""

    try:
        await websocket.send_json({
            "type": "ready",
            "sampleRate": SAMPLE_RATE,
            "format": "pcm_s16le",
            "model": MODEL_NAME,
        })

        while True:
            message = await websocket.receive()

            if message.get("bytes") is not None:
                pcm_buffer.extend(message["bytes"])

                while len(pcm_buffer) >= STEP_BYTES:
                    chunk_bytes = bytes(pcm_buffer[:STEP_BYTES])
                    del pcm_buffer[:STEP_BYTES]

                    # int16 PCM -> float32，范围约为 -1.0 到 1.0
                    samples_int16 = np.frombuffer(
                        chunk_bytes,
                        dtype="<i2",
                    )

                    samples_float32 = (
                        samples_int16.astype(np.float32) / 32768.0
                    )

                    text = await run_streaming_transcribe(
                        samples_float32,
                        state,
                    )

                    if text != last_text:
                        last_text = text

                        await websocket.send_json({
                            "type": "partial",
                            "language": state.language,
                            "text": text,
                        })

            elif message.get("text") is not None:
                try:
                    data = json.loads(message["text"])
                except json.JSONDecodeError:
                    await websocket.send_json({
                        "type": "error",
                        "message": "Invalid JSON message",
                    })
                    continue

                message_type = data.get("type")

                if message_type == "start":
                    await websocket.send_json({
                        "type": "started",
                    })

                elif message_type == "stop":
                    # 处理最后不足 500 ms 的音频
                    if pcm_buffer:
                        samples_int16 = np.frombuffer(
                            bytes(pcm_buffer),
                            dtype="<i2",
                        )

                        samples_float32 = (
                            samples_int16.astype(np.float32) / 32768.0
                        )

                        await run_streaming_transcribe(
                            samples_float32,
                            state,
                        )

                        pcm_buffer.clear()

                    final_text = await finish_streaming(state)

                    await websocket.send_json({
                        "type": "final",
                        "language": state.language,
                        "text": final_text,
                    })

                    await websocket.close(code=1000)
                    break

                elif message_type == "ping":
                    await websocket.send_json({
                        "type": "pong",
                    })

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected: %s", client)

    except Exception as exc:
        logger.exception("ASR WebSocket error")

        try:
            await websocket.send_json({
                "type": "error",
                "message": str(exc),
            })
            await websocket.close(code=1011)
        except Exception:
            pass


if __name__ == "__main__":
    # 不要使用 reload，也不要启动多个 worker。
    # vLLM 模型只能加载一次。
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8765,
        workers=1,
        log_level="info",
    )