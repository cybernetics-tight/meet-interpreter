# Meet Interpreter

Google Meet에 봇을 초대하지 않고, Meet 탭 오디오와 내 마이크를 받아 실시간 통역하는 로컬/배포용 MVP입니다.

## 실행

```bash
cd /Users/hong-eunji/Documents/Codex/2026-07-06/new-chat/outputs/meet-interpreter
OPENAI_API_KEY="your_api_key_here" python3 server.py
```

## Vercel 배포

Vercel 프로젝트의 Environment Variables에 `OPENAI_API_KEY`를 추가하세요. 팀원들은 배포된 URL만 열면 됩니다.

```bash
vercel
vercel env add OPENAI_API_KEY production
vercel --prod
```

브라우저에서 `http://localhost:8765`를 열고 `오디오 선택`을 누른 뒤 Google Meet 탭을 선택하세요. Chrome의 선택 창에서 탭 오디오 공유가 켜져 있어야 합니다.

## 동작

- 한국어 또는 영어가 들리면 interviewer 발화로 보고 중국어 번역을 즉시 음성으로 재생합니다.
- 중국어가 들리면 interviewee 답변으로 보고 한국어 음성을 재생하고 한국어/영어 텍스트를 표시합니다.
- OpenAI Realtime API와 WebRTC를 사용합니다. 이전 버전처럼 10초/20초 단위로 파일을 업로드하지 않습니다.

## 모델 설정

환경변수로 모델을 바꿀 수 있습니다.

```bash
OPENAI_REALTIME_MODEL="gpt-realtime-2.1"
OPENAI_REALTIME_VOICE="marin"
```

## 한계

- 설치 없이 시스템 전체 오디오를 조용히 캡처하는 방식은 macOS 권한과 오디오 드라이버 제약이 있습니다. 이 MVP는 브라우저의 탭 오디오 공유 기능을 사용합니다.
- Chrome에서 가장 잘 동작합니다.
- Realtime API 사용 권한, 결제, rate limit의 영향을 받습니다.
