import hashlib
import json
import os
import uuid
from http.server import BaseHTTPRequestHandler
from urllib import error, request


OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
REALTIME_MODEL = os.environ.get("OPENAI_REALTIME_MODEL", "gpt-realtime-2")
REALTIME_VOICE = os.environ.get("OPENAI_REALTIME_VOICE", "marin")


INSTRUCTIONS = """
You are a live Google Meet interpreter for interviews.

Listen continuously. Detect whether the latest speaker is using Korean, English, or Mandarin Chinese.

Rules:
- If the speaker uses Korean or English, they are the interviewer. Translate faithfully into natural Simplified Mandarin Chinese. Speak the Mandarin translation immediately.
- If the speaker uses Mandarin Chinese, they are the interviewee. Translate faithfully into Korean and English. Speak the Korean translation immediately. Do not speak the English translation.
- Also emit a compact JSON object in text so the UI can update immediately.
- The text response must be only JSON, with this schema:
  {"direction":"ko_en_to_zh","original":"...","zh":"..."}
  or
  {"direction":"zh_to_ko_en","original":"...","ko":"...","en":"..."}
- Preserve questions as questions. Do not invent missing details. If the audio is too unclear, ask for repetition in the target spoken language and include an empty original field.
""".strip()


def multipart_form(fields):
    boundary = f"----codexrealtime{uuid.uuid4().hex}"
    chunks = []
    for name, value, content_type in fields:
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n'.encode())
        if content_type:
            chunks.append(f"Content-Type: {content_type}\r\n".encode())
        chunks.append(b"\r\n")
        chunks.append(value.encode("utf-8") if isinstance(value, str) else value)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return boundary, b"".join(chunks)


def create_realtime_call(offer_sdp):
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is not set.")

    session = {
        "type": "realtime",
        "model": REALTIME_MODEL,
        "instructions": INSTRUCTIONS,
        "output_modalities": ["audio", "text"],
        "audio": {
            "input": {
                "transcription": {"model": "gpt-4o-mini-transcribe"},
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.55,
                    "prefix_padding_ms": 500,
                    "silence_duration_ms": 850,
                    "create_response": True,
                },
            },
            "output": {"voice": REALTIME_VOICE},
        },
    }
    boundary, body = multipart_form(
        [
            ("sdp", offer_sdp, "application/sdp"),
            ("session", json.dumps(session), "application/json"),
        ]
    )
    safety_id = hashlib.sha256(b"meet-interpreter-local-user").hexdigest()
    req = request.Request(
        "https://api.openai.com/v1/realtime/calls",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "OpenAI-Safety-Identifier": safety_id,
        },
    )
    try:
        with request.urlopen(req, timeout=90) as resp:
            return resp.read().decode("utf-8", "replace")
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"OpenAI Realtime error {exc.code}: {detail}") from exc


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            offer_sdp = self.rfile.read(length).decode("utf-8", "replace")
            answer_sdp = create_realtime_call(offer_sdp)
            data = answer_sdp.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/sdp")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:
            data = str(exc).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
