// Draws the page from a view model (LangeFormat.viewModel). Used by the live page (app.js)
// and the design preview (preview/demo.js). Browser global: LangePage.
(function (root) {
  function render(vm, assetBase = 'assets/') {
    function el(tag, cls, text, ...children) {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text) n.textContent = text;
      n.append(...children.filter(Boolean));
      return n;
    }
    const star = (show) => show && el('span', 'star', '★');
    const link = (cls, text, href) => { const a = el('a', cls, text); a.href = href; return a; };

    // Sky follows Lange's local hour (the viewer's own hour when he's home).
    const h = vm.today.localHour;
    document.documentElement.dataset.sky = h < 5 ? 'night' : h < 8 ? 'dawn' : h < 17 ? 'day' : h < 20 ? 'dusk' : 'night';

    // Animated Lange, waving. data-state is there if the animation should ever react to the page.
    const portrait = el('img');
    portrait.src = `${assetBase}lange-waving.svg`;
    portrait.alt = '';
    const avatar = el('div', 'avatar-slot', null, portrait);
    avatar.id = 'avatar-slot';
    avatar.dataset.state = vm.today.inAir ? 'in-air' : vm.pill ? 'travel-day' : vm.today.isHome ? 'home' : 'away';
    avatar.setAttribute('aria-hidden', 'true');

    // Stamp: Local Mail in the Bay Area / Sacramento / San Joaquin, Air Mail anywhere else or in flight.
    const stamp = el('div', 'stamp');
    stamp.setAttribute('aria-hidden', 'true');
    stamp.innerHTML = vm.today.mail === 'local'
      ? '<div><svg viewBox="0 0 32 20" width="30" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">'
        + '<path d="M1 15h30M9 3v15M23 3v15M1 11Q6 8 9 3Q16 14 23 3Q26 8 31 11"/></svg><small>LOCAL MAIL</small></div>'
      : '<div><span>✈</span><small>AIR MAIL</small></div>';

    const away = !vm.today.isHome && !vm.today.inAir;
    const today = el('section', 'card today', null,
      el('p', 'eyebrow', away ? 'Today · Greetings from' : 'Today'),
      el('p', 'place', vm.today.place, star(vm.today.work && away)),
      vm.today.sub && el('p', 'sub', vm.today.sub),
      vm.today.localTime && el('p', 'local-time', vm.today.localTime),
      vm.pill && el('p', 'pill', vm.pill),
      stamp);

    const back = vm.back && el('section', 'card back', null,
      el('p', 'eyebrow', 'Back in San Francisco'),
      el('p', 'back-date', vm.back.date, el('span', 'rel', vm.back.rel)));

    const trips = vm.trips.map((t) => el('li', t.badge ? 'trip mine' : 'trip', null,
      el('span', 'dates', t.dates),
      el('span', 'where', t.place, star(t.work)),
      t.badge && el('span', 'extra', null, el('span', 'badge', t.badge), link('dinner', "Let's get dinner", t.dinnerHref))));

    const upcoming = el('section', 'upcoming', null,
      el('h2', 'eyebrow', 'Coming up'),
      trips.length ? el('ul', 'trips', null, ...trips) : el('p', 'empty', 'Nothing planned for the next two months.'),
      vm.showKey && el('p', 'key', '★ = work trip, so Lange is less free to meet up'));

    const actions = el('nav', 'actions', null, link('btn btn-text', 'Text Lange', vm.textHref), link('btn btn-call', 'Call', vm.callHref));

    const updated = el('footer', vm.updated.stale ? 'updated stale' : 'updated', null,
      el('span', 'updated-time', vm.updated.text),
      vm.updated.stale && el('span', 'stale-note', 'may be out of date'));

    document.getElementById('app').replaceChildren(
      el('main', 'page', null, el('h1', 'title', "Where's Lange?"), avatar, today, back, upcoming, actions, updated));
  }

  /** A message in place of the page (no status yet, or an error). */
  function renderMessage(text) {
    const p = document.createElement('p');
    p.className = 'card message';
    p.textContent = text;
    const main = document.createElement('main');
    main.className = 'page';
    main.append(Object.assign(document.createElement('h1'), { className: 'title', textContent: "Where's Lange?" }), p);
    document.getElementById('app').replaceChildren(main);
  }

  root.LangePage = { render, renderMessage };
})(window);
