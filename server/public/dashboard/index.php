<?php
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
  <title>Podcast Sync · Your library</title>
  <link rel="stylesheet" href="app.css">
  <script src="app.js" defer></script>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <a class="brand" href="./" aria-label="Podcast Sync home"><span class="brand-mark" aria-hidden="true">◖◗</span><span>Podcast<span class="brand-second">Sync</span></span></a>
      <div class="sidebar-label">YOUR LIBRARY</div>
      <nav id="navigation" aria-label="Dashboard sections" hidden>
        <button type="button" data-view="overview" class="nav-item active" aria-current="page"><span aria-hidden="true">▦</span>Overview</button>
        <button type="button" data-view="subscriptions" class="nav-item"><span aria-hidden="true">◉</span>Subscriptions<span id="nav-subscriptions" class="nav-count"></span></button>
        <button type="button" data-view="queue" class="nav-item"><span aria-hidden="true">≡</span>Queue<span id="nav-queue" class="nav-count"></span></button>
        <button type="button" data-view="devices" class="nav-item"><span aria-hidden="true">▣</span>Devices</button>
        <button type="button" data-view="activity" class="nav-item"><span aria-hidden="true">◷</span>Playback history</button>
      </nav>
      <div class="sidebar-footer"><span class="status-dot"></span>Your server, your library<span class="muted">A view of your last synced data.</span></div>
    </aside>
    <main>
      <header class="topbar"><span id="server-name" class="server-name"></span><div id="account-controls" class="account-controls" hidden><span id="account-name"></span><button id="sign-out" class="text-button" type="button">Sign out</button></div></header>
      <section id="login-screen" class="login-wrap">
        <div class="eyebrow">WELCOME HOME</div>
        <h1>Your podcasts.<br>Your place.</h1>
        <p class="intro">See your subscriptions, what’s up next, and the apps sharing your library.</p>
        <form id="login-form" class="login-card">
          <h2>Sign in to your sync account</h2>
          <label for="username">Username</label><input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" pattern="[a-zA-Z0-9_.-]{1,64}" maxlength="64" required>
          <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required>
          <button id="sign-in" type="submit" class="primary-button">Open my library <span aria-hidden="true">↗</span></button>
          <p id="login-error" class="error-text" role="alert" hidden></p>
          <p class="login-note">Use the same account as Kasts and AntennaPod. This page only views your library.</p>
        </form>
      </section>
      <section id="dashboard" hidden>
        <div class="page-heading"><div><div class="eyebrow">PODCAST SYNC</div><h1 id="page-title">Your library, together.</h1><p id="page-subtitle" class="muted">Everything your apps have shared with this server.</p></div><div class="refresh-area"><button id="refresh" class="secondary-button" type="button"><span aria-hidden="true">↻</span> Refresh</button><span id="updated-at" class="small muted"></span></div></div>
        <p id="dashboard-error" class="error-banner" role="alert" hidden></p>
        <div id="stats" class="stats">
          <article class="stat-card"><span class="stat-label">Subscriptions</span><strong id="stat-subscriptions">0</strong><span class="stat-detail">Active podcast feeds</span></article>
          <article class="stat-card accent"><span class="stat-label">Up next</span><strong id="stat-queue">0</strong><span id="stat-duration" class="stat-detail">In your shared queue</span></article>
          <article class="stat-card"><span class="stat-label">Devices</span><strong id="stat-devices">0</strong><span class="stat-detail">Registered sync identities</span></article>
          <article class="stat-card"><span class="stat-label">Playback updates</span><strong id="stat-actions">0</strong><span class="stat-detail">Latest saved episode updates</span></article>
        </div>
        <div id="overview-view">
          <div class="overview-grid"><section class="surface"><div class="section-heading"><div><span class="eyebrow">READY WHEN YOU ARE</span><h2>Your listening queue</h2></div><button class="text-button" type="button" data-view="queue">View all →</button></div><div id="queue-preview"></div></section><section class="surface"><div class="section-heading"><div><span class="eyebrow">LAST HEARD</span><h2>Recent playback</h2></div><button class="text-button" type="button" data-view="activity">View all →</button></div><div id="activity-preview"></div></section></div>
          <div class="sync-note"><span aria-hidden="true">↔</span><div><strong>One account. One shared library.</strong><p>Sync in one app, then the other, to exchange changes. Refresh this page to see what the server has received.</p></div></div>
        </div>
        <section id="detail-view" class="surface detail-surface" hidden>
          <div class="list-toolbar"><label class="search-label" for="search"><span aria-hidden="true">⌕</span><input id="search" type="search" placeholder="Search your library" autocomplete="off"></label><span id="result-count" class="small muted"></span></div>
          <p id="list-note" class="list-note"></p>
          <div id="list-content"></div>
          <div class="load-more-wrap"><button id="load-more" class="secondary-button" type="button" hidden>Show more</button></div>
        </section>
        <footer class="page-footer">Read-only dashboard <span aria-hidden="true">·</span> Make changes in Kasts or AntennaPod</footer>
      </section>
      <div id="status" class="sr-only" role="status" aria-live="polite"></div>
    </main>
  </div>
</body>
</html>
