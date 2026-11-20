# Voncloft-Kasts

A self-hosted podcast library, web player, and sync server for Kasts on Linux and AntennaPod on Android. Keep your subscriptions, listening progress, and ordered queue together while using your own LAMP server.

The website is called **Podcast Sync**. Open `/dashboard/` on your server and sign in with the same sync account used by your apps. An HTTP-only session cookie keeps you signed in across page refreshes; your password is not stored in browser storage. Sign out ends the server session.

## What the website does

- **Overview:** shows subscription, queue, device, and playback-update totals, plus your queue and recent listening activity. Click each of the four summary cards to open its matching page.
- **Subscriptions:** displays podcast artwork and names. Click a podcast or episode title/thumbnail to read the full synopsis, browse episodes, play audio, or add episodes to the shared queue. Subscribe by RSS URL or remove subscriptions.
- **Library search:** searches podcast names and episode titles across subscribed podcasts and the shared queue. Matching episodes include their podcast name, Play, and Add to queue controls. Titles are indexed while feeds load, so you do not have to open every podcast first. Inside a podcast, filtering also searches episode synopses; a labeled matching excerpt explains synopsis-only results. Click a result to read its full synopsis with matching text highlighted.
- **Discover:** searches Apple Podcasts by show name, topic, or creator. Click a thumbnail or title to preview a podcast and its episodes without subscribing. Subscribe remains a separate choice on both the search card and the podcast page.
- **Back navigation:** the on-page Back button with an arrow icon and browser Back return to the saved results, query, filter, visible item count, and scroll position. Browser Forward reopens the podcast.
- **Web playback:** streams audio from the publisher, saves listening progress, supports playback speed and skip controls, and can continue through the selected listening list. Finishing an episode on the website removes it from the shared queue if it is queued.
- **Shared queue:** add, remove, clear, and reorder episodes. Drag the grip beside a queue row to move it freely with a mouse or touch. Earlier/Later buttons and keyboard Up/Down/Home/End are also available. Reordering filtered results preserves hidden episodes. The stored queue and order are exchanged with the modified desktop and Android clients.
- **Sorting and counts:** sort subscriptions by latest episode date in either direction, title, or count. Thumbnail counts can show Unplayed, Played, Total episodes, In queue, or Off. Episode lists also support newest/oldest ordering.
- **Devices:** shows registered sync identities and separate live player reports, including episode, playing/paused/stopped state, and position.
- **Playback history:** shows the latest synced episode-state records. These are not a complete listening-session history or a lifetime listening-time total.
- **Android download:** the sidebar has a Latest Android APK link with the available custom app version. It downloads from the server's public downloads folder without signing in.

- **Account settings:** click your username beside Sign out to change your sync password. Enter the current password and the new password twice (at least 12 characters, at most 72 UTF-8 bytes). This browser stays signed in; older sessions end. Update Kasts and AntennaPod with the new password. The database password is separate.

## Versions covered by this update

| Component | Version |
| --- | --- |
| Website and server update | **1.1.6** |
| AntennaPod Queue Sync | **3.12.3-vonqueue.3** / Android versionCode **3120397** |
| Kasts with queue sync and live reporting | **26.08.3, package release 5** |

The features above describe the 1.1.6 update package. Older archives committed to this repository may contain earlier versions; check the website footer or `/health` on your installed server. Updating this README alone does not deploy the application.

## How synchronization works

Use one account on the website, Kasts, and AntennaPod Queue Sync. Distinct device names make the clients easier to identify. Sharing a sync identity is possible, but the Devices page then lists that identity once; live player reports still identify separate players.

Website changes save to the server immediately. Other apps receive subscriptions, queue changes, and playback progress when they synchronize. Queue edits are **not instant push updates**. Sync the app making a change, then sync the other device when you want to see it immediately. Kasts' playback-only quick upload does not exchange the shared queue.

While visible, the website checks the library for updates about every 30 seconds. Web playback progress saves approximately every 15 seconds. Updated clients report live playback about every 15 seconds; reports are marked stale after 90 seconds without an update. Live status is informational and does not remotely control another device.

Queue membership and order require the modified clients because ordinary gpodder sync does not carry an ordered queue. Stock clients can use compatible subscription and episode-state endpoints, but do not gain queue sync or live reporting just by changing the server address.

Played/unplayed counts and title searches use episodes still listed in the publisher's feed, up to the parser limit of 2,000 episodes per feed. Old episodes already in the shared queue remain searchable there. Failed feeds are indicated in search results. Sorting preferences for subscription and episode views are local; changes to the actual shared queue order sync between devices.

## Server requirements and initial setup

- Apache 2.4 with URL rewriting and your PHP handler, including PHP-FPM if used.
- PHP 8.1 or newer with PDO, the selected database driver, sessions, JSON, and DOM/XML.
- MariaDB/MySQL for a LAMP deployment; SQLite is also supported by the server.
- Publisher-feed downloads through PHP HTTPS support, or the system `curl` command with HTTPS support and PHP `proc_open` enabled.
- A writable private `server/var/` directory for runtime caches and sessions.

No Nextcloud, Docker, Composer, Android Studio, or cron job is required to use the delivered server and APK. See [the initial setup guide](docs/SETUP.txt) and [client build instructions](docs/BUILD.txt) for the base installation; use the component versions above for the newer queue/live-status features.

