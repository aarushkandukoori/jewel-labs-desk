// The shared app context: { state, dispatch, route, nav, toast, refresh }. app.js provides it;
// every view reads it with useApp().
import { createContext, useContext } from '../vendor/preact-htm.mjs';

export const AppContext = createContext(null);

export function useApp() {
  return useContext(AppContext);
}
