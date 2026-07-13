const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const clearButton = document.querySelector("#clearButton");
const statusText = document.querySelector("#statusText");
const captureText = document.querySelector("#captureText");
const originalText = document.querySelector("#originalText");
const chineseText = document.querySelector("#chineseText");
const respondentChineseText = document.querySelector("#respondentChineseText");
const koreanText = document.querySelector("#koreanText");
const history = document.querySelector("#history");
const includeMicInput = document.querySelector("#includeMicInput");
const chineseVariantInput = document.querySelector("#chineseVariantInput");

const CHUNK_MS = 4000;
const SPEECH_LEVEL_THRESHOLD = 0.012;

let displayStream = null;
let micStream = null;
let audioContext = null;
let mixedStream = null;
let recorder = null;
let chunkTimer = null;
let volumeTimer = null;
let analyser = null;
let analyserData = null;
let chunkPeakLevel = 0;
let processing = false;
let pendingBlob = null;
let running = false;
let audioPlayer = null;

function setStatus(text) {
  statusText.textContent = text;
}

function setText(node, text, fallback) {
  node.textContent = text || fallback;
  node.classList.toggle("muted", !text);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function addHistory(kind, original, primary, secondary = "") {
  const item = document.createElement("li");
  item.innerHTML = `
    <div class="historyMeta">${new Date().toLocaleTimeString()} · ${escapeHtml(kind)}</div>
    ${original ? `<p><b>원문</b> ${escapeHtml(original)}</p>` : ""}
    ${primary ? `<p>${escapeHtml(primary)}</p>` : ""}
    ${secondary ? `<p>${escapeHtml(secondary)}</p>` : ""}
  `;
  history.prepend(item);
}

function chineseVariantLabel(value) {
  if (value === "mainland_mandarin") return "본토 중국어";
  if (value === "taiwan_mandarin") return "대만 중국어";
  if (value === "cantonese") return "광동어";
  if (chineseVariantInput && chineseVariantInput.value !== "auto") return chineseVariantLabel(chineseVariantInput.value);
  return "중국어";
}

function pickMimeType() {
  const choices = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return choices.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function connectAudioSource(source, destination) {
  source.connect(destination);
  if (analyser) source.connect(analyser);
}

function updatePeakLevel() {
  if (!analyser || !analyserData) return;
  analyser.getByteTimeDomainData(analyserData);
  let peak = 0;
  for (const value of analyserData) {
    peak = Math.max(peak, Math.abs(value - 128) / 128);
  }
  chunkPeakLevel = Math.max(chunkPeakLevel, peak);
}

async function createMixedAudioStream() {
  setStatus("Meet 탭 선택 대기");
  displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  const tabAudioTracks = displayStream.getAudioTracks();
  if (!tabAudioTracks.length) {
    displayStream.getTracks().forEach((track) => track.stop());
    throw new Error("Meet 탭을 선택하고 탭 오디오 공유를 켜주세요.");
  }

  audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyserData = new Uint8Array(analyser.fftSize);
  connectAudioSource(audioContext.createMediaStreamSource(new MediaStream(tabAudioTracks)), destination);

  let micLabel = "";
  if (includeMicInput.checked) {
    setStatus("마이크 권한 대기");
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      connectAudioSource(audioContext.createMediaStreamSource(micStream), destination);
      micLabel = micStream.getAudioTracks()[0]?.label || "마이크";
    } catch {
      micStream = null;
      includeMicInput.checked = false;
      setText(originalText, "마이크 권한이 거부되어 Meet 탭 오디오만 듣습니다.", "알림");
    }
  }

  if (audioContext.state === "suspended") await audioContext.resume();
  captureText.textContent = micLabel ? `Meet 탭 + ${micLabel}` : tabAudioTracks[0].label || "Meet 탭 오디오";
  return destination.stream;
}

async function playAudio(base64Audio) {
  if (!base64Audio) return;
  if (!audioPlayer) {
    audioPlayer = document.createElement("audio");
    audioPlayer.autoplay = true;
    audioPlayer.playsInline = true;
    audioPlayer.style.display = "none";
    document.body.appendChild(audioPlayer);
  }
  const bytes = Uint8Array.from(atob(base64Audio), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
  audioPlayer.src = url;
  try {
    await audioPlayer.play();
  } catch {
    setStatus("음성 재생 차단됨");
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

function renderResult(result) {
  if (!result || result.direction === "skip") {
    setStatus("듣는 중");
    return;
  }

  if (result.direction === "ko_en_to_zh") {
    setText(originalText, result.original || "", "interviewer가 말한 내용이 표시됩니다.");
    setText(respondentChineseText, "", "응답자가 중국어로 말한 내용이 표시됩니다.");
    setText(chineseText, result.zh || "", "중국어 번역 없음");
    setText(koreanText, "", "중국어 답변의 한국어 번역이 표시됩니다.");
    addHistory("질문 -> 중국어 음성", result.original || "", `中文 ${result.zh || ""}`);
    playAudio(result.audio);
    return;
  }

  if (result.direction === "zh_to_ko_en") {
    const label = chineseVariantLabel(result.zh_variant);
    setText(respondentChineseText, result.original ? `[${label}] ${result.original}` : "", "중국어 원문 없음");
    setText(koreanText, result.ko || "", "한국어 번역 없음");
    addHistory(`${label} 답변 -> 한국어/영어 텍스트`, result.original || "", `한국어 ${result.ko || ""}`, `English ${result.en || ""}`);
  }
}

async function sendChunk(blob) {
  if (!running || blob.size < 1200) return;
  if (processing) {
    pendingBlob = blob;
    return;
  }
  processing = true;
  setStatus("통역 중");
  try {
    const form = new FormData();
    form.append("audio", blob, "chunk.webm");
    form.append("chinese_variant", chineseVariantInput.value || "auto");
    const response = await fetch("/api/interpret", {
      method: "POST",
      body: form,
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || "통역 처리에 실패했습니다.");
    renderResult(result);
  } catch (error) {
    setStatus("오류");
    const message = String(error.message || "");
    if (message.includes("requests per day") || message.includes("rate_limit_exceeded")) {
      setText(originalText, "OpenAI 하루 요청 한도에 걸렸습니다. 오늘은 더 이상 받아쓰기가 어렵고, 한도가 리셋된 뒤 다시 사용할 수 있습니다.", "오류");
      stopStableInterpreter();
    } else {
      setText(originalText, message || "통역 처리에 실패했습니다.", "오류");
    }
  } finally {
    processing = false;
    if (running && pendingBlob) {
      const nextBlob = pendingBlob;
      pendingBlob = null;
      sendChunk(nextBlob);
      return;
    }
    if (running && statusText.textContent !== "오류") setStatus("듣는 중");
  }
}

function recordNextChunk() {
  if (!running || !mixedStream) return;

  const mimeType = pickMimeType();
  const chunks = [];
  chunkPeakLevel = 0;
  recorder = new MediaRecorder(mixedStream, mimeType ? { mimeType } : undefined);
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    if (volumeTimer) window.clearInterval(volumeTimer);
    volumeTimer = null;
    if (chunks.length && chunkPeakLevel >= SPEECH_LEVEL_THRESHOLD) {
      const type = recorder.mimeType || mimeType || "audio/webm";
      sendChunk(new Blob(chunks, { type }));
    } else if (running) {
      setStatus("조용함 감지");
    }
    if (running) chunkTimer = window.setTimeout(recordNextChunk, 120);
  });
  recorder.start();
  volumeTimer = window.setInterval(updatePeakLevel, 200);
  chunkTimer = window.setTimeout(() => {
    if (recorder && recorder.state === "recording") recorder.stop();
  }, CHUNK_MS);
}

async function startStableInterpreter() {
  setStatus("연결 준비 중");
  mixedStream = await createMixedAudioStream();
  running = true;

  recordNextChunk();

  startButton.disabled = true;
  stopButton.disabled = false;
  includeMicInput.disabled = true;
  chineseVariantInput.disabled = true;
  setStatus("듣는 중");
}

function stopStableInterpreter() {
  running = false;
  if (chunkTimer) window.clearTimeout(chunkTimer);
  if (volumeTimer) window.clearInterval(volumeTimer);
  if (recorder && recorder.state !== "inactive") recorder.stop();
  if (displayStream) displayStream.getTracks().forEach((track) => track.stop());
  if (micStream) micStream.getTracks().forEach((track) => track.stop());
  if (mixedStream) mixedStream.getTracks().forEach((track) => track.stop());
  if (audioContext) audioContext.close().catch(() => {});

  displayStream = null;
  micStream = null;
  mixedStream = null;
  audioContext = null;
  recorder = null;
  chunkTimer = null;
  volumeTimer = null;
  analyser = null;
  analyserData = null;
  chunkPeakLevel = 0;
  processing = false;
  pendingBlob = null;

  startButton.disabled = false;
  stopButton.disabled = true;
  includeMicInput.disabled = false;
  chineseVariantInput.disabled = false;
  captureText.textContent = "중지됨";
  setStatus("대기 중");
}

startButton.addEventListener("click", () => {
  startStableInterpreter().catch((error) => {
    setStatus("오류");
    const message = String(error.message || "");
    if (message.includes("Permission denied") || message.includes("NotAllowedError")) {
      setText(originalText, "브라우저에서 권한이 거부됐습니다. 주소창 왼쪽 사이트 설정에서 마이크/화면 공유를 허용한 뒤 다시 시도하세요.", "오류");
    } else {
      setText(originalText, message, "오류");
    }
    stopStableInterpreter();
  });
});

stopButton.addEventListener("click", stopStableInterpreter);
clearButton.addEventListener("click", () => {
  history.replaceChildren();
});
