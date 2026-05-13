/**
 * src/plugins/sdk/api-types.ts — Public API surface for plugin authors.
 *
 * These types document the GilgaMesh object injected into every sandbox.
 * Plugin code is plain JavaScript but authors can reference these for docs.
 */

export interface FetchResult {
  readonly ok:     boolean;
  readonly status: number;
  readonly body:   string; // raw text — parse JSON yourself
}

export interface NotifyResult {
  readonly sent: boolean;
}

export interface StorageResult {
  readonly value: unknown;
}

export interface StorageWriteResult {
  readonly ok: boolean;
}

export interface SendResult {
  readonly sent: boolean;
}

export interface ButtonOptions {
  /** Tooltip text shown on hover. */
  readonly label:       string;
  /** Emoji or single character displayed on the button. */
  readonly icon:        string;
  /** DOM id of the chrome area to inject into. Default: 'header-right'. */
  readonly targetArea?: string;
  /** Hook event name fired back to the plugin when clicked. */
  readonly eventName:   string;
}

export interface BotRegisterOptions {
  /** Slash command name without '/'. E.g. 'remind'. */
  readonly command:     string;
  readonly description: string;
  readonly scope?:      'room' | 'dm' | 'both';
  readonly icon?:       string;
}

export interface BotCommandPayload {
  readonly command: string;
  readonly args:    string;
  readonly context: CommandContext;
}

export interface CommandContext {
  readonly roomId?:     string;
  readonly channel?:    string;
  readonly dmPeerId?:   string;
  readonly authorId:    string;
  readonly authorName:  string;
}

export interface RegisterResult {
  readonly registered: boolean;
  readonly command:    string;
}

export interface GilgaMeshAPI {
  readonly pluginId:    string;
  readonly permissions: Set<string>;

  /** Subscribe to a lifecycle or inter-plugin event. Returns unsubscribe fn. */
  on(event: string, callback: (payload: unknown) => void): () => void;

  /** Emit an event to all other enabled plugins. */
  emit(event: string, payload?: unknown): void;

  readonly api: {
    /** Proxied fetch. Requires 'network' permission. */
    fetch(url: string, options?: RequestInit): Promise<FetchResult>;

    /** Browser notification. Requires 'notifications' permission. */
    notify(title: string, body?: string): Promise<NotifyResult>;

    /** Check if a peer is currently online. */
    isPeerOnline(peerId: string): Promise<{ online: boolean }>;

    readonly dm: {
      /** Read DM history. Requires 'dm:read'. */
      getHistory(peerId: string): Promise<unknown[]>;
      /** Send a DM. Requires 'dm:write'. */
      send(peerId: string, content: string): Promise<SendResult>;
    };

    readonly room: {
      /** Read channel history. Requires 'room:read'. */
      getHistory(roomId: string, channel?: string): Promise<unknown[]>;
      /** Inject a message. Requires 'room:write'. */
      send(roomId: string, channel: string, content: string): Promise<SendResult>;
    };

    readonly storage: {
      /** Read from isolated plugin store. Requires 'storage:read'. */
      get(key: string): Promise<StorageResult>;
      /** Write to isolated plugin store. Requires 'storage:write'. */
      set(key: string, value: unknown): Promise<StorageWriteResult>;
      /** Delete from isolated plugin store. Requires 'storage:write'. */
      delete(key: string): Promise<StorageWriteResult>;
    };

    readonly ui: {
      /** Add a button to app chrome. Requires 'ui:inject'. */
      addButton(opts: ButtonOptions): Promise<{ injected: boolean }>;
    };

    readonly bot: {
      /** Register a slash command. Requires 'bot:command'. */
      register(opts: BotRegisterOptions): Promise<RegisterResult>;
      /**
       * Send a bot response into the conversation that triggered the command.
       * Call from inside GilgaMesh.on('bot:command', cb).
       * Requires 'bot:command'.
       */
      respond(content: string, context: CommandContext): Promise<SendResult>;
    };
  };
}
