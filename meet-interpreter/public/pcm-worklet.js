// 마이크/탭 오디오(Float32) → 16-bit PCM(Int16)으로 변환해 메인 스레드로 전달.
// AudioContext 를 16kHz 로 생성하므로 별도 리샘플링은 필요 없다.
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      const channel = input[0];
      const buf = new Int16Array(channel.length);
      for (let i = 0; i < channel.length; i++) {
        let s = Math.max(-1, Math.min(1, channel[i]));
        buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(buf.buffer, [buf.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
