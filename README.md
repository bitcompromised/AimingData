# Mouse-Stats — functional MVP

This version is an executable vertical slice rather than a static UI mockup.

## Run on Windows
Requirements: Python 3.11+ and Node.js 20+.

```powershell
py run.py
```

Open `http://127.0.0.1:3001` if it does not open automatically.

## What works
- Windows low-level mouse hook
- Windows low-level keyboard hook
- high-resolution monotonic timestamps
- bounded in-memory raw event buffer
- localhost collector API
- Node orchestration API
- start/stop/save sessions
- JSON session persistence
- live dashboard metrics
- saved session browser
- timestamped raw-event replay visualization
- statistics over saved raw events
- collector status/settings

## Important boundary
Game-specific round synchronization, Match API integration, and visual death detection are intentionally adapters still to be implemented. The collector does not understand Valorant. This follows the supplied specification: raw input is retained independently, while round/death metadata is synchronized in the core layer.

The collector uses low-level Windows hooks only to observe input and calls CallNextHookEx; it does not inject, alter, or block input.
