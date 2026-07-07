const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const clearButton = document.querySelector("#clearButton");
const statusText = document.querySelector("#statusText");
const captureText = document.querySelector("#captureText");
const originalText = document.querySelector("#originalText");
const chineseText = document.querySelector("#chineseText");
const koreanText = document.querySelector("#koreanText");
const englishText = document.querySelector("#englishText");
const history = document.querySelector("#history");
const includeMicInput = document.querySelector("#includeMicInput");

let pc = null;
let dc = null;
let remoteAudio = null;
let displayStream = null;
let micStream = null;
let audioContext = null;
let mixedStream = null;
let responseText = "";
let responseTranscript = "";

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

function parseInterpreterPayload(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

function renderInterpreterPayload(payload) {
  if (!payload) return;
  setText(originalText, payload.original || payload.source_text || "", "원문 없음");

  if (payload.direction === "ko_en_to_zh") {
    setText(chineseText, payload.zh || payload.chinese || "", "중국어 번역 없음");
    setText(koreanText, "", "interviewee의 중국어 답변이 여기에 표시됩니다.");
    setText(englishText, "", "Chinese answers appear here in English.");
    addHistory("질문 -> 중국어 음성", payload.original || "", `中文 ${payload.zh || payload.chinese || ""}`);
    return;
  }

  if (payload.direction === "zh_to_ko_en") {
    setText(chineseText, "", "중국어 답변은 한국어 음성으로도 재생됩니다.");
    setText(koreanText, payload.ko || payload.korean || "", "한국어 번역 없음");
    setText(englishText, payload.en || payload.english || "", "English translation unavailable.");
    addHistory(
      "중국어 답변 -> 한국어 음성 + 텍스트",
      payload.original || "",
      `한국어 ${payload.ko || payload.korean || ""}`,
      `English ${payload.en || payload.english || ""}`
    );
  }
}

function handleRealtimeEvent(event) {
  if (event.type === "error") {
    const message = event.error?.message || "Realtime API 오류가 발생했습니다.";
    setStatus("오류");
    setText(originalText, message, "오류");
    return;
  }

  if (event.type === "session.created" || event.type === "session.updated") {
    setStatus("실시간 듣는 중");
    return;
  }

  if (event.type === "input_audio_buffer.speech_started") {
    setStatus("말 듣는 중");
    return;
  }

  if (event.type === "input_audio_buffer.speech_stopped") {
    setStatus("바로 통역 중");
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    setText(originalText, event.transcript || "", "원문 없음");
    return;
  }

  if (event.type === "response.created") {
    responseText = "";
    responseTranscript = "";
    setStatus("통역 응답 중");
    return;
  }

  if (event.type === "response.text.delta" || event.type === "response.output_text.delta") {
    responseText += event.delta || "";
    const payload = parseInterpreterPayload(responseText);
    if (payload) renderInterpreterPayload(payload);
    return;
  }

  if (event.type === "response.text.done" || event.type === "response.output_text.done") {
    responseText += event.text || "";
    const payload = parseInterpreterPayload(responseText);
    if (payload) renderInterpreterPayload(payload);
    return;
  }

  if (event.type === "response.audio_transcript.delta") {
    responseTranscript += event.delta || "";
    const payload = parseInterpreterPayload(responseTranscript);
    if (payload) renderInterpreterPayload(payload);
    return;
  }

  if (event.type === "response.audio_transcript.done") {
    responseTranscript = event.transcript || responseTranscript;
    const payload = parseInterpreterPayload(responseTranscript);
    if (payload) renderInterpreterPayload(payload);
    setStatus("실시간 듣는 중");
    return;
  }

  if (event.type === "response.done") {
    const payload = parseInterpreterPayload(responseText) || parseInterpreterPayload(responseTranscript);
    if (payload) renderInterpreterPayload(payload);
    setStatus("실시간 듣는 중");
  }
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
  audioContext.createMediaStreamSource(new MediaStream(tabAudioTracks)).connect(destination);

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
      audioContext.createMediaStreamSource(micStream).connect(destination);
      micLabel = micStream.getAudioTracks()[0]?.label || "마이크";
    } catch (error) {
      micStream = null;
      includeMicInput.checked = false;
      setText(originalText, "마이크 권한이 거부되어 Meet 탭 오디오만 듣습니다.", "알림");
    }
  }

  if (audioContext.state === "suspended") await audioContext.resume();
  captureText.textContent = micLabel ? `Meet 탭 + ${micLabel}` : tabAudioTracks[0].label || "Meet 탭 오디오";
  return destination.stream;
}

async function startRealtime() {
  setStatus("연결 준비 중");
  mixedStream = await createMixedAudioStream();

  pc = new RTCPeerConnection();
  remoteAudio = document.createElement("audio");
  remoteAudio.autoplay = true;
  remoteAudio.playsInline = true;
  pc.ontrack = (event) => {
    remoteAudio.srcObject = event.streams[0];
  };

  for (const track of mixedStream.getAudioTracks()) {
    pc.addTrack(track, mixedStream);
  }

  dc = pc.createDataChannel("oai-events");
  dc.addEventListener("open", () => {
    setStatus("실시간 듣는 중");
  });
  dc.addEventListener("message", (message) => {
    try {
      handleRealtimeEvent(JSON.parse(message.data));
    } catch {
      // Ignore non-JSON diagnostics from the data channel.
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const response = await fetch("/api/realtime-call", {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: offer.sdp,
  });
  const answerSdp = await response.text();
  if (!response.ok) throw new Error(answerSdp || "Realtime 연결에 실패했습니다.");

  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  startButton.disabled = true;
  stopButton.disabled = false;
  includeMicInput.disabled = true;
}

function stopRealtime() {
  if (dc) dc.close();
  if (pc) pc.close();
  if (displayStream) displayStream.getTracks().forEach((track) => track.stop());
  if (micStream) micStream.getTracks().forEach((track) => track.stop());
  if (mixedStream) mixedStream.getTracks().forEach((track) => track.stop());
  if (audioContext) audioContext.close().catch(() => {});

  pc = null;
  dc = null;
  remoteAudio = null;
  displayStream = null;
  micStream = null;
  mixedStream = null;
  audioContext = null;
  responseText = "";
  responseTranscript = "";

  startButton.disabled = false;
  stopButton.disabled = true;
  includeMicInput.disabled = false;
  captureText.textContent = "중지됨";
  setStatus("대기 중");
}

startButton.addEventListener("click", () => {
  startRealtime().catch((error) => {
    setStatus("오류");
    const message = String(error.message || "");
    if (message.includes("Permission denied") || message.includes("NotAllowedError")) {
      setText(originalText, "브라우저에서 마이크 권한이 거부됐습니다. 주소창 왼쪽 사이트 설정에서 마이크를 허용한 뒤 다시 시도하세요.", "오류");
    } else if (message.includes("OpenAI Realtime error 504")) {
      setText(originalText, "OpenAI Realtime 연결이 시간 초과됐습니다. 잠시 후 다시 시도하거나 Vercel 환경변수 OPENAI_REALTIME_MODEL을 gpt-realtime-2.1로 설정했는지 확인하세요.", "오류");
    } else {
      setText(originalText, message, "오류");
    }
    stopRealtime();
  });
});

stopButton.addEventListener("click", stopRealtime);
clearButton.addEventListener("click", () => {
  history.replaceChildren();
});
