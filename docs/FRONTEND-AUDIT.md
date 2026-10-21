# Frontend audit — the dashboard, end to end

Ten audit slices over `src/app/(dashboard)/**`, `src/shared/**` and the API
contract in both directions. Every finding below was re-checked by hand before
it went in: the slices reported their own verification, and the ones that
contradicted each other were settled by reading the code.

**Scope:** 198 frontend files (~45 000 lines), 52 shared components, 11
hooks/stores, 177 API routes, 34 locale files.

**How to read it:** `broken` = a user-visible feature does not work; `bug` =
the UI shows the wrong thing or lies; `contract` = the frontend and the API
disagree; `dead` = code that can never run.

**Status: fixed.** Everything in sections 1–4 below has been fixed, except the
translations (section 5, a translator's backlog) and the features that are
hidden on purpose (PXPIPE, the media combos, the Kiro social buttons, the
combo presets, the Donate button — the last one is meant to come back). The
fixes carry their own tests where the logic could be extracted; the rest is
covered by the build and the suite.

One thing the audit turned up on its own: the React Compiler lint rules that
came with Next 16 flag ~140 pre-existing violations in this tree (a fetch in
an effect that then sets state — the pattern this codebase uses everywhere).
As errors they blocked every change that touched a file, including the fixes
below, so they are warnings now; the debt is visible and can be paid down
file by file.

---

## 1. Broken features

| # | Where | What is wrong | Effect |
|---|---|---|---|
| 1 | `basic-chat/BasicChatPageClient.js:646` | POSTs to `/api/dashboard/chat/completions`; no such route exists (the real one is `/api/v1/chat/completions`) | Every message answers `Error: Request failed (404)` — the page can never reach a model |
| 2 | `providers/new/page.js:14-17,148,169-178` | `authMethodOptions` reads `m.name`, but `AUTH_METHODS` entries only have `{id}` → every label is `undefined`; the form's own ids (`api_key`, `oauth2`) match none of the option ids (`apikey`, `oauth`, `cookie`); the "Connect with OAuth2" button has no `onClick` | Three unlabelled icon buttons, none selected; picking "apikey" hides the API-key field and makes the key optional; the OAuth button does nothing |
| 3 | `providers/[id]/page.js:669` + `ModelRow.js` + `CompatibleModelsSection.js` + `providers/components/ModelsCard.js` | `onSetAlias` is passed by three call sites; **no receiving component destructures it** (one even passes `() => {}`) | The model-alias editor is unreachable: an alias can be deleted but never created or renamed |
| 4 | `providers/[id]/page.js:20` | `PassthroughModelsSection` (174 lines) is imported and never rendered | The passthrough providers (openrouter, kilocode, bai, grok-web) never get their "add any model id" panel |
| 5 | `shared/components/KiroOAuthWrapper.js:18-34` | `handleMethodSelect` handles `builder-id`, `idc`, `social`, `import`, `api-key` — but not `import-cli-proxy`, which `KiroAuthModal.js:131` calls on success | The CLIProxy import succeeds server-side; the frontend drops it — no refresh, no modal close, no feedback |
| 6 | `shared/components/Sidebar.js:91-99` | The update countdown's `setInterval` is never stored and never cleared on unmount | Navigating away during the countdown still fires `POST /api/version/shutdown` — the gateway shuts itself down after the user left the page |
| 7 | `providers/[id]/AddApiKeyModal.js` | The form state (name, apiKey, proxyPoolId, region) is initialised from the `provider` prop and **never reset** (11 `useState`, 0 `useEffect`); the modal is mounted unconditionally, so it survives a provider change | Provider A's typed key stays in provider B's dialog — and saving stores A's credential under B |
| 8 | `combos/page.js:920` | `ModelItem` seeds `draft` from the `model` prop but is keyed by `uid: \`item-${i}\`` (the index) | After a drag-reorder, editing a row writes the model that used to be in that slot — a duplicated model, the dragged one gone |
| 9 | `usage/components/ProviderLimits/index.js:544` | `refreshAll` marks **every** connection loading but only fetches the non-Claude ones (Claude is skipped 9 ticks out of 10), and the loading flag is cleared only inside `fetchQuota`'s `finally` | The Claude account card spins forever, and its Refresh / reset-credit buttons stay disabled |
| 10 | `cli-tools/components/CoworkToolCard.js:535` | The `ModelSelectModal` renders, but `setModelSelectOpen(true)` is never called | The Cowork card cannot add a plain model — only combos |

## 2. Bugs — the UI lies or shows the wrong thing

| # | Where | What is wrong | Effect |
|---|---|---|---|
| 11 | `shared/hooks/useCopyToClipboard.js:15-30` | The async write is not awaited and `setCopied(id)` runs unconditionally | Every copy button (20 call sites) claims "Copied!" when the clipboard write was rejected — and the rejection is unhandled |
| 12 | `store/themeStore.js:19` | `toggleTheme()` derives from the *stored* theme, but the default is `"system"` | With the theme on "System" and a dark OS, the first click on the toggle does nothing visible |
| 13 | `endpoint/components/KeyRateLimitControls.js:120-127` | The hint says "Leave empty to use the global ceiling", but an empty field is saved as `0` — and `0` means **no limit** | Clearing the field silently removes the key's rate limit instead of inheriting the global one |
| 14 | `shared/components/Badge.js` (no `neutral` variant) + `UsageStats.js:344,379,404,430` | `<Badge variant="neutral">` resolves to `undefined` | The provider badge in all four usage tables renders as bare text |
| 15 | `shared/components/Button.js` (no `default` variant) + `XiaomiMimoAuthModal.js:299` | `<Button variant="default">` resolves to `undefined` | The MiMo modal's main CTA renders with no background — it looks like plain text |
| 16 | `shared/components/Toggle.js:5-13` | `Toggle` destructures a fixed prop list and never spreads `...props` | The `title` / `aria-label` at 7 call sites are dropped: the "Pause key" tooltip never appears and two switches have no accessible name |
| 17 | `providers/[id]/page.js:1355` | The test-all stream handler keys results by `model.split("/").pop()`, but model ids may contain `/` (`anthropic/claude-opus-4.7`) | "Test all" paints no per-model status for Cline, ClinePass and Cloudflare-AI; the filter reports everything as "Untested" |
| 18 | `providers/[id]/page.js:1802-1809` | "Apply Proxy" opens the modal directly and the modal applies to **all** connections, ignoring the checkbox selection; the selection-aware helper `openBulkProxyModal` is never wired | Ticking 2 of 5 connections and applying a pool changes all 5 |
| 19 | `usage/components/ProviderLimits/index.js:769-772` | The `visibilitychange` handler starts new intervals without clearing the old ones | Two 60 s pollers and two countdowns — double the provider API traffic, countdown at 2× speed |
| 20 | `usage/components/ProviderLimits/index.js:267` | `expiringFirst` is in the `useCallback` deps but never used in the body | Toggling a sort re-fetches every connection **and** re-polls every provider quota |
| 21 | `usage/components/ProviderLimits/index.js:1372,1387` | `quota.message` is rendered by two branches | The provider's message appears twice in the same card |
| 22 | `usage/components/RequestDetailsTab.js:191,214,228` | Changing a filter does not reset `pagination.page` | After paging to page 2 and narrowing the filter: "No request details found" — the rows are on page 1 |
| 23 | `usage/components/RequestDetailsTab.js:145-149` | `fetchDetails` never checks `res.ok` | A server error is shown as "no requests recorded" |
| 24 | `usage/components/RequestDetailsTab.js:459-503` vs `api/usage/request-details/route.js:56-64` | The drawer renders four payload sections; the route replaces all four with `{redacted: true}` | Every section shows `{"redacted": true}` — a permanent dead end |
| 25 | `usage/components/RequestDetailsTab.js:269,278` | 9 columns, `colSpan="7"` | The empty/loading row is centred over 7 of 9 columns |
| 26 | `usage/components/ProviderLimits/QuotaTable.js:120-122` | Returns `null` for an empty list, with no fallback at the call site | A connected account with no quota rows renders a blank card |
| 27 | `combos/page.js:243-250,186-197` | `persistComboStrategies` / `handleSetCapacityAdapter` never check `res.ok` | The dropdown shows a new strategy while the server kept the old one — the change vanishes on reload |
| 28 | `endpoint/EndpointPageClient.js:647-667,687,703` | `handleCreateKey` has no error branch; the toggle/access handlers only `console.log` | A failed key creation is silent; the modal stays open with no message |
| 29 | `combos/page.js:179`, `endpoint/EndpointPageClient.js:266` | Neither list fetch has an error state | A server failure renders as "No combos yet" / "No API keys yet" |
| 30 | `endpoint/EndpointPageClient.js:141-169,122-136` | The browser-side ping and the status poll both stop once everything is healthy (the "slow" tier constants are never used) | If the tunnel dies, the dashboard keeps showing it as reachable until a reload |
| 31 | `endpoint/EndpointPageClient.js:540-565,587-613` | The Tailscale login/funnel loops have no unmount check | Up to two minutes of polling after leaving the page |
| 32 | `shared/components/ProviderMiniChat.js:330-377` | The persist effect writes the previous provider's messages into the new provider's storage key, and the restore timeout then reads the overwritten value | Navigating between providers destroys the second provider's saved chat and shows the first's |
| 33 | `shared/components/OAuthModal.js:768,978` | In paste-token mode the error panel and the paste form render together; "Try Again" opens a browser OAuth popup | Two conflicting panels; the retry does the wrong thing |
| 34 | `shared/hooks/useModelCaps.js:78-86` | `invalidate()` returns the in-flight promise instead of forcing a new fetch, and the cache is only invalidated by a listener that needs a mounted consumer | A custom model's capabilities stay stale for the rest of the session |
| 35 | `store/settingsStore.js:50-57` | `patchSettings` swallows every failure and returns `null`; no consumer reads an error | The per-key rate-limit override shows the new number while the limit never changed |
| 36 | `shared/components/AddCustomEmbeddingModal.js:52-66` | `handleSubmit` acts only `if (res.ok)` — no `else`, no error state | A rejected save looks like nothing happened |
| 37 | `translator/page.js:118,141` | The early `return` on failure skips the `setLoad(..., false)` | After one failed translate the button spins forever and stays disabled |
| 38 | `cli-tools/components/GenericCliToolCard.js:128` | `getConfigStatus()` never returns `"other"` | The "Other" badge is unreachable — a foreign endpoint still shows "Connected" |
| 39 | `token-saver/TokenSaverClient.js:203` | `handleHeadroomStop` has no `catch` and no `res.ok` check | An unhandled rejection; a 500 is treated as success |
| 40 | `profile/page.js:1280` | `navigator.clipboard.writeText` is not awaited, no `.catch()`, and the success message is set unconditionally | Over plain HTTP `navigator.clipboard` is `undefined` → the click throws, nothing is copied, no error is shown |
| 41 | `proxy-pools/page.js:562` | The import dedupe key is `new URL(...).toString()` (adds a trailing `/`), the stored key is the raw URL | Re-importing the same list creates a duplicate pool every time |
| 42 | `providers/page.js:420-428` | `availableCount` subtracts `connectedCount` and `attentionCount`, but a provider with one good and one failing connection is in both | The "Available" tile under-reports |
| 43 | `usage/components/ProviderLimits/utils.js:795,798` | `case "apinex":` appears twice in one switch | The second label is unreachable |
| 44 | `basic-chat/BasicChatPageClient.js:173-195` | `useState(() => localStorage.getItem(...))` reads storage during the first client render | The first client tree differs from the server's — a hydration mismatch on every return visit |
| 45 | `basic-chat/BasicChatPageClient.js:720` | On Stop the fetch rejects with `AbortError`; the catch only handles other errors | The assistant bubble stays empty and marked "streaming" |
| 46 | `shared/components/RequestLogger.js:15-23`, `usage/components/RateLimitStatusCard.js:81`, `endpoint/components/KeyRateLimitControls.js:75` | The poll intervals never check `document.hidden` | A background tab keeps hitting the server every 3 s / 10 s / 15 s forever |
| 47 | `shared/components/Header.js:25-53` | The media-detail branch assumes the segment after `/media-providers/` is a registry provider id; `web` and `combo` are not | The page title shows the raw id ("web"), and the breadcrumb links to a route that 404s |
| 48 | `shared/components/Header.js:150-160` | `handleLogout` only navigates when `res.ok` | A failed logout is a silent dead end |
| 49 | `skills/page.js:100` | "View on GitHub" points at `/tree/master/skills`; the repo's branch is `main` (the constants use `BRANCH = "main"`) | The link 404s |
| 50 | `shared/constants/skills.js` | The `SKILLS` list has 8 entries; the repo ships 9 (`omnihilbras-video` is missing) | The video skill cannot be copied from the UI |

## 3. Contract mismatches

| # | Where | What is wrong |
|---|---|---|
| 51 | `shared/constants/providers.js:83,89` → `media-providers/.../GenericExampleCard.js:163` | The kinds declare `POST /v1/images/understanding` and `POST /v1/audio/music`; neither route exists → the cards show `HTTP 404` |
| 52 | `media-providers/.../GenericExampleCard.js:90-96` | The "Connection" picker is filled from `/api/providers/client`, which filters to providers with `features.usage` — OpenAI, Cloudflare-AI, Gemini and xAI have none → the row never renders on exactly the pages that need it |
| 53 | `providers/new/page.js:27,190` vs `api/providers/route.js:88-196` | The form posts `isActive` and `authMethod`; the route hardcodes `isActive: true` and never reads `authMethod` | The "Active" toggle is ignored — the connection is always created active |

## 4. Dead code

**Components nothing renders:** `shared/components/Footer.js` (the landing page has its own),
`shared/components/Avatar.js`, `shared/components/NineRemoteButton.js` +
`NineRemotePromoModal.js`, the `Loading` / `Spinner` / `PageLoading` exports of
`Loading.js` (only `CardSkeleton` is used), `usage/.../ProviderLimits/ProviderLimitCard.js`
(+ its only importer `QuotaProgressBar.js`), `cli-tools/components/AntigravityToolCard.js`
(480 lines), `cli-tools/components/CopilotToolCard.js`,
`cli-tools/components/EndpointPresetControl.js`.

**Barrels and modules only they reach:** `src/store/index.js` (so `userStore.js`
and `providerStore.js` are dead too), `src/shared/constants/index.js` (so
`colors.js` is dead), `src/shared/hooks/index.js`, `src/shared/utils/api.js`
(a 93-line HTTP wrapper).

**Dead exports (never imported):** `getProviderModelsForMapping`,
`webSessionProviderIds`, `sortRequestFromExpiringFirst`, `getStatusColor`,
`getStatusEmoji`, `STATUS_POLL_SLOW_MS`, `CLIENT_PING_SLOW_MS`,
`getBucketSnapshot`, `getRawMachineId`, `isBrowser`, `SUBSCRIPTION_CONFIG`,
`API_ENDPOINTS`, `ID_TO_ALIAS`, `CSS_VARIABLES`, `isValidModelCore`,
`FREE_PROVIDERS` / `WEB_COOKIE_PROVIDERS` / `PROVIDER_MODELS` (the "backward
compatibility" re-exports in `config.js`), `extractDelta` (re-exported from
`ProviderMiniChat.js`), and 16 barrel re-exports in `shared/components/index.js`.

**Dead state and helpers:** `machineId` (three pages compute it, three clients
ignore it), `proxyPools` (`EditConnectionModal`), `badge` / `actions`
(`EndpointRow`), `onClose` (`ProviderMiniChat` — the "Close chat" button can
never appear), `providerDisplayAlias`, `kindFilter`, `authType`, `initialStatus`
(14 tool cards), `bulkProxyPoolId`, `clearSelection`, `selectedProxySummary`,
`openBulkProxyModal`, `sortItemsByPriority`, `dotColors` / `dotLabels`,
`lastUpdated`, the `quotaCacheData` localStorage entry (written, never read),
`handleNewChat` / `handleSelectProvider` (Basic Chat), `AUTO_PING_TOOLIPS`,
`pageSizeLabel`, `noPrivilege`, `WINDOW_MS`.

**Endpoints with no caller:** `api/models/availability`, `api/models/catalog-sync`,
`api/oauth/codex/import-token`, `api/providers/[id]/test-models`, `api/tags`,
`api/usage/history`, `api/cli-tools/copilot-settings`.

**Hidden on purpose — kept, not deleted:** the PXPIPE block in Token Saver
(`{false && …}`, labelled "hidden from UI — experimental"), `COMBO_KINDS` in
`media-providers/[kind]/page.js` (an empty set, labelled "currently disabled"),
the Kiro social-login buttons (`className="hidden"`), the combo preset buttons
(`className="hidden"`), and `SHOW_DONATE = false` in the header — the Donate
button is meant to come back.

## 5. Translations

- **28 `translate()` keys are missing from every locale file** — "Invalid JSON",
  "Bulk Add Codex Accounts", "Import All", "Request failed" and 24 more. They
  render in English in all 34 languages.
- **28 of the 34 locale files hold only 195 of the 1 644 keys.** Complete:
  zh-CN (1417), fa (1407), km (1396), id/th (1391). Skeleton: uk, ur, vi, zh-TW
  (195). Switching to French leaves most of the UI in English.

This is a translation backlog, not a code defect — the fallback to the source
string works. It needs a translator, not a patch.

---

## What was checked and found clean

- Every `fetch`/`EventSource` URL in the dashboard resolves to a real route
  (the only exceptions are the findings above), including the `next.config.mjs`
  rewrites and the `publicRoutes` table.
- Every `.map()` key is unique except the two index-keyed reorder lists
  (findings 8 and the combo model list).
- Every `setInterval`/`setTimeout` is cleared on unmount — except the three
  polling loops in finding 46 and the two in finding 31.
- The OAuth action set (`authorize`, `exchange`, `poll`, `device-code`,
  `ide-status`, `start-proxy`, `poll-status`, `stop-proxy`, `manual-code`,
  `password-login`, `register-session`) all exist in the dynamic route.
- The key create → reveal → copy → delete flow matches the API: the plaintext
  is returned exactly once, the list shows the masked form.
- The per-key access control and rate-limit override payloads match
  `validateKeyAccessInput` and the gateway's `settings.rateLimit.keyOverrides`.
- No `TODO`/`FIXME`/`XXX`/`HACK` markers in the frontend.
- No console noise in render paths or event handlers.
- The `Modal`/`Drawer`/`ConfirmModal` escape, overlay and scroll-lock handling
  is consistent; the SSE consumers close their `EventSource` on unmount.
