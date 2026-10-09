# Dashboard quality

Phase 8 evidence. What is measured, and what is not.

| Roadmap item | Status | Evidence |
| --- | --- | --- |
| 8.1 Connection state from the backend | covered | `src/lib/providerCards.ts` marks a card `connected` only when a credential exists, the connection is enabled, and health is not unavailable or degraded; `tests/provider-card-merge.test.js` pins that a paused connection is not connected however healthy |
| 8.1 Catalog presence is not readiness | covered | `tests/provider-card-honesty.test.js` and the merge tests |
| 8.2 Pending and duplicate-submit states | covered in part | `AddProviderModal` and the connect dialogs show pending states; not separately tested for duplicate submission |
| 8.3 Dialog focus management | **fixed** | the three connect dialogs (OAuth, Kiro, web cookie) now restore focus to the control that opened them on close; `AddProviderModal` already did this |
| 8.3 Escape closes dialogs | covered | the connect dialogs and `AddProviderModal` handle Escape |
| 8.3 Keyboard navigation of the whole page, contrast, screen-reader labels | **not measured** | needs a real browser driver and an accessibility audit |
| 8.4 Large lists | **not measured** | needs a benchmark with a large provider and model list (Phase 9) |

## What was measured, and how

- Focus restore was added to the three dialogs that lacked it. The typecheck passes, the repo guards pass, and the
  providers page renders in headless Chromium with no error markers.
- Focus restore itself was **not** exercised in a browser. A static DOM dump cannot show which element has focus.
  That check needs a driver that opens a dialog, closes it and reads `document.activeElement`.

## Still open

- Keyboard-only walkthrough and a contrast audit.
- Duplicate-submit tests for the connect flows.
- Large-list performance, which belongs with Phase 9's benchmarks.
