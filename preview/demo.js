// Design preview: renders the real page (public/page.js) from fixture statuses in demo-data.js.
// URL params: ?scenario=<key in demo-data.js>  &viewer=mary|jason  &theme=light|dark
(function () {
  const params = new URLSearchParams(location.search);
  const demo = window.DEMO;
  const scenario = demo.scenarios[params.get('scenario')] || demo.scenarios.travel;
  const viewer = demo.viewers[params.get('viewer')] || demo.viewers.mary;
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

  // The Worker sends the viewer's highlight with the status; the demo derives it here.
  const metro = viewer.metro && demo.config.metros[viewer.metro];
  LangePage.render(LangeFormat.viewModel(scenario.status, {
    now: Date.parse(scenario.now),
    tz: 'America/Los_Angeles',
    home: demo.config.home,
    phone: demo.config.phone,
    highlight: metro ? { metro: viewer.metro, label: metro.label } : null,
  }), '../public/assets/');
})();
