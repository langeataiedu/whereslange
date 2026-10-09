// Live page: loads the status from the Worker and draws it. Refreshes every 5 minutes while open.
(function () {
  const REFRESH_MS = 5 * 60e3;

  // An expired login comes back as Cloudflare Access's sign-in page instead of JSON. Reload once to
  // sign in again; if that just happened, show a message instead of reloading in a loop.
  function signInAgain() {
    let last = 0;
    try { last = Number(sessionStorage.getItem('signin-reload')) || 0; } catch (e) { /* storage blocked */ }
    if (Date.now() - last < 60e3) return LangePage.renderMessage('Please sign in again: close this page and reopen it.');
    try { sessionStorage.setItem('signin-reload', String(Date.now())); } catch (e) { /* storage blocked */ }
    location.reload();
  }

  async function load() {
    let res;
    try {
      res = await fetch('/api/status', { cache: 'no-store', credentials: 'same-origin' });
    } catch (e) {
      return LangePage.renderMessage("Can't reach the server right now. Try again in a minute.");
    }
    if (!(res.headers.get('Content-Type') || '').includes('application/json')) return signInAgain();
    if (res.status === 503) return LangePage.renderMessage('No update from Lange yet. Check back soon.');
    if (!res.ok) return LangePage.renderMessage("Something went wrong loading Lange's status.");

    const data = await res.json();
    LangePage.render(LangeFormat.viewModel(data.status, {
      now: Date.now(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      home: data.home,
      phone: data.phone,
      highlight: data.highlight,
    }));
  }

  load();
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
