# Estimates AI Agent: Design Description

A chat-based AI agent that prices electrical construction estimates (.xlsx) by learning from estimates the company has already priced by hand. This document describes the design as built in this project: its pages, components, states, visual system and behaviour.

---

## 1. Product summary

**Users:** estimators at a small electrical and construction company. They are not technical, so every page uses plain labels, shows progress, and offers one obvious next step.

**Core idea:** the user uploads priced reference estimates, hourly norms and price lists to a knowledge base. In chat, they either attach a blank estimate for the agent to fill, or describe a work list for the agent to build a new estimate from. The agent explains its work step by step, asks permission before using files the user didn't select, falls back to web search, and returns a priced .xlsx file. The user reviews that file in a built-in document viewer.

**Language rule:** the UI is always English and has no language toggle. Estimate content keeps the language of its source (Latvian, Danish, English). A small language tag (`LV`, `EN`, `DA`) appears on file cards, conversation lists, history, the viewer and the file picker.

---

## 2. Look and feel

- A calm, minimal chat layout: a collapsible left sidebar, one centred conversation column with generous whitespace, and a rounded composer at the bottom.
- User messages sit in soft bubbles. Agent replies are plain flowing text with no bubble.
- Documents open in a panel that slides in from the right beside the conversation.
- There are no dashboards inside the chat, no purple gradients, no sparkle icons and no "magic" language.
- The design is original. It follows the common modern chat-app pattern but has its own palette, type and brand mark.

### 2.1 Colour tokens

All colours are CSS custom properties. They are defined for light mode (`:root`, `[data-theme=light]`) and dark mode (`[data-theme=dark]`), so any element can be forced into either theme.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #fcfcfd | #141619 | Page background |
| `--side` | #f5f6f8 | #101214 | Sidebar, tab strips, footers |
| `--panel` | #ffffff | #1a1d21 | Cards, panels, grid cells |
| `--sunk` | #eef0f3 | #23272c | Hover, table headers, chips |
| `--bubble` | #eceff4 | #262a30 | User message bubble |
| `--line` / `--line2` | #e1e4e9 / #eceef2 | #2d3238 / #23272c | Borders, dividers |
| `--ink` / `--ink2` / `--ink3` | #15181c / #4a525c / #737b86 | #e7e9ec / #adb4bc / #7f8791 | Primary, secondary, tertiary text |
| `--acc` / `--accSoft` / `--accInk` | #1f5eff / #e7eeff / #1747c9 | #4a7dff / #1b2851 / #9ab7ff | Brand accent (electric blue) |
| `--ok` / `--okSoft` | #177a43 / #e3f3e9 | #5cc98a / #14301f | Analysed, done, high confidence |
| `--warn` / `--warnSoft` | #9a5700 / #fcefd8 | #f0b04a / #3a2a10 | Needs attention, near budget |
| `--err` / `--errSoft` | #bf3228 / #fbe6e4 | #f07a70 / #3d1a18 | Failed, exceeded, no price |
| `--web` / `--webSoft` | #0d6e84 / #dff1f5 | #55c6da / #0f2d33 | Web-sourced prices |
| `--hl` / `--hl2` | #fff1b3 / #fff8d6 | #4a3f12 / #2e2912 | Find-in-document highlights |

The theme is stored in `localStorage` (`eaa-theme`) and applied before first paint. It can be switched from the sidebar, from Profile (Light / Dark / Match my computer), and from the index and component pages.

### 2.2 Typography

- **IBM Plex Sans** for all UI text. Agent replies are 15px with a 1.65 line height. UI text is 13–14.5px. Page titles are 22–30px.
- **IBM Plex Mono** for numbers, prices, row numbers, token counts, file-kind labels (`XLSX`, `PDF`, `DOCX`) and language tags.
- Tables use tabular figures.

### 2.3 Shape and spacing

