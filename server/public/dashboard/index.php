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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: http: https:; media-src 'self' http: https:; base-uri 'none'; form-action 'none'">
  <title>Podcast Sync · Listen together</title>
  <link rel="stylesheet" href="app.css?v=1.1.1">
  <script src="app.js?v=1.1.1" defer></script>
</head>
<body>
<div class="shell">
  <aside class="sidebar">
    <a class="brand" href="./"><span class="brand-mark" aria-hidden="true">◖◗</span><span>Podcast<span class="brand-second">Sync</span></span></a>
    <div class="sidebar-label">YOUR LIBRARY</div>
    <nav id="navigation" aria-label="Library sections" hidden>
      <button type="button" data-view="overview" class="nav-item active" aria-current="page"><span aria-hidden="true">▦</span>Overview</button>
      <button type="button" data-view="subscriptions" class="nav-item"><span aria-hidden="true">◉</span>Subscriptions<span id="nav-subscriptions" class="nav-count"></span></button>
      <button type="button" data-view="discover" class="nav-item"><span aria-hidden="true">⌕</span>Discover</button>
      <button type="button" data-view="queue" class="nav-item"><span aria-hidden="true">≡</span>Queue<span id="nav-queue" class="nav-count"></span></button>
      <button type="button" data-view="devices" class="nav-item"><span aria-hidden="true">▣</span>Devices</button>
      <button type="button" data-view="activity" class="nav-item"><span aria-hidden="true">◷</span>Playback history</button>
    </nav>
    <div class="sidebar-footer">Your server. Your library.<span class="muted">Listen here. Pick up anywhere.</span></div>
  </aside>
  <main>
    <header class="topbar"><span id="server-name" class="server-name"></span><div id="account-controls" class="account-controls" hidden><span id="account-name"></span><button id="sign-out" class="text-button" type="button">Sign out</button></div></header>
    <section id="login-screen" class="login-wrap">
      <div class="eyebrow">WELCOME HOME</div><h1>Your podcasts.<br>Your place.</h1>
      <p class="intro">Browse, queue, and listen. Your library stays connected to Kasts and AntennaPod.</p>
      <form id="login-form" class="login-card">
        <h2>Sign in to your sync account</h2>
        <label for="username">Username</label><input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" pattern="[a-zA-Z0-9_.-]{1,64}" maxlength="64" required>
        <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required>
        <button id="sign-in" type="submit" class="primary-button">Open my library</button>
        <p id="login-error" class="error-text" role="alert" hidden></p>
        <p class="login-note">Use the same account as your apps. Your password stays in this tab’s memory until you sign out or close it.</p>
      </form>
    </section>
    <section id="dashboard" hidden>
      <div class="page-heading"><div><div class="eyebrow">PODCAST SYNC</div><h1 id="page-title">Your library, together.</h1><p id="page-subtitle" class="muted">A little of everything you love listening to.</p></div><div class="refresh-area"><button id="refresh" class="secondary-button" type="button">Refresh</button><span id="updated-at" class="small muted"></span></div></div>
      <p id="dashboard-error" class="error-banner" role="alert" hidden></p>
      <p id="notice" class="notice" role="status" hidden></p>
      <div id="stats" class="stats">
        <article class="stat-card"><span class="stat-label">Subscriptions</span><strong id="stat-subscriptions">0</strong><span class="stat-detail">Podcasts in your library</span></article>
        <article class="stat-card accent"><span class="stat-label">Up next</span><strong id="stat-queue">0</strong><span id="stat-duration" class="stat-detail">In your shared queue</span></article>
        <article class="stat-card"><span class="stat-label">Devices</span><strong id="stat-devices">0</strong><span class="stat-detail">Registered sync identities</span></article>
        <article class="stat-card"><span class="stat-label">Playback updates</span><strong id="stat-actions">0</strong><span class="stat-detail">Latest saved episode updates</span></article>
      </div>
      <div id="overview-view">
        <div class="overview-grid"><section class="surface"><div class="section-heading"><div><span class="eyebrow">READY WHEN YOU ARE</span><h2>Your listening queue</h2></div><button class="text-button" type="button" data-view="queue">View all</button></div><div id="queue-preview"></div></section><section class="surface"><div class="section-heading"><div><span class="eyebrow">LAST HEARD</span><h2>Recent playback</h2></div><button class="text-button" type="button" data-view="activity">View all</button></div><div id="activity-preview"></div></section></div>
        <section class="library-preview"><div class="section-heading"><h2>Find your next listen</h2><button class="text-button" type="button" data-view="subscriptions">All subscriptions</button></div><div id="feed-preview" class="feed-grid"></div></section>
        <div class="sync-note"><strong>One account. One shared library.</strong><p>Web changes save to your server immediately. Kasts and AntennaPod receive them on their next sync. This page checks for changes every 30 seconds while visible.</p></div>
      </div>
      <section id="detail-view" hidden>
        <div id="discover-tools" class="surface add-feed" hidden><form id="discover-form"><label for="discover-query">Search podcasts by name, topic, or creator</label><div class="inline-form"><input id="discover-query" type="search" placeholder="Search podcasts" minlength="2" maxlength="160" required><button id="discover-submit" type="submit" class="primary-button">Search</button></div><p id="discover-error" class="error-text" role="alert" hidden></p></form></div>
        <div id="subscription-tools" class="surface add-feed" hidden><form id="subscribe-form"><label for="feed-url">Add a podcast by RSS feed URL</label><div class="inline-form"><input id="feed-url" type="url" placeholder="https://example.com/podcast/rss" required><button type="submit" class="primary-button" data-write>Subscribe</button></div></form></div>
        <div id="podcast-heading" hidden></div>
        <div class="surface detail-surface">
          <div class="list-toolbar"><label class="search-label" for="search"><span aria-hidden="true">⌕</span><input id="search" type="search" placeholder="Search your library" autocomplete="off"></label><span id="result-count" class="small muted"></span><button id="clear-queue" class="danger-button" data-write type="button" hidden>Clear queue</button></div>
          <p id="list-note" class="list-note"></p><div id="list-content"></div>
          <div class="load-more-wrap"><button id="load-more" class="secondary-button" type="button" hidden>Show more</button></div>
        </div>
      </section>
      <footer class="page-footer">Podcast Sync 1.1.1 <span aria-hidden="true">·</span> Audio streams directly from its publisher</footer>
    </section>
    <div id="status" class="sr-only" role="status" aria-live="polite"></div>
  </main>
