import base64
import json
import os
import uuid
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler
from urllib import error, request


OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
TRANSCRIBE_MODEL = os.environ.get("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-transcribe")
TRANSLATE_MODEL = os.environ.get("OPENAI_TRANSLATE_MODEL", "gpt-4o")
TTS_MODEL = os.environ.get("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
ZH_VOICE = os.environ.get("OPENAI_ZH_VOICE", "alloy")
KO_VOICE = os.environ.get("OPENAI_KO_VOICE", "alloy")


TRANSCRIBE_PROMPT = """
This is a Google Meet interview with Korean, English, Mandarin Chinese, Taiwan Mandarin, Mainland Mandarin, and Cantonese speakers.
Common domain terms include interview, job interview, research interview, consent form, agreement, personal information, recording, participation, and schedule.
If the audio is silence, background noise, or only faint echo, return an empty transcription. Do not invent text from this prompt.
""".strip()


TRANSLATE_SYSTEM = """
You are a Google Meet interview interpreter.

Classify the source text as interviewer speech or respondent speech.

Rules:
- The user selects language 1 and language 2 before the session starts.
- Language 1 is the interviewer language: Korean, English, or Korean/English.
- Language 2 is the respondent language and the Chinese output language: Traditional Chinese / zh-Hant or Taiwan Mandarin / zh-TW.
- If the transcript is in language 1, translate it to accurate language 2 Chinese.
- If the transcript is Chinese, treat it as respondent speech and translate it to accurate Korean and English.
- Preserve the exact meaning, tense, aspect, modality, and whether an action is completed or currently happening.
- Do not paraphrase into a different question. For example, "읽어보셨나요?" means "have you read/reviewed it?", not "are you reading it now?"
- For interview consent forms, translate "동의서를 읽어보셨나요?" as asking whether the person has already read/reviewed the consent form.
- Prefer faithful interpretation over elegant wording. Keep legal/interview wording precise.
- For zh-Hant output, use Traditional Chinese characters and neutral Mandarin wording. Do not output Simplified Chinese.
- For zh-TW output, use Traditional Chinese characters and natural Taiwan Mandarin wording. Prefer Taiwan terms such as 資訊, 影片, 國語 when appropriate. Do not output Simplified Chinese.
- Preserve the original Chinese script in "original" when respondent speech is Chinese.
- Return only compact JSON.
- Use this schema for Korean/English:
  {"direction":"ko_en_to_zh","target_language":"zh-Hant|zh-TW","original":"...","zh":"..."}
- Use this schema for Chinese:
  {"direction":"zh_to_ko_en","target_language":"zh-Hant|zh-TW","original":"...","ko":"...","en":"..."}
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
            {"name": "prompt", "value": TRANSCRIBE_PROMPT},
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


SOURCE_LANGUAGE_LABELS = {
    "ko_en": "Korean or English",
    "ko": "Korean",
    "en": "English",
}


TARGET_CHINESE_LABELS = {
    "zh-Hant": "Traditional Chinese / zh-Hant",
    "zh-TW": "Taiwan Mandarin / zh-TW",
}


def translate(transcript, source_language="ko_en", target_chinese="zh-Hant"):
    source = source_language if source_language in SOURCE_LANGUAGE_LABELS else "ko_en"
    target = target_chinese if target_chinese in TARGET_CHINESE_LABELS else "zh-Hant"
    language_instruction = (
        f"Language 1: {SOURCE_LANGUAGE_LABELS[source]}.\n"
        f"Language 2: {TARGET_CHINESE_LABELS[target]}.\n"
        "Do not auto-select a different Chinese target. Use the selected language 2 style exactly."
    )
    payload = {
        "model": TRANSLATE_MODEL,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": TRANSLATE_SYSTEM},
            {"role": "user", "content": f"{language_instruction}\n\nTranscript:\n{transcript}"},
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


def interpret(audio, source_language="ko_en", target_chinese="zh-Hant"):
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is not set.")
    transcript = transcribe(audio)
    if len(transcript) < 2:
        return {"direction": "skip", "original": ""}
    result = translate(transcript, source_language, target_chinese)
    result["original"] = result.get("original") or transcript
    result["target_language"] = result.get("target_language") or target_chinese
    if result.get("direction") == "ko_en_to_zh":
        result["audio"] = synthesize(result.get("zh", ""), ZH_VOICE)
    return result


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            fields = parse_multipart(self.headers, self.rfile.read(length))
            audio = fields.get("audio")
            source_language = fields.get("source_language", {}).get("data", b"ko_en").decode("utf-8", "replace")
            target_chinese = fields.get("target_chinese", {}).get("data", b"zh-Hant").decode("utf-8", "replace")
            if not audio or not audio["data"]:
                raise RuntimeError("Audio file is missing.")
            payload = interpret(audio, source_language, target_chinese)
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
