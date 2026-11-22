declare namespace chrome {
  namespace runtime {
    interface LastError {
      message?: string;
    }
    const lastError: LastError | undefined;
    function getURL(path: string): string;
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: { id?: string; url?: string },
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    };
    const onInstalled: {
      addListener(callback: () => void): void;
    };
    const onStartup: {
      addListener(callback: () => void): void;
    };
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      setAccessLevel?(accessOptions: {
        accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
      }): Promise<void>;
    }
    const local: StorageArea;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      windowId?: number;
      url?: string;
      title?: string;
      active?: boolean;
    }
    function query(queryInfo: { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>;
    function create(createProperties: { url: string; active?: boolean }): Promise<Tab>;
  }

  namespace windows {
    function create(createData: {
      url: string;
      type?: 'normal' | 'popup' | 'panel';
      width?: number;
      height?: number;
    }): Promise<{ id?: number }>;
  }

  namespace action {
    function openPopup(): Promise<void>;
  }

  namespace contextMenus {
    type ContextType = 'page' | 'selection';
    interface OnClickData {
      menuItemId: string | number;
      pageUrl?: string;
      selectionText?: string;
    }
    function removeAll(): Promise<void>;
    function create(
      createProperties: {
        id: string;
        title: string;
        contexts: ContextType[];
      },
      callback?: () => void,
    ): void;
    const onClicked: {
      addListener(callback: (info: OnClickData, tab?: tabs.Tab) => void): void;
    };
  }

  namespace scripting {
    interface InjectionResult<T = unknown> {
      result?: T;
    }
    function executeScript<T = unknown>(injection: {
      target: { tabId: number };
      func: () => T;
    }): Promise<InjectionResult<T>[]>;
  }

  namespace permissions {
    interface Permissions {
      origins?: string[];
    }
    function contains(permissions: Permissions): Promise<boolean>;
    function request(permissions: Permissions): Promise<boolean>;
  }
}
