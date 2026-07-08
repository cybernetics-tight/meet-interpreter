import base64
import json
import os
import uuid
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler
from urllib import error, request


OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
TRANSCRIBE_MODEL = os.environ.get("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe")
TRANSLATE_MODEL = os.environ.get("OPENAI_TRANSLATE_MODEL", "gpt-4o-mini")
TTS_MODEL = os.environ.get("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
ZH_VOICE = os.environ.get("OPENAI_ZH_VOICE", "alloy")
KO_VOICE = os.environ.get("OPENAI_KO_VOICE", "alloy")


TRANSLATE_SYSTEM = """
You are a Google Meet interview interpreter.

Classify the source text as Korean, English, Mandarin Chinese, or unclear.

Rules:
- Korean or English means the interviewer is asking. Translate it to natural Simplified Mandarin Chinese.
- Mandarin Chinese means the interviewee is answering. Translate it to Korean and English.
- Return only compact JSON.
- Use this schema for Korean/English:
  {"direction":"ko_en_to_zh","original":"...","zh":"..."}
- Use this schema for Chinese:
  {"direction":"zh_to_ko_en","original":"...","ko":"...","en":"..."}
- If the text is empty, noise, or too unclear:
  {"direction":"skip","original":""}
- Preserve questions as questions. Do not invent details.
""".strip()


def make_multipart(fields):
    boundary = f"----meetinterpreter{uuid.uuid4().hex}"
    body = []
    for field in fields:
        name = field["name"]
        value = field["value"]
        filename = field.get("filename")
        content_type = field.get("content_type")
        body.append(f"--{boundary}\r\n".encode())
        disposition = f'Content-Disposition: form-data; name="{name}"'
        if filename:
            disposition += f'; filename="{filename}"'
        body.append(f"{disposition}\r\n".encode())
        if content_type:
            body.append(f"Content-Type: {content_type}\r\n".encode())
        body.append(b"\r\n")
        body.append(value.encode("utf-8") if isinstance(value, str) else value)
        body.append(b"\r\n")
    body.append(f"--{boundary}--\r\n".encode())
    return boundary, b"".join(body)


def parse_multipart(headers, body):
    content_type = headers.get("Content-Type", "")
    message = BytesParser(policy=default).parsebytes(
        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
    )
    result = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        result[name] = {
            "data": part.get_payload(decode=True) or b"",
            "filename": part.get_filename() or "audio.webm",
            "content_type": part.get_content_type() or "application/octet-stream",
        }
    return result


def openai_request_json(url, payload, timeout=45):
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
    )
    with request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def transcribe(audio):
    boundary, body = make_multipart(
        [
            {"name": "model", "value": TRANSCRIBE_MODEL},
            {"name": "response_format", "value": "json"},
            {
                "name": "file",
                "value": audio["data"],
                "filename": audio["filename"],
                "content_type": audio["content_type"],
            },
        ]
    )
    req = request.Request(
        "https://api.openai.com/v1/audio/transcriptions",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    with request.urlopen(req, timeout=45) as resp:
        payload = json.loads(resp.read().decode("utf-8", "replace"))
    return (payload.get("text") or "").strip()


def translate(transcript):
    payload = {
        "model": TRANSLATE_MODEL,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": TRANSLATE_SYSTEM},
            {"role": "user", "content": transcript},
        ],
    }
    data = openai_request_json("https://api.openai.com/v1/chat/completions", payload)
    content = data["choices"][0]["message"]["content"]
    return json.loads(content)


def synthesize(text, voice):
    if not text:
        return ""
    payload = {
        "model": TTS_MODEL,
        "voice": voice,
        "input": text,
        "response_format": "mp3",
    }
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(
        "https://api.openai.com/v1/audio/speech",
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
    )
    with request.urlopen(req, timeout=45) as resp:
        return base64.b64encode(resp.read()).decode("ascii")


def interpret(audio):
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is not set.")
    transcript = transcribe(audio)
    if len(transcript) < 2:
        return {"direction": "skip", "original": ""}
    result = translate(transcript)
    result["original"] = result.get("original") or transcript
    if result.get("direction") == "ko_en_to_zh":
        result["audio"] = synthesize(result.get("zh", ""), ZH_VOICE)
    return result


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            fields = parse_multipart(self.headers, self.rfile.read(length))
            audio = fields.get("audio")
            if not audio or not audio["data"]:
                raise RuntimeError("Audio file is missing.")
            payload = interpret(audio)
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            message = f"OpenAI API error {exc.code}: {detail}"
            data = json.dumps({"error": message}, ensure_ascii=False).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:
            data = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
