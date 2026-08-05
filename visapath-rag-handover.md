# VisaPath RAG Implementation — Handover for Claude Code

**Owner:** Neulab / Eri Adrian
**Target repo:** `~/Desktop/visapath/` (git: github.com/jolor69/visapath, public)
**Domain:** visapath.neulab.xyz
**Current stack:** Cloudflare Worker + Pages, DeepSeek V3 via OpenRouter, KV rate limiting (5 checks/day free), 195-country visa checker

---

## 0. Why this exists (context for Claude Code, not marketing copy)

VisaPath currently answers visa questions from DeepSeek V3's parametric knowledge — no grounding, no citations, no way to verify an answer is current. Visa rules change (often), and a wrong answer here has real consequences: a denied boarding, a missed connection, an overstay fine. This is the highest-stakes hallucination surface in the Neulab portfolio. RAG fixes this by forcing every answer to be generated from retrieved, sourced, dated rule text — not the model's memory.

This doc covers two deliverables:
1. RAG backend for the visa checker (grounded answers + citations)
2. A landing page section explaining "why RAG" to prospective users (trust/marketing angle)

---

## 1. CRITICAL OPEN DECISION — data source (resolve before building)

**This is the part that matters more than the Cloudflare plumbing.** RAG quality is capped by corpus quality. Do not start ingestion pipeline work until this is decided:

| Option | Pros | Cons |
|---|---|---|
| IATA Timatic API | Industry-standard, airline-grade accuracy | Paid, licensing terms may restrict resale/display — verify before committing |
| Government travel advisory sites (embassy/immigration sites, scraped) | Free, authoritative per-country | Inconsistent formats across 195 countries, scraping fragility, translation overhead, staleness risk between scrapes |
| Commercial aggregators (Sherpa, VisaHQ, Passport Index, etc.) | Structured, easier to parse | Licensing/ToS risk if scraped without permission; accuracy not guaranteed |
| Hybrid: government sources for top 30-50 traveled-to countries + aggregator/LLM fallback for the rest | Ships faster, concentrates accuracy where volume is | Inconsistent quality across the corpus; needs clear "verified vs unverified" labeling to users |

**DECIDED: hybrid approach.** Official government/embassy sources for the top 30-50 most-traveled-to countries, aggregator fallback for the rest. Every answer must show its source tier (official vs. aggregator) in the citation — this is also a trust feature on the landing page (see Section 5).

