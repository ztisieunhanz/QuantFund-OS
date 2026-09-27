export interface ChatRequestCoordinator {
  readonly begin: () => ChatRequestLease;
  readonly isCurrent: (requestId: number) => boolean;
  readonly finish: (requestId: number) => void;
  readonly dispose: () => void;
  readonly isPending: () => boolean;
}

export interface ChatRequestLease {
  readonly requestId: number;
  readonly signal: AbortSignal;
}

/**
 * Synchronous latest-request ownership for chat UI surfaces. React state remains
 * the visual lifecycle. Starting a request invalidates the prior lease so stale
 * success, error, and finally paths cannot mutate the visible conversation.
 */
export function createChatRequestCoordinator(): ChatRequestCoordinator {
  let sequence = 0;
  let activeRequest: { readonly requestId: number; readonly controller: AbortController } | null = null;

  return Object.freeze({
    begin: (): ChatRequestLease => {
      activeRequest?.controller.abort();
      sequence += 1;
      const controller = new AbortController();
      activeRequest = { requestId: sequence, controller };
      return Object.freeze({ requestId: sequence, signal: controller.signal });
    },
    isCurrent: (requestId: number): boolean => activeRequest?.requestId === requestId,
    finish: (requestId: number): void => {
      if (activeRequest?.requestId === requestId) activeRequest = null;
    },
    dispose: (): void => {
      activeRequest?.controller.abort();
      activeRequest = null;
    },
    isPending: (): boolean => activeRequest !== null,
  });
}
