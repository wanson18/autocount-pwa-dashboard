# Task 3 fix round 1 report

Status: COMPLETE_WITH_CONCERNS

## Review findings addressed

- Invoice and trip visual cards are non-interactive containers. Dedicated
  Select buttons own selection, and assignment/Print Items controls remain
  siblings; no interactive element is nested inside another.
- Tabs use the ARIA tab pattern with one `tabindex="0"` tab, `aria-selected`
  updates, ArrowLeft/ArrowRight/Home/End navigation, focus movement, and
  matching `aria-controls`/`aria-labelledby` relationships.
- The queue badge, `<select>`, state, visible count, and refresh request use
  the same `all`, `enterprise`, or `sdn_bhd` filter. Refresh deliberately
  preserves the selected filter.
- Every dispatch fixture invoice now carries `docKey` beside
  `companyKey + invoiceId`; parity assertions compare the active Task 1
  fixture documents and preserve company-scoped identity.

## RED/GREEN evidence

- RED: `node --test test/dispatch-state.test.mjs` exited 1 after the new tests
  were added, because the production module did not yet export the requested
  filter/tab helpers.
- GREEN: `node --test test/dispatch-state.test.mjs` exited 0 with 11/11
  passing tests.
- Full suite: `npm test` exited 0 with 79 passing, 1 hosted-provider test
  skipped, and 0 failures.
- Build: `npm run build` exited 0.
- Diff: `git diff --check` exited 0. Git emitted only existing LF/CRLF
  normalization warnings.

## Browser evidence

The Task 3 Chromium inspection covered 390x844, 768x1024, and 1440x1000.
At each viewport, `documentScrollWidth == documentClientWidth`, no primary
controls were clipped, tabs and invoice/trip selection worked, and the
following screenshots were captured:

| Evidence | SHA-256 |
| --- | --- |
| `output/playwright/dispatch-390.png` | `478D7E701A10AB38D8E504BCEECB1F7ABF763F2253196BF0868911B1F6F54D32` |
| `output/playwright/dispatch-768.png` | `969775B00B79C8269C09D6B00AB5D9BA4B53DBB61D8C01A1B87BBC9A4BDB550B` |
| `output/playwright/dispatch-1440.png` | `40D96A08642155D46826E0F917D6DEB3FDEA6BCA5D56236CC81E99557DA296A4` |

The screenshots and `.playwright-cli/` are untracked evidence and are not
included in either commit.

## Safety recheck

- Dispatch browser/test assets contain no account-book IDs or credential
  names.
- Fixture quantities remain decimal strings, including `2.125`, `3.000`, `1`,
  and `2`; no floating-point aggregation was added.
- The dispatch UI remains fixture-only. Its only fetch path is the injected
  GET invoice-feed transport; no backend write or deployment configuration was
  added.

## Commits

- Code/tests: `612ec393207925c79b43eb325b86a0c40f023f71`
- Report update: recorded separately after the report commit.