- Radii: 4px for tags, 6–10px for buttons and inputs, 12–14px for cards, 18px for the composer.
- Shadows are used only for floating layers: the composer, popovers, the inspector and modals.
- Layout uses flex and grid with `gap`. Pages are fluid and reflow down to phone width.

---

## 3. Information architecture

Every page has its own URL. `Estimates AI Agent.dc.html` is the index and links to every page and state.

| Route (file) | Page |
|---|---|
| `login.dc.html` | Sign in and forgot password |
| `set-password.dc.html` | Set password from an invite or reset link |
| `setup.dc.html` | First-run knowledge base setup (chat is locked until done) |
| `knowledge.dc.html` | Knowledge base library |
| `knowledge-file.dc.html?f=…` | File detail, with 5 tabs |
| `chat-new.dc.html` | New conversation (empty state) |
| `chat.dc.html?s=…` | Conversation, with a scenario parameter |
| `history.dc.html` | All estimates and conversations |
| `settings-usage.dc.html` | Usage and costs, and the budget |
| `settings-routing.dc.html` | Model routing pipeline |
| `settings-profile.dc.html` | Profile, send-to email, password, theme |
| `settings-users.dc.html` | Users (admin only) |
| `components.dc.html` | Component set with all states |
| `mobile.dc.html` | Live phone-width previews |

The settings pages share a left sub-navigation (`SettingsNav`). All app pages share the `Sidebar`.

---

## 4. Pages

### 4.1 Sign in (`/login`)
- A centred card with the brand mark, Email, Password (with Show/Hide) and **Sign in**.
- **Forgot password?** switches the card to a reset form (email and **Send reset link**), then to a "Check your email" confirmation.
- Inline errors: missing email, missing password, and "Email or password is incorrect" (`?error=1`).
- Footer note: access is by invitation only. There is no sign-up.

### 4.2 Set password (`/set-password`)
- **Invite:** "Anna Bērziņa invited you to Elektro Serviss SIA." The email is shown locked.
- **Reset** (`?reset=1`): "Choose a new password."
- A live rule checklist: at least 10 characters, contains a number, both passwords match. The button stays disabled until all rules pass.
- **Expired link** state (`?expired=1`).

### 4.3 Setup, first run (`/setup`)
- Left column: a four-step checklist.
  1. Upload priced estimates (required)
  2. Add norms and price lists (optional)
  3. Review what the agent learned
  4. Start estimating
- A lock notice explains that chat is locked until at least one priced estimate is analysed. It turns green when chat unlocks.
- Right column: a drag-and-drop upload area for .xlsx, .xls, .docx and .pdf. Each file row has:
  - file kind, name and size
  - a type selector: *Priced estimate (reference)*, *Hourly norms*, *Price list* or *Other*
  - a live status: **Queued → Reading → Analysing (with %) → Analysed**, or **Failed** with a plain-language reason and a **Retry** button
- Step 3 shows one card per analysed file with its Structure, Calculation logic and Saved counts, plus a **Review details** link.
- Empty state: `?empty=1`.

### 4.4 Knowledge base (`/knowledge`)
- A header with an explanation and an **Upload files** button.
- Search, a type filter and a status filter.
- A list with these columns: Name (kind icon), Type, Language, Added, Status, Extracted (prices and norms), Used in (estimates), and **Open** (opens the document viewer on the right).
- Clicking a row opens the file detail page.
- Empty state (`?empty=1`) explains that chat is locked and links to setup.

### 4.5 File detail (`/knowledge-file`)
- Header: file kind, name, type, language tag and status. Buttons: **Open document**, **Re-analyse** (shows an inline progress banner) and **Delete** (a confirmation modal that says what the agent will forget).
- Tabs:
  - **Overview:** type, language, status, uploaded by, size, model cost, and a list of the estimates that used the file (linking to those conversations).
  - **Structure:** detected sheets, their sections with row ranges, and the column layout, with each column's meaning in plain English.
  - **Calculation logic:** labour, material, subtotals and contribution margin, each written as a plain sentence with key numbers as chips (for example "Hourly rate DKK 430"). Each can be edited and is marked *Edited* once changed.
  - **Saved numbers:** an editable table (Item, Unit, Norm h, Unit price, Found in). You can search, add rows and delete rows. Changed rows are highlighted and a "Save changes" bar appears.
  - **Agent notes:** short notes the agent wrote for itself, marked *Agent* or *Your note*. Each note can be edited or deleted, and you can add your own.
