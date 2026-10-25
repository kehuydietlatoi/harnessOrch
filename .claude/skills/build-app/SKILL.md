---
name: build-app
description: Build harnessOrch into a runnable Windows app (release/win-unpacked/harnessOrch.exe) without npm run desktop.
disable-model-invocation: true
---

Build the desktop app as an executable.

1. From the repo root run `npm run app` in the foreground (timeout 10 minutes).
2. If it stops with "harnessOrch.exe is running", tell the user to close the app and run `/build-app` again. Do not kill the process yourself.
3. On success, report the path `release\win-unpacked\harnessOrch.exe` and the build time.
4. On failure, show the failing step and the error lines. Do not retry blindly.
5. Do not commit anything.
