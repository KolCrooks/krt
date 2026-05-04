// data.jsx — sample PR/repo data (made-up generic project)
const SAMPLE_PRS = [
  {
    id: 4128,
    title: "Add streaming response cache with backpressure",
    repo: "core/api",
    branch: "feat/streaming-cache",
    base: "main",
    author: { handle: "marin.osei", name: "Marin Osei", initials: "MO", color: "oklch(0.85 0.06 30)" },
    status: "open",
    reviewState: "approved-1-of-2",
    plus: 412, minus: 88, files: 14, commits: 6,
    updated: "2h ago",
    labels: ["performance", "needs-runbook"],
    checks: { passed: 7, failed: 0, pending: 1 },
    youReviewed: false,
    description: "Adds a streaming response cache layer that respects downstream backpressure. Replaces the per-handler buffer with a shared, bounded ring keyed by request hash. Cache eviction is tier-aware so we don't drop in-flight chunks belonging to a long-running stream."
  },
  {
    id: 4127,
    title: "Refactor token bucket: replace ad-hoc throttle with TokenBucketCell",
    repo: "core/api",
    branch: "refactor/token-bucket",
    base: "main",
    author: { handle: "park.jisoo", name: "Park Ji-soo", initials: "PJ", color: "oklch(0.85 0.06 280)" },
    status: "open",
    reviewState: "needs-review",
    plus: 188, minus: 412, files: 22, commits: 11,
    updated: "5h ago",
    labels: ["refactor", "good-first-review"],
    checks: { passed: 6, failed: 0, pending: 2 },
    youReviewed: true, lastVersion: 8,
  },
  {
    id: 4124,
    title: "[INFRA-2207] Drain workers gracefully on rolling restart",
    repo: "infra/orchestrator",
    branch: "infra-2207-drain-workers",
    base: "main",
    author: { handle: "abebe.tariku", name: "Abebe Tariku", initials: "AT", color: "oklch(0.85 0.06 145)" },
    status: "open",
    reviewState: "changes-requested",
    plus: 76, minus: 23, files: 5, commits: 3,
    updated: "yesterday",
    labels: ["infra", "incident-followup"],
    checks: { passed: 8, failed: 1, pending: 0 },
    youReviewed: true, lastVersion: 4,
  },
  {
    id: 4119,
    title: "Bump tonic to 0.12 and migrate interceptor API",
    repo: "core/api",
    branch: "deps/tonic-0-12",
    base: "main",
    author: { handle: "renata.silva", name: "Renata Silva", initials: "RS", color: "oklch(0.85 0.06 200)" },
    status: "open",
    reviewState: "draft",
    plus: 612, minus: 538, files: 41, commits: 14,
    updated: "2d ago",
    labels: ["dependencies"],
    checks: { passed: 4, failed: 2, pending: 0 },
    youReviewed: false,
  },
  {
    id: 4116,
    title: "Wire SnapshotControl into hot path; remove legacy clone",
    repo: "core/storage",
    branch: "snapshot-control-hotpath",
    base: "main",
    author: { handle: "kwame.boateng", name: "Kwame Boateng", initials: "KB", color: "oklch(0.85 0.06 60)" },
    status: "open",
    reviewState: "needs-review",
    plus: 156, minus: 89, files: 9, commits: 5,
    updated: "3d ago",
    labels: ["storage"],
    checks: { passed: 8, failed: 0, pending: 0 },
    youReviewed: false,
  },
  {
    id: 4109,
    title: "Cell config v2: introduce EnforcementLevel enum",
    repo: "core/config",
    branch: "config/enforcement-level",
    base: "main",
    author: { handle: "lin.qiao", name: "Lin Qiao", initials: "LQ", color: "oklch(0.85 0.06 320)" },
    status: "merged",
    reviewState: "merged",
    plus: 287, minus: 92, files: 11, commits: 8,
    updated: "1w ago",
    labels: ["config", "breaking"],
    checks: { passed: 9, failed: 0, pending: 0 },
    youReviewed: true, lastVersion: 12,
  },
];

const RECENT_REPOS = [
  { name: "core/api", desc: "Edge gateway + request lifecycle", prs: 18 },
  { name: "core/storage", desc: "Tiered storage, snapshots, replication", prs: 7 },
  { name: "core/config", desc: "Cell topology + config rollout", prs: 4 },
  { name: "infra/orchestrator", desc: "Worker lifecycle & scheduling", prs: 11 },
  { name: "tools/review-cli", desc: "Internal review tooling", prs: 2 },
];

