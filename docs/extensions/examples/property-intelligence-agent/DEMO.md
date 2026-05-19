# Property Intelligence Agent — 3-Minute Demo

## One-line opener
> *"In the next three minutes this agent is going to read your property and
> lease data and show you every dollar of risk and opportunity hiding in
> a single building."*

## Setup (before you hit record)
1. Start a fresh conversation in the harness.
2. Mention the `property-intelligence-agent` and confirm the agent is wired.
3. Have `P003 — Riverside Commons` loaded as the hero property.

## 60-second Act 1 — Portfolio Briefing (proves the harness works)

**Prompt:**
> "Run the daily portfolio briefing."

**What you're selling the audience on:**
- The harness visibly streams 6+ tool calls:
  `list-properties → get-expiring-leases → get-tenants-at-risk →
  get-covenant-status → get-compliance → find-unbilled-escalations →
  draft-email × N → create-task × N`
- Every finding cites the tool that produced it.
- Every dollar figure is an actual number lifted from the data, not an
  LLM hallucination.

**Expected headline numbers (seed 42):**
- At-risk receivables: **$113,500**
- Unbilled escalations YTD: **~$14,400**
- 2 leases expiring < 90 days
- 1 covenant alert (P003)
- 1 insurance item expiring < 30 days

**Talking point:** *"Before we've even looked at any one building, the
agent has identified six figures of actionable dollars and drafted the
follow-up emails and tasks for every one. Drafts, not sends — the
manager keeps the pen."*

## 120-second Act 2 — Property Deep Dive (THE HERO)

**Prompt:**
> "Now give me a full deep dive on P003."

**Why P003:** It carries every major category of finding, overlapping
on one building:

| Finding | Value | Source tool |
|---|---|---|
| **Loan covenant at risk** — DSCR 1.22 vs covenant 1.15 (gap 0.07) | a technical breach is 0.07 away | `get-covenant-status` |
| **NOI underperformance** — $1.08M YTD vs $1.30M budget | **−16.9% / −$220K** | `get-noi-trend` + `get-budget-vs-actual` |
| **Unbilled rent escalations** on L-301 and L-302 | **~$10.5K recoverable** | `find-unbilled-escalations` |
| **CAM 2024 under-recovery** | **$13K** unissued true-up | `get-cam-status` |
| **Insurance policy expiring in 22 days** | critical compliance clock | `get-compliance` |
| **OpEx Utilities +25%** over budget | **$13K** investigation target | `get-budget-vs-actual` |
| **Open capex chiller replacement** | **$185K** in flight | `get-capex-summary` |

**Talking points (one per section, ~20s each):**

1. *"First — overview, leases, rent roll. Sanity check on the building."*
2. *"Here's where the value starts. The agent noticed that two tenants,
   L-301 and L-302, have been billed at last year's rate for four months.
   That's $10,500 of revenue we haven't invoiced. Not estimated — actual
   uncollected dollars. The agent drafted the catch-up billing task."*
3. *"Financial performance: NOI is 17% below plan, with Utilities running
   25% over budget. Every variance is traced to a source tool — the
   agent doesn't just wave at bad numbers, it tells you which account
   to go look at."*
4. *"CAM under-recovered by $13,000 in 2024 — true-up not yet issued.
   The agent drafted the tenant memo with the math already done."*
5. *"Debt: DSCR is 0.07 above covenant. That's a call-the-lender-this-week
   problem, and the agent drafted the internal memo."*
6. *"Compliance: insurance expires in 22 days. High-severity task drafted
   for the property manager."*
7. *"And finally — **ranked risks** by dollar impact, **ranked
   opportunities**, and every drafted action queued for one-click approval.
   The manager's role becomes reviewing a drafted package, not hunting
   through spreadsheets at 6am."*

## 30-second close — The Ask

> *"What just happened: an agent read ten CSVs the way a senior accounting
> analyst would — cross-referencing leases against billings, NOI against
> budget, loans against covenants, and reconciliations against recoveries —
> and produced a report better than what most portfolio managers get from
> their analyst team on a Monday. Every number is cited. Every action is
> drafted. Nothing was sent without approval. Scale this across a 50-building
> portfolio and you've bought back 15 hours a week per person on your
> accounting team."*

## Fallbacks if the LLM misbehaves on stage
- `generate-daily-briefing` tool produces a deterministic, server-side
  briefing with the exact same headlines. Call it directly as a demo-safe
  bypass.
- `generate-property-deep-dive` tool does the same for the hero property.
  Both are plain JSON-RPC calls and produce the markdown the audience
  expects to see.

## FAQ the audience will ask

**"How does it know which dollars to chase?"**
> Rules encoded in the `property-accounting-playbook` skill + the analytic
> helpers in `index.ts`. DSCR within 0.10 is at-risk; CAM shortfall > $10K
> is material; budget variance > 15% is a flag. Same thresholds an analyst
> would use.

**"Can it connect to our real system (Yardi/MRI/AppFolio)?"**
> Yes. The agent reads through ten `load*()` functions at the top of
> `index.ts`. Swap those for API calls. The analytics and the agent's
> behavior don't change.

**"Why drafts and not sends?"**
> Because the people running property accounting answer to lenders,
> auditors, and tenants. The drafted artifacts preserve human approval
> without slowing the process — one click to send, zero clicks to hunt
> for the right number.

**"What prevents hallucination?"**
> The system prompt forbids guessing numbers. The model must call a tool
> to read data. Every finding cites its source tool. The deterministic
> synthesis tools (`generate-daily-briefing`, `generate-property-deep-dive`)
> are the ground-truth fallback — they don't use the LLM at all.
