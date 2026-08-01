# stdin으로 받은 컨텍스트를 SessionStart hookSpecificOutput JSON으로 감싼다.
# 10,000자 제한 대비 9,000자에서 UTF-8 안전하게 절단한다.
import json
import sys

text = sys.stdin.buffer.read().decode("utf-8", errors="replace")
if len(text) > 9000:
    text = text[:9000] + "\n…(9,000자 초과로 절단됨)"

payload = json.dumps(
    {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": text,
        }
    },
    ensure_ascii=False,
)
# Windows 콘솔 기본 인코딩(cp949)을 우회해 UTF-8 바이트로 직접 쓴다
sys.stdout.buffer.write(payload.encode("utf-8") + b"\n")
