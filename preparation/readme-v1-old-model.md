# Tribal Authentica

**Every mask carries its maker's story, and every resale pays its maker.**

Tribal Authentica gives contemporary African masks, made by living artisans and workshops, a permanent on-chain certificate on Bitcoin Cash. Each certificate records who made the mask, where, and the story behind it. Through the Tribal Authentica marketplace, the artisan is paid directly in BCH at the first sale and automatically earns a royalty on every resale.

Built by [Emtée Studio](#team) for **BCH BLAZE 2026**.

---

## Why

African heritage is rich, but much of it is passed down orally, with very little written record. When a mask leaves the workshop, its story, its maker and its origin are usually lost after the first sale. Artisans sell once, often through intermediaries, and never benefit when their work gains value.

Tribal Authentica keeps that record:

- **Provenance from the source.** The certificate is created when the mask is made, not reconstructed years later.
- **Stories preserved.** The meaning, materials, region and maker are written down (FR/EN) and permanently anchored on-chain.
- **Artisans protected and paid.** They are paid directly at the first sale and earn a royalty on every resale through the marketplace.

### What this is, and what it isn't

Tribal Authentica is a **provenance and ownership record**, not a forensic anti-counterfeit tool. It proves that a mask was registered by a known workshop on a known date, and it shows every owner since. It does not physically inspect an object. See [Known limitations](#known-limitations).

---

## How it works

```
Artisan makes a mask
      │
      ▼
Emtée registers it  ──►  NFT certificate minted (CashTokens)
(story, photos, maker)    commitment = artisan address + mask ID
      │
      ▼
Mask is listed on the marketplace (NFT locked in the royalty covenant)
      │
      ▼
Buyer pays in BCH  ──►  first sale: 100% to artisan
      │                 NFT goes to the buyer's wallet
      ▼
Owner resells  ──►  covenant enforces: seller gets price − royalty,
                    artisan gets royalty, NFT goes to the new buyer
      │
      ▼
Anyone scans the QR on the mask ──► public certificate page:
                                    story, maker, current owner, full ownership timeline
```

---

## Core features (hackathon scope)

| # | Feature | Description |
|---|---------|-------------|
| 1 | **Mask registration** | Emtée mints an NFT certificate for the artisan. The artisan's address and mask ID are stored in the token itself. |
| 2 | **Story and metadata** | Written story (FR/EN), maker, workshop, region, materials and photos, stored off-chain and anchored on-chain by hash. |
| 3 | **Public certificate page** | Opened by QR code or link, with no wallet needed. Shows the story, maker, current owner and ownership timeline. |
| 4 | **First sale** | The buyer connects a wallet and pays in BCH. The artisan receives 100% directly to their own wallet (Paytaca). |
| 5 | **Resale with royalties** | A CashScript covenant pays the artisan a royalty on every resale through the marketplace. |
| 6 | **Ownership timeline** | Read directly from the chain (token transfer history), with no separate database of truth. |

---

## On-chain design

### Certificate NFT (CashTokens)

- **One token category** for the platform. The **minting baton is held by Emtée**, so only Emtée-registered masks are valid certificates.
- **One immutable NFT per mask.**
- **NFT commitment:**
  - artisan public key hash (20 bytes): who gets paid
  - mask serial / ID
- **Metadata hash:** SHA-256 of the metadata JSON, written in an OP_RETURN output of the minting transaction. This anchors the story and photos without bloating the commitment.

> TODO: confirm the current CashTokens commitment size limit. If it allows it, the metadata hash can move into the commitment directly.

### Royalty marketplace covenant (CashScript)

When an owner lists a mask, the NFT is locked in a covenant parameterised with:

- `sellerPkh`: the current owner
- `price`: asking price in satoshis
- `royaltyBps`: royalty rate (**TBD**, e.g. 500 to 1000 bps = 5–10%)

The artisan's address is **read from the NFT commitment** through transaction introspection, so it can't be swapped out by the seller.

**Functions:**

- `buy()`: valid only if, in a single transaction,
  - the NFT goes to the buyer's output,
  - the seller receives `price − royalty`,
  - the artisan receives `royalty`.
  - On a first sale (seller = artisan), the artisan receives the full price.
- `cancel(sellerSig)`: the seller withdraws the listing and reclaims the NFT.

**Constraints:**

- The royalty output must be above the dust limit, which sets a minimum listing price.
- Develop and test on **chipnet** first, then deploy to **mainnet**.

### Off-chain

- Metadata JSON and photos are stored on IPFS (or on the backend for the demo), referenced by the hash on-chain.
- A light indexer or API reads token history to build the ownership timeline.

---

## Judge demo flow (target: under 2 minutes)

1. Open the homepage, which shows featured real masks from a real workshop in Côte d'Ivoire.
2. Click a mask to see its certificate page: story, maker, region, photos, ownership timeline. No wallet needed.
3. Connect a wallet (WizardConnect / XO).
4. Buy a demo mask for a small amount of BCH. The NFT lands in the wallet and the artisan is paid on-chain.
5. Optionally, relist it and buy it with a second wallet, so the royalty to the artisan is visible on-chain.

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Frontend | Next.js |
| Wallet connection | WizardConnect or XO Template (**to decide after workshops**) |
| Contracts | CashScript (marketplace and royalty covenant) |
| Tokens | CashTokens (NFT certificates) |
| BCH library | TBD (e.g. libauth / mainnet-js) |
| Metadata storage | IPFS or backend |
| Backend / API | Minimal: minting service (holds the baton) + chain indexer. NestJS optional. |
| Hosting | Vercel (frontend) + small API host |

The previous Ethereum / Hardhat setup is **dropped**.

---

## Roles

| Role | Who | Responsibilities |
|------|-----|------------------|
| **Platform (Emtée)** | Holds the minting baton | Registers masks for artisans, hosts metadata, runs the marketplace |
| **Artisan / workshop** | Own Paytaca wallet | Provides masks, stories and photos; receives first-sale payments and royalties |
| **Buyer / owner** | Any BCH wallet | Buys, holds and resells certificates |
| **Public** | No wallet | Looks up and verifies any mask by QR code or link |

---

## Known limitations

- **Physical-to-digital link.** For the hackathon, a mask is linked to its certificate by QR code, which can be copied. Ownership is proven by holding the NFT, not by the QR. The production fix is tamper-resistant NFC tags (secure NTAG-style chips).
- **Royalties are only enforced through the marketplace.** An owner can still transfer the NFT privately, and no blockchain can verify an off-platform price. This is the same limitation every NFT royalty system has.
- **Trust in the registrar.** Certificates are only as trustworthy as Emtée's onboarding of artisans. Multi-attester certification (workshop + cooperative + platform) is on the roadmap.

---

## Roadmap (post-hackathon)

- Audio stories in the artisan's own voice, including local languages with translation, to preserve oral heritage
- Short video of the making process for each mask
- Secure NFC tags embedded in masks
- Multiple certifiers: workshop heads, cooperatives, cultural institutions
- Artisans minting directly from their own wallet
- PUSD (ParyonUSD) pricing for stable prices
- Cash-out to XOF / mobile money for artisans
- Expansion to other crafts (textiles, sculpture, jewellery) and other countries

---

## Business model

- **Platform fee** on first sales
- **Share of resale fees** on secondary sales
- **Target buyers:** tourists, the diaspora, galleries, interior and decor retailers
- **Go-to-market:** start with workshops in Côte d'Ivoire, where Emtée has an existing network, then expand across francophone West Africa

---

## BCH BLAZE 2026 compliance checklist

- [ ] At least one team member attends a prep stream (Workshop 1, 2 or 3) for roll call
- [ ] Project confirmed in the BCH BLAZE Telegram channel
- [ ] Registered on DoraHacks
- [ ] Live, clickable demo URL
- [ ] At least one feature sends BCH mainnet transactions
- [ ] WizardConnect and/or XO Template integration
- [ ] Top-of-page banner on the homepage with:
  - [ ] Link to the Widget Factory presentation
  - [ ] Link to this GitHub repository
  - [ ] CashTokens address for EMBER2026 donations (Community Choice)
- [ ] Optional: Media track entry (short video about the artisan and their mask)

---

## Timeline

| Dates | Milestone |
|-------|-----------|
| 20–26 Oct | Attend a workshop, wallet-connect spike, CashScript hello world on chipnet, collect 3–5 masks with stories and photos from the artisan, set up the artisan's Paytaca wallet |
| 27 Oct – 2 Nov | Minting flow, metadata, public certificate page |
| 3–9 Nov | Marketplace covenant: first sale + resale royalty on chipnet |
| 10–16 Nov | Mainnet deployment, mint the real masks, UI polish, Widget Factory slides, register the project |
| 17–22 Nov | Bug bash, banner, Telegram confirmation, **submit by 20 Nov** (hard deadline 22 Nov, 15:00 CET) |

**Critical path:** the royalty covenant (3–9 Nov). Fallback: ship first sale only and move royalties to the roadmap.

---

## Prior work

This repository previously contained only default framework scaffolding (Next.js, NestJS and Hardhat starter templates) with no implemented features. All features listed above are built during BCH BLAZE 2026.

---

## Team

**Emtée Studio**: Thomas De Rouck (operations, build) and Moustapha (technical co-founder).

## Links

- Demo: _TBD_
- Widget Factory presentation: _TBD_
- Donations (EMBER2026): _TBD CashTokens address_