</div>
<section id="player" class="player" aria-label="Audio player" hidden>
  <div class="now-playing"><div id="player-art"></div><div class="row-main"><div class="eyebrow">NOW PLAYING</div><strong id="player-title"></strong><button id="player-podcast" class="text-button" type="button"></button></div></div>
  <div class="playback-controls"><audio id="audio" controls preload="metadata"></audio><div class="player-options"><button id="skip-back" class="small-button" type="button" aria-label="Back 15 seconds">−15s</button><button id="skip-forward" class="small-button" type="button" aria-label="Forward 30 seconds">+30s</button><label for="playback-rate">Speed</label><select id="playback-rate"><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option></select><label class="check-label"><input id="auto-next" type="checkbox" checked>Play next</label></div></div>
  <div class="player-state"><span id="progress-status" class="small muted">Ready to play</span><button id="retry-progress" class="text-button" type="button" hidden>Retry saving</button><p id="player-error" class="error-text" role="alert" hidden></p></div>
</section>
<dialog id="confirm-dialog"><form method="dialog"><h2 id="confirm-title"></h2><p id="confirm-message"></p><div class="dialog-actions"><button value="cancel" class="secondary-button">Cancel</button><button value="confirm" id="confirm-button" class="danger-button">Confirm</button></div></form></dialog>
</body>
</html>
