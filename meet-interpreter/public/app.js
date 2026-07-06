'use strict';

const SAMPLE_RATE = 16000;

const els = {
  micSelect: document.getElementById('micSelect'),
  outputSelect: document.getElementById('outputSelect'),
  interviewerBtn: document.getElementById('interviewerBtn'),
  intervieweeBtn: document.getElementById('intervieweeBtn'),
  monitorTTS: document.getElementById('monitorTTS'),
  interviewerDot: document.getElementById('interviewerDot'),
  intervieweeDot: document.getElementById('intervieweeDot'),
  interviewerInterim: document.getElementById('interviewerInterim'),
  intervieweeInterim: document.getElementById('intervieweeInterim'),
  interviewerLog: document.getElementById('interviewerLog'),
  intervieweeLog: document.getElementById('intervieweeLog'),
  status: document.getElementById('status'),
};

function setStatus(msg) {
  els.status.textContent = msg;
}

function nowTime() {
  const d = new Date();
  return d.toLocaleTimeString('ko-KR', { hour12: false });
}

// ---------------------------------------------------------------------------
// 장치 목록 채우기
// ---------------------------------------------------------------------------
async function populateDevices() {
  try {
    // 라벨을 얻으려면 먼저 마이크 권한이 필요
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (err) {
    setStatus('마이크 권한이 필요합니다: ' + err.message);
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  els.micSelect.innerHTML = '';
  els.outputSelect.innerHTML = '';

  devices.forEach((d) => {
    if (d.kind === 'audioinput') {
      const opt = new Option(d.label || `마이크 ${els.micSelect.length + 1}`, d.deviceId);
      els.micSelect.add(opt);
    } else if (d.kind === 'audiooutput') {
      const opt = new Option(d.label || `출력 ${els.outputSelect.length + 1}`, d.deviceId);
      els.outputSelect.add(opt);
      // BlackHole 이 보이면 기본 선택
      if (/blackhole/i.test(d.label)) opt.selected = true;
    }
  });
}

navigator.mediaDevices.addEventListener?.('devicechange', populateDevices);

// ---------------------------------------------------------------------------
// 오디오 캡처 파이프라인 (마이크 or 탭 오디오 → WS 로 PCM 전송)
// ---------------------------------------------------------------------------
class Capture {
  constructor(role, dot) {
    this.role = role;
    this.dot = dot;
    this.active = false;
    this.ws = null;
    this.audioContext = null;
    this.stream = null;
    this.workletNode = null;
    this.source = null;
  }

  async start(stream) {
    this.stream = stream;

    // WebSocket 연결
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/?role=${this.role}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (e) => handleServerMessage(e.data);
    this.ws.onclose = () => {
      if (this.active) setStatus(`[${this.role}] 서버 연결 끊김`);
    };

    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    // 16kHz AudioContext (브라우저가 리샘플링 처리)
    this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    await this.audioContext.audioWorklet.addModule('/pcm-worklet.js');

    this.source = this.audioContext.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');
    this.workletNode.port.onmessage = (e) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(e.data);
      }
    };
    this.source.connect(this.workletNode);
    // worklet 출력을 destination 에 연결하지 않아 소리는 재생되지 않음(캡처 전용)

    this.active = true;
    this.dot.classList.add('on');
  }

  stop() {
    this.active = false;
    this.dot.classList.remove('on');
    if (this.workletNode) this.workletNode.disconnect();
    if (this.source) this.source.disconnect();
    if (this.audioContext) this.audioContext.close();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ws) this.ws.close();
    this.ws = null;
    this.audioContext = null;
    this.stream = null;
  }
}

const interviewerCapture = new Capture('interviewer', els.interviewerDot);
const intervieweeCapture = new Capture('interviewee', els.intervieweeDot);

// ---------------------------------------------------------------------------
// 인터뷰어 마이크 시작/중지
// ---------------------------------------------------------------------------
els.interviewerBtn.addEventListener('click', async () => {
  if (interviewerCapture.active) {
    interviewerCapture.stop();
    els.interviewerBtn.textContent = '▶ 인터뷰어 마이크 시작';
    els.interviewerBtn.classList.remove('active');
    return;
  }
  try {
    const deviceId = els.micSelect.value;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    await interviewerCapture.start(stream);
    els.interviewerBtn.textContent = '■ 인터뷰어 마이크 중지';
    els.interviewerBtn.classList.add('active');
    setStatus('인터뷰어 마이크 인식 중… (한/영 → 중국어 음성)');
  } catch (err) {
    setStatus('마이크 시작 실패: ' + err.message);
  }
});