// PR detail — used for the "View" and "Review" modes for PR #4128
const PR_DETAIL = {
  ...SAMPLE_PRS[0],
  body: `## Summary

The current cache holds one buffer per in-flight request. Under spikes that flatten downstream consumers, we end up with a long tail of orphaned buffers that GC can't reclaim until the original request times out (default 60s).

This PR replaces that with a shared, bounded ring buffer keyed by **request hash**, with explicit backpressure signals propagated to upstream producers via a \`StreamPermit\`.

## Why

We hit this on Tuesday's 18:42 incident — when shard \`us-1.b\` slowed down, the upstream pool kept producing chunks and the cache RSS doubled in 90s. The new design caps total cache RSS at the configured \`cache.bytes\` limit and shifts the backpressure cost onto the producer instead of OOMing us.

## What's in here

1. **\`StreamPermit\`** — a small RAII handle in \`api/stream/permit.rs\`. Holding one is the contract that the cache has space for at least \`min_chunk\` bytes.
2. **\`RingCache\`** — the shared, hash-keyed ring. Replaces \`PerRequestBuffer\` in \`api/cache/mod.rs\`.
3. **Backpressure plumbing** — producers now \`await permit.reserve(n)\` before writing; on cache pressure this returns \`Pending\` and we ask upstream to slow.
4. **Tiered eviction** — long-running streams (>5s) get a "do-not-evict-mid-chunk" flag so we don't truncate them when a flood of short requests arrives.

## Risk / rollout

Behind \`feature_flags.streaming_cache_v2\`. Default off. Plan: enable in \`us-1.staging\` for 24h, watch \`cache.rss\`, \`stream.permit_wait_p99\`, and \`stream.dropped_chunks\`.

## Out of scope

- Distributed cache coherence — single-pod for now.
- Compression — separate PR (#4131).`,
  comments: [
    {
      id: "c1", author: { initials: "JC", name: "Jules Carter", color: "oklch(0.85 0.06 100)" },
      when: "1d ago", body: "Have you measured what happens if `min_chunk` is set above `cache.bytes / 4`? I'd expect every reservation to fail and we silently fall back to the old path.",
      replies: [
        { id: "c1r1", author: { initials: "MO", name: "Marin Osei", color: "oklch(0.85 0.06 30)" }, when: "1d ago", body: "Good catch — added a debug_assert and a config-validation step. If `min_chunk * 4 > cache.bytes` we refuse to start.", you: false }
      ],
    },
    {
      id: "c2", author: { initials: "RS", name: "Renata Silva", color: "oklch(0.85 0.06 200)" },
      when: "20h ago", body: "Tour mode walked me through this beautifully. The only thing I'd push back on: chapter 4 (\"tiered eviction\") is doing two things — the long-running flag *and* the per-tier counter. Consider splitting.",
      tour: true,
    },
    {
      id: "c3", author: { initials: "KB", name: "Kwame Boateng", color: "oklch(0.85 0.06 60)" },
      when: "6h ago", body: "+1 to splitting. Otherwise this is great. Approving once the assert lands.", approved: true,
    },
  ],
  // automation events: CI, bots, force-pushes, label changes
  automation: [
    { id:'a1', kind:'push',   actor:'marin.osei',     when:'2d ago', summary:'Pushed 4 commits', detail:'feat(cache): introduce StreamPermit · refactor(cache): RingCache · test: pressure paths · docs: changelog' },
    { id:'a2', kind:'ci',     actor:'github-actions', when:'2d ago', summary:'CI started · #1147', status:'running', detail:'5 jobs · runner: linux-x64-large' },
    { id:'a3', kind:'ci',     actor:'github-actions', when:'2d ago', summary:'ci/lint passed · 12s',          status:'ok' },
    { id:'a4', kind:'ci',     actor:'github-actions', when:'2d ago', summary:'ci/build passed · 1m 48s',      status:'ok' },
    { id:'a5', kind:'ci',     actor:'github-actions', when:'2d ago', summary:'ci/test passed · 4m 22s',       status:'ok' },
    { id:'a6', kind:'ci',     actor:'github-actions', when:'2d ago', summary:'ci/integration passed · 8m 11s', status:'ok' },
    { id:'a7', kind:'bot',    actor:'codecov[bot]',   when:'2d ago', summary:'Coverage 91.2% (+0.4%)',         detail:'New tests for permit_lifecycle and cache_pressure raised coverage on api/cache/*.' },
    { id:'a8', kind:'label',  actor:'jules.carter',   when:'1d ago', summary:'Added label needs-review' },
    { id:'a9', kind:'push',   actor:'marin.osei',     when:'1d ago', summary:'Force-pushed · rebased on main', detail:'rebase onto a3f1c9 · resolved trivial conflict in CHANGELOG.md' },
    { id:'a10',kind:'ci',     actor:'github-actions', when:'1d ago', summary:'CI re-running · #1149',          status:'running' },
    { id:'a11',kind:'bot',    actor:'sentry-pr[bot]', when:'1d ago', summary:'No new issues vs. main',         detail:'Compared against base branch over the last 24h.' },
    { id:'a12',kind:'review', actor:'kwame.boateng',  when:'6h ago', summary:'Requested changes · resolved'    },
    { id:'a13',kind:'ci',     actor:'github-actions', when:'2h ago', summary:'ci/perf-bench running…',         status:'running', detail:'Estimated 18m. Comparing against baseline e7c2.' },
  ],
  reviewers: [
    { initials: "JC", name: "jules.carter", state: "approved" },
    { initials: "RS", name: "renata.silva", state: "commented" },
    { initials: "KB", name: "kwame.boateng", state: "pending" },
    { initials: "AT", name: "abebe.tariku", state: "pending" },
  ],
  files: [
    { path: "api/cache/mod.rs", plus: 142, minus: 38, status: "modified" },
    { path: "api/cache/ring.rs", plus: 211, minus: 0, status: "added" },
    { path: "api/cache/per_request.rs", plus: 0, minus: 184, status: "deleted" },
    { path: "api/stream/permit.rs", plus: 156, minus: 0, status: "added" },
    { path: "api/stream/mod.rs", plus: 28, minus: 12, status: "modified" },
    { path: "api/stream/producer.rs", plus: 47, minus: 22, status: "modified" },
    { path: "api/handlers/get.rs", plus: 18, minus: 9, status: "modified" },
    { path: "api/handlers/list.rs", plus: 12, minus: 7, status: "modified" },
    { path: "config/feature_flags.rs", plus: 4, minus: 0, status: "modified" },
    { path: "config/cache.rs", plus: 22, minus: 6, status: "modified" },
    { path: "tests/cache_pressure.rs", plus: 184, minus: 0, status: "added" },
    { path: "tests/permit_lifecycle.rs", plus: 96, minus: 0, status: "added" },
    { path: "metrics/cache.rs", plus: 18, minus: 4, status: "modified" },
    { path: "CHANGELOG.md", plus: 6, minus: 0, status: "modified" },
  ],
};

