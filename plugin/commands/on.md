---
description: Turn Jeverb back on install-wide.
---

This Markdown command is not an executable TUI callback. Muse 1.4.14 does not provide trusted operator-origin evidence to UserPromptSubmit hooks, and Jeverb has no protected local control service. The hook consumes this exact prompt and refuses to change state. Do not invoke tools or a shell command for it. Explain that switching requires a trusted host control channel that is not yet available; do not attempt the control on the operator's behalf.
