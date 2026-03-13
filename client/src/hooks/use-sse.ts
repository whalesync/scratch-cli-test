import { EventSourceMessage, fetchEventSource } from '@microsoft/fetch-event-source';
import { useEffect, useState } from 'react';

// Define the options for our hook
interface UseSSEOptions {
  url: string;
  authToken: string | null;
  authType: 'api-token' | 'jwt';
  // Let's add optional callbacks for more control
  onOpen?: () => void;
  onMessage?: (event: EventSourceMessage) => void;
  onError?: (error: unknown) => void;
}

// Define the return type of our hook
interface SSEReturn<T> {
  /** The most recent data event from the server. */
  data: T | null;
  /** The last error that occurred. */
  error: unknown | null;
  /** A boolean indicating if the SSE connection is currently active. */
  isConnected: boolean;
}

/**
 * A React hook to connect to a Server-Sent Events (SSE) endpoint with custom headers.
 *
 * @template T The expected type of the data from the server.
 * @param {UseSSEOptions} options - The configuration for the SSE connection.
 * @returns {SSEReturn<T>} An object containing the latest data, error, and connection status.
 */
export const useSSE = <T = unknown>({
  url,
  authToken,
  authType,
  onOpen,
  onMessage,
  onError,
}: UseSSEOptions): SSEReturn<T> => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);

  useEffect(() => {
    // Do not connect if the URL or token is not provided.
    // This is useful for conditional connections.
    if (!url || !authToken) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- guard clause resets connection state when preconditions are absent
      setIsConnected(false);
      return;
    }

    const ctrl = new AbortController();

    const connect = async () => {
      try {
        await fetchEventSource(url, {
          headers: {
            Authorization: authType === 'api-token' ? `API-Token ${authToken}` : `Bearer ${authToken}`,
            Accept: 'text/event-stream',
          },
          signal: ctrl.signal,

          onopen: async (response) => {
            if (response.ok) {
              console.debug('SSE connection established.');
              setIsConnected(true);
              setError(null);
              onOpen?.(); // Call the user-provided callback
            } else {
              // Handle non-200 responses, like 401 Unauthorized
              const err = new Error(`Failed to connect: ${response.status} ${response.statusText}`);
              setIsConnected(false);
              setError(err);
              onError?.(err);
              ctrl.abort(); // Stop retrying on auth errors
            }
          },

          onmessage: (ev: EventSourceMessage) => {
            console.debug(`SSE message: ${ev.event}, data: ${ev.data}`);
            try {
              const parsedData = JSON.parse(ev.data) as T;
              setData(parsedData);
              onMessage?.(ev); // Call the user-provided callback
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
            } catch (e) {
              // If data isn't JSON, you might want to handle it differently
              // For this example, we'll set the raw data
              setData(ev.data as T);
              onMessage?.(ev);
            }
          },

          onerror: (err) => {
            console.error('SSE Error:', err);
            setIsConnected(false);
            setError(err);
            onError?.(err);
            // The library will attempt to reconnect automatically.
            // If you want to stop it, you must throw the error.
            // For example, on a 401 error, we might not want to retry.
            // This is handled in onopen, but is an option here too.
          },
        });
      } catch (err) {
        // This catch is for fatal, non-recoverable errors
        if (!ctrl.signal.aborted) {
          console.error('Fatal SSE Error:', err);
          setError(err);
          onError?.(err);
        }
      }
    };

    connect();

    // Cleanup function: abort the connection when the component unmounts
    // or when dependencies change.
    return () => {
      console.debug('Closing SSE connection on unmount');
      ctrl.abort();
      setIsConnected(false);
    };

    // IMPORTANT: Add any function props to the dependency array.
    // The consuming component MUST memoize them with `useCallback`.
  }, [url, authToken, onOpen, onMessage, onError, authType]);

  return { data, error, isConnected };
};
