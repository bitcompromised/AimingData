# Implementation status

Implemented: raw collector, HTTP API, Node session orchestration, persistence, live dashboard, replay shell, statistics shell.

Not implemented because they require game-specific data or visual calibration: Riot Match API synchronization, round boundaries, death detection, aim-target ground truth, weapon/headshot statistics.

The supplied spec explicitly treats these as later phases and says the first MVP should be Python input capture → timestamps → Node requests `[T1,T2]` → JSON round file → website trajectory/timeline → variable-speed replay.
