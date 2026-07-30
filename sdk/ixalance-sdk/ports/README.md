# SDK production ports

- `square/` — Square by Pulse, rebuilt from its released Win32-port source as
  an SDK-backed iXalance guest.

Each port keeps only production-specific compatibility code here; reusable
host ABI, video, timing, music, memory, libc, math, and packaging support
belongs in the parent SDK.
