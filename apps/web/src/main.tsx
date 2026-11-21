import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initAppearance } from './lib/appearance';
import './styles/tokens.css';
import './styles/global.css';
import './styles/revisit.css';
import './styles/capture.css';

// Apply palette and light/dark mode before the first paint to avoid a flash of the default theme.
initAppearance();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
