# Optimization evidence

Run `pnpm exec architecture-kit optimize check --run-id pilot --json` to inventory TS/JS refactoring candidates and project scenarios. Use `--task rollout-oversized-page` for the bounded rollout probe. The matching post-change check adds `--from 001-check` using the actual prior round ID. Check tasks.md for scope, hypothesis and raw evidence. The rollout append/read gate requires better-sqlite3 compiled for the Node used by Vitest.

For renderer and turn measurements, point ACTION_DRIVER_OPTIMIZE_CAPTURE at an external capture descriptor. Store it in ignored storage. Keep raw inputs, descriptor and measured checkout together. The source object comes from `pnpm exec architecture-kit optimize capture -- stamp` **at capture time**. Record the browser/device/model versions, cache, fixture and warmup in environment and workload. Reuse these names and dimensions on repeat runs. Fill loading with the original measure-loading-performance.mjs report. For shell bytes supply the digest of the build log from that same fresh build. Turn inputs are turn-metrics JSONL. File paths are relative to the descriptor.

```json
{"source":{"commit":"…","diff":"…","untracked":"…"},"workload":"fixture + input size + cache policy","environment":"browser version, hardware or model and harness","loading":{"path":"loading.json","sha256":"…","buildLogSha256":"…"},"turn":{"path":"turns.jsonl","sha256":"…"}}
```

Absent or invalid captures produce incomplete tasks. The four GStreamer stages require a Linux desktop and real capture pipeline. Review and gate tasks can run independently of these external inputs.