- **Analysis failed** state (`?f=broken`): a red panel with the reason (password-protected PDF) and **Try again** / **Replace file** buttons.

### 4.6 New conversation (`/chat`)
- A centred greeting ("Good morning, Mārtiņš" and "What are we estimating today?") with the composer.
- Two suggestion cards:
  - **Fill a blank:** attach an estimate blank and the agent fills it in the blank's own language.
  - **Generate from a work list:** describe or attach the work and the agent builds a new estimate like your references.
- Three example prompts below, and a knowledge base status line.
- Locked state (`?locked=1`) replaces all of this with "Chat opens after your first reference is analysed" and a link to setup.

### 4.7 Conversation (`/chat/:id`)
Layout: Sidebar | conversation column (header with title, language tag and conversation cost; messages; composer) | optional document viewer.

Scenarios (`?s=`):

| Scenario | What it shows |
|---|---|
| `result` | The main flow: a blank plus references, finished working steps, a denied permission card, a plain-text summary, the document card, a web-sourced prices table, follow-up Q&A ("Why is row 58 so expensive?", "Which norm did you use for cable trays?"), and "Send me this estimate" with an email-sent card |
| `working` | A long run with live counters ("Pricing materials · 184 / 300"), a progress bar, the item currently being priced and an elapsed timer. It finishes on its own and posts the result |
| `permission` | A paused run with the permission card pending. Allow or Deny each continue the conversation differently |
| `worklist` | A work list typed into chat, then the structure proposal card (pending) |
| `vague` | A clarifying-questions card with quick-reply chips |
| `nothing` | Web search found nothing for one item: a warning step, a note and a flagged row |
| `emailfail` | The email card in its failed state, with Retry |
| `blocked` | Budget exceeded: a red banner above a disabled composer |

Behaviour:
- Sending a message appends it and gets a short agent reply. Messages mentioning a row get a reply with a row chip; "send" gets an email card.
- Row chips and file chips open the document viewer at that sheet and row.
- The conversation auto-scrolls to the newest message.

### 4.8 History (`/history`)
- Search (client, project or file) and filters for status (*In progress / Done / Sent*), language and date.
- Each entry shows the title and client, date, status badge, language tag, AI cost and output file.
- Clicking the file chip opens the document viewer, and **↓** downloads the file. Clicking the row opens the conversation.
- The footer shows the count and total AI cost. There are states for an empty history and for no matches.

### 4.9 Usage and costs (`/settings/usage`)
- KPI cards for today, this week and this month. The month card has a budget progress bar.
- Daily spend chart: 30 stacked bars (Advanced, Standard, Fast), a dashed daily-average line, and a hover readout.
- Spend by model tier (a stacked bar plus a list), the most expensive conversations, and a per-conversation table split by tier.
- Monthly budget: amount, an alert threshold slider (default 80%), and what happens when the budget runs out (*Pause all new requests*, *Allow Fast tier only* or *Keep working, only warn*).
- Banner states:
  - **Near limit** (`?b=near`): an amber banner showing 86% used, the projected date the limit is reached, and **Adjust budget**.
  - **Exceeded** (`?b=over`): a red banner saying new requests are paused, and **Raise budget**.

### 4.10 Model routing (`/settings/routing`)
- A left-to-right pipeline diagram: **Incoming request → Router → Fast / Standard / Advanced**.
- The router card has a toggle: "Move up a tier when the agent is unsure".
- Each tier card shows its model, its price per 1M tokens (input and output), an on/off switch, the tasks routed to it (as chips) and this month's spend.

  | Tier | Default tasks |
  |---|---|
  | Fast | Simple questions, short replies, sending email |
  | Standard | File analysis, filling blanks, supplier web search |
  | Advanced | Generating from a work list, complex reasoning |

