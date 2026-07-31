---
name: Blogbot Editorial Workstation
description: Calm, evidence-first Windows editorial automation for any user-selected project.
colors:
  private-ink: "#122329"
  muted-ink: "#526267"
  canvas: "#f3f4f0"
  paper: "#fbfcf9"
  raised-paper: "#ffffff"
  divider: "#dce1da"
  sidebar: "#0d1b21"
  editorial-orange: "#e65f38"
  verified-teal: "#1b7d72"
  evidence-blue: "#326e91"
  attention-amber: "#b7791f"
  blocker-red: "#b93d3d"
typography:
  display:
    fontFamily: "Georgia, Cambria, serif"
    fontSize: "clamp(2rem, 3vw, 3rem)"
    fontWeight: 700
    lineHeight: 1.05
  headline:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(1.75rem, 3vw, 2.75rem)"
    fontWeight: 750
    lineHeight: 1.08
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 750
    lineHeight: 1.2
    letterSpacing: "0.1em"
rounded:
  control: "8px"
  panel: "12px"
  feature: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.editorial-orange}"
    textColor: "{colors.raised-paper}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-secondary:
    backgroundColor: "{colors.raised-paper}"
    textColor: "{colors.private-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  field:
    backgroundColor: "{colors.raised-paper}"
    textColor: "{colors.private-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  status-pill:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.muted-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "3px 8px"
---

# Design System: Blogbot Editorial Workstation

## Overview

**Creative North Star: "The Editor's Instrument Panel"**

Blogbot is a quiet, high-density Windows workstation used by one accountable editor in daylight and office lighting. It combines the legibility of a newsroom planning board with the confidence of a native operations console. Information is compact, but hierarchy is never sacrificed.

The system rejects generic SaaS dashboards, decorative AI imagery, blocked onboarding, neon, glass effects, and marketing-scale typography. Five stable work areas hold the complete product. Setup and settings remain secondary, while local-engine and connector readiness plus the next editorial decision stay continuously visible.

**Key Characteristics:**

- Evidence before decoration.
- Dense lists and workspaces, with generous separation between major regions.
- Restrained surfaces with one editorial orange action voice.
- Status always uses text, shape, and color together.
- The interface remains understandable at 960px and comfortable at 1440px.

## Colors

The palette resembles paper, dark print, proofing marks, and restrained operational signals.

### Primary

- **Editorial Orange:** Reserved for the current action, active focus, and human approval.

### Secondary

- **Verified Teal:** Successful checks, healthy services, and trusted continuity.
- **Evidence Blue:** Informational evidence, research states, and non-blocking guidance.
- **Attention Amber:** Incomplete evidence, limits, and review attention.
- **Blocker Red:** Failed checks and actions that cannot proceed.

### Neutral

- **Private Ink:** Primary text on the light workspace.
- **Canvas and Paper:** Tinted neutral layers that separate the application without decorative card stacking.
- **Private Sidebar:** A stable dark navigation rail, never a full-product dark theme.

### Named Rules

**The One Editorial Voice Rule.** Editorial orange occupies less than ten percent of a screen and identifies the most consequential available action.

**The Truthful Status Rule.** Green is forbidden for checks that have not actually run.

## Typography

**Display Font:** Georgia with Cambria fallback
**Body Font:** Segoe UI Variable Text with Segoe UI and system fallbacks
**Label/Mono Font:** Segoe UI for labels; Consolas only for hashes and paths

**Character:** The application shell is native, direct, and highly legible. Article previews use a restrained editorial serif so content feels distinct from application chrome.

### Hierarchy

- **Display** (700, fluid 32px to 48px, 1.05): Article titles inside TR and EN review.
- **Headline** (750, fluid 28px to 44px, 1.08): Page-level decisions and work-area titles.
- **Title** (680, 17px to 24px, 1.25): Panel and item headings.
- **Body** (400, 14px, 1.55): Operational copy, capped near 72 characters when prose is long.
- **Label** (750, 11px, 0.1em, uppercase): Section kickers and compact state categories.

### Named Rules

**The Two Voices Rule.** Serif belongs to article content; Segoe UI owns every control, status, form, and navigation surface.

## Elevation

Blogbot is flat by default. One-pixel dividers, tinted surfaces, and changes in density establish structure. Ambient shadows are allowed only for raised panels and actionable controls, never as a substitute for layout.

### Shadow Vocabulary

- **Tight Ambient** (`0 6px 18px rgb(20 36 41 / 0.07)`): Buttons and compact raised panels.
- **Workspace Ambient** (`0 18px 48px rgb(20 36 41 / 0.08)`): Rare top-level floating surfaces only.

### Named Rules

**The Flat Workbench Rule.** Lists and editorial workspaces remain flat; elevation signals interactivity or a true overlay relationship.

## Components

### Buttons

- **Shape:** Gently curved rectangular controls (8px).
- **Primary:** Editorial orange, white tinted text, compact 10px by 16px padding.
- **Hover / Focus:** A short lift, darker orange on hover, and a visible focus ring. Layout properties never animate.
- **Secondary / Ghost:** Raised paper with a one-pixel divider, or transparent for quiet tertiary actions.

### Chips

- **Style:** Compact pill with a tinted semantic background and explicit text.
- **State:** Status chips are labels, not standalone color dots. Selection uses a filled neutral surface and readable state text.

### Cards / Containers

- **Corner Style:** 12px for work panels, 16px only for major feature regions.
- **Background:** Paper or raised paper over the canvas.
- **Shadow Strategy:** Flat for lists; tight ambient only where a surface is genuinely raised.
- **Border:** One-pixel divider.
- **Internal Padding:** 16px to 24px based on hierarchy.

### Inputs / Fields

- **Style:** Raised paper, one-pixel strong divider, 8px corners, native Segoe UI text.
- **Focus:** Clear focus-visible ring and border shift.
- **Error / Disabled:** Error copy remains adjacent and announced; disabled controls retain readable labels and explain the missing prerequisite.

### Navigation

The private sidebar uses five stable destinations. Active items use a complete border, stronger surface, white text, and a warmer icon. Hidden deep routes keep their parent destination active. At compact desktop widths the sidebar narrows, while content scrolls independently.

### Review Workbench

The review workbench combines a revision queue, fail-closed approval controls, immutable hash, quality tabs, and a simultaneous TR and EN reading surface. Application metadata moves below the two-language comparison before either language becomes unreadably narrow.

## Do's and Don'ts

### Do:

- **Do** preserve the five-area information architecture and secondary Setup and Settings destinations.
- **Do** use one-pixel dividers, semantic tint, and text labels for status.
- **Do** keep the main human approval action visually strongest and exact-hash bound.
- **Do** show loading, empty, error, stale, and offline states as real product states.
- **Do** keep controls keyboard reachable, focus visible, and motion removable.

### Don't:

- **Don't** create a generic admin template with a dozen equal-weight sidebar destinations.
- **Don't** create blocking first-run onboarding that prevents opening the product.
- **Don't** present empty dashboards or unexecuted checks as success.
- **Don't** use neon, glassmorphism, decorative gradients, floating blobs, or oversized marketing typography.
- **Don't** use a colored left or right stripe wider than one pixel on cards, callouts, or list items.
- **Don't** use gradient text, the hero-metric template, nested cards, or identical icon-card grids.
- **Don't** use technical worker terminology as the primary information architecture.
