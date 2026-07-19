export type ApiTransport = (path: string, init: RequestInit) => Promise<Response>;

export const browserApiTransport: ApiTransport = (path, init) => fetch(path, init);

let activeTransport: ApiTransport = browserApiTransport;

export function configureApiTransport(transport: ApiTransport): () => void {
  const previous = activeTransport;
  activeTransport = transport;
  return () => {
    if (activeTransport === transport) activeTransport = previous;
  };
}

export function dispatchApiRequest(path: string, init: RequestInit): Promise<Response> {
  return activeTransport(path, init);
}