- Per-task overrides table (Task, Default, Send to, This month). Changing an override moves the task chip in the diagram and marks it *OVERRIDE*. Turning a tier off sends its tasks to the next tier up.
- **Reset to defaults** button.

### 4.11 Profile (`/settings/profile`)
- Name, and the "Send estimates to" email, with a note that the sign-in email is unchanged.
- Theme picker with preview thumbnails: Light, Dark, Match my computer.
- Password change, which expands inline. A sign-out link.

### 4.12 Users (`/settings/users`, admin only)
- Invite form (email and role: Estimator or Admin) with validation and confirmation.
- User table: avatar, name, email, role selector, status (*Active*, *Invite sent*, *Invite expired*), last active, and an action (**Remove** with a two-step confirmation, **Cancel invite** or **Resend**).
- An explanation of what each role can do.
- No-access state (`?role=estimator`).

---

## 5. Components

Shared components are separate files and are reused across pages.

### 5.1 `Sidebar`
- Brand, collapse toggle, **+ New estimate**, and navigation (Knowledge base, History, Settings).
- Conversation list grouped by date (Today, Yesterday, Previous 7 days, September), with a language tag and a blue dot while the agent is working.
- Footer: the user (links to Profile) and a theme toggle.
- **Collapsed** (60px rail, remembered in `localStorage`). It collapses automatically when a document opens in split view.
- **Mobile:** an overlay drawer with a backdrop, opened by ☰.

### 5.2 `Message`
- **User:** file attachment cards (kind, name, role) above a soft bubble.
- **Agent:** plain text blocks with inline **row chips** (blue, e.g. `EL · row 58`) and **file chips** (outlined, with kind label). Other blocks:
  - **Working steps:** a collapsible block. The header shows a spinner, ✓ or a paused ring, a title and the elapsed time. Each step has a status dot (done, active, todo or warn), a label, a live meta counter, an optional progress bar and a sub-line. Running blocks have **Stop**. Finished blocks collapse to "Finished 8 steps · 3 min 52 s".
  - **Inline card:** see `InlineCard`.
  - **Document card:** XLSX icon, name, language tag, "4 sheets · 1,248 rows · generated today 10:45", and **Open** / **Download .xlsx**. There is no table preview.
  - **Web-sourced prices table:** Product, Unit price, Qty, Total, Source (link) and Location (a chip that jumps to the viewer). It shows 5 rows with "Show all 17".
  - **Warning note** (amber text) for "nothing found".
- **Footer:** a quiet tier badge and cost (hover shows input and output token counts), plus **Copy** and **Retry**.

### 5.3 `Composer`
- Rounded box: file chips (kind, name, role, ×; clicking the name opens the viewer), an auto-growing textarea, **+** attach (native file picker), **/ References**, a quiet hint ("Auto model · about $0.02 per question") and a send button.
- Files can be dragged onto it, with a dashed "Drop files to attach" overlay.
- **"/" file picker popover:** opens when you type `/` at the start of a word or click **/ References**.
  - A search field (the text after `/` is the query).
  - Files grouped by type (Priced estimates, Hourly norms, Price lists, Other), each with a status dot and language tag. Failed files are disabled.
  - Multi-select checkboxes, and a keyboard hint bar.
  - Keyboard: **↑↓** move, **Enter** toggles, **Esc** closes (and removes the typed `/query`).
  - Selected files become chips.
- **Disabled** state for an exceeded budget.

### 5.4 `InlineCard` (every state)
All cards share a header label and a status pill: *Waiting for you*, *Approved*, *Denied*, *Expired*, *Done*, *Failed* or *Sending*. Pending cards have an accent border.

