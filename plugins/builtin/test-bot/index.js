/**
 * test-bot/index.js — Scaffold bot plugin for GilgaMesh.
 *
 * Registers the /test slash command (scope: 'both' = works in rooms + DMs).
 * When invoked, posts "Got called!" back to the chat via GilgaMesh.api.bot.respond().
 *
 * To install manually (dev console):
 *   window._gmInstallPlugin({ baseUrl: './plugins/builtin/test-bot' });
 */

(async () => {
  // Wait until GilgaMesh SDK is ready (it sets window.GilgaMesh)
  await new Promise(resolve => {
    if (window.GilgaMesh) { resolve(); return; }
    const iv = setInterval(() => {
      if (window.GilgaMesh) { clearInterval(iv); resolve(); }
    }, 50);
    setTimeout(() => { clearInterval(iv); resolve(); }, 3000);
  });

  const GM = window.GilgaMesh;
  if (!GM) { console.error('[test-bot] GilgaMesh SDK not available'); return; }

  // ── Register the /test command ──────────────────────────────────────────────
  try {
    await GM.api.bot.register({
      command:     'test',
      description: 'Confirm the bot system is working',
      scope:       'rooms',   // rooms only — matches manifest.json
      icon:        '🤖',
    });
    console.log('[test-bot] /test command registered');
  } catch (err) {
    console.error('[test-bot] Failed to register /test:', err.message);
    return;
  }

  // ── Listen for invocations ──────────────────────────────────────────────────
  GM.on('bot:command', async ({ command, args, context }) => {
    if (command !== 'test') return;  // guard: only handle our own command

    console.log('[test-bot] /test invoked, args:', args, 'context:', context);

    const reply = args
      ? `Got called! (you said: "${args}")`
      : 'Got called!';

    try {
      await GM.api.bot.respond(reply, context);
    } catch (err) {
      console.error('[test-bot] Failed to respond:', err.message);
    }
  });

  console.log('[test-bot] Ready.');
})();
