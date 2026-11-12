import { ChatInterface } from './components/ChatInterface';
import { useSystemAccent } from './hooks/useSystemAccent';

/**
 * Task 21 moved the shell (AppShell + Rail + Sidebar slots) inside ChatInterface, where the project
 * and session state already lives. App stays a single mounted view; the rail's destinations are real
 * actions (new chat, search palette, project focus, memory/settings modals), not placeholder views.
 * `useSystemAccent` paints the Windows system accent over the brand tokens when running in Electron.
 */
function App() {
    useSystemAccent();
    // The UI language is applied by `lib/prefs` (at import, and inside `setUiLanguage`), so this
    // component stays a pure wrapper: applying the dictionary here meant a side effect during render.
    return <ChatInterface />;
}

export default App;
