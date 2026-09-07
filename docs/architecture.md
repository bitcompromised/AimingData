# Architecture

```text
Windows input hooks
       ↓
Python collector
       ↓ localhost HTTP
Node.js core
       ↓
JSON session storage
       ↓
Browser UI
```

The collector only records raw input. It does not inspect game memory, inject into the game, or determine Valorant state. Round synchronization and death detection are core-layer adapters. Raw data remains the source of truth so analysis algorithms can change later.