**Before ingestion starts, Claude Code should:**
- Derive the "top 30-50" country list from actual data (most-searched passport/destination pairs — Passport Index, IATA traffic stats, or VisaPath's own usage logs if any exist yet), not intuition. Flag back to Eri if no good data source is available and a placeholder list is being used instead.
- Add `source_tier` as a tracked field per country in `ingestion_log` (see Section 3) — not just chunk counts. A country silently downgrading from official to aggregator tier on a future ingestion run (e.g. an official source starts failing to fetch and the pipeline falls back) must be visible in the log, not buried. Consider alerting Eri (or at minimum surfacing in an admin view) on any tier downgrade.

**Do not scrape or ingest without checking each source's ToS.** Flag any source with unclear licensing back to Eri rather than proceeding.

---

## 2. Architecture (Cloudflare-native)

```
Ingestion (scheduled, not per-request):
  Cron Trigger (Worker) → fetch/scrape source docs → chunk → embed → write to Vectorize + D1

Query (per-request):
  User query → Worker → embed query → Vectorize.query(topK, filter: country_code)
  → retrieve chunks + metadata from D1 → build grounded prompt → DeepSeek V3 (OpenRouter)
  → response with inline citations → return to frontend
```

### Cloudflare resources needed
- **Vectorize index**: `visapath-rules` — confirm embedding model dimension before creating (OpenAI `text-embedding-3-small` = 1536 dims; if switching to Workers AI `bge-base-en-v1.5` = 768 dims, cheaper but lower retrieval quality — recommend staying OpenAI for accuracy given the stakes here)
- **D1 table** `rule_chunks`: `id, country_code, source_url, source_tier (official|aggregator), chunk_text, last_verified_date, vector_id`
- **D1 table** `ingestion_log`: `run_id, started_at, source, chunks_added, chunks_updated, errors`
- **R2 bucket** `visapath-raw-sources`: store raw fetched HTML/PDF per source for audit trail and re-chunking without re-scraping
- **Cron Trigger**: weekly re-ingestion sweep (visa rules don't change daily; don't over-engineer freshness)
- **KV**: keep existing rate limiting as-is

### Account
Run `wrangler whoami` before any deploy — confirm which of the 4 Cloudflare accounts (ai.neulab.inc / joe.lord.ai / neuralstocks.dev / trendpulse.nw) VisaPath's existing Worker lives under, and create Vectorize/D1/R2 resources under that same account. Do not assume — verify first per standing infra rule.

---

## 3. Ingestion pipeline (build order)

1. **Source fetch** — per-country fetch job, respecting each source's ToS/rate limits. Store raw doc in R2 with `{country_code}/{source}/{date}.html`.
2. **Chunking** — target ~300-500 tokens per chunk, chunk boundaries on rule sections (visa type, duration, requirements) not arbitrary character counts. Preserve `country_code` and `source_tier` as chunk metadata — this is required for query-time filtering.
3. **Embedding** — OpenAI `text-embedding-3-small`, called from the ingestion Worker (not client-side).
4. **Write** — upsert to Vectorize (vector + id) and D1 (metadata + chunk text). Use `last_verified_date` to support "as of" language in answers.
5. **Diffing** — on re-ingestion, compare new chunk text to existing; only re-embed changed chunks (saves embedding cost and avoids unnecessary Vectorize churn).

---

## 4. Query-time flow

1. User submits query with origin/destination country + optional free-text question.
2. Worker embeds the query text.
3. `Vectorize.query()` with `filter: { country_code: destination }`, `topK: 6`.
4. Fetch matching chunk text + metadata from D1 by vector id.
5. Build prompt for DeepSeek V3 (OpenRouter) that:
   - Includes retrieved chunks with source + date
   - Explicitly instructs the model to only answer from provided chunks, and to say "I don't have current information on this" rather than fill gaps from parametric knowledge
   - Requires inline citation markers per claim
6. Return answer + citation list (source name, URL, last_verified_date) to frontend.
7. **Display source_tier and last_verified_date visibly in the UI** — this is both a trust feature and honesty about the hybrid corpus limitation from Section 1.

---

## 5. Landing page — "why RAG" marketing section

Goal: turn the RAG implementation into a trust differentiator, not a technical footnote. Target audience is non-technical travelers — avoid jargon like "vector database" or "embeddings" in user-facing copy.

**Section placement:** below the hero/checker tool, above testimonials or FAQ.

**Content direction (Claude Code should draft actual copy, but hit these points):**
- Plain-language framing: "Most AI travel tools guess. VisaPath checks." — contrast against generic chatbot answers.
- Explain that every answer is backed by a real, dated source — not the AI's memory, which can be wrong or outdated.
- Show the citation/source-tier UI as visual proof, not just a claim — a small mockup or live example embedded on the landing page (real screenshot of an answer with visible citations) is more convincing than a paragraph of copy.
- Include the `last_verified_date` angle — "verified as of [date]" builds more trust than "AI-powered."
- Do NOT claim 100% accuracy or use language implying legal/immigration advice — add a visible disclaimer ("VisaPath provides informational guidance, not legal advice; always confirm with official embassy sources before travel") given the stakes discussed in Section 1. This protects Eri legally and is honest about the hybrid-source limitation.

**Technical note for Claude Code:** if the landing page is a single-file HTML app, follow the standing JS constraints (no backticks, no template literals, no async/await, no optional chaining, `document.createElement` only, no CDN/React unless already used elsewhere on the page) and run `node --check` before marking it deploy-safe.

---

## 6. Cost estimate (rough, for Eri's awareness — not a blocker)

- Vectorize: free tier covers 30M queried / 5M stored dimensions/month. Even at 195 countries × ~50 chunks × 1536 dims ≈ 15M stored dimensions — likely stays within or just above free tier. Query cost at low VisaPath traffic volumes: negligible, sub-$5/month.
- Embedding (OpenAI): ingestion-time only, not per-user-query cost. One-time corpus build + weekly diff-based re-embedding — expect low single-digit dollars/month.
- DeepSeek V3 generation cost: unchanged from current setup, just with a longer grounded prompt (more input tokens per call — check OpenRouter DeepSeek input pricing if call volume is high).
- **Bottom line: Cloudflare/embedding costs are not the constraint here. Data sourcing effort (Section 1) is.**

---

## 7. Open questions for Eri (resolve before or during build, flag if blocking)

1. ~~Which data source strategy~~ — **RESOLVED: hybrid** (see Section 1). Still need the actual "top 30-50 countries" list sourced from real usage/traffic data, not a guess — flag to Eri if no such data exists yet.
2. Confirm Cloudflare account for VisaPath (`wrangler whoami`).
3. Legal disclaimer wording — draft one, but Eri should approve before shipping given the stakes.
4. Re-ingestion cadence — weekly assumed above; adjust if visa rule volatility for target countries is known to be higher.
5. Should source_tier/last_verified_date be visible in the free-tier checker, or only in a paid tier as a trust upsell?
6. Tier-downgrade alerting (Section 1) — email/Telegram notification, admin dashboard flag, or is a log entry sufficient for now?

---

## 8. Deploy note (per standing workflow)

Once Claude Code has built this: output all changed files, then provide **one single CLI command** to copy from `~/Downloads` into `~/Desktop/visapath/` and deploy — not multiple separate steps.
