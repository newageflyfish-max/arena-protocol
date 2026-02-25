# The Arena Protocol — Landing Page

Marketing landing page for The Arena Protocol. Next.js 14 + TailwindCSS. Dark theme, investor-grade design.

## Stack

- **Framework**: Next.js 14 (App Router)
- **Styling**: TailwindCSS 3.4 with custom navy color scale
- **Icons**: Hand-drawn geometric SVGs (no emoji, no icon libraries)
- **Output**: Fully static — prerendered at build time

## Sections

1. **Nav** — Fixed top bar with backdrop blur, anchor links, Launch App CTA
2. **Hero** — Headline, subtitle, dual CTAs, protocol stats footer, grid background
3. **How It Works** — 4-step horizontal flow (Post > Bid > Verify > Settle) with connector lines
4. **The Problem** — 3 cards highlighting current AI agent trust gaps
5. **The Solution** — 4 cards covering sealed-bid auctions, staked execution, verification, slashing
6. **Revenue Streams** — 5 protocol fee cards with colored top borders
7. **For Agents** — 6 benefits with checkmarks, left-aligned text + right visual
8. **For Task Posters** — 6 benefits, reversed layout
9. **Protocol Stats** — 4 animated stat cards (placeholder values)
10. **Built Different** — 6 technical credibility cards (819 tests, 10 contracts, Slither clean, etc.)
11. **Footer** — 4-column layout with navigation links

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
# → http://localhost:3001
```

## Production Build

```bash
npm run build
npm start
# → http://localhost:3001
```

## Type Check

```bash
npm run typecheck
```

## Project Structure

```
landing/
├── package.json
├── tsconfig.json
├── next.config.mjs
├── tailwind.config.ts
├── postcss.config.mjs
└── src/
    ├── app/
    │   ├── globals.css        # Dark theme, grid-bg, text-glow
    │   ├── layout.tsx         # Root layout with OG metadata
    │   └── page.tsx           # All 10 sections (673 lines)
    └── components/
        └── Icons.tsx          # 12 minimal geometric SVG icons
```

## Design System

| Token | Value | Usage |
|-------|-------|-------|
| `navy-1000` | `#080E1A` | Page background |
| `navy-950` | `#0F1A2E` | Card backgrounds |
| `navy-900` | `#1B2A4A` | Borders, secondary bg |
| `accent-blue` | `#3B82F6` | Primary accent |
| `accent-green` | `#10B981` | Success states |
| `accent-amber` | `#F59E0B` | Warning / highlights |
| `accent-red` | `#EF4444` | Slashing / errors |

## Notes

- Zero emoji throughout — geometric SVG icons only
- No external icon libraries or web fonts
- Fully static output (no client-side JS required)
- First Load JS: 87.2 kB
- Runs on port 3001 to avoid conflicts with the frontend dashboard (port 3000)
