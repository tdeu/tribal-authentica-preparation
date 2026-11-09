# Preparation (before BCH BLAZE 2026 hacking period)

**What existed before 14 Nov 2026, 14:00 UTC:** written specs and design decisions for the Tribal Authentica contracts,
plus throwaway, CLI-only spikes of both contracts (`RoyaltyVault` for mask certificates with resale royalties and
`PatronDispenser` for fungible Patron tokens), run on **chipnet only**. There was no UI, no frontend, no backend,
and no mainnet deployment. **What will be built during BCH BLAZE:** the final contracts, rewritten from scratch
from these specs in a new repository, along with mask minting, the public certificate pages, the marketplace UI with
wallet connection (WizardConnect / XO), the ownership-timeline indexer, and the mainnet deployment.

Everything in this folder was written **before 14 Nov 2026, 14:00 UTC**, when official hacking starts.
It contains plans, decisions and learnings only. No code from `spikes/` is reused as-is in the submission.

| File | Content |
|------|---------|
| `decisions.md` | Design decisions taken during prep, with reasons |
| `contract-spec.md` | Target spec for the RoyaltyVault covenant (to be rewritten cleanly after 14 Nov) |
| `spike-spec.md` | The brief given for the prep spikes |
| `spike-report.md` | What the spikes showed: what works, what broke, limits, lib versions |
| `readme-v1-old-model.md` | First README draft, based on a model that was dropped (see `decisions.md`) |
