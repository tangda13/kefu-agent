/** 麦克风录音 → 16kHz 16bit 单声道 WAV（ASR 直传格式） */
export class WavRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.context = new AudioContext({ sampleRate: 16000 });
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.processor.onaudioprocess = (event) => {
      this.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.context.destination);
  }

  async stop(): Promise<Blob> {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    const sampleRate = this.context?.sampleRate ?? 16000;
    await this.context?.close();
    this.context = null;

    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const padding = Math.round(sampleRate * 0.3); // 尾部补 300ms 静音，避免末词截断
    const pcm = new Int16Array(total + padding);
    let offset = 0;
    for (const chunk of this.chunks) {
      for (let i = 0; i < chunk.length; i += 1) {
        const value = Math.max(-1, Math.min(1, chunk[i]!));
        pcm[offset + i] = value < 0 ? value * 0x8000 : value * 0x7fff;
      }
      offset += chunk.length;
    }
    this.chunks = [];
    return encodeWav(pcm, sampleRate);
  }
}

function encodeWav(pcm: Int16Array, sampleRate: number): Blob {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeString = (pos: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(pos + i, text.charCodeAt(i));
  };
  const dataSize = pcm.length * 2;
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  return new Blob([header, pcm.buffer as ArrayBuffer], { type: "audio/wav" });
}
