import axios from 'axios';

/**
 * True when the Scratch API could not be reached or returned a gateway / overload response.
 * Used to show a recoverable “no connection” splash instead of a bare error string.
 */
export function isServerConnectionError(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED') {
      return true;
    }
    if (!error.response) {
      return true;
    }
    const status = error.response.status;
    return status === 502 || status === 503 || status === 504;
  }
  if (error instanceof TypeError && error.message === 'Failed to fetch') {
    return true;
  }
  return false;
}
