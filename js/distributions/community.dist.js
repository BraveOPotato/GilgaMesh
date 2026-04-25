/**
 * distributions/community.dist.js
 *
 * Community-focused distribution. Ships with offline messaging,
 * room storage, music player, and discount bot.
 * Core infra plugins are non-removable; entertainment plugins are removable.
 */
export default {
  name: 'GilgaMesh Community',
  description: 'Full-featured community chat with shared room history and entertainment.',
  plugins: [
    { id: 'offline-manager',       removable: false },
    { id: 'room-storage-bucket',   removable: false },
    { id: 'music-player',          removable: true  },
    { id: 'discount-bot',          removable: true  },
  ],
};