// AI Tour chapters for PR #4128
const TOUR_CHAPTERS = [
  {
    id: "ch1",
    title: "StreamPermit — the new backpressure primitive",
    files: ["api/stream/permit.rs"],
    plus: 156, minus: 0,
    summary: "An RAII handle that producers must hold before writing into the cache. `reserve(n)` returns `Pending` when the cache has no room — the executor then naturally slows the upstream task. Drop releases bytes back to the ring.",
    bullets: [
      "Producers no longer write into a per-request buffer; they await `permit.reserve(n)` first.",
      "On cache pressure, `reserve` parks the task until eviction frees space.",
      "Drop semantics make leaks impossible — even on panic, the bytes are returned.",
    ],
    diffFile: 0,
    sensitive: true,
    sensitiveReason: "New concurrency primitive on the hot path. Verify drop semantics under panic and confirm `reserve` cannot deadlock if `pressure` notify is missed.",
  },
  {
    id: "ch2",
    title: "RingCache replaces PerRequestBuffer",
    files: ["api/cache/ring.rs", "api/cache/per_request.rs", "api/cache/mod.rs"],
    plus: 353, minus: 222,
    summary: "The shared, hash-keyed ring. Bounded by `cache.bytes`. Old `PerRequestBuffer` is deleted in full — a +211 / −184 net swap, plus 142 lines of glue in `mod.rs`.",
    bullets: [
      "Insertion is keyed by `BlobHash`, so identical streams dedupe naturally.",
      "Eviction policy is tier-aware (chapter 4).",
      "All `cache_pressure` test cases pass on the new path; old code is gone.",
    ],
    diffFile: 1,
  },
  {
    id: "ch3",
    title: "Producer plumbing — await before write",
    files: ["api/stream/producer.rs", "api/stream/mod.rs"],
    plus: 75, minus: 34,
    summary: "Producers now ask the cache for permission before they write. The change is mostly mechanical — every `cache.write(buf)` becomes `let p = cache.reserve(buf.len()).await; cache.write(&p, buf)`.",
    bullets: [
      "All write sites updated; one removed entirely (the old fast-path was dead).",
      "Error type unchanged — `reserve` returns the same `CacheError`.",
    ],
    diffFile: 5,
  },
  {
    id: "ch4",
    title: "Tiered eviction — protect long streams",
    files: ["api/cache/ring.rs"],
    plus: 86, minus: 0,
    summary: "Streams older than 5s get a `do_not_truncate_mid_chunk` flag. A flood of short requests can no longer evict the middle of an in-flight long stream. (Renata flagged this for split — doing two things at once.)",
    bullets: [
      "New `StreamTier` enum: `Short`, `Long`.",
      "Eviction picks `Short` first, falls back to `Long` only at total exhaustion.",
      "Per-tier counters are emitted as `cache.rss_by_tier`.",
    ],
    flagged: true,
    sensitive: true,
    sensitiveReason: "Eviction policy change affects in-flight long streams. Edge cases around tier transitions need careful review.",
    diffFile: 1,
  },
  {
    id: "ch5",
    title: "Config + feature flag",
    files: ["config/feature_flags.rs", "config/cache.rs"],
    plus: 26, minus: 6,
    summary: "Behind `feature_flags.streaming_cache_v2`, default off. `cache.bytes` and `cache.min_chunk` are validated at startup — we refuse to boot if `min_chunk * 4 > cache.bytes` (Jules's catch).",
    bullets: ["Old `cache.per_request_bytes` is removed.", "Validation runs in `Config::validate()`."],
    diffFile: 8,
  },
  {
    id: "ch6",
    title: "Tests + observability",
    files: ["tests/cache_pressure.rs", "tests/permit_lifecycle.rs", "metrics/cache.rs"],
    plus: 298, minus: 4,
    summary: "Two new test files exercise the pressure paths. `metrics/cache.rs` adds `permit_wait`, `dropped_chunks`, and `rss_by_tier`.",
    bullets: [
      "`cache_pressure.rs` simulates the Tuesday incident with a paused consumer.",
      "`permit_lifecycle.rs` verifies drop-on-panic returns bytes.",
      "All four new metrics have alarm wiring in `runbook/cache.md` (separate PR).",
    ],
    diffFile: 10,
  },
];