Point Apache's DocumentRoot at **`server/public/`**, not the repository root. Keep database credentials in `server/config/config.php`, outside the public directory. Initialize the database and create the sync user with `server/bin/manage.php` as described in the setup guide. Use that sync username/password in each client; the database password is separate.

Your website can use HTTP on your LAN. Publishers may still require HTTPS for feeds and artwork, which the server fetches using PHP or curl. HTTP does not encrypt the sync credentials; use HTTPS when exposing authenticated access outside your trusted LAN.

## Updating the existing LAMP installation

Use the supplied **`Podcast-Sync-Web-Player-1.1.6.zip`** update package. On the LAMP server, after copying it into `/tmp`:

```bash
(
set -e
unzip -o /tmp/Podcast-Sync-Web-Player-1.1.6.zip -d /tmp/podcast-web-player-1.1.6
bash /tmp/podcast-web-player-1.1.6/install.sh /media/Websites/kasts_server/server
curl -fsS http://127.0.0.1:87/health
)
```

Substitute your own installation path and server address when deploying elsewhere. The installer's default target is `/media/Websites/kasts_server/server`.

The installer verifies checksums and PHP requirements, backs up the previous application files and README, publishes the Android APK, and prints a rollback command. It does not replace the configuration or database and does not require a database migration. The repository README is installed one directory above `server/`.

Open `http://YOUR-SERVER/dashboard/` and use **Ctrl+Shift+R** once. The footer and `/health` should report **1.1.6**. Sign in once after installing 1.1.6 to renew the session; subsequent refreshes restore your session and current page. If PHP-FPM has an opcode cache with timestamp checks disabled, reload PHP-FPM so it reads the updated PHP files.

## Android app and public download folder

The sidebar's **Latest Android APK** link points to:

```text
/downloads/AntennaPod-Queue-Sync-3.12.3-3.apk
```

The installer places the file at:

```text
server/public/downloads/AntennaPod-Queue-Sync-3.12.3-3.apk
```

That is an intentionally public static download; only the app package belongs there. Source archives, configuration, backups, and the update ZIP remain outside the web document root.

Open the sidebar link on your phone and install over the existing **AntennaPod Queue Sync** app. Keep the app installed so Android retains its library and settings. Revision 3 uses the same signing certificate as earlier custom revisions. Android Studio is not needed; Android 6.0 or newer is required.

The custom package is `de.danoeh.antennapod.vonqueue`; it is separate from stock AntennaPod. This is a signed custom debug build, not an upstream Play Store release. Future custom updates must retain the same signing key. The update ZIP includes the corresponding AntennaPod source, patch, build instructions, and GPL license.

Revision 3 provides explicit **Newest first / Oldest first** controls on subscriptions, podcast episode lists, and the queue. Subscription order compares each show's latest episode date. Queue sorting changes the shared queue order on the next synchronization.

## Connecting the clients

In **Kasts**, choose Settings → Synchronization → gpodder.net → Log In, enable the custom server option, and enter the server's base URL and sync account. Use the base URL, without `/dashboard/` or `/api/2`. The gpodder.net choice also supports a self-hosted compatible server; the Nextcloud option uses a different protocol.

In **AntennaPod Queue Sync**, choose the gpodder.net synchronization provider, enter the same custom server base URL, and use the same sync account. Select or create a device identity, then synchronize. Install the modified Kasts/AntennaPod versions for shared queue support and live reports.

## Changelog

### Website 1.1.6

- Click the signed-in username to open Account settings and change the sync password.
- Requires the current password, matching new passwords and a session token; rotates the current session and invalidates older sessions.
- Queue rows support dragging by their grip, edge scrolling and keyboard Up/Down/Home/End. Earlier/Later controls remain available.
- Queue moves save through the existing revision-aware shared queue and preserve episodes hidden by filters.
- No database migration or new Android build is required. Update the saved sync password in each app after changing it.


### Website 1.1.5

- Click episode titles or thumbnails to open full synopsis details.
- Podcast synopses are expanded; search terms are highlighted and synopsis-only matches show an excerpt.
- A Back button with an arrow icon works throughout the website and restores the prior search context.
- Refresh restores the signed-in session and current page without storing a password in browser storage.
- The four Overview summary cards link to Subscriptions, Queue, Devices and Playback history.


### Website 1.1.4

- Discover thumbnails and titles open podcast previews without subscribing.
- Subscribe remains available on both Discover cards and podcast details.
- Browser Back/Forward and Back to search results preserve navigation context.
- Library search also matches episode titles and exposes playback/queue actions.
- The sidebar shows the latest custom Android APK version and public download.
- README now explains the website, setup, sync behavior, downloads, and limits.

### AntennaPod 3.12.3-vonqueue.3

- Explicit newest/oldest choices for subscriptions, podcast episodes, and queue.
- More visible sorting controls; existing queue sync and live reports retained.

### Website 1.1.3

- Configurable subscription counts and live player status on the Devices page.

### Website 1.1.2

- Continuous playback fixes, date ordering, and artwork handling for larger feeds.

### Earlier releases

- Initial gpodder-compatible server, ordered queue sync, dashboard, and web player.
- Publisher downloads through system curl when PHP HTTPS support is unavailable.
