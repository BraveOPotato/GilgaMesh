/**
 * distributions/privacy.dist.js
 *
 * Privacy-focused distribution. Minimal external server contact.
 * Only personal encrypted storage for DMs. No room-level persistence.
 */
export default {
  name: 'GilgaMesh Privacy',
  description: 'Privacy-first P2P chat. Minimal server contact. Encrypted personal storage only.',
  plugins: [
    { id: 'personal-storage-bucket', removable: false },
  ],
};