// ---------------------------------------------------------------------------
// 인터뷰이 캡처 시작/중지 (구글밋 탭 오디오 공유)
// ---------------------------------------------------------------------------
els.intervieweeBtn.addEventListener('click', async () => {
  if (intervieweeCapture.active) {
    intervieweeCapture.stop();
    els.intervieweeBtn.textContent = '▶ 인터뷰이 캡처 시작 (밋 탭 공유)';
    els.intervieweeBtn.classList.remove('active');
    return;
  }
  try {
    // 화면 공유 다이얼로그에서 "구글밋 탭"을 고르고 "탭 오디오 공유"를 켜야 함
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      setStatus('⚠️ 탭 오디오가 공유되지 않았습니다. 공유 창에서 "탭 오디오 공유"를 켜주세요.');
      return;
    }
    // 영상 트랙은 필요 없으니 정지 (오디오만 유지)
    stream.getVideoTracks().forEach((t) => t.stop());
    const audioOnly = new MediaStream(audioTracks);

    await intervieweeCapture.start(audioOnly);
    els.intervieweeBtn.textContent = '■ 인터뷰이 캡처 중지';
    els.intervieweeBtn.classList.add('active');
    setStatus('인터뷰이 캡처 중… (중국어 → 한/영 텍스트)');

    // 사용자가 브라우저 UI 로 공유를 멈추면 정리
    audioTracks[0].addEventListener('ended', () => {
      intervieweeCapture.stop();
      els.intervieweeBtn.textContent = '▶ 인터뷰이 캡처 시작 (밋 탭 공유)';
      els.intervieweeBtn.classList.remove('active');
    });
  } catch (err) {
    setStatus('탭 캡처 실패: ' + err.message);
  }
});

// ---------------------------------------------------------------------------
// 서버 메시지 처리 (자막 표시 + 중국어 TTS 재생)
// ---------------------------------------------------------------------------
function handleServerMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch (_) {
    return;
  }

  if (msg.type === 'interim') {
    const el = msg.role === 'interviewer' ? els.interviewerInterim : els.intervieweeInterim;
    el.textContent = msg.source;
    return;
  }

  if (msg.type === 'final') {
    if (msg.role === 'interviewer') {
      els.interviewerInterim.textContent = '';
      addInterviewerEntry(msg.source, msg.chinese);
    } else {
      els.intervieweeInterim.textContent = '';
      addIntervieweeEntry(msg.source, msg.korean, msg.english);
    }
    return;
  }

  if (msg.type === 'tts') {
    playTTS(msg.audio);
    return;
  }
}

function addInterviewerEntry(source, chinese) {
  const entry = document.createElement('div');
  entry.className = 'entry';
  entry.innerHTML = `
    <span class="time">${nowTime()}</span>
    <div class="src">${escapeHtml(source)}</div>
    <div class="primary" lang="zh">${escapeHtml(chinese)}</div>
  `;
  els.interviewerLog.appendChild(entry);
  els.interviewerLog.scrollTop = els.interviewerLog.scrollHeight;
}

function addIntervieweeEntry(source, korean, english) {
  const entry = document.createElement('div');
  entry.className = 'entry';
  entry.innerHTML = `
    <span class="time">${nowTime()}</span>
    <div class="src" lang="zh">${escapeHtml(source)}</div>
    <div class="primary"><span class="lang-tag">KO</span>${escapeHtml(korean)}</div>
    <div class="secondary"><span class="lang-tag">EN</span>${escapeHtml(english)}</div>
  `;
  els.intervieweeLog.appendChild(entry);
  els.intervieweeLog.scrollTop = els.intervieweeLog.scrollHeight;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// 중국어 TTS 재생 (선택한 출력 장치 = BlackHole 로 라우팅, 순차 재생)
// ---------------------------------------------------------------------------
let ttsQueue = Promise.resolve();

function playTTS(base64) {
  ttsQueue = ttsQueue.then(() => playOne(base64)).catch(() => {});
}

async function playOne(base64) {
  const outputId = els.outputSelect.value;

  const play = (deviceId) =>
    new Promise(async (resolve) => {
      const audio = new Audio('data:audio/mp3;base64,' + base64);
      audio.onended = resolve;
      audio.onerror = resolve;
      try {
        if (deviceId && typeof audio.setSinkId === 'function') {
          await audio.setSinkId(deviceId);
        }
        await audio.play();
      } catch (err) {
        setStatus('TTS 재생 오류: ' + err.message);
        resolve();
      }
    });

  // 1) BlackHole(선택 출력)로 인터뷰이에게 전달
  await play(outputId);

  // 2) 모니터 옵션이 켜져 있으면 기본 스피커로도 재생
  if (els.monitorTTS.checked) {
    await play('');
  }
}

// ---------------------------------------------------------------------------
// 초기화
// ---------------------------------------------------------------------------
populateDevices();
setStatus('준비 완료. 장치를 선택하고 시작 버튼을 누르세요.');
