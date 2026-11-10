import { useRef } from 'react';
import { ChatInterface } from './components/ChatInterface';
import { useSystemAccent } from './hooks/useSystemAccent';
import { applyUiLanguage } from './i18n/vi';
import { useUiLanguage } from './lib/prefs';

/**
 * Task 21 moved the shell (AppShell + Rail + Sidebar slots) inside ChatInterface, where the project
 * and session state already lives. App stays a single mounted view; the rail's destinations are real
 * actions (new chat, search palette, project focus, memory/settings modals), not placeholder views.
 * `useSystemAccent` paints the Windows system accent over the brand tokens when running in Electron.
 */
function App() {
    useSystemAccent();
    const uiLang = useUiLanguage();
    // The dictionary is module-level mutable state (`applyUiLanguage` rewrites the shared `vi`
    // object), so it must be applied BEFORE the tree renders: an effect would paint the old
    // language first and leave it stuck there, with nothing left to re-render.
    const appliedLang = useRef<string>('');
    if (appliedLang.current !== uiLang) {
        appliedLang.current = uiLang;
        applyUiLanguage(uiLang);
    }
    return <ChatInterface />;
}

export default App;
