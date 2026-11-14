# omp-web UI/UX redesign: Warm Paper

- Date: 2026-07-27
- Status: pending user review
- Scope: visual polish, the chat flow, configuration forms, and feedback and state systems

## Background and goals

This historical proposal describes omp-web as a Next.js 16, React 19 and Tailwind CSS 4 interface with custom CSS variable themes. It already had responsive layouts, accessibility, and loading, empty and error states, but lacked a distinctive visual style, shared component primitives and consistent feedback.

Give the interface a warm, human character with paper-like light surfaces and warm charcoal dark surfaces. Keep existing functionality, data flows, shortcuts and routes intact, except for additive frontend interactions such as a command palette.

## Decisions

- Cover visual polish, chat, configuration forms, and feedback and state systems.
- Use warm paper, warm gray and serif headings, with a matching warm charcoal dark theme.
- Use Source Serif 4 and Noto Serif SC for headings, the existing system sans stack for body text and the existing monospace stack for code.
- Introduce tokens first, then implement in phases. Validate the direction on the chat screen in phase 0.
- Proposed component stack: shadcn/ui with Base UI, cmdk, lucide-react and motion. Deep refactoring is acceptable within the functional boundaries above.

## Design tokens

Define CSS variables in `app/globals.css` and expose utility tokens through Tailwind's `@theme inline`. Replace raw colors and inline styles with semantic tokens.

### Light palette: paper

| Token            | Value     | Use                            |
| ---------------- | --------- | ------------------------------ |
| `--bg`           | `#FAF9F6` | Warm paper page background     |
| `--bg-panel`     | `#F2F0EA` | Sidebars, panels and toolbars  |
| `--bg-hover`     | `#EAE7DF` | Hover                          |
| `--bg-selected`  | `#E5E0D4` | Selected                       |
| `--border`       | `#E2DDD2` | Borders                        |
| `--text`         | `#2B2823` | Warm ink body text             |
| `--text-muted`   | `#6E6860` | Secondary text                 |
| `--text-dim`     | `#948D82` | De-emphasized text             |
| `--accent`       | `#C24A2E` | Buttons, links and focus rings |
| `--accent-hover` | `#A83D24` | Accent hover                   |
| `--user-bg`      | `#F5EDE1` | Cream user message bubble      |

### Dark palette: ember

| Token          | Value     |
| -------------- | --------- |
| `--bg`         | `#1B1916` |
| `--bg-panel`   | `#231F1B` |
| `--border`     | `#38322B` |
| `--text`       | `#EBE6DC` |
| `--text-muted` | `#A39B8E` |
| `--accent`     | `#E07B54` |
| `--user-bg`    | `#2C2721` |

Derive remaining dark tokens using the same principles, lightening panel colors for hover and selection. Text and background combinations must meet WCAG AA contrast of at least 4.5:1; record measured ratios in CSS comments.

### Typography, shape and motion

- Headings include session and dialog titles, empty-state headings and toast titles. The proposal loads Source Serif 4 and Noto Serif SC from Google Fonts with `display: swap`.
- Type sizes: 12, 13, 14 (body), 16, 20 and 28px; line height 1.5–1.6.
- Radii: 8px for controls, 12px for cards and bubbles, 16px for dialogs.
- Light shadows use three warm diffuse levels (`rgba(60,50,35,.06–.12)`); dark shadows use a low-opacity warm black glow and a 1px warm edge.
- Motion durations: 150ms, 220ms and 320ms, eased with `cubic-bezier(.22,1,.36,1)`. Under `prefers-reduced-motion`, switch immediately.

## Component stack

| Library                    | Purpose                                                                                                       | Notes                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| shadcn/ui, Base UI variant | Dialog, AlertDialog, DropdownMenu, Tooltip, Tabs, ScrollArea, Field, Form, Popover and Collapsible primitives | Copy source into `components/ui/`; CSS variables define the theme contract. |
| Base UI Toast              | Global notifications                                                                                          | Do not add Sonner.                                                          |
| cmdk                       | Command palette                                                                                               | Smoke-test React 19 compatibility before integration.                       |
| lucide-react               | Shared icons replacing inline SVG                                                                             | Tree-shaken.                                                                |
| motion                     | Dialog and toast transitions and layout animation                                                             | Keep hover and focus effects in CSS.                                        |

The proposal excludes Radix Themes because of visual customization limits and React Aria because its internationalization features overlap and it adds weight.

## Changes by area

### Visual foundation

1. Rebuild `globals.css` with warm light and dark palettes, `@theme inline`, and radius, shadow and motion tokens.
2. Add serif fonts and a heading hierarchy.
3. Replace inline SVG with lucide-react and inline styles with Tailwind and semantic tokens.
4. Target touch areas of at least 44px and use a consistent warm ochre `focus-visible` ring.

### Chat flow

1. Use cream user bubbles with an ochre left border, paper-white assistant cards with warm shadows, and beige collapsible tool-call cards.
2. Give the auto-growing multiline composer a warm focus glow. Support mentions, slash commands and a cmdk palette for switching sessions, searching files, switching themes and changing models.
3. Use a breathing warm dot for streaming, warm minimap ticks and a floating pill to return to the bottom.
4. Use Base UI Toolbar and Tooltip for copy, fork and edit actions.

### Configuration forms

1. Move Models, Skills and Plugins forms to Base UI Dialog, Field and Form, grouping fields in cards.
2. Show required-field and format errors immediately beneath fields in warm red.
3. Show a toast on save; confirm destructive delete and reset actions with AlertDialog.

### Feedback and states

1. Stack success, error, information and task-complete toasts at bottom right with warm icons and serif headings.
2. Use a consistent warm shimmer for skeletons.
3. Give empty states a large serif heading, steps and a primary action.
4. Give error pages illustrative typography and retry and back actions.

## Phases

0. Validate tokens, serif fonts and the main chat screen (bubbles, composer and top bar) with the user.
1. Finish chat flow: command palette, streaming details, minimap and actions.
2. Update sidebar and file panels, including TabBar, FileViewer and FileExplorer.
3. Update Models, Skills and Plugins dialogs.
4. Finish toasts, skeletons, empty states and error pages.

At each phase, verify light and dark themes on desktop and mobile. Check accent on background and muted text on panel for 4.5:1 contrast, and regress existing shortcuts including Esc to abort and Ctrl+Alt+N for a new session.

## Degradation and non-goals

- If cmdk fails its smoke test, use a simple custom palette without blocking the rest.
- Fall back to system serif fonts if font loading fails. Disable motion for reduced-motion users.
- Fix Base UI styling gaps in `components/ui/` without changing component semantics.
- No guided onboarding, drag reordering of messages or tabs, state-management rewrite, new state library, logo or marketing page.
- New interface copy belongs in the English dictionary; retain generic multilingual font support for user content.