// Sample diff content — used by both standard diff view and AI tour
const DIFF_FILES = [
  {
    path: "api/stream/permit.rs",
    lang: "rust",
    plus: 156, minus: 0,
    hunks: [
      {
        header: "@@ -0,0 +1,38 @@",
        newStart: 1,
        oldStart: 0,
        lines: [
          { t: "+", n: 1, c: "use std::sync::Arc;" },
          { t: "+", n: 2, c: "use tokio::sync::Notify;" },
          { t: "+", n: 3, c: "" },
          { t: "+", n: 4, c: "/// RAII handle: holding one means the cache has reserved", note: "doc explains the invariant" },
          { t: "+", n: 5, c: "/// `bytes` for this writer." },
          { t: "+", n: 6, c: "pub struct StreamPermit {" },
          { t: "+", n: 7, c: "    bytes: usize," },
          { t: "+", n: 8, c: "    cache: Arc<RingCache>," },
          { t: "+", n: 9, c: "}" },
          { t: "+", n: 10, c: "" },
          { t: "+", n: 11, c: "impl StreamPermit {" },
          { t: "+", n: 12, c: "    pub async fn reserve(cache: Arc<RingCache>, bytes: usize) -> Self {", note: "the await point — backpressure lives here" },
          { t: "+", n: 13, c: "        loop {" },
          { t: "+", n: 14, c: "            if cache.try_reserve(bytes) {" },
          { t: "+", n: 15, c: "                return Self { bytes, cache };" },
          { t: "+", n: 16, c: "            }" },
          { t: "+", n: 17, c: "            cache.pressure.notified().await;" },
          { t: "+", n: 18, c: "        }" },
          { t: "+", n: 19, c: "    }" },
          { t: "+", n: 20, c: "}" },
          { t: "+", n: 21, c: "" },
          { t: "+", n: 22, c: "impl Drop for StreamPermit {", note: "Drop returns bytes — leak-proof on panic" },
          { t: "+", n: 23, c: "    fn drop(&mut self) {" },
          { t: "+", n: 24, c: "        self.cache.release(self.bytes);" },
          { t: "+", n: 25, c: "    }" },
          { t: "+", n: 26, c: "}" },
        ],
      },
    ],
  },
  {
    path: "api/cache/mod.rs",
    lang: "rust",
    plus: 142, minus: 38,
    hunks: [
      {
        header: "@@ -12,18 +12,22 @@ use crate::stream::StreamPermit;",
        newStart: 12, oldStart: 12,
        lines: [
          { t: " ", n: 12, c: "pub struct CacheConfig {" },
          { t: " ", n: 13, c: "    pub bytes: usize,"},
          { t: "-", n: 14, c: "    pub per_request_bytes: usize,", oldN: 14 },
          { t: "+", n: 14, c: "    pub min_chunk: usize," },
          { t: "+", n: 15, c: "    pub allow_long_stream_protection: bool," },
          { t: " ", n: 16, c: "}" },
          { t: " ", n: 17, c: "" },
          { t: "-", n: 18, c: "pub struct PerRequestBuffer { /* ... */ }", oldN: 16 },
          { t: "+", n: 18, c: "pub struct RingCache {" },
          { t: "+", n: 19, c: "    inner: Mutex<RingInner>," },
          { t: "+", n: 20, c: "    pub(crate) pressure: Notify," },
          { t: "+", n: 21, c: "}" },
        ],
      },
      {
        header: "@@ -84,12 +88,18 @@ impl Cache for RingCache {",
        newStart: 88, oldStart: 84,
        lines: [
          { t: " ", n: 88, c: "    fn write(&self, p: &StreamPermit, buf: &[u8]) -> Result<()> {" },
          { t: "-", n: 89, c: "        // old: unbounded write", oldN: 85 },
          { t: "-", n: 90, c: "        self.inner.lock().push(buf);", oldN: 86 },
          { t: "+", n: 89, c: "        debug_assert!(p.bytes >= buf.len());", note: "permit guarantees space" },
          { t: "+", n: 90, c: "        let mut inner = self.inner.lock();" },
          { t: "+", n: 91, c: "        inner.push_with_tier(buf, p.tier())?;" },
          { t: " ", n: 92, c: "        Ok(())" },
          { t: " ", n: 93, c: "    }" },
        ],
      },
    ],
  },
  {
    path: "api/cache/ring.rs",
    lang: "rust",
    plus: 211, minus: 0,
    hunks: [
      {
        header: "@@ -0,0 +1,24 @@",
        newStart: 1, oldStart: 0,
        lines: [
          { t: "+", n: 1, c: "use std::collections::VecDeque;" },
          { t: "+", n: 2, c: "" },
          { t: "+", n: 3, c: "#[derive(Clone, Copy)]" },
          { t: "+", n: 4, c: "pub enum StreamTier {" },
          { t: "+", n: 5, c: "    Short," },
          { t: "+", n: 6, c: "    Long,", note: ">5s old; protected from mid-chunk truncation" },
          { t: "+", n: 7, c: "}" },
          { t: "+", n: 8, c: "" },
          { t: "+", n: 9, c: "pub(crate) struct RingInner {" },
          { t: "+", n: 10, c: "    short: VecDeque<Slot>," },
          { t: "+", n: 11, c: "    long:  VecDeque<Slot>," },
          { t: "+", n: 12, c: "    bytes: usize," },
          { t: "+", n: 13, c: "    cap: usize," },
          { t: "+", n: 14, c: "}" },
          { t: "+", n: 15, c: "" },
          { t: "+", n: 16, c: "impl RingInner {" },
          { t: "+", n: 17, c: "    pub fn evict(&mut self) -> Option<BlobHash> {" },
          { t: "+", n: 18, c: "        // short tier first; long only at total exhaustion", note: "the safety property in plain English" },
          { t: "+", n: 19, c: "        self.short.pop_front()" },
          { t: "+", n: 20, c: "            .or_else(|| self.long.pop_front())" },
          { t: "+", n: 21, c: "            .map(|s| s.hash)" },
          { t: "+", n: 22, c: "    }" },
          { t: "+", n: 23, c: "}" },
        ],
      },
    ],
  },
];

Object.assign(window, { SAMPLE_PRS, RECENT_REPOS, PR_DETAIL, TOUR_CHAPTERS, DIFF_FILES });
