export async function verifyVisibleActionMatrix({ execute: rawExecute, fail, sessionId, wait, waitForVisibleHeading }) {
  const evidence = [];
  let currentStage = "bootstrap";
  const execute = async (...args) => {
    try {
      return await rawExecute(...args);
    } catch {
      fail(`visible action matrix execution failed at ${currentStage}`);
    }
  };
  const assert = (condition, message) => {
    if (!condition) fail(`visible action matrix: ${message}`);
  };
  const waitUntil = async (script, message, attempts = 160, delayMs = 200) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await execute(sessionId, script)) return;
      await wait(delayMs);
    }
    fail(`visible action matrix: ${message}`);
  };
  const navigate = async (route) => {
    await execute(sessionId, `window.location.hash = ${JSON.stringify(`#${route}`)}; return true;`);
    await waitForVisibleHeading(sessionId, route);
    await wait(150);
  };

  currentStage = "dashboard";
  await navigate("dashboard");
  const about = await execute(sessionId, `return (() => {
    const button = document.querySelector('.about-toggle');
    if (!button || button.disabled || /indir ve kur/iu.test(button.textContent ?? '')) return false;
    button.click(); return true;
  })();`);
  if (about) {
    await waitUntil("return Boolean(document.querySelector('#blogbot-about-card'));", "about card did not open");
    await waitUntil("return Boolean(document.querySelector('#blogbot-about-card button:not(:disabled)'));", "about update check stayed busy", 240);
    await execute(sessionId, "document.querySelector('#blogbot-about-card button:not(:disabled)').click(); return true;");
    await waitUntil("return Boolean(document.querySelector('#blogbot-about-card button:not(:disabled)')) && !document.querySelector('#blogbot-about-card button')?.textContent?.includes('…');", "about update check did not finish", 240);
    evidence.push("about-update-check");
  } else {
    evidence.push("about-update-entry");
  }
  await execute(sessionId, `return (() => { const button = document.querySelector('button.setup-button:not(.settings-button):not(.diagnostic-button)'); if (!button) return false; button.click(); return true; })();`);
  await waitUntil("return window.location.hash === '#setup';", "prerequisite action did not open setup");
  evidence.push("prerequisite-navigation");

  currentStage = "sources";
  await navigate("content");
  const sourceTabs = await execute(sessionId, "return document.querySelectorAll('.source-composer .segmented-control button').length;");
  assert(sourceTabs === 3, "source input modes were incomplete");
  await execute(sessionId, "document.querySelectorAll('.source-composer .segmented-control button')[1].click(); return true;");
  await execute(sessionId, `return (() => { const field = document.querySelector('.source-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'https://example.invalid/feed.xml\\nhttp://127.0.0.1/private'); field.dispatchEvent(new Event('input', { bubbles: true })); return true; })();`);
  await execute(sessionId, "document.querySelector('.source-composer .composer-actions button').click(); return true;");
  await waitUntil("return document.querySelectorAll('.candidate-panel .candidate-row').length >= 1 && Boolean(document.querySelector('.inline-notice.is-warning[role=alert]'));", "bulk source preview did not separate accepted and rejected inputs");
  evidence.push("source-bulk-security-preview");

  await execute(sessionId, "document.querySelectorAll('.source-composer .segmented-control button')[2].click(); return true;");
  await execute(sessionId, `return (() => { const field = document.querySelector('.source-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, '<opml version="2.0"><body><outline text="Synthetic" xmlUrl="https://example.invalid/opml-feed.xml"/></body></opml>'); field.dispatchEvent(new Event('input', { bubbles: true })); return true; })();`);
  await execute(sessionId, "document.querySelector('.source-composer .composer-actions button').click(); return true;");
  await waitUntil("return document.querySelectorAll('.candidate-panel .candidate-row').length === 1;", "OPML preview did not produce one candidate");
  await execute(sessionId, "document.querySelectorAll('.source-composer .segmented-control button')[0].click(); return true;");
  assert(await execute(sessionId, "return document.querySelector('.source-composer textarea')?.rows === 2;"), "single source mode did not reactivate");
  evidence.push("source-opml-and-single-modes");

  const sourceHeaderButtons = await execute(sessionId, "return document.querySelectorAll('.source-list-actions button').length;");
  assert(sourceHeaderButtons >= 2, "source catalog actions were incomplete");
  await execute(sessionId, "document.querySelectorAll('.source-list-actions button')[0].click(); return true;");
  await waitUntil("return !document.querySelectorAll('.source-list-actions button')[0].disabled;", "source catalog refresh did not finish");
  await execute(sessionId, "document.querySelector('.source-list .row-menu').click(); return true;");
  assert(await execute(sessionId, "return Boolean(document.querySelector('.inline-notice[role=status]'));"), "source details did not render a status result");
  await execute(sessionId, "document.querySelectorAll('.source-list .source-row .source-row-actions .button-quiet')[1].click(); return true;");
  await waitUntil("return Boolean(document.querySelector('.source-review-panel'));", "source usage review did not open");
  await execute(sessionId, "document.querySelector('.source-review-actions button').click(); return true;");
  assert(await execute(sessionId, "return !document.querySelector('.source-review-panel');"), "source usage review did not cancel");
  await execute(sessionId, "document.querySelectorAll('.source-list-actions button')[1].click(); return true;");
  await waitUntil(`return (() => { const progress = document.querySelector('.source-scan-progress-track'); return Boolean(progress) && Number(progress.getAttribute('aria-valuenow')) >= Number(progress.getAttribute('aria-valuemax')); })();`, "all-source scan did not finish", 300);
  evidence.push("source-refresh-details-review-cancel-scan-all");

  currentStage = "candidates";
  await navigate("content-candidates");
  const initialCandidateCount = await execute(sessionId, "return document.querySelectorAll('.candidate-card').length;");
  assert(initialCandidateCount >= 5, "candidate fixture did not expose five actionable rows");
  await execute(sessionId, "document.querySelectorAll('.candidate-bulk-actions button')[0].click(); return true;");
  assert(await execute(sessionId, "return [...document.querySelectorAll('.candidate-card input[type=checkbox]')].every((item) => item.checked);"), "candidate select-all failed");
  await execute(sessionId, "document.querySelectorAll('.candidate-bulk-actions button')[1].click(); return true;");
  assert(await execute(sessionId, "return ![...document.querySelectorAll('.candidate-card input[type=checkbox]')].some((item) => item.checked);"), "candidate selection clear failed");
  currentStage = "candidate-single-close";
  const beforeClose = await execute(sessionId, "return document.querySelectorAll('.candidate-card').length;");
  const singleCloseClicked = await execute(sessionId, "return (() => { const button = document.querySelector('.candidate-card .card-actions .button-secondary'); if (!button || button.disabled) return false; button.click(); return true; })();");
  assert(singleCloseClicked, "candidate single close action was unavailable");
  await waitUntil(`return document.querySelectorAll('.candidate-card').length < ${beforeClose};`, "candidate single close did not remove the selected row");
  await waitUntil("return !document.querySelectorAll('.candidate-bulk-actions button')[0].disabled;", "candidate single close did not settle");
  currentStage = "candidate-bulk-hide";
  const beforeHide = await execute(sessionId, "return document.querySelectorAll('.candidate-card').length;");
  if (beforeHide < 1) {
    const directCandidateCount = await execute(sessionId, `return window.__TAURI_INTERNALS__.invoke('get_editorial_workspace', { includeCandidates: true })
      .then((workspace) => Array.isArray(workspace?.candidates) ? workspace.candidates.filter((item) => item?.state !== 'DISMISSED').length : -1)
      .catch(() => -2);`);
    fail(`visible action matrix: candidate fixture was exhausted before bulk hide; safe ui=${beforeHide}, direct=${directCandidateCount}, initial=${initialCandidateCount}`);
  }
  await execute(sessionId, "document.querySelector('.candidate-card input[type=checkbox]').click(); return true;");
  await waitUntil("return document.querySelector('.candidate-card input[type=checkbox]')?.checked === true && !document.querySelectorAll('.candidate-bulk-actions button')[2].disabled;", "candidate selection did not enable bulk hide");
  await execute(sessionId, "document.querySelectorAll('.candidate-bulk-actions button')[2].click(); return true;");
  await waitUntil(`return document.querySelectorAll('.candidate-card').length < ${beforeHide};`, "candidate bulk hide did not remove the selected row");
  await waitUntil("return !document.querySelectorAll('.candidate-bulk-actions button')[0].disabled;", "candidate bulk hide did not settle");
  evidence.push("candidate-select-clear-hide-close");

  currentStage = "candidate-bulk-research";
  const beforeResearchCards = await execute(sessionId, "return document.querySelectorAll('.candidate-card').length;");
  const researchTargets = await execute(sessionId, `return (() => { const cards = [...document.querySelectorAll('.candidate-card')].filter((card) => [...card.querySelectorAll('button')].some((button) => !button.disabled && /^Ara/u.test(button.textContent?.trim() ?? ''))).slice(0, 2); for (const card of cards) card.querySelector('input[type=checkbox]').click(); return cards.length; })();`);
  assert(researchTargets === 2, "candidate fixture did not expose two researchable rows");
  await waitUntil("return !document.querySelectorAll('.candidate-bulk-actions button')[3].disabled;", "candidate selection did not enable bulk research");
  await execute(sessionId, "document.querySelectorAll('.candidate-bulk-actions button')[3].click(); return true;");
  await waitUntil("return (() => { const progress = document.querySelector('.candidate-batch-progress'); return Boolean(progress) && Number(progress.getAttribute('aria-valuenow')) >= Number(progress.getAttribute('aria-valuemax')) && ![...document.querySelectorAll('.candidate-card input[type=checkbox]')].some((item) => item.checked); })();", "candidate bulk research did not finish", 300);
  const researchCardCount = await execute(sessionId, "return document.querySelectorAll('.candidate-card').length;");
  assert(researchCardCount <= beforeResearchCards, "candidate bulk research resurrected rows");
  evidence.push("candidate-bulk-research");

  currentStage = "editorial";
  await navigate("editorial");
  await execute(sessionId, "document.querySelector('.page-header .button-secondary').click(); return true;");
  await waitUntil("return !document.querySelector('.page-header .button-secondary').disabled;", "draft inventory refresh did not finish");
  const initialDraftCount = await execute(sessionId, "return document.querySelectorAll('.draft-row-with-action').length;");
  assert(initialDraftCount >= 1, "editorial fixture did not expose a draft");
  await execute(sessionId, "document.querySelectorAll('.editorial-bulk-actions button')[0].click(); return true;");
  assert(await execute(sessionId, "return [...document.querySelectorAll('.draft-row-with-action input[type=checkbox]')].every((item) => item.checked);"), "draft select-all failed");
  await execute(sessionId, "document.querySelectorAll('.editorial-bulk-actions button')[1].click(); return true;");
  assert(await execute(sessionId, "return ![...document.querySelectorAll('.draft-row-with-action input[type=checkbox]')].some((item) => item.checked);"), "draft selection clear failed");
  await execute(sessionId, "document.querySelector('.draft-row-with-action input[type=checkbox]').click(); return true;");
  await waitUntil("return document.querySelector('.draft-row-with-action input[type=checkbox]')?.checked === true && !document.querySelectorAll('.editorial-bulk-actions button')[2].disabled;", "draft selection did not enable bulk hide");
  await execute(sessionId, "document.querySelectorAll('.editorial-bulk-actions button')[2].click(); return true;");
  await waitUntil(`return document.querySelectorAll('.draft-row-with-action').length === ${initialDraftCount - 1};`, "draft hide did not remove one row");
  await execute(sessionId, "document.querySelector('.editorial-hidden-drafts button').click(); return true;");
  await waitUntil(`return document.querySelectorAll('.draft-row-with-action').length >= ${initialDraftCount};`, "hidden drafts did not restore");
  await execute(sessionId, "document.querySelector('#editorial-tab-review').click(); return true;");
  assert(await execute(sessionId, "return document.querySelector('#editorial-tab-review')?.getAttribute('aria-selected') === 'true';"), "editorial review tab did not activate");
  await execute(sessionId, "document.querySelector('#editorial-tab-drafts').click(); return true;");
  evidence.push("editorial-refresh-select-hide-restore-tabs");

  currentStage = "publishing";
  await navigate("publishing");
  for (const id of ["publishing-tab-scheduled", "publishing-tab-history", "publishing-tab-calendar"]) {
    await execute(sessionId, `document.querySelector(${JSON.stringify(`#${id}`)}).click(); return true;`);
    assert(await execute(sessionId, `return document.querySelector(${JSON.stringify(`#${id}`)})?.getAttribute('aria-selected') === 'true';`), `publishing tab ${id} did not activate`);
  }
  await execute(sessionId, "document.querySelector('.slot-summary').click(); return true;");
  await waitUntil("return Boolean(document.querySelector('.slot-card .slot-save'));", "weekly slot editor did not open");
  await execute(sessionId, "document.querySelector('.slot-card .slot-save').click(); return true;");
  await waitUntil("return !document.querySelector('.slot-card .slot-save')?.disabled;", "weekly slot save did not finish");
  evidence.push("publishing-tabs-slot-save");

  currentStage = "operations";
  await navigate("operations");
  const automationButtonSelector = ".page-header .header-actions button:first-of-type";
  const initialAutomationLabel = await execute(sessionId, `return document.querySelector(${JSON.stringify(automationButtonSelector)})?.textContent ?? '';`);
  await execute(sessionId, `document.querySelector(${JSON.stringify(automationButtonSelector)}).click(); return true;`);
  await waitUntil(`return document.querySelector(${JSON.stringify(automationButtonSelector)})?.textContent !== ${JSON.stringify(initialAutomationLabel)};`, "ingestion pause did not change state");
  await execute(sessionId, `document.querySelector(${JSON.stringify(automationButtonSelector)}).click(); return true;`);
  await waitUntil(`return document.querySelector(${JSON.stringify(automationButtonSelector)})?.textContent === ${JSON.stringify(initialAutomationLabel)};`, "ingestion resume did not restore state");
  for (const id of ["operations-tab-codex", "operations-tab-health", "operations-tab-activity"]) {
    await execute(sessionId, `document.querySelector(${JSON.stringify(`#${id}`)}).click(); return true;`);
    assert(await execute(sessionId, `return document.querySelector(${JSON.stringify(`#${id}`)})?.getAttribute('aria-selected') === 'true';`), `operations tab ${id} did not activate`);
  }
  const filterCount = await execute(sessionId, "return document.querySelectorAll('.log-toolbar button').length;");
  assert(filterCount === 4, "operation log filters were incomplete");
  for (let index = 0; index < filterCount; index += 1) {
    await execute(sessionId, `document.querySelectorAll('.log-toolbar button')[${index}].click(); return true;`);
    assert(await execute(sessionId, `return document.querySelectorAll('.log-toolbar button')[${index}]?.getAttribute('aria-pressed') === 'true';`), `operation log filter ${index} did not activate`);
  }
  evidence.push("operations-pause-resume-tabs-filters");

  currentStage = "settings";
  await navigate("settings");
  const originalAuthor = await execute(sessionId, "return document.querySelector('input[name=author]')?.value ?? ''; ");
  await execute(sessionId, `return (() => { const field = document.querySelector('input[name=author]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'Synthetic Audit Editor'); field.dispatchEvent(new Event('input', { bubbles: true })); return true; })();`);
  await execute(sessionId, "document.querySelectorAll('.settings-actions button')[1].click(); return true;");
  assert((await execute(sessionId, "return document.querySelector('input[name=author]')?.value ?? ''; ")) === originalAuthor, "settings cancel did not restore saved data");
  await execute(sessionId, "document.querySelectorAll('.settings-actions button')[2].click(); return true;");
  assert(await execute(sessionId, "return Boolean(document.querySelector('input[name=author]')?.value);"), "settings defaults did not populate the form");
  await execute(sessionId, "document.querySelectorAll('.settings-actions button')[1].click(); return true;");
  const notificationEnabled = await execute(sessionId, "return !document.querySelectorAll('.settings-actions button')[3]?.disabled;");
  if (notificationEnabled) {
    await execute(sessionId, "document.querySelectorAll('.settings-actions button')[3].click(); return true;");
    await waitUntil("return Boolean(document.querySelector('.form-message[role=status]'));", "test notification did not render a result");
    evidence.push("settings-notification-test");
  }
  evidence.push("settings-edit-cancel-default-cancel");

  currentStage = "setup";
  await navigate("setup");
  const taskCount = await execute(sessionId, "return document.querySelectorAll('.setup-task-card').length;");
  assert(taskCount >= 4, "setup task hub was incomplete");
  for (let index = 0; index < taskCount; index += 1) {
    await execute(sessionId, `document.querySelectorAll('.setup-task-card')[${index}].click(); return true;`);
    await waitUntil("return Boolean(document.querySelector('#setup-task-title, #guided-setup-title'));", `setup task ${index} did not open`);
    await execute(sessionId, "document.querySelector('.setup-task-heading button').click(); return true;");
    await waitUntil("return Boolean(document.querySelector('.setup-task-grid'));", `setup task ${index} did not return to hub`);
  }
  evidence.push(`setup-focused-tasks-${taskCount}`);

  return { actionGroups: evidence.length, evidence };
}