- **Permission request:** "Socket prices aren't in your selected references. I found them in 'Price list 2025.xlsx'. Can I use it?" plus the affected rows.
  - Pending: **Allow for this estimate** / **Deny: search the web instead**.
  - Approved, Denied (both with **Undo**), Expired (**Ask again**), Done.
- **Structure proposal:** "I'll build this like 'Braila 23.xlsx'…" with Sheets, Sections, Columns, Pricing logic, and a Language selector (defaults to the template's language and notes when it has been changed).
  - Buttons: **Generate**, **Change structure**, **Use a different reference** (an inline list of templates).
  - States: Approved, Denied (asked to change), Expired (replaced), Done.
- **Clarifying questions:** four short questions, each with single-select chips, a counter and **Send answers** (enabled when all are answered) or **Skip, use defaults**.
  - States: Done (shows the chosen answers) and Expired.
- **Email:**
  - Sending (spinner).
  - Done: "Sent to m.kalnins@elektro.lv: Estimate_Denmark.xlsx", with a timestamp.
  - Failed: reason plus **Retry**, which goes through Sending to Done.

### 5.5 `DocViewer` (core component)
Opens any file without leaving the current page. It is used by chat, the knowledge base, file detail, history and the component page.

**Modes**
- **Split** (default): the panel sits beside the conversation, with a draggable divider (26–70%).
- **Full screen:** the conversation collapses to a 64px rail with **‹ Chat** and **Ask**. **Ask** opens a floating composer over the document.
- **Sheet** (phone): full-screen, with a "‹ Back to chat" bar. The inspector becomes a bottom sheet.

**Header**
- A tab strip: each open document is a tab with its kind label and ×. Buttons for Full screen / Exit full screen and Close.
- A document row: kind icon, name, language tag, source ("Generated by the agent · today 10:45" or "Knowledge base · Hourly norms"), **Ask about this document** (focuses the composer and adds the file as a chip) and **Download**.

**xlsx**
- Sheet tabs at the bottom with row counts, and the estimate total.
- Spreadsheet grid with 12 columns in the source language (for example *Nr. · Beskrivelse · Enh. · Antal · Norm t · Timer · Arbejde kr · Mat./enh. kr · Materiale kr · I alt kr · Kilde*):
  - sticky header, and a sticky bottom subtotal that follows the section currently in view
  - frozen first three columns (#, Nr., Description)
  - section header rows and "I alt" subtotal rows
  - virtualised rendering: the sample estimate has **1,248 rows across 4 sheets** and scrolls smoothly
- Toolbar: **Find** (match count, ↑↓, Enter / Shift+Enter), **Go to row**, and zoom (80–130%).
- Jump-to-row: opens at a sheet and row, with the row highlighted and outlined.

**Generated-estimate extras**
- "Show only" filters with counts: *Needs attention*, *Web-sourced*, *Manually changed*.
- Row markers: a coloured left edge plus a tag.

  | Tag | Colour | Meaning |
  |---|---|---|
  | `WEB` | teal | Price found on a supplier website |
  | `CHECK` | amber | Low confidence |
  | `NO PRICE` | red | No price found anywhere |
  | `EDITED` | blue | Changed by the user |

- **Row inspector:** a floating card that opens when you click a row. It shows:
  - the location and title
  - confidence (High, Medium or Low, with %) and the reason
  - the matched reference row (clicking it opens the reference file at that row)
  - the norm used (links to norms.docx)
  - the price source (a file row, or a web link for web prices)
  - editable Quantity, Norm and Unit price, with a live row total, and **Save change** (the row is then marked EDITED)

**pdf:** page thumbnails, Prev/Next with "Page 2 of 14", zoom and text search with highlights. Pages are drawn as a Danish supplier price list.

**docx:** a rendered document (the "Hourly norms 2025" tables and adjustments) with search highlighting.

**Failed to render:** "This document can't be displayed" with the reason (password-protected), **Try again** and **Download original**.

**Loading:** "Opening document…" with skeleton lines.

### 5.6 `SettingsNav`
Usage & costs, Model routing, Profile, and Users (with an *Admin* tag).

### 5.7 Badges and tags
- **Status badges** (dot and label, pill shape): Queued, Reading, Analysing, Analysed, Failed, In progress, Done, Sent, Needs attention.
- **Language tag:** monospace, outlined (`LV`, `EN`, `DA`).
- **Model tier and cost badge:** outlined tier name plus a monospace cost. A dark tooltip shows token counts.

---

## 6. States covered

| State | Where |
|---|---|
| Knowledge base empty, chat locked | `setup.dc.html?empty=1`, `chat-new.dc.html?locked=1`, `knowledge.dc.html?empty=1` |
| File analysis failed | Setup file row; `knowledge-file.dc.html?f=broken` |
| Agent working (long run) | `chat.dc.html?s=working` |
| Permission: pending / approved / denied / expired | `chat.dc.html?s=permission`; component page |
| Web search found nothing | `chat.dc.html?s=nothing` |
| Email failed | `chat.dc.html?s=emailfail` |
| Budget near limit / exceeded | `settings-usage.dc.html?b=near` / `?b=over`; `chat.dc.html?s=blocked` |
| Vague work list | `chat.dc.html?s=vague` |
| Very long estimate (1,248 rows) | Document viewer on any estimate |
| Document failed to render | `chat.dc.html?doc=broken`; component page |
| Mobile chat and viewer sheet | `mobile.dc.html` |
| Empty history / no matches | `history.dc.html?empty=1` |
| Expired invite link | `set-password.dc.html?expired=1` |
| Users: no access | `settings-users.dc.html?role=estimator` |

Deep links for the viewer: `chat.dc.html?s=result&doc=estimate&sheet=EL&row=58` (split) and `&mode=full` (full screen). The `doc` values are `estimate`, `blank`, `datacenter`, `braila`, `norms`, `solar` and `broken`.

---

## 7. Sample content

- **Main estimate:** *Estimate_Denmark_Hal_B.xlsx* (Danish). Sheets EL, ELT, Belysning and Tavler; 1,248 rows; 1,224 priced items.
  - Total **DKK 45,626,345** excl. VAT: labour DKK 17,526,628 (38%) and material DKK 28,099,717 (62%).
  - Labour rate DKK 430/h. 10 rows need attention. 17 prices are web-sourced.
- **References:** data-center.xlsx (DA), Braila 23.xlsx (LV), norms.docx (EN), Solar prisliste 2025.pdf (DA), Price list 2025.xlsx (LV), and others.
- **Latvian examples:** the Braila 24 work list, the Teikums blank, the Ķekava house.
- The data is deterministic and generated by `estimate-data.js`, so every row number, total and chip in the chat matches the viewer.

---

## 8. Responsive behaviour

- **Desktop first.** Below 760px:
  - the sidebar becomes a drawer
  - the document viewer becomes a full-screen sheet
  - the inspector becomes a bottom sheet
  - History rows stack into cards
- Tables inside cards scroll horizontally within their own container. The page itself never scrolls sideways.
- Touch targets on phone bars are at least 36–44px.

---

## 9. File map

| File | Role |
|---|---|
| `Estimates AI Agent.dc.html` | Index of all pages and states |
| `Sidebar.dc.html`, `SettingsNav.dc.html` | Navigation |
| `Composer.dc.html` | Composer and "/" picker |
| `Message.dc.html` | User and agent messages, steps, document card, web table, footer |
| `InlineCard.dc.html` | Permission, structure, clarify and email cards |
| `DocViewer.dc.html` | Document viewer (xlsx, pdf, docx, failed) |
| `estimate-data.js` | Deterministic sample estimates |
| `login`, `set-password`, `setup`, `knowledge`, `knowledge-file`, `chat-new`, `chat`, `history`, `settings-*` (`.dc.html`) | Pages |
| `components.dc.html` | Component set |
| `mobile.dc.html` | Phone previews |
| `v1/` | Earlier operator-console exploration (kept for reference) |
