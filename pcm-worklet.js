class PCM16VADProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions || {};
    this.chunkSamples = Math.max(
      128,
      Math.round(sampleRate * (config.chunkDurationMs || 100) / 1000)
    );
    this.speechThreshold = config.speechThreshold || 0.006;
    this.silenceDurationMs = config.silenceDurationMs || 2000;
    this.minimumSpeechSamples = Math.round(
      sampleRate * (config.minimumSpeechMs || 300) / 1000
    );
    this.silenceTriggerSamples = Math.round(
      sampleRate * this.silenceDurationMs / 1000
    );
    this.pending = new Float32Array(this.chunkSamples);
    this.pendingLength = 0;
    this.hasSpeech = false;
    this.segmentEnded = false;
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.levelReportSamples = 0;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "flush") this.flush();
      if (data.type === "reset_vad") this.resetVad();
      if (data.type === "update_settings") {
        const threshold = Number(data.speechThreshold);
        const silenceMs = Number(data.silenceDurationMs);
        if (Number.isFinite(threshold) && threshold > 0) {
          this.speechThreshold = threshold;
        }
        if (Number.isFinite(silenceMs) && silenceMs >= 500) {
          this.silenceDurationMs = silenceMs;
          this.silenceTriggerSamples = Math.round(
            sampleRate * silenceMs / 1000
          );
        }
      }
    };
  }

  resetVad() {
    this.hasSpeech = false;
    this.segmentEnded = false;
    this.speechSamples = 0;
    this.silenceSamples = 0;
  }

  emitAudio(count) {
    if (count <= 0) return;
    const pcm = new Int16Array(count);
    for (let i = 0; i < count; i += 1) {
      const value = Math.max(-1, Math.min(1, this.pending[i]));
      pcm[i] = value < 0
        ? Math.round(value * 32768)
        : Math.round(value * 32767);
    }
    this.port.postMessage(
      { type: "audio", buffer: pcm.buffer },
      [pcm.buffer]
    );
    this.pendingLength = 0;
  }

  flush() {
    this.emitAudio(this.pendingLength);
  }

  updateVad(rms, frameCount) {
    if (rms >= this.speechThreshold) {
      this.speechSamples += frameCount;
      this.silenceSamples = 0;
      if (this.speechSamples >= this.minimumSpeechSamples) {
        this.hasSpeech = true;
        this.segmentEnded = false;
      }
      return;
    }

    if (!this.hasSpeech) {
      this.speechSamples = 0;
      return;
    }

    this.silenceSamples += frameCount;
    if (
      !this.segmentEnded
      && this.silenceSamples >= this.silenceTriggerSamples
    ) {
      this.flush();
      this.port.postMessage({
        type: "segment_end",
        silenceMs: Math.round(this.silenceSamples / sampleRate * 1000)
      });
      this.segmentEnded = true;
      this.hasSpeech = false;
      this.speechSamples = 0;
      this.silenceSamples = 0;
    }
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;

    const frames = channels[0].length;
    let squareSum = 0;

    for (let frame = 0; frame < frames; frame += 1) {
      let mono = 0;
      for (let channel = 0; channel < channels.length; channel += 1) {
        mono += channels[channel][frame] || 0;
      }
      mono /= channels.length;
      squareSum += mono * mono;
      this.pending[this.pendingLength] = mono;
      this.pendingLength += 1;
      if (this.pendingLength >= this.chunkSamples) {
        this.emitAudio(this.pendingLength);
      }
    }

    const rms = Math.sqrt(squareSum / frames);
    this.updateVad(rms, frames);
    this.levelReportSamples += frames;
    if (this.levelReportSamples >= sampleRate / 5) {
      this.port.postMessage({ type: "level", rms });
      this.levelReportSamples = 0;
    }
    return true;
  }
}

registerProcessor("pcm16-vad-processor", PCM16VADProcessor);